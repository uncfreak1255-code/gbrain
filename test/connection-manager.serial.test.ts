import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  isSupabasePoolerUrl,
  deriveDirectUrl,
  readKillSwitchEnv,
  resolveDirectPoolSize,
  ConnectionManager,
  DEFAULT_DIRECT_POOL_SIZE,
} from '../src/core/connection-manager.ts';

describe('isSupabasePoolerUrl', () => {
  test('detects port 6543', () => {
    expect(isSupabasePoolerUrl('postgresql://u:p@host:6543/db')).toBe(true);
  });

  test('detects pooler.supabase.com hostname', () => {
    expect(
      isSupabasePoolerUrl('postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/db')
    ).toBe(true);
  });

  test('rejects direct supabase host', () => {
    expect(
      isSupabasePoolerUrl('postgresql://u:p@db.abc.supabase.co:5432/postgres')
    ).toBe(false);
  });

  test('rejects self-hosted on standard port', () => {
    expect(isSupabasePoolerUrl('postgresql://u:p@localhost:5432/gbrain_test')).toBe(false);
  });

  test('handles malformed URL gracefully', () => {
    expect(isSupabasePoolerUrl('not a url')).toBe(false);
  });
});

describe('deriveDirectUrl', () => {
  test('swaps pooler hostname + port for known shape', () => {
    const direct = deriveDirectUrl(
      'postgresql://postgres.abcxyz:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
    );
    expect(direct).toBeTruthy();
    expect(direct).toContain('db.abcxyz.supabase.co:5432');
    expect(direct).toContain(':secret@'); // creds preserved
  });

  test('strips .<project-ref> suffix from username when going pooler→direct', () => {
    // Supabase direct connections require bare `postgres`; the `postgres.<ref>`
    // form is pooler-only (Supavisor uses the suffix for tenant routing).
    // Without the strip, direct auth fails with "password authentication
    // failed for user postgres.<ref>" even with the correct password.
    const direct = deriveDirectUrl(
      'postgresql://postgres.abcxyz:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
    );
    expect(direct).toContain('postgres:secret@'); // bare username
    expect(direct).not.toContain('postgres.abcxyz:secret@'); // no pooler suffix
  });

  test('falls back to port-only swap when project-ref unparseable', () => {
    const direct = deriveDirectUrl(
      'postgresql://customuser:secret@some.pooler.supabase.com:6543/db'
    );
    expect(direct).toBeTruthy();
    expect(direct).toContain(':5432');
    expect(direct).toContain('some.pooler.supabase.com'); // host preserved
    expect(direct).toContain('customuser:secret@'); // non-pooler username preserved
  });

  test('returns null for non-pooler URL', () => {
    expect(deriveDirectUrl('postgresql://u:p@localhost:5432/db')).toBeNull();
  });

  test('preserves query string', () => {
    const direct = deriveDirectUrl(
      'postgresql://postgres.ref:p@aws.pooler.supabase.com:6543/db?prepare=false'
    );
    expect(direct).toContain('?prepare=false');
  });
});

describe('readKillSwitchEnv', () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env.GBRAIN_DISABLE_DIRECT_POOL; });
  afterEach(() => {
    if (original === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    else process.env.GBRAIN_DISABLE_DIRECT_POOL = original;
  });

  test('false when unset', () => {
    delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    expect(readKillSwitchEnv()).toBe(false);
  });

  test('true when "1"', () => {
    process.env.GBRAIN_DISABLE_DIRECT_POOL = '1';
    expect(readKillSwitchEnv()).toBe(true);
  });

  test('true when "true"', () => {
    process.env.GBRAIN_DISABLE_DIRECT_POOL = 'true';
    expect(readKillSwitchEnv()).toBe(true);
  });

  test('false for any other value', () => {
    process.env.GBRAIN_DISABLE_DIRECT_POOL = '0';
    expect(readKillSwitchEnv()).toBe(false);
    process.env.GBRAIN_DISABLE_DIRECT_POOL = 'false';
    expect(readKillSwitchEnv()).toBe(false);
  });
});

describe('resolveDirectPoolSize', () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env.GBRAIN_DIRECT_POOL_SIZE; });
  afterEach(() => {
    if (original === undefined) delete process.env.GBRAIN_DIRECT_POOL_SIZE;
    else process.env.GBRAIN_DIRECT_POOL_SIZE = original;
  });

  test('default to 3', () => {
    delete process.env.GBRAIN_DIRECT_POOL_SIZE;
    expect(resolveDirectPoolSize()).toBe(DEFAULT_DIRECT_POOL_SIZE);
    expect(DEFAULT_DIRECT_POOL_SIZE).toBe(3);
  });

  test('explicit overrides env', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = '5';
    expect(resolveDirectPoolSize(7)).toBe(7);
  });

  test('env overrides default', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = '5';
    expect(resolveDirectPoolSize()).toBe(5);
  });

  test('rejects invalid env values', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = 'abc';
    expect(resolveDirectPoolSize()).toBe(DEFAULT_DIRECT_POOL_SIZE);
    process.env.GBRAIN_DIRECT_POOL_SIZE = '0';
    expect(resolveDirectPoolSize()).toBe(DEFAULT_DIRECT_POOL_SIZE);
    process.env.GBRAIN_DIRECT_POOL_SIZE = '999';
    expect(resolveDirectPoolSize()).toBe(DEFAULT_DIRECT_POOL_SIZE);
  });
});

describe('ConnectionManager — describeMode + dual-pool routing', () => {
  let originalKillSwitch: string | undefined;
  beforeEach(() => {
    originalKillSwitch = process.env.GBRAIN_DISABLE_DIRECT_POOL;
    delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
  });
  afterEach(() => {
    if (originalKillSwitch === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    else process.env.GBRAIN_DISABLE_DIRECT_POOL = originalKillSwitch;
  });

  test('non-Supabase URL → single mode', () => {
    const url = 'postgresql://u@localhost:5432/db';
    const cm = new ConnectionManager({ url });
    expect(cm.isSupabase()).toBe(false);
    expect(cm.isDualPoolActive()).toBe(false);
    expect(cm.describeMode().mode).toBe('single (non-supabase)');
    expect(cm.resolveSessionUrl()).toBe(url);
  });

  test('Supabase pooler URL → dual mode (without kill-switch)', () => {
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
    });
    expect(cm.isSupabase()).toBe(true);
    expect(cm.isDualPoolActive()).toBe(true);
    expect(cm.describeMode().mode).toBe('split');
    expect(cm.describeMode().direct_host).toContain('db.abc.supabase.co:5432');
    expect(cm.resolveSessionUrl()).toContain('db.abc.supabase.co:5432');
  });

  test('kill-switch active → single mode (kill-switch)', () => {
    process.env.GBRAIN_DISABLE_DIRECT_POOL = '1';
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
    });
    expect(cm.isSupabase()).toBe(true);
    expect(cm.isKillSwitchActive()).toBe(true);
    expect(cm.isDualPoolActive()).toBe(false);
    expect(cm.describeMode().mode).toBe('single (kill-switch)');
    expect(cm.resolveSessionUrl()).toBeNull();
  });

  test('explicit directUrl override wins', () => {
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
      directUrl: 'postgresql://u:p@custom-direct.example.com:5432/db',
    });
    expect(cm.resolveDirectUrl()).toContain('custom-direct.example.com');
  });

  test('host string contains creds neither in describeMode nor resolveDirectUrl logging', () => {
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:secret@aws.pooler.supabase.com:6543/db',
    });
    const desc = cm.describeMode();
    expect(desc.direct_host ?? '').not.toContain('secret');
  });
});

describe('ConnectionManager — parent inheritance (A2)', () => {
  test('child inherits kill-switch from parent', () => {
    const original = process.env.GBRAIN_DISABLE_DIRECT_POOL;
    try {
      process.env.GBRAIN_DISABLE_DIRECT_POOL = '1';
      const parent = new ConnectionManager({
        url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
      });
      // Child constructed AFTER env reset — parent's snapshot is what matters.
      delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
      const child = new ConnectionManager({
        url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
        parent,
      });
      expect(child.isKillSwitchActive()).toBe(true);
      expect(child.isDualPoolActive()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
      else process.env.GBRAIN_DISABLE_DIRECT_POOL = original;
    }
  });

  test('child without parent reads env at construction', () => {
    const original = process.env.GBRAIN_DISABLE_DIRECT_POOL;
    try {
      delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
      const cm = new ConnectionManager({
        url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
      });
      expect(cm.isKillSwitchActive()).toBe(false);
      // Mutating env after construction does NOT change the manager's state.
      process.env.GBRAIN_DISABLE_DIRECT_POOL = '1';
      expect(cm.isKillSwitchActive()).toBe(false); // snapshot semantics
    } finally {
      if (original === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
      else process.env.GBRAIN_DISABLE_DIRECT_POOL = original;
    }
  });
});

describe('ConnectionManager — session pool lifecycle', () => {
  test('disconnect invalidates and closes an in-flight session initializer', async () => {
    const cm = new ConnectionManager({ url: 'postgresql://u@localhost:5432/db' });
    let resolveInit!: (pool: unknown) => void;
    const initGate = new Promise<unknown>((resolve) => { resolveInit = resolve; });
    let ended = 0;
    const pool = {
      end: async () => { ended += 1; },
    };

    const internals = cm as unknown as {
      initSessionPool: () => Promise<unknown>;
      _sessionPool: unknown | null;
      _sessionInit: Promise<unknown> | null;
    };
    internals.initSessionPool = () => initGate;

    const session = cm.session();
    const disconnect = cm.disconnect();
    resolveInit(pool);

    await expect(session).rejects.toThrow('disconnected while initializing the session pool');
    await disconnect;
    expect(ended).toBe(1);
    expect(internals._sessionPool).toBeNull();
    expect(internals._sessionInit).toBeNull();
  });

  test('a new session request cannot race disconnect and publish another pool', async () => {
    const cm = new ConnectionManager({ url: 'postgresql://u@localhost:5432/db' });
    let resolveInit!: (pool: unknown) => void;
    const initGate = new Promise<unknown>((resolve) => { resolveInit = resolve; });
    let initCalls = 0;
    let ended = 0;
    const pool = {
      end: async () => { ended += 1; },
    };

    const internals = cm as unknown as {
      initSessionPool: () => Promise<unknown>;
      _sessionPool: unknown | null;
      _sessionInit: Promise<unknown> | null;
    };
    internals.initSessionPool = () => {
      initCalls += 1;
      return initGate;
    };

    const firstSession = cm.session();
    const disconnect = cm.disconnect();
    const racingSession = cm.session();

    await expect(racingSession).rejects.toThrow('session pool is unavailable after disconnect has started');
    expect(initCalls).toBe(1);
    resolveInit(pool);
    await expect(firstSession).rejects.toThrow('disconnected while initializing the session pool');
    await disconnect;
    expect(ended).toBe(1);
    expect(internals._sessionPool).toBeNull();
    expect(internals._sessionInit).toBeNull();
  });
});
