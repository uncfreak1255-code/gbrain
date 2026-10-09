/** Real local CLI scan wiring; old unknown-flag handling or truncated recall
 * loses the scan envelope/backdated facts and fails. Existing CLI recall tests
 * never traverse all saved facts. Uses a scratch PGLite store, no new seam. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';

let home: string;
let engine: PGLiteEngine;
const SINCE = '2026-01-01T00:00:00.000Z';

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-scan-cli-'));
  const brain = join(home, '.gbrain');
  mkdirSync(brain);
  const database_path = join(brain, 'brain.pglite');
  writeFileSync(join(brain, 'config.json'), JSON.stringify({ engine: 'pglite', database_path }));
  engine = new PGLiteEngine();
  await engine.connect({ database_path });
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO facts(source_id,fact,source,visibility,created_at,valid_from)
    SELECT 'default','Saved claim ' || i::text,'synthetic','world','2026-06-10T00:00:00Z','2020-01-01T00:00:00Z'
    FROM generate_series(1,130) AS i`);
  await engine.disconnect();
});
afterAll(async () => { await engine?.disconnect(); if (home) rmSync(home, { recursive: true, force: true }); });

const call = (args: string[]) => runCli(['recall', ...args, '--json'], { home, cwd: home, env: {
  GBRAIN_NO_BANNER: '1', GBRAIN_MODEL_DISCOVERY: 'off', GBRAIN_BRAIN_ID: undefined, GBRAIN_SOURCE: undefined,
} });

test('local CLI retrieves 130 facts across a stable cursor and keeps backdated event times', async () => {
  const base = ['--scan', '--since', SINCE, '--include-expired', '--limit', '100'];
  const first = await call(base);
  expect({ code: first.exitCode, stderr: first.stderr }).toMatchObject({ code: 0 });
  const page = JSON.parse(first.stdout);
  expect(page.facts).toHaveLength(100);
  expect(page.scan).toMatchObject({ version: 1, source_id: 'default', since: SINCE, has_more: true });
  expect(page.facts.every((row: any) => row.valid_from === '2020-01-01T00:00:00.000Z')).toBe(true);
  const second = await call([...base, `--after-id=${page.scan.next_after_id}`, `--through-id=${page.scan.through_id}`]);
  expect({ code: second.exitCode, stderr: second.stderr }).toMatchObject({ code: 0 });
  const tail = JSON.parse(second.stdout);
  expect(tail.facts).toHaveLength(30);
  expect(tail.scan).toMatchObject({ through_id: page.scan.through_id, after_id: page.scan.next_after_id, has_more: false });
  expect(new Set([...page.facts, ...tail.facts].map(row => row.id)).size).toBe(130);
}, 90_000);

test('CLI scan rejects invalid cursors, windows and mixed modes instead of running ordinary recall', async () => {
  for (const args of [
    ['--scan', '--since', '7 days ago'], ['--scan', '--since', SINCE, '--after-id', '4'],
    ['--scan', '--since', SINCE, '--limit', '1.5'], ['--scan', '--since', SINCE, '--today'],
    ['--scan', '--since', SINCE, '--since-last-run'], ['--scan', '--since', SINCE, '--grep', 'claim'],
    ['--after-id=1'], ['--scan', '--since', SINCE, '--source', 'missing-example'],
  ]) {
    const result = await call(args);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout).error).toBe(args.includes('missing-example') ? 'unknown_source' : 'invalid_params');
  }
}, 90_000);
