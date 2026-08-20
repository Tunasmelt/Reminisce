/**
 * Shared constants used across multiple API routes.
 * Import from here rather than duplicating values inline.
 */

// K-3: Canonical set of provider names. Must match the values stored in
// user_api_keys and recognised by lib/ai-client.ts BYOK resolution.
// Referenced by: app/api/keys/save/route.ts, app/api/keys/delete/route.ts
export const ALLOWED_PROVIDERS = new Set([
  'groq', 'cerebras', 'sambanova', 'gemini', 'mistral',
  'anthropic', 'openai', 'kimi', 'minimax', 'openrouter',
])
