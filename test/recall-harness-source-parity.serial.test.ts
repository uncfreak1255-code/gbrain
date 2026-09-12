/**
 * A machine-level harness can pin ambient memory writes to a dedicated source.
 * A bare local `gbrain recall` must read that same source when the ordinary
 * resolver has no stronger signal; otherwise memory is saved successfully but
 * appears missing from the documented verification command.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRecall } from '../src/commands/recall.ts';
import { writeHarnessReceipt } from '../src/core/bootstrap/format.ts';
import type { HarnessReceipt } from '../src/core/bootstrap/format.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

async function recallFacts(args: string[], parentHome: string): Promise<string[]> {
  const originalWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await withEnv({ GBRAIN_HOME: parentHome, GBRAIN_SOURCE: undefined }, () =>
      runRecall(engine, [...args, '--json']),
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  return (JSON.parse(captured).facts as Array<{ fact: string }>).map((row) => row.fact);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('session-briefs', 'session-briefs', '{"federated": true}'::jsonb)`,
  );
  await engine.insertFact(
    {
      fact: 'The operator prefers visible system state.',
      kind: 'preference',
      source: 'hook:writeback',
      visibility: 'world',
    },
    { source_id: 'session-briefs' },
  );
  await engine.insertFact(
    {
      fact: 'The default source remains independently queryable.',
      kind: 'fact',
      source: 'test',
      visibility: 'world',
    },
    { source_id: 'default' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('recall and harness write-source parity', () => {
  test('a bare local recall uses the source pinned by the harness receipt', async () => {
    const parentHome = emptyHome();
    writeHarnessReceipt(join(parentHome, '.gbrain'), {
      harness_receipt_version: 1,
      created_at: '2026-09-11T00:00:00Z',
      created_by: 'gbrain@test',
      url: 'http://127.0.0.1:3131/mcp',
      source_id: 'session-briefs',
      token: { name: 'bootstrap-harness', minted: true },
      targets: [
        { host: 'codex', kind: 'mcp', state: 'confirmed', scope: 'user' },
      ],
    });

    expect(await recallFacts(['--grep', 'visible system state'], parentHome)).toEqual([
      'The operator prefers visible system state.',
    ]);
  });

  test('an explicit --source default overrides the harness receipt', async () => {
    const parentHome = emptyHome();
    writeHarnessReceipt(join(parentHome, '.gbrain'), {
      harness_receipt_version: 1,
      created_at: '2026-09-11T00:00:00Z',
      created_by: 'gbrain@test',
      url: 'http://127.0.0.1:3131/mcp',
      source_id: 'session-briefs',
      token: { name: 'bootstrap-harness', minted: true },
      targets: [
        { host: 'codex', kind: 'mcp', state: 'confirmed', scope: 'user' },
      ],
    });

    expect(await recallFacts(['--source', 'default', '--grep', 'default source'], parentHome)).toEqual([
      'The default source remains independently queryable.',
    ]);
  });

  test('unsafe or stale receipts fall back to the canonical default source', async () => {
    const cases: Array<{
      name: string;
      source_id: string;
      source_pinned?: false;
      targets: HarnessReceipt['targets'];
    }> = [
      {
        name: 'unpinned',
        source_id: 'session-briefs',
        source_pinned: false as const,
        targets: [{ host: 'codex', kind: 'mcp' as const, state: 'confirmed' as const, scope: 'user' }],
      },
      {
        name: 'pending-only',
        source_id: 'session-briefs',
        targets: [{ host: 'codex', kind: 'mcp' as const, state: 'pending' as const, scope: 'user' }],
      },
      {
        name: 'missing-source',
        source_id: 'stale-source',
        targets: [{ host: 'codex', kind: 'hooks' as const, state: 'confirmed' as const, scope: 'user' }],
      },
    ];

    for (const candidate of cases) {
      const parentHome = emptyHome();
      writeHarnessReceipt(join(parentHome, '.gbrain'), {
        harness_receipt_version: 1,
        created_at: '2026-09-11T00:00:00Z',
        created_by: 'gbrain@test',
        url: 'http://127.0.0.1:3131/mcp',
        source_id: candidate.source_id,
        ...(candidate.source_pinned === false ? { source_pinned: false as const } : {}),
        token: { name: 'bootstrap-harness', minted: true },
        targets: candidate.targets,
      });

      expect(
        await recallFacts(['--grep', 'default source'], parentHome),
        candidate.name,
      ).toEqual(['The default source remains independently queryable.']);
    }

    const malformedHome = emptyHome();
    const bootstrapDir = join(malformedHome, '.gbrain', 'bootstrap');
    mkdirSync(bootstrapDir, { recursive: true });
    writeFileSync(join(bootstrapDir, 'harness.json'), '{not-json}\n');
    expect(await recallFacts(['--grep', 'default source'], malformedHome)).toEqual([
      'The default source remains independently queryable.',
    ]);
  });
});
