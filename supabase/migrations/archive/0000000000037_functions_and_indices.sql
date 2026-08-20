-- Migration 0037: Functions & Indices
-- Consolidates all RPC helpers and idempotency/performance indices.
-- Supersedes migrations 0030 (admin RPC helpers), 0031 (wallet idempotency),
-- and 0032 (template use_count RPC).
-- All statements are idempotent — safe to re-run.

-- ── RPC: increment_wallet_field ───────────────────────────────────────────────
-- Atomically adds p_amount to either 'coins' or 'gems' on user_wallets.
-- Called by admin add_coins / add_gems actions. Fixes TOCTOU race vs
-- the old read-then-write pattern.
CREATE OR REPLACE FUNCTION public.increment_wallet_field(
  p_user_id uuid,
  p_field    text,
  p_amount   integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_field = 'coins' THEN
    UPDATE user_wallets
    SET coins      = coins + p_amount,
        updated_at = now()
    WHERE user_id = p_user_id;
  ELSIF p_field = 'gems' THEN
    UPDATE user_wallets
    SET gems       = gems + p_amount,
        updated_at = now()
    WHERE user_id = p_user_id;
  ELSE
    RAISE EXCEPTION 'increment_wallet_field: unknown field "%"', p_field;
  END IF;
END;
$$;

-- ── RPC: sum_wallet_balances ──────────────────────────────────────────────────
-- Returns platform-wide sum of coins and gems in a single aggregate.
-- Used by admin stats route instead of JS-side reduce over all wallet rows.
CREATE OR REPLACE FUNCTION public.sum_wallet_balances()
RETURNS TABLE(total_coins bigint, total_gems bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(coins), 0)::bigint AS total_coins,
    COALESCE(SUM(gems),  0)::bigint AS total_gems
  FROM user_wallets;
$$;

-- ── RPC: increment_template_use_count ────────────────────────────────────────
-- Atomic template use_count increment. Replaces the read-then-write TOCTOU
-- pattern in /api/templates/use.
CREATE OR REPLACE FUNCTION public.increment_template_use_count(p_template_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE prompt_templates
  SET use_count  = use_count + 1,
      updated_at = now()
  WHERE id = p_template_id;
$$;

-- ── RPC: match_memory_chunks ──────────────────────────────────────────────────
-- Semantic vector search over memory_chunks with optional source-type filter.
-- Included here so it's guaranteed present even on DBs that skipped migration 23.
CREATE OR REPLACE FUNCTION public.match_memory_chunks (
  query_embedding  vector(1536),
  match_threshold  float,
  match_count      int,
  p_project_id     uuid,
  p_source_types   text[] DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  content     text,
  source_type text,
  source_path text,
  similarity  float
)
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    mc.id,
    mc.content,
    mc.source_type,
    mc.source_path,
    1 - (mc.embedding <=> query_embedding) AS similarity
  FROM public.memory_chunks mc
  WHERE mc.project_id = p_project_id
    AND (mc.embedding <=> query_embedding) < 1 - match_threshold
    AND (p_source_types IS NULL OR mc.source_type = ANY(p_source_types))
  ORDER BY mc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ── Wallet idempotency indices ────────────────────────────────────────────────

-- Per-project reward idempotency (one award per user per project per event type)
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_project_reward_idempotency
  ON public.wallet_transactions (user_id, transaction_source, (metadata->>'referenceId'))
  WHERE transaction_source IN ('wizard_complete', 'first_agent_run')
    AND metadata->>'referenceId' IS NOT NULL
    AND metadata->>'referenceId' != '';

-- Daily reward idempotency (one award per user per UTC day per event type)
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_daily_reward_idempotency
  ON public.wallet_transactions (
    user_id,
    transaction_source,
    date_trunc('day', created_at AT TIME ZONE 'UTC')
  )
  WHERE transaction_source IN ('daily_login', 'save_context');

-- Refund idempotency (one refund per run_id)
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_refund_idempotency
  ON public.wallet_transactions (run_id, type)
  WHERE type = 'refund'
    AND run_id IS NOT NULL;

-- ── Additional performance indices ────────────────────────────────────────────

-- PAM summarisation — fast lookup of unsummarised threads per project
CREATE INDEX IF NOT EXISTS idx_pam_threads_summarised
  ON public.pam_threads(project_id, summarised) WHERE summarised = false;

-- provider_models — fast lookup for the model-guard check in agent/run and wizard/chat
CREATE INDEX IF NOT EXISTS idx_provider_models_enabled
  ON public.provider_models(provider, model_id) WHERE enabled = true;
