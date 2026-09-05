// A failed configuration read must refuse inference rather than switch model or cap.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function captureChat(): { calls: ChatOpts[]; chat: (o: ChatOpts) => Promise<ChatResult> } {
  const calls: ChatOpts[] = [];
  return {
    calls,
    chat: async (o: ChatOpts) => {
      calls.push(o);
      return {
        text: '[]',
        blocks: [{ type: 'text', text: '[]' }],
        stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    },
  };
}

describe('extract_atoms configuration reads fail closed before paid work', () => {
  test('a throwing getConfig rejects before inference', async () => {
    const { calls, chat } = captureChat();
    // Wrap the real engine so every getConfig() throws, mirroring the
    // "on any config-read failure" scenario the try/catch is meant to
    // absorb, without hand-rolling a full BrainEngine stub.
    const throwingEngine = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'getConfig') {
          return async () => {
            throw new Error('simulated config-read failure');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(runPhaseExtractAtoms(throwingEngine as unknown as PGLiteEngine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/fail-soft.txt', content: 'hello world', contentHash: 'h1'.repeat(8) }],
      _pages: [],
      _chat: chat,
    })).rejects.toThrow('configuration unavailable');
    expect(calls).toHaveLength(0);
  });
});
