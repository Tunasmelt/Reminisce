-- Migration 0036: Models 2026
-- Self-contained model registry update for May 2026.
-- Supersedes migrations 0029 (rate_limit columns + initial seed) and
-- 0033 (reseed with 2026 IDs).
-- All statements are idempotent — safe to re-run.

-- ── Step 1: Ensure rate-limit columns exist ───────────────────────────────────
ALTER TABLE public.provider_models
  ADD COLUMN IF NOT EXISTS rate_limit_rpm  integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS rate_limit_rpd  integer NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS context_window  integer;

-- ── Step 2: Disable stale / broken model IDs ─────────────────────────────────
-- These model IDs no longer work with their respective provider APIs.
UPDATE public.provider_models SET enabled = false WHERE
  -- Groq: deprecated or wrong ID format
  (provider = 'groq' AND model_id IN (
    'meta-llama/llama-4-maverick',       -- old short form → use -17b-128e-instruct
    'moonshotai/kimi-k2',                -- old short form → use kimi-k2-instruct
    'qwen-qwen3-32b',                    -- wrong format → use qwen/qwen3-32b
    'mixtral-8x7b-32768',                -- deprecated Feb 2026
    'qwen-2.5-coder-32b',                -- no longer available
    'llama-3.2-3b-preview',              -- removed from Groq
    'gemma2-9b-it'                       -- removed from Groq
  ))
  OR
  -- Anthropic: IDs that were never valid
  (provider = 'anthropic' AND model_id IN (
    'claude-sonnet-4-6',                 -- hallucinated ID
    'claude-opus-4-5-20251101',          -- unverified
    'claude-haiku-4-5'                   -- missing date suffix
  ))
  OR
  -- Gemini: legacy 1.5 models (replaced by 2.x)
  (provider = 'gemini' AND model_id IN (
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro'
  ))
  OR
  -- Mistral: free 7B no longer offered via direct API
  (provider = 'mistral' AND model_id IN (
    'open-mistral-7b'
  ))
  OR
  -- OpenRouter: stale free-tier routes
  (provider = 'openrouter' AND model_id IN (
    'meta-llama/llama-3.1-8b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
    'qwen/qwen-2.5-72b-instruct:free'
  ));

-- ── Step 3: Upsert all verified 2026 models ──────────────────────────────────
INSERT INTO public.provider_models
  (provider, model_id, model_name, label, is_free, enabled, tier_required,
   cost_coins, cost_gems, sort_order, rate_limit_rpm, rate_limit_rpd)
VALUES
  -- ── Groq (free tier) ──────────────────────────────────────────────────────
  ('groq','llama-3.1-8b-instant',                          'Llama 3.1 8B',    'Llama 3.1 8B (Groq)',         true,true,'free',1,NULL, 1,30,14400),
  ('groq','llama-3.3-70b-versatile',                       'Llama 3.3 70B',   'Llama 3.3 70B (Groq)',        true,true,'free',2,NULL, 2,30,14400),
  ('groq','meta-llama/llama-4-scout-17b-16e-instruct',     'Llama 4 Scout',   'Llama 4 Scout ⚡',            true,true,'free',2,NULL, 3,30,14400),
  ('groq','meta-llama/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick','Llama 4 Maverick (Groq)',     true,true,'free',3,NULL, 4,30,14400),
  ('groq','moonshotai/kimi-k2-instruct',                   'Kimi K2',         'Kimi K2 (Groq)',              true,true,'free',3,NULL, 5,30,14400),
  ('groq','qwen/qwen3-32b',                                'Qwen3 32B',       'Qwen3 32B (Groq)',            true,true,'free',2,NULL, 6,30,14400),

  -- ── Cerebras (ultra-fast — free tier) ─────────────────────────────────────
  ('cerebras','llama3.1-8b',                    'Llama 3.1 8B', 'Llama 3.1 8B (Cerebras) ⚡', true,true,'free',1,NULL,11,30,14400),
  ('cerebras','llama3.3-70b',                   'Llama 3.3 70B','Llama 3.3 70B (Cerebras) ⚡',true,true,'free',2,NULL,12,30,14400),
  ('cerebras','llama-4-scout-17b-16e-instruct', 'Llama 4 Scout','Llama 4 Scout (Cerebras) ⚡',true,true,'free',2,NULL,13,30,14400),
  ('cerebras','gpt-oss-120b',                   'GPT-OSS 120B', 'GPT-OSS 120B (Cerebras) ⚡', true,true,'free',3,NULL,14,30,14400),

  -- ── SambaNova (free tier) ──────────────────────────────────────────────────
  ('sambanova','Meta-Llama-3.3-70B-Instruct',        'Llama 3.3 70B',      'Llama 3.3 70B (SN)',       true,true,'free',2,NULL,21,10,1000),
  ('sambanova','Llama-4-Maverick-17B-128E-Instruct',  'Llama 4 Maverick',   'Llama 4 Maverick (SN)',    true,true,'free',3,NULL,22,10,1000),
  ('sambanova','DeepSeek-V3.2',                       'DeepSeek V3.2',      'DeepSeek V3.2 (SN)',       true,true,'free',3,NULL,23,10,1000),
  ('sambanova','DeepSeek-R1-Distill-Llama-70B',       'DeepSeek R1 Distill','DeepSeek R1 Distill (SN)', true,true,'free',3,NULL,24,10,1000),

  -- ── OpenRouter (free :free suffix) ────────────────────────────────────────
  ('openrouter','meta-llama/llama-3.3-70b-instruct:free','Llama 3.3 70B',   'Llama 3.3 70B (OR)',   true,true,'free',2,NULL,31,20,9999),
  ('openrouter','meta-llama/llama-4-maverick:free',      'Llama 4 Maverick', 'Llama 4 Maverick (OR)',true,true,'free',2,NULL,32,20,9999),
  ('openrouter','deepseek/deepseek-chat-v3.1:free',      'DeepSeek V3.1',   'DeepSeek V3.1 (OR)',    true,true,'free',2,NULL,33,20,9999),
  ('openrouter','deepseek/deepseek-r1:free',             'DeepSeek R1',     'DeepSeek R1 (OR)',      true,true,'free',2,NULL,34,20,9999),
  ('openrouter','qwen/qwen3-235b-a22b:free',             'Qwen3 235B',      'Qwen3 235B (OR)',       true,true,'free',2,NULL,35,20,9999),
  ('openrouter','google/gemma-3-12b-it:free',            'Gemma 3 12B',     'Gemma 3 12B (OR)',      true,true,'free',1,NULL,36,20,9999),

  -- ── Gemini (free quota tier) ───────────────────────────────────────────────
  ('gemini','gemini-2.0-flash','Gemini 2.0 Flash','Gemini 2.0 Flash',true,true,'free',1,NULL,41,15,1500),
  ('gemini','gemini-2.5-flash','Gemini 2.5 Flash','Gemini 2.5 Flash',true,true,'free',2,NULL,42,15,1500),

  -- ── Anthropic (pro — gems) ────────────────────────────────────────────────
  ('anthropic','claude-haiku-4-5-20251001', 'Claude Haiku 4.5','Claude Haiku 4.5',   false,true,'pro',NULL,3,101,5,200),
  ('anthropic','claude-3-5-haiku-20241022', 'Claude 3.5 Haiku','Claude 3.5 Haiku ⚡',false,true,'pro',NULL,3,102,5,200),
  ('anthropic','claude-3-5-sonnet-20241022','Claude 3.5 Sonnet','Claude 3.5 Sonnet', false,true,'pro',NULL,5,103,5,200),
  ('anthropic','claude-sonnet-4-20250514',  'Claude Sonnet 4', 'Claude Sonnet 4',    false,true,'pro',NULL,6,104,5,200),

  -- ── Gemini (pro — gems) ───────────────────────────────────────────────────
  ('gemini','gemini-2.5-pro','Gemini 2.5 Pro','Gemini 2.5 Pro',false,true,'pro',NULL,5,111,5,200),

  -- ── OpenAI (pro — gems) ───────────────────────────────────────────────────
  ('openai','gpt-4o-mini','GPT-4o Mini','GPT-4o Mini ⚡',false,true,'pro',NULL,3,121,5,200),
  ('openai','gpt-4o',     'GPT-4o',    'GPT-4o',        false,true,'pro',NULL,6,122,5,200),
  ('openai','gpt-4.1',    'GPT-4.1',   'GPT-4.1',       false,true,'pro',NULL,6,123,5,200),

  -- ── Mistral (pro — gems) ──────────────────────────────────────────────────
  ('mistral','codestral-latest',    'Codestral',    'Codestral (Code)',false,true,'pro',NULL,4,131,5,200),
  ('mistral','mistral-small-latest','Mistral Small','Mistral Small',  false,true,'pro',NULL,3,132,5,200),
  ('mistral','mistral-large-latest','Mistral Large','Mistral Large',  false,true,'pro',NULL,6,133,5,200)

ON CONFLICT (provider, model_id) DO UPDATE SET
  model_name     = EXCLUDED.model_name,
  label          = EXCLUDED.label,
  is_free        = EXCLUDED.is_free,
  enabled        = EXCLUDED.enabled,
  tier_required  = EXCLUDED.tier_required,
  cost_coins     = EXCLUDED.cost_coins,
  cost_gems      = EXCLUDED.cost_gems,
  sort_order     = EXCLUDED.sort_order,
  rate_limit_rpm = EXCLUDED.rate_limit_rpm,
  rate_limit_rpd = EXCLUDED.rate_limit_rpd;

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT provider, model_id, enabled, tier_required, sort_order
FROM public.provider_models
ORDER BY sort_order;
