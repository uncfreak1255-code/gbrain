import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, _setSpawnTarget } from './helpers/cli-spawn.ts';

for (const args of [['query', 'synthetic query'], ['put', 'notes/synthetic', '--content', 'synthetic content']]) {
  test(`local ${args[0]} operation preserves a nested spend scope`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-spend-'));
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
    _setSpawnTarget([process.execPath, '--preload', resolve('test/fixtures/cli-spend-scope-preload.ts'), resolve('src/cli.ts')]);
    try {
      const result = await runCli(args, { home, timeoutMs: 45000 });
      expect(result.stderr).toContain('CLI_SPEND_SCOPE_OK');
      expect(result.exitCode).toBe(0);
    } finally {
      _setSpawnTarget(null);
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);
}
