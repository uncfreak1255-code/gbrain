// Instrument only the operation body; the real CLI still connects, builds
// context, dispatches each scope class, and drains its engine normally.
import { operations } from '../../src/core/operations.ts';
import { currentGatewaySpendRunId, withGatewaySpendScope } from '../../src/core/budget/gateway-spend.ts';
for (const name of ['query', 'put_page']) {
  const op = operations.find(op => op.name === name)!;
  op.handler = async ctx => {
    const runId = currentGatewaySpendRunId(ctx.engine);
    if (!runId) throw new Error('Missing CLI spend scope');
    const nested = await withGatewaySpendScope(ctx.engine, async () => currentGatewaySpendRunId(ctx.engine));
    if (nested !== runId) throw new Error('Nested operation lost spend identity');
    console.error('CLI_SPEND_SCOPE_OK');
    return name === 'query' ? [] : { status: 'ok' };
  };
}
