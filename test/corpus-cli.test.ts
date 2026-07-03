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
    expect(stdout).toContain('ingest, review, and brief are implemented for local transcript');
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

  test('review and brief write JSON receipts without a configured brain', () => {
    const input = mkdtempSync(join(tmpdir(), 'gbrain-corpus-cli-in-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-cli-out-'));
    try {
      writeFileSync(join(input, 'agent-ops.txt'), 'Agents need retrieval, proof receipts, evals, and bounded workflow decisions.\n');
      const ingest = runCli([
        'corpus',
        'ingest',
        input,
        '--source',
        'cli-test',
        '--out',
        out,
        '--json',
      ]);
      expect(ingest.status).toBe(0);
      const ingestJson = JSON.parse(ingest.stdout);

      const review = runCli([
        'corpus',
        'review',
        ingestJson.out_dir,
        '--source',
        'cli-test',
        '--json',
      ]);
      expect(review.status).toBe(0);
      const reviewJson = JSON.parse(review.stdout);
      expect(reviewJson.review_pages_written).toHaveLength(1);
      expect(readFileSync(reviewJson.review_pages_written[0], 'utf8')).toContain('## Key Ideas');

      const brief = runCli([
        'corpus',
        'brief',
        ingestJson.out_dir,
        '--profile',
        'sawyer',
        '--json',
      ]);
      expect(brief.status).toBe(0);
      const briefJson = JSON.parse(brief.stdout);
      expect(readFileSync(briefJson.brief_path, 'utf8')).toContain('## Best use of your time');
    } finally {
      rmSync(input, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
