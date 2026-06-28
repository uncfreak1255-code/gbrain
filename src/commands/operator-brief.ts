import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRootFromHere(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function runOperatorBrief(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain operator-brief [--repo <path>]

Generate a one-screen operator receipt for repo, source, queue, doctor,
budget, active jobs, source-drift preview, and installed autopilot schedule.

Environment:
  GBRAIN_OPERATOR_BRIEF_DIR       Receipt output directory
  GBRAIN_SOURCE_DRIFT_DIR         Source drift preview directory
`);
    return;
  }

  const scriptPath = resolve(repoRootFromHere(), 'scripts', 'gbrain-operator-brief.sh');
  if (!existsSync(scriptPath)) {
    console.error(`operator-brief script not found: ${scriptPath}`);
    process.exit(1);
  }

  const repoIdx = args.indexOf('--repo');
  const repo = repoIdx >= 0 && repoIdx + 1 < args.length ? args[repoIdx + 1] : repoRootFromHere();
  const currentCli = `${process.execPath} ${process.argv[1]}`;
  const result = spawnSync('bash', [scriptPath], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GBRAIN_OPERATOR_BRIEF_REPO: repo,
      GBRAIN_OPERATOR_BRIEF_BIN: process.env.GBRAIN_OPERATOR_BRIEF_BIN || currentCli,
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
    },
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status && result.status !== 0) process.exit(result.status);
}
