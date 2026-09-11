import type { Recipe } from '../types.ts';

/**
 * Z.AI's ordinary paid OpenAI-compatible API.
 * Pricing verified 2026-09-01: https://docs.z.ai/guides/overview/pricing
 */
export const zai: Recipe = {
  id: 'zai',
  name: 'Z.AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.z.ai/api/paas/v4',
  auth_env: {
    required: ['ZAI_API_KEY'],
    setup_url: 'https://docs.z.ai/guides/overview/quick-start',
  },
  touchpoints: {
    chat: {
      models: ['glm-5.2'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: true,
      thinking_by_default: true,
      max_context_tokens: 1_000_000,
      cost_per_1m_input_usd: 1.4,
      cost_per_1m_output_usd: 4.4,
      price_last_verified: '2026-09-01',
    },
  },
  setup_hint: 'Get a Z.AI API key, export ZAI_API_KEY=..., and use zai:glm-5.2.',
};
