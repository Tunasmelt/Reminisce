-- Migration 0039: Model registry rehaul (live-verified, May 2026)
-- Supersedes 0036. Every model_id below was verified against the provider's LIVE
-- /models catalogue via scripts/verify-models.mjs on 2026-05-31. Dead IDs are
-- disabled; new working free models added; retired pro models replaced.
-- Idempotent — safe to re-run.

-- ── Step 1: Disable IDs that are no longer in the provider catalogue ──────────
UPDATE public.provider_models SET enabled = false WHERE
  (provider = 'groq' AND model_id IN (
    'meta-llama/llama-4-maverick-17b-128e-instruct', -- removed from Groq
    'moonshotai/kimi-k2-instruct'                    -- removed from Groq
  ))
  OR (provider = 'cerebras' AND model_id IN (
    'llama3.1-8b', 'llama3.3-70b', 'llama-4-scout-17b-16e-instruct' -- Cerebras dropped Llama; only gpt-oss-120b + zai-glm remain
  ))
  OR (provider = 'sambanova' AND model_id IN (
    'DeepSeek-R1-Distill-Llama-70B'                  -- no longer served
  ))
  OR (provider = 'openrouter' AND model_id IN (
    'meta-llama/llama-4-maverick:free',
    'deepseek/deepseek-chat-v3.1:free',
    'deepseek/deepseek-r1:free',
    'qwen/qwen3-235b-a22b:free',
    'google/gemma-3-12b-it:free'                     -- all 5 free routes retired
  ))
  OR (provider = 'anthropic' AND model_id IN (
    'claude-3-5-haiku-20241022',
    'claude-3-5-sonnet-20241022'                     -- Claude 3.5 series retired
  ));

-- ── Step 1b: Disable OpenAI on the platform — the platform OPENAI_API_KEY is
-- invalid (verified 401). Re-enable these once a valid key is configured; they
-- still work for BYOK users only when re-enabled. Left disabled to avoid serving
-- non-BYOK users a model that always errors.
UPDATE public.provider_models SET enabled = false WHERE provider = 'openai';

-- ── Step 2: Upsert the verified working set ──────────────────────────────────
INSERT INTO public.provider_models
  (provider, model_id, model_name, label, is_free, enabled, visible, tier_required,
   cost_coins, cost_gems, context_window, sort_order, rate_limit_rpm, rate_limit_rpd)
VALUES
  -- ── Groq (free, LPU — verified) ───────────────────────────────────────────
  ('groq','llama-3.1-8b-instant',                      'Llama 3.1 8B',   'Llama 3.1 8B (Groq)',     true,true,true,'free',1,NULL,131072, 1,30,14400),
  ('groq','llama-3.3-70b-versatile',                   'Llama 3.3 70B',  'Llama 3.3 70B (Groq)',    true,true,true,'free',2,NULL,131072, 2,30,14400),
  ('groq','meta-llama/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout',  'Llama 4 Scout ⚡',        true,true,true,'free',2,NULL,131072, 3,30,14400),
  ('groq','qwen/qwen3-32b',                            'Qwen3 32B',      'Qwen3 32B (Groq)',        true,true,true,'free',2,NULL,131072, 4,30,14400),
  ('groq','openai/gpt-oss-120b',                       'GPT-OSS 120B',   'GPT-OSS 120B (Groq)',     true,true,true,'free',3,NULL,131072, 5,30,14400), -- NEW
  ('groq','openai/gpt-oss-20b',                        'GPT-OSS 20B',    'GPT-OSS 20B (Groq) ⚡',   true,true,true,'free',2,NULL,131072, 6,30,14400), -- NEW

  -- ── Cerebras (free, fastest — only 2 chat models remain) ──────────────────
  ('cerebras','gpt-oss-120b', 'GPT-OSS 120B','GPT-OSS 120B (Cerebras) ⚡',true,true,true,'free',3,NULL,131072,11,30,14400),
  ('cerebras','zai-glm-4.7',  'GLM 4.7',     'GLM 4.7 (Cerebras) ⚡',     true,true,true,'free',3,NULL,131072,12,30,14400), -- NEW (replaces dropped Llamas)

  -- ── SambaNova (free, RDU — verified) ──────────────────────────────────────
  ('sambanova','Meta-Llama-3.3-70B-Instruct',       'Llama 3.3 70B',   'Llama 3.3 70B (SN)',    true,true,true,'free',2,NULL,131072,21,10,1000),
  ('sambanova','Llama-4-Maverick-17B-128E-Instruct','Llama 4 Maverick','Llama 4 Maverick (SN)', true,true,true,'free',3,NULL,131072,22,10,1000),
  ('sambanova','DeepSeek-V3.2',                     'DeepSeek V3.2',   'DeepSeek V3.2 (SN)',    true,true,true,'free',3,NULL, 65536,23,10,1000),
  ('sambanova','DeepSeek-V3.1',                     'DeepSeek V3.1',   'DeepSeek V3.1 (SN)',    true,true,true,'free',3,NULL, 65536,24,10,1000), -- NEW (replaces dead R1-Distill)
  ('sambanova','gpt-oss-120b',                      'GPT-OSS 120B',    'GPT-OSS 120B (SN)',     true,true,true,'free',3,NULL,131072,25,10,1000), -- NEW

  -- ── OpenRouter (free :free routes — verified live) ────────────────────────
  ('openrouter','meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B','Llama 3.3 70B (OR)',         true,true,true,'free',2,NULL,131072, 31,20,9999),
  ('openrouter','openai/gpt-oss-120b:free',               'GPT-OSS 120B', 'GPT-OSS 120B (OR)',          true,true,true,'free',2,NULL,131072, 32,20,9999), -- NEW
  ('openrouter','qwen/qwen3-coder:free',                  'Qwen3 Coder',  'Qwen3 Coder (OR) — 1M ctx',  true,true,true,'free',2,NULL,1048576,33,20,9999), -- NEW (coding)
  ('openrouter','qwen/qwen3-next-80b-a3b-instruct:free',  'Qwen3 Next 80B','Qwen3 Next 80B (OR)',       true,true,true,'free',2,NULL,262144, 34,20,9999), -- NEW
  ('openrouter','z-ai/glm-4.5-air:free',                  'GLM 4.5 Air',  'GLM 4.5 Air (OR)',           true,true,true,'free',2,NULL,131072, 35,20,9999), -- NEW
  ('openrouter','google/gemma-4-31b-it:free',             'Gemma 4 31B',  'Gemma 4 31B (OR)',           true,true,true,'free',1,NULL,262144, 36,20,9999), -- NEW (replaces dead gemma-3-12b)

  -- ── Gemini (free quota — verified) ────────────────────────────────────────
  ('gemini','gemini-2.0-flash',      'Gemini 2.0 Flash',     'Gemini 2.0 Flash',      true,true,true,'free',1,NULL,1000000,41,15,1500),
  ('gemini','gemini-2.5-flash',      'Gemini 2.5 Flash',     'Gemini 2.5 Flash',      true,true,true,'free',2,NULL,1000000,42,15,1500),
  ('gemini','gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite','Gemini 2.5 Flash Lite ⚡',true,true,true,'free',1,NULL,1000000,43,15,1500), -- NEW

  -- ── Anthropic (pro — gems, verified) ──────────────────────────────────────
  ('anthropic','claude-haiku-4-5-20251001',  'Claude Haiku 4.5', 'Claude Haiku 4.5 ⚡',false,true,true,'pro',NULL, 3,200000,101,5,200),
  ('anthropic','claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5','Claude Sonnet 4.5', false,true,true,'pro',NULL, 6,200000,102,5,200), -- NEW (replaces 3.5 sonnet)
  ('anthropic','claude-sonnet-4-20250514',   'Claude Sonnet 4',  'Claude Sonnet 4',   false,true,true,'pro',NULL, 6,200000,103,5,200),
  ('anthropic','claude-opus-4-5-20251101',   'Claude Opus 4.5',  'Claude Opus 4.5 (BEST)',false,true,true,'pro',NULL,10,200000,104,5,200), -- NEW (flagship)

  -- ── Gemini (pro — gems) ───────────────────────────────────────────────────
  ('gemini','gemini-2.5-pro','Gemini 2.5 Pro','Gemini 2.5 Pro (1M ctx)',false,true,true,'pro',NULL,5,1000000,111,5,200),

  -- ── Mistral (pro — gems, verified) ────────────────────────────────────────
  ('mistral','codestral-latest',    'Codestral',    'Codestral (Code)',false,true,true,'pro',NULL,4,256000,131,5,200),
  ('mistral','mistral-small-latest','Mistral Small','Mistral Small',   false,true,true,'pro',NULL,3,131072,132,5,200),
  ('mistral','mistral-large-latest','Mistral Large','Mistral Large',   false,true,true,'pro',NULL,6,131072,133,5,200),

  -- ── Kimi / Moonshot (pro — gems, NEW provider seeding, key verified) ──────
  ('kimi','kimi-k2.6', 'Kimi K2.6','Kimi K2.6',false,true,true,'pro',NULL,4,262144,141,5,200), -- NEW

  -- ── MiniMax (pro — gems, NEW provider seeding, key verified) ──────────────
  ('minimax','MiniMax-M2.7','MiniMax M2.7','MiniMax M2.7',false,true,true,'pro',NULL,3,200000,151,5,200) -- NEW

ON CONFLICT (provider, model_id) DO UPDATE SET
  model_name     = EXCLUDED.model_name,
  label          = EXCLUDED.label,
  is_free        = EXCLUDED.is_free,
  enabled        = EXCLUDED.enabled,
  visible        = EXCLUDED.visible,
  tier_required  = EXCLUDED.tier_required,
  cost_coins     = EXCLUDED.cost_coins,
  cost_gems      = EXCLUDED.cost_gems,
  context_window = EXCLUDED.context_window,
  sort_order     = EXCLUDED.sort_order,
  rate_limit_rpm = EXCLUDED.rate_limit_rpm,
  rate_limit_rpd = EXCLUDED.rate_limit_rpd;
