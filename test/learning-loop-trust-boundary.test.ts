import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations, operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isProtectedOwnerControlKey } from '../src/commands/config.ts';
import { withEnv } from './helpers/with-env.ts';

const PRIVILEGED = [
  'learning_loop_get_mode',
  'learning_loop_set_mode',
  'learning_loop_inspect',
  'learning_loop_arm',
  'learning_loop_abort',
  'learning_loop_resolve_transcript',
  'learning_loop_bind_session',
  'learning_loop_candidate',
  'learning_loop_authority',
  'learning_loop_activate',
  'learning_loop_correct',
  'learning_loop_reverse',
];

function unsafeContext(remote: unknown): OperationContext {
  return {
    remote,
    dryRun: false,
    config: { engine: 'pglite' },
    engine: {} as OperationContext['engine'],
    logger: { info() {}, warn() {}, error() {} },
    sourceId: 'default',
  } as OperationContext;
}

describe('Learning Loop and generic localOnly transport boundary', () => {
  test('generic config mutation cannot bypass the mode lifecycle control', () => {
    expect(isProtectedOwnerControlKey('learning_loop.mode')).toBe(true);
    expect(isProtectedOwnerControlKey('search.mode')).toBe(false);
  });

  test('trusted-local inspection returns the empty ledger replay', async () => {
    const home = mkdtempSync(join(tmpdir(), 'learning-loop-inspect-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await expect(operationsByName.learning_loop_inspect.handler(unsafeContext(false), {}))
          .resolves.toEqual({ active_run_id: null, event_count: 0, runs: [] });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('network discovery omits every localOnly operation', () => {
    const localNames = operations.filter((op) => op.localOnly).map((op) => op.name);
    const http = new Set(operations.filter((op) => !op.localOnly).map((op) => op.name));
    for (const name of localNames) {
      expect(http.has(name)).toBe(false);
    }
  });

  test('the streamable HTTP registry applies the current localOnly filter', () => {
    // test-reads-source-ok: pins HTTP registry wiring alongside runtime dispatch and handler rejection tests.
    const source = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');
    expect(source).toContain('operations.filter(op => !op.localOnly)');
    expect(source).not.toContain('const mcpOperations = operations;');
  });

  test('shared remote dispatch denies direct localOnly invocation', async () => {
    for (const name of PRIVILEGED) {
      const result = await dispatchToolCall({} as OperationContext['engine'], name, {}, { remote: true, transport: 'http' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('unknown_tool');
    }
  });

  test('each privileged handler independently rejects true and undefined remote state', async () => {
    for (const name of PRIVILEGED) {
      const op = operationsByName[name];
      await expect(op.handler(unsafeContext(true), {})).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(op.handler(unsafeContext(undefined), {})).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  test('authenticated adapter submission is network-visible but owner controls are not', () => {
    const httpOperations = operations.filter((op) => !op.localOnly);
    expect(httpOperations.some((op) => op.name === 'learning_loop_submit_session_v1')).toBe(true);
    for (const name of PRIVILEGED) {
      expect(httpOperations.some((op) => op.name === name)).toBe(false);
    }
  });

  test('adapter submission rejects missing or mismatched source identity and stays inert while off', async () => {
    const op = operationsByName.learning_loop_submit_session_v1;
    const params = {
      provider: 'codex', provider_session_id: 'session-1', source_id: 'personal',
      completion_state: 'completed', completed_at: '2026-08-31T00:00:00Z',
    };
    await expect(op.handler(unsafeContext(true), params)).rejects.toMatchObject({ code: 'permission_denied' });

    const ambiguous = unsafeContext(undefined);
    ambiguous.sourceId = 'personal';
    ambiguous.auth = { token: 'redacted', clientId: 'adapter', scopes: ['write'], sourceId: 'personal' };
    await expect(op.handler(ambiguous, params)).rejects.toMatchObject({ code: 'permission_denied' });

    const wrongSource = unsafeContext(true);
    wrongSource.sourceId = 'personal';
    wrongSource.auth = { token: 'redacted', clientId: 'adapter', scopes: ['write'], sourceId: 'other' };
    await expect(op.handler(wrongSource, params)).rejects.toMatchObject({ code: 'permission_denied' });

    const off = unsafeContext(true);
    off.sourceId = 'personal';
    off.auth = { token: 'redacted', clientId: 'adapter', scopes: ['write'], sourceId: 'personal' };
    off.engine = { getConfig: async () => null } as unknown as OperationContext['engine'];
    await expect(op.handler(off, params)).resolves.toEqual({ status: 'disabled', mode: 'off' });
  });

  test('adapter submission checks session binding before transcript discovery', async () => {
    const home = mkdtempSync(join(tmpdir(), 'learning-loop-binding-order-'));
    let transcriptConfigReads = 0;
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const ctx = unsafeContext(true);
        ctx.sourceId = 'personal';
        ctx.config = { engine: 'pglite', database_path: join(home, 'brain') };
        ctx.auth = { token: 'redacted', clientId: 'adapter', scopes: ['write'], sourceId: 'personal' };
        ctx.engine = {
          getConfig: async (key: string) => {
            if (key === 'learning_loop.mode') return 'capture';
            if (key.startsWith('learning_loop.corpus.')) transcriptConfigReads += 1;
            throw new Error(`unexpected transcript discovery config read: ${key}`);
          },
        } as unknown as OperationContext['engine'];

        await expect(operationsByName.learning_loop_submit_session_v1.handler(ctx, {
          provider: 'codex',
          provider_session_id: 'unbound-session',
          source_id: 'personal',
          completion_state: 'completed',
          completed_at: '2026-08-31T00:00:00Z',
        })).rejects.toMatchObject({ code: 'permission_denied' });
      });
      expect(transcriptConfigReads).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
