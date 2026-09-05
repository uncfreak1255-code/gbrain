import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { reserveGatewaySpend } from '../../src/core/minions/budget-meter.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
const url = process.env.DATABASE_URL!;
assertSafeE2eDatabaseUrl(url);
const engine = new PostgresEngine();
try {
  await engine.connect({ database_url: url, poolSize: 1 });
  await reserveGatewaySpend(engine, { runId: process.argv[2], estimatedUsd: 0.10, runCapUsd: 0.15, dayCapUsd: 0.20, model: 'test:model' });
  console.log('admitted');
} catch (err: any) {
  if (err.message?.includes('cap exceeded')) console.log('refused');
  else { console.error(err.message); process.exitCode = 1; }
} finally { await engine.disconnect(); }
