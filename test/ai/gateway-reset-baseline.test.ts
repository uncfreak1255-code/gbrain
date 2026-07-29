/**
 * resetGateway() must restore the process-wide test embedding baseline so
 * cross-file shard ordering cannot silently change the PGLite vector width.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setChatTransportForTests,
  __unconfigureGatewayForTests,
  configureGateway,
  getEmbeddingDimensions,
  getEmbeddingModel,
  isAvailable,
  resetGateway,
} from '../../src/core/ai/gateway.ts';

afterEach(() => resetGateway());

describe('resetGateway test baseline', () => {
  test('reset restores the preload OpenAI/1536 baseline', () => {
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: {},
    });
    resetGateway();
    expect(getEmbeddingModel()).toBe('openai:text-embedding-3-large');
    expect(getEmbeddingDimensions()).toBe(1536);
  });

  test('reset clears transports while hard-unconfigure remains available', () => {
    __setChatTransportForTests(async () => {
      throw new Error('stale test transport');
    });
    resetGateway();
    __unconfigureGatewayForTests();
    expect(isAvailable('chat')).toBe(false);
    expect(() => getEmbeddingDimensions()).toThrow(/not configured/);
  });
});
