import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The launchd wrapper is intentionally machine-local. CI can inject a mounted
// copy with GBRAIN_NIGHTLY_DREAM_WRAPPER; otherwise this local-contract test
// skips instead of assuming a macOS home-directory layout.
const WRAPPER = process.env.GBRAIN_NIGHTLY_DREAM_WRAPPER ?? '/Users/sawbeck/.gbrain/nightly-dream-synth.sh';
const policyTest = existsSync(WRAPPER) ? test : test.skip;

interface Scenario {
  children: number;
  written: boolean;
  verdict?: 'pass' | 'fail';
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

function runScenario(scenario: Scenario): { exit: number | null; summary: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'nightly-dream-policy-'));
  try {
    const bin = join(root, 'bin');
    const stateHome = join(root, '.gbrain');
    mkdirSync(bin, { recursive: true });

    writeExecutable(join(bin, 'launchctl'), [
      '#!/bin/zsh',
      'if [[ "$1" == "print" ]]; then exit 1; fi',
      'exit 0',
      '',
    ].join('\n'));
    writeExecutable(join(bin, 'bun'), [
      '#!/bin/zsh',
      'set -u',
      'print -r -- "$*" >> "${FAKE_TRACE}"',
      'if [[ "$*" == *"src/cli.ts models"* ]]; then print -r -- "fake-models"; exit 0; fi',
      'if [[ "$*" == *"src/cli.ts config get dream.synthesize.queue"* ]]; then',
      '  print -r -- "nightly-dream-synth"',
      '  exit 0',
      'fi',
      'if [[ "$*" == *"src/cli.ts jobs work"* ]]; then',
      '  exec /bin/sleep 60',
      'fi',
      'if [[ "$*" == *"src/cli.ts dream"* ]]; then',
      '  print -r -- "$FAKE_DREAM_JSON"',
      '  exit 0',
      'fi',
      'if [[ "$*" == *"src/cli.ts eval dream-quality"* ]]; then',
      '  out=""',
      '  args=("$@")',
      '  for ((i = 1; i <= $#; i++)); do',
      '    if [[ "${args[$i]}" == "--output" ]]; then',
      '      next=$((i + 1))',
      '      out="${args[$next]}"',
      '      break',
      '    fi',
      '  done',
      '  print -r -- "{\\"verdict\\":\\"${FAKE_QUALITY_VERDICT}\\"}" > "$out"',
      '  exit "${FAKE_QUALITY_EXIT}"',
      'fi',
      'print -u2 -- "unexpected fake bun command: $*"',
      'exit 99',
      '',
    ].join('\n'));

    const synthesizePhase: Record<string, unknown> = {
      phase: 'synthesize',
      details: { children_submitted: scenario.children, children_cancelled: 0, child_ids_cancelled: [] },
    };
    if (scenario.written) synthesizePhase.written_slugs = ['wiki/originals/ideas/fake-dream-page'];
    const dreamJson = JSON.stringify({ phases: [synthesizePhase] });
    const result = spawnSync('/bin/zsh', ['-f', WRAPPER], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GBRAIN_REPO: root,
        GBRAIN_STATE_HOME: stateHome,
        DREAM_QUEUE: 'nightly-dream-synth',
        DREAM_MAX_CHILDREN: '1',
        DREAM_ARTIFACT_QUALITY_GATE: 'true',
        FAKE_DREAM_JSON: dreamJson,
        FAKE_TRACE: join(root, 'fake-bun.trace'),
        FAKE_QUALITY_VERDICT: scenario.verdict ?? 'pass',
        FAKE_QUALITY_EXIT: scenario.verdict === 'fail' ? '1' : '0',
      },
    });
    const receiptRoot = join(stateHome, 'receipts', 'nightly-dream-synth');
    const runDir = readdirSync(receiptRoot)[0]!;
    return {
      exit: result.status,
      summary: readFileSync(join(receiptRoot, runDir, 'summary.md'), 'utf8'),
      output: `${result.stdout}\n${result.stderr}\n${readFileSync(join(root, 'fake-bun.trace'), 'utf8')}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('nightly Dream artifact-quality policy', () => {
  policyTest('treats a zero-work run as a clean skip', () => {
    const result = runScenario({ children: 0, written: false });
    expect(result.exit, result.output).toBe(0);
    expect(result.summary).toContain('- dream_run_disposition: skipped');
    expect(result.summary).toContain('- dream_artifact_disposition: skipped');
  });

  policyTest('quarantines a scored quality failure without failing the nightly wrapper', () => {
    const result = runScenario({ children: 1, written: true, verdict: 'fail' });
    expect(result.exit, result.output).toBe(0);
    expect(result.summary).toContain('- dream_quality_verdict: fail');
    expect(result.summary).toContain('- dream_artifact_disposition: quarantined');
  });

  policyTest('makes a passing artifact review-eligible only', () => {
    const result = runScenario({ children: 1, written: true, verdict: 'pass' });
    expect(result.exit, result.output).toBe(0);
    expect(result.summary).toContain('- dream_artifact_disposition: review_eligible');
  });

  policyTest('fails closed when the child limit is exceeded', () => {
    const result = runScenario({ children: 2, written: false });
    expect(result.exit, result.output).toBe(65);
    expect(result.summary).toContain('- dream_run_disposition: child_limit_exceeded');
  });
});
