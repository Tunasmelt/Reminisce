import type { ModelDef } from '@/lib/model-registry'

// ─────────────────────────────────────────────────────────────────────────────
//  Model permission resolver — the SINGLE place that decides whether a given
//  user may run a given model. Previously this logic was scattered across three
//  layers: agent/run checked `enabled`, wallet.deductCost checked tier, and
//  ai-client checked rate limits — so policy changes meant editing three files
//  and the BYOK-bypasses-tier behaviour was an accidental side-effect of *where*
//  the check happened rather than a stated rule.
//
//  This function is pure (no I/O): callers resolve the ModelDef from the registry
//  and the user's plan/BYOK status, then ask here. Rate limiting remains separate
//  (it's time-windowed I/O), but the eligibility decision lives here.
// ─────────────────────────────────────────────────────────────────────────────

export type ModelPermissionContext = {
  /** The user's subscription plan. */
  plan: 'free' | 'pro'
  /** True if the user supplies their own API key for this provider (BYOK). */
  isBYOK: boolean
}

export type ModelPermissionResult =
  | { ok: true; model: ModelDef }
  | { ok: false; status: 400 | 403; reason: string }

/**
 * Decide whether `ctx` may run `model`.
 *
 * Policy:
 *  - Unknown / disabled model → 400 (not available to anyone).
 *  - Pro-tier model + free plan + NOT BYOK → 403 (upgrade required).
 *  - BYOK explicitly bypasses tier gating: a user supplying their own key pays
 *    the provider directly, so the subscription tier is not a gate for them.
 *    (Documented here on purpose, rather than being implicit in call ordering.)
 *
 * Note: `visible` is intentionally NOT checked here — it only governs whether a
 * model appears in the picker UI, not whether an authorized caller may execute
 * it. Execution eligibility is `enabled` + tier.
 */
export function canUseModel(
  ctx: ModelPermissionContext,
  model: ModelDef | null,
): ModelPermissionResult {
  if (!model || !model.enabled) {
    return {
      ok: false,
      status: 400,
      reason: 'Selected model is not available. Please choose a different model.',
    }
  }

  const isProTier = model.tier_required === 'pro' || !model.is_free

  if (isProTier && ctx.plan !== 'pro' && !ctx.isBYOK) {
    const name = model.label || model.model_name || model.model_id
    return {
      ok: false,
      status: 403,
      reason: `${name} requires a Pro subscription. Upgrade to use premium models, or add your own API key.`,
    }
  }

  return { ok: true, model }
}
