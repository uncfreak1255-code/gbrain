import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { reserveGatewaySpend, clientLockKey } from '../../src/core/minions/budget-meter.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { chat, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { withGatewaySpendScope, currentGatewaySpendRunId, gatewayJobRunId, SPEND_RUN_DATA_KEY } from '../../src/core/budget/gateway-spend.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';

const url = process.env.DATABASE_URL!;
const client = 'gbrain:gateway-budget';
let engine: PostgresEngine;
beforeAll(async () => {
  assertSafeE2eDatabaseUrl(url);
  engine = new PostgresEngine();
  await engine.connect({ database_url: url, poolSize: 6 });
  await engine.initSchema();
});
beforeEach(async () => { await engine.executeRaw('DELETE FROM mcp_spend_log WHERE client_id = $1', [client]); });
afterAll(async () => { resetGateway(); await engine?.disconnect(); });

test('four independent processes wait on one lock and cannot exceed daily headroom', async () => {
  let release!: () => void;
  let ready!: () => void;
  const holding = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { ready = resolve; });
  const blocker = engine.transaction(async tx => {
    await tx.executeRaw('SELECT pg_advisory_xact_lock($1::bigint)', [String(clientLockKey(client))]);
    ready();
    await holding;
  });
  await locked;
  const children = Array.from({ length: 4 }, (_, i) => Bun.spawn({
    cmd: [process.execPath, 'test/fixtures/gateway-spend-child.ts', `process-${i}`],
    env: { ...process.env, DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
  }));
  try {
    let waiters = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await engine.executeRaw<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'");
      waiters = rows[0].count;
      if (waiters === 4) break;
      await Bun.sleep(100);
    }
    expect(waiters).toBe(4);
    release();
    await blocker;
    const results = await Promise.all(children.map(async child => {
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0);
      return output.trim();
    }));
    expect(results.filter(x => x === 'admitted')).toHaveLength(2);
    expect(results.filter(x => x === 'refused')).toHaveLength(2);
    const [row] = await engine.executeRaw<{ cents: string }>('SELECT sum(spend_cents)::text AS cents FROM mcp_spend_log WHERE client_id=$1', [client]);
    expect(Number(row.cents)).toBe(20);
  } finally {
    release(); await blocker;
    for (const child of children) { child.kill(); await child.exited; }
  }
}, 20000);

test('UTC rollover renews day headroom but cannot release an old run hold', async () => {
  const reserve = (runId: string) => reserveGatewaySpend(engine, { runId, estimatedUsd: 0.1, runCapUsd: 0.15, dayCapUsd: 0.15, model: 'test:model' });
  await reserve('old-run');
  await engine.executeRaw("UPDATE mcp_spend_log SET created_at=(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '1 second' WHERE client_id=$1", [client]);
  await expect(reserve('old-run')).rejects.toThrow('cap');
  await reserve('new-run');
  await expect(reserve('third-run')).rejects.toThrow('cap');
});

test('real ledger INSERT failure prevents HTTP dispatch', async () => {
  await engine.executeRaw("CREATE FUNCTION reject_gateway_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture ledger write refused'; END $$");
  await engine.executeRaw('CREATE TRIGGER reject_gateway_test BEFORE INSERT ON mcp_spend_log FOR EACH ROW EXECUTE FUNCTION reject_gateway_test()');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('unexpected HTTP'); }) as unknown as typeof fetch;
  configureGateway({ chat_model: 'zai:glm-5.2', env: { ZAI_API_KEY: 'test-only' }, paid_budget: { max_usd_per_run: 1, max_usd_per_day: 1 } });
  try {
    await expect(withGatewaySpendScope(engine, () => chat({ messages: [{ role: 'user', content: 'test' }], maxTokens: 64 })))
      .rejects.toThrow('fixture ledger write refused');
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = original; resetGateway();
    await engine.executeRaw('DROP TRIGGER reject_gateway_test ON mcp_spend_log');
    await engine.executeRaw('DROP FUNCTION reject_gateway_test()');
  }
});

test('queue owns run identity; caller cannot replace it and children retain it', async () => {
  const queue = new MinionQueue(engine);
  await withGatewaySpendScope(engine, async () => {
    const id = currentGatewaySpendRunId(engine);
    const parent = await queue.add('sync', { [SPEND_RUN_DATA_KEY]: 'forged', fixture: 'spend' }, { coalesce_params: false });
    expect(parent.data[SPEND_RUN_DATA_KEY]).toBe(id!);
    const child = await queue.add('extract', { [SPEND_RUN_DATA_KEY]: 'forged-child' }, { parent_job_id: parent.id });
    expect(await gatewayJobRunId(engine, child)).toBe(id!);
  });
});
