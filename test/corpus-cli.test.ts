import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GBRAIN_HOME: '/tmp/gbrain-test-corpus-help' },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('gbrain corpus CLI', () => {
  test('help is reachable without a configured brain', () => {
    const { stdout, stderr, status } = runCli(['corpus', '--help']);
    expect(status).toBe(0);
    expect(stderr).not.toContain('No brain configured');
    expect(stdout).toContain('gbrain corpus inspect <url-or-path>');
    expect(stdout).toContain('ingest is implemented for local transcript directories only');
  });

  test('main help lists corpus', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('corpus inspect');
  });

  test('ingest writes JSON receipt without a configured brain', () => {
    const input = mkdtempSync(join(tmpdir(), 'gbrain-corpus-cli-in-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-cli-out-'));
    try {
      writeFileSync(join(input, 'talk.txt'), 'Receipts over vibes.\n');
      const { stdout, stderr, status } = runCli([
        'corpus',
        'ingest',
        input,
        '--source',
        'cli-test',
        '--out',
        out,
        '--json',
      ]);
      expect(status).toBe(0);
      expect(stderr).not.toContain('No brain configured');
      const json = JSON.parse(stdout);
      expect(json.source_id).toBe('cli-test');
      expect(json.pages_written).toHaveLength(1);
      expect(readFileSync(json.pages_written[0], 'utf8')).toContain('source_id: cli-test');
    } finally {
      rmSync(input, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
