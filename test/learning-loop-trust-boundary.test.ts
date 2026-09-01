import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { operations, operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { stdioOperations } from '../src/mcp/server.ts';
import { legacyHttpOperations } from '../src/mcp/http-transport.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';
import { isProtectedOwnerControlKey } from '../src/commands/config.ts';

const PRIVILEGED = [
  'learning_loop_get_mode',
  'learning_loop_set_mode',
  'learning_loop_inspect',
  'learning_loop_arm',
  'learning_loop_abort',
  'learning_loop_resolve_transcript',
];

function unsafeContext(remote: unknown): OperationContext {
  return {
    remote,
    dryRun: false,
    config: { engine: 'pglite' },
    engine: {} as OperationContext['engine'],
    logger: { info() {}, warn() {}, error() {} },
    sourceId: 'default',
  } as OperationContext;
}

describe('Learning Loop and generic localOnly transport boundary', () => {
  test('generic config mutation cannot bypass the mode lifecycle control', () => {
    expect(isProtectedOwnerControlKey('learning_loop.mode')).toBe(true);
    expect(isProtectedOwnerControlKey('search.mode')).toBe(false);
  });

  test('stdio and legacy HTTP discovery omit every localOnly operation', () => {
    const localNames = operations.filter((op) => op.localOnly).map((op) => op.name);
    const stdio = new Set(stdioOperations.map((op) => op.name));
    const http = new Set(legacyHttpOperations.map((op) => op.name));
    for (const name of localNames) {
      expect(stdio.has(name)).toBe(false);
      expect(http.has(name)).toBe(false);
      expect(BRAIN_TOOL_ALLOWLIST.has(name)).toBe(false);
    }
  });

  test('the streamable HTTP registry uses the same localOnly filter', () => {
    const source = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');
    expect(source).toContain('filterAgentFacingOperations(operations)');
    expect(source).not.toContain('const mcpOperations = operations;');
  });

  test('shared remote dispatch denies direct localOnly invocation', async () => {
    for (const name of PRIVILEGED) {
      const result = await dispatchToolCall({} as OperationContext['engine'], name, {}, { remote: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('local-only');
    }
  });

  test('each privileged handler independently rejects true and undefined remote state', async () => {
    for (const name of PRIVILEGED) {
      const op = operationsByName[name];
      await expect(op.handler(unsafeContext(true), {})).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(op.handler(unsafeContext(undefined), {})).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  test('authenticated adapter submission is visible but owner controls are not', () => {
    expect(stdioOperations.some((op) => op.name === 'learning_loop_submit_session_v1')).toBe(true);
    expect(legacyHttpOperations.some((op) => op.name === 'learning_loop_submit_session_v1')).toBe(true);
    for (const name of PRIVILEGED) {
      expect(stdioOperations.some((op) => op.name === name)).toBe(false);
      expect(legacyHttpOperations.some((op) => op.name === name)).toBe(false);
    }
  });

  test('adapter submission rejects missing or mismatched source identity and stays inert while off', async () => {
    const op = operationsByName.learning_loop_submit_session_v1;
    const params = {
      provider: 'codex', provider_session_id: 'session-1', source_id: 'personal',
      completion_state: 'completed', completed_at: '2026-08-31T00:00:00Z',
    };
    await expect(op.handler(unsafeContext(true), params)).rejects.toMatchObject({ code: 'permission_denied' });

    const ambiguous = unsafeContext(undefined);
    ambiguous.sourceId = 'personal';
    ambiguous.auth = { token: 'redacted', clientId: 'adapter', scopes: ['write'], sourceId: 'personal' };
    await expect(op.handler(ambiguous, params)).rejects.toMatchObject({ code: 'permission_denied' });

    const wrongSource = unsafeContext(true);
    wrongSource.sourceId = 'personal';
    wrongSource.auth = { token: 'redacted', clientId: 'adapter', scopes: ['write'], sourceId: 'other' };
    await expect(op.handler(wrongSource, params)).rejects.toMatchObject({ code: 'permission_denied' });

    const off = unsafeContext(true);
    off.sourceId = 'personal';
    off.auth = { token: 'redacted', clientId: 'adapter', scopes: ['write'], sourceId: 'personal' };
    off.engine = { getConfig: async () => null } as unknown as OperationContext['engine'];
    await expect(op.handler(off, params)).resolves.toEqual({ status: 'disabled', mode: 'off' });
  });
});
