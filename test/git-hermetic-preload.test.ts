import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('fixture commits ignore workstation hooks but still execute repository-local hooks', () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-git-isolation-'));
  try {
    const hooks = join(root, 'operator-hooks');
    mkdirSync(hooks);
    const operatorMarker = join(root, 'operator-hook-ran');
    const localMarker = join(root, 'local-hook-ran');
    writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\nprintf invoked > "$OPERATOR_MARKER"\n');
    chmodSync(join(hooks, 'post-commit'), 0o755);
    const config = join(root, 'operator.gitconfig');
    writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n`);
    const probe = join(root, 'probe.ts');
    const preload = resolve(import.meta.dir, 'helpers/git-hermetic-preload.ts');
    writeFileSync(probe, `
      import ${JSON.stringify(preload)};
      import { execFileSync } from 'node:child_process';
      import { writeFileSync, chmodSync } from 'node:fs';
      import { join } from 'node:path';
      const cwd = process.env.FIXTURE_ROOT!;
      const git = (...args: string[]) => execFileSync('git', args, { cwd, env: process.env, stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      writeFileSync(join(cwd, 'README.md'), 'fixture');
      git('add', 'README.md');
      git('commit', '-qm', 'fixture');
      const hook = join(cwd, '.git/hooks/post-commit');
      writeFileSync(hook, '#!/bin/sh\\nprintf invoked > "$LOCAL_MARKER"\\n');
      chmodSync(hook, 0o755);
      git('commit', '--allow-empty', '-qm', 'local-hook');
    `);
    execFileSync(process.execPath, ['run', probe], {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_SYSTEM: config,
        FIXTURE_ROOT: root,
        OPERATOR_MARKER: operatorMarker,
        LOCAL_MARKER: localMarker,
      },
      timeout: 10_000,
      stdio: 'pipe',
    });
    expect(existsSync(operatorMarker)).toBe(false);
    expect(existsSync(localMarker)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
