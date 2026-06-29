/**
 * Tests for the `advisor` MCP op gate (T7 / C3): remote callers need
 * mcp.publish_advisor; local callers bypass; the op is read-only (drops
 * workspace-dependent findings over MCP via runAdvisor's remote filter).
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';
import type { Page } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

const advisor = operationsByName['advisor']!;

function page(overrides: Partial<Page> = {}): Page {
  return {
    id: 1,
    slug: 'wiki/originals/ideas/seascape-strategy-dream',
    type: 'original',
    title: 'Seascape strategy dream',
    compiled_truth: `# Seascape strategy dream

Session: 019example
Date: 2026-06-28
Repo: seascape-hub

## What Happened

Proof: owner readback completed.
Decision: promote the strategy update after human review.
Seascape Hub strategy canon update.
`,
    timeline: '',
    frontmatter: {
      dream_generated: true,
      session_id: '019example',
      started_at: '2026-06-28T10:00:00Z',
    },
    created_at: new Date('2026-06-28T10:00:00Z'),
    updated_at: new Date('2026-06-28T10:00:00Z'),
    source_id: 'default',
    ...overrides,
  };
}

function memoryOnlyPage(): Page {
  return page({
    compiled_truth: `# Seascape strategy dream

Session: 019example

Seascape Hub strategy canon update without independent confirmation yet.
`,
  });
}

function ctx(
  over: Partial<OperationContext>,
  cfg: Record<string, string | null> = {},
  opts: { candidate?: boolean; memoryOnlyReject?: boolean } = {},
): OperationContext {
  return {
    engine: ({
      getConfig: async (k: string) => cfg[k] ?? null,
      getStats: async () => { throw new Error('no'); },
      getHealth: async () => { throw new Error('no'); },
      executeRaw: async () => {
        if (opts.candidate) {
          return [
            {
              id: 'seascape-hub-src',
              name: 'gstack-code-hub-ae4800f6-9c4839',
              local_path: '/Users/sawbeck/Projects/seascape-hub',
              last_commit: null,
              last_sync_at: new Date('2026-06-28T12:00:00Z'),
              config: '{"federated":true}',
              created_at: new Date('2026-06-01T00:00:00Z'),
            },
          ];
        }
        throw new Error('no');
      },
      listPages: async () => (opts.memoryOnlyReject ? [memoryOnlyPage()] : opts.candidate ? [page()] : []),
    }) as unknown as OperationContext['engine'],
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: true,
    ...over,
  } as OperationContext;
}

describe('advisor op gate', () => {
  test('op exists, is read-scoped and not localOnly (exposed over MCP)', () => {
    expect(advisor).toBeDefined();
    expect(advisor.scope).toBe('read');
    expect(advisor.localOnly).not.toBe(true);
  });

  test('remote without mcp.publish_advisor → permission_denied', async () => {
    await expect(advisor.handler(ctx({ remote: true }), {})).rejects.toBeInstanceOf(OperationError);
  });

  test('remote WITH mcp.publish_advisor → returns a report', async () => {
    const report = (await advisor.handler(ctx({ remote: true }, { 'mcp.publish_advisor': 'true' }), {})) as {
      findings: unknown[];
    };
    expect(Array.isArray(report.findings)).toBe(true);
  });

  test('local caller bypasses the gate', async () => {
    const report = (await advisor.handler(ctx({ remote: false }), {})) as { findings: unknown[] };
    expect(Array.isArray(report.findings)).toBe(true);
  });

  test('remote advisor payload stays read-only even when a Seascape candidate exists', async () => {
    const report = (await advisor.handler(
      ctx({ remote: true }, { 'mcp.publish_advisor': 'true' }, { candidate: true }),
      {},
    )) as {
      findings: Array<{
        fix: { command_argv: string[] | null; dispatch_id?: string };
        writeback_candidate?: { draft?: { writes: boolean } | null };
      }>;
    };
    const candidateFinding = report.findings.find((finding) => finding.writeback_candidate);
    expect(candidateFinding).toBeDefined();
    expect(candidateFinding?.writeback_candidate?.draft?.writes).toBe(false);
    expect(candidateFinding?.fix.command_argv).toBeNull();
    expect(candidateFinding?.fix.dispatch_id).toBeUndefined();
  });

  test('remote advisor does not persist Seascape suppression state for rejected memory-only residue', async () => {
    const gbHome = mkdtempSync(join(tmpdir(), 'gbrain-advisor-remote-readonly-'));
    try {
      await withEnv({ GBRAIN_HOME: gbHome }, async () => {
        await advisor.handler(
          ctx({ remote: true }, { 'mcp.publish_advisor': 'true' }, { candidate: true, memoryOnlyReject: true }),
          {},
        );
        expect(existsSync(join(gbHome, '.gbrain', 'writeback-suppression-state.json'))).toBe(false);
      });
    } finally {
      rmSync(gbHome, { recursive: true, force: true });
    }
  });
});
