-- Migration 0038: Admin & model-management architecture hardening
-- Addresses the architecture review findings A1, A3, A4, A5, A8.
-- All statements are idempotent — safe to re-run.

-- ── A4: split global-usability (enabled) from picker-visibility (visible) ──────
-- `enabled` remains the global kill switch (gates execution + cost lookups).
-- `visible` controls whether a model appears in the PAM/agent model picker.
-- The admin "hide Pro models" toggle now flips `visible`, never `enabled`,
-- so hiding a model from the picker no longer makes it unusable platform-wide.
ALTER TABLE public.provider_models
  ADD COLUMN IF NOT EXISTS visible boolean NOT NULL DEFAULT true;

-- ── A1: keep audit logs when the referenced users are deleted ──────────────────
-- admin_id and target_user previously had no ON DELETE rule (RESTRICT), so any
-- user who ever appeared in an audit row could not be deleted — exactly the
-- accounts most likely to be deleted. Switch both to ON DELETE SET NULL and make
-- admin_id nullable so the log row survives the referenced user's deletion.
ALTER TABLE public.admin_logs ALTER COLUMN admin_id DROP NOT NULL;

ALTER TABLE public.admin_logs DROP CONSTRAINT IF EXISTS admin_logs_admin_id_fkey;
ALTER TABLE public.admin_logs
  ADD CONSTRAINT admin_logs_admin_id_fkey
  FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.admin_logs DROP CONSTRAINT IF EXISTS admin_logs_target_user_fkey;
ALTER TABLE public.admin_logs
  ADD CONSTRAINT admin_logs_target_user_fkey
  FOREIGN KEY (target_user) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── A3: rate limiting decoupled from the billing ledger ────────────────────────
-- Rate limits were previously derived by COUNT(*) over wallet_transactions, which
-- (a) double-counted refunds, (b) had an off-by-one from the request's own debit
-- row, and (c) gave BYOK users no limit at all (they write no transactions).
-- rate_events records one row per model call regardless of billing path.
CREATE TABLE IF NOT EXISTS public.rate_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model_id   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_events_user_model_time
  ON public.rate_events (user_id, model_id, created_at DESC);

ALTER TABLE public.rate_events ENABLE ROW LEVEL SECURITY;
-- Service-role only; no client policy (writes/reads happen via service key).

-- ── A5: atomic plan upgrade/downgrade ──────────────────────────────────────────
-- Updates user_plans AND user_wallets in a single transaction so the two tables
-- can never drift (the old route did two separate UPDATEs and only logged drift).
CREATE OR REPLACE FUNCTION public.admin_set_plan(
  p_user_id uuid,
  p_plan    text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_plan = 'pro' THEN
    UPDATE user_plans
       SET plan = 'pro', status = 'active', projects_limit = 999,
           updated_at = now()
     WHERE user_id = p_user_id;
    UPDATE user_wallets
       SET daily_coins_limit = 200, max_coins_banked = 500,
           gems_monthly_grant = 100, updated_at = now()
     WHERE user_id = p_user_id;
  ELSIF p_plan = 'free' THEN
    UPDATE user_plans
       SET plan = 'free', status = 'active', projects_limit = 2,
           stripe_subscription_id = NULL, updated_at = now()
     WHERE user_id = p_user_id;
    UPDATE user_wallets
       SET daily_coins_limit = 50, max_coins_banked = 200,
           gems_monthly_grant = 0, updated_at = now()
     WHERE user_id = p_user_id;
  ELSE
    RAISE EXCEPTION 'admin_set_plan: unknown plan "%"', p_plan;
  END IF;
END;
$$;

-- ── A1: atomic user deletion via cascade ───────────────────────────────────────
-- Every user-owned table cascades from auth.users (directly, or via
-- workspaces → projects). Deleting the auth row therefore removes ALL of the
-- user's data atomically. Replaces the old route's 6 sequential, non-transactional
-- manual deletes that ran BEFORE the (non-fatal) auth delete — an ordering that
-- could wipe a user's data while leaving them able to log in.
CREATE OR REPLACE FUNCTION public.admin_delete_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  DELETE FROM auth.users WHERE id = p_user_id;
END;
$$;
