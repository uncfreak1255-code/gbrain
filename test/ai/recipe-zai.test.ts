import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: zai', () => {
  test('registers direct GLM-5.2 with bounded spend metadata', () => {
    const recipe = getRecipe('zai');
    expect(recipe).toBeDefined();
    expect(recipe!.implementation).toBe('openai-compatible');
    expect(recipe!.base_url_default).toBe('https://api.z.ai/api/paas/v4');
    expect(recipe!.auth_env?.required).toEqual(['ZAI_API_KEY']);
    expect(recipe!.touchpoints.chat).toMatchObject({
      models: ['glm-5.2'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: true,
      thinking_by_default: true,
      max_context_tokens: 1_000_000,
      cost_per_1m_input_usd: 1.4,
      cost_per_1m_output_usd: 4.4,
      price_last_verified: '2026-09-01',
    });
  });

  test('resolves ZAI_API_KEY as bearer auth and fails closed when absent', () => {
    const recipe = getRecipe('zai')!;
    expect(defaultResolveAuth(recipe, { ZAI_API_KEY: 'fake-zai-key' }, 'chat')).toEqual({
      headerName: 'Authorization',
      token: 'Bearer fake-zai-key',
    });
    expect(() => defaultResolveAuth(recipe, {}, 'chat')).toThrow(AIConfigError);
  });
});
