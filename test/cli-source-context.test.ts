import { describe, expect, test } from 'bun:test';
import { makeContext } from '../src/cli.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function resolverEngine(opts: {
  defaultSource?: string;
  archived?: boolean;
  error?: Error & { code?: string };
}): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (opts.error) throw opts.error;
      if (sql.includes('SELECT id, local_path')) return [];
      if (sql.includes('SELECT id, archived') && sql.includes('FROM sources WHERE id = $1')) {
        return [{
          id: params?.[0],
          archived: opts.archived === true,
          draining: false,
        }] as T[];
      }
      return [];
    },
    getConfig: async (key: string) => key === 'sources.default'
      ? (opts.defaultSource ?? null)
      : null,
  } as unknown as BrainEngine;
}

describe('CLI operation context source routing', () => {
  test('propagates an archived automatic-route failure instead of writing to default', async () => {
    const engine = resolverEngine({ defaultSource: 'retired', archived: true });
    await expect(makeContext(engine, {})).rejects.toThrow(
      /Source "retired" is archived.*sources\.default/,
    );
  });

  test('retains the pre-init fallback only when the sources table is absent', async () => {
    const missing = Object.assign(new Error('relation "sources" does not exist'), { code: '42P01' });
    const context = await makeContext(resolverEngine({ error: missing }), {});
    expect(context.sourceId).toBe('default');
  });

  test('propagates non-schema resolver failures', async () => {
    const connectionError = new Error('connection reset by peer');
    await expect(makeContext(resolverEngine({ error: connectionError }), {})).rejects.toThrow(
      /connection reset by peer/,
    );
  });

  test('does not treat another missing table as pre-init source compatibility', async () => {
    const wrongTable = Object.assign(new Error('relation "pages" does not exist'), { code: '42P01' });
    await expect(makeContext(resolverEngine({ error: wrongTable }), {})).rejects.toThrow(
      /relation "pages" does not exist/,
    );
  });
});
