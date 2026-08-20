import { getServiceSupabase } from '@/lib/supabase'
import { getModel, getModelByIdLoose } from '@/lib/model-registry'

// ─── MODEL COSTS ──────────────────────────────
// Cost/tier are derived from the model-registry (the single provider_models
// reader — one cache, one owner). Lookups prefer the authoritative key
// (provider, model_id); callers that don't have the provider in scope fall back
// to a model_id-only lookup that warns on cross-provider ambiguity.

// ── E-22: Process-local daily-reset memo ───────────────────────────────────
// Tracks the UTC date (YYYY-MM-DD) on which applyDailyReset last confirmed a
// reset (or that today's reset already ran) for each userId. When 50 rapid
// wizard messages hit the same warm serverless function instance, only the
// FIRST call does the DB round-trip; the rest short-circuit here.
//
// This is process-local — each serverless function instance has its own copy.
// The memo is automatically valid only for today: the date string changes at
// UTC midnight, automatically expiring stale entries.
const _resetMemo = new Map<string, string>() // userId → 'YYYY-MM-DD'

export async function getModelCostInfo(
  model: string,
  provider?: string,
): Promise<{
  currency: 'coins' | 'gems'
  amount: number
  tier: 'free' | 'pro'
}> {
  const row = provider
    ? await getModel(provider, model)
    : await getModelByIdLoose(model)
  if (!row) {
    // E-10: Unknown model — warn so mis-spellings/disabled models are detectable
    console.warn(`[wallet] getModelCostInfo: model "${model}" not found in provider_models — charging 1 coin as fallback`)
    return { currency: 'coins', amount: 1, tier: 'free' }
  }
  const isPro = row.tier_required === 'pro' || !row.is_free
  if (!isPro) {
    return { currency: 'coins', amount: row.cost_coins ?? 1, tier: 'free' }
  }
  return { currency: 'gems', amount: row.cost_gems ?? 3, tier: 'pro' }
}

// ─── PLAN HELPERS ─────────────────────────────

export type UserPlan = {
  plan: 'free' | 'pro'
  status: string
  projects_limit: number
}

export async function getUserPlan(
  userId: string
): Promise<UserPlan> {
  const supabase = getServiceSupabase()
  const { data } = await supabase
    .from('user_plans')
    .select('plan, status, projects_limit')
    .eq('user_id', userId)
    .single()
  if (!data) {
    // E-9: Missing plan row means handle_new_user trigger didn't fire (rare).
    // Defaulting to free so the user isn't silently blocked. Warn so it's
    // visible in server logs — the user may actually be Pro.
    console.warn(`[wallet] getUserPlan: no user_plans row for ${userId} — defaulting to free`)
  }
  return data || { plan: 'free', status: 'active', projects_limit: 2 }
}

export async function canCreateProject(
  userId: string
): Promise<{ 
  allowed: boolean
  reason?: string
  current: number
  limit: number
}> {
  const supabase = getServiceSupabase()
  
  // Count projects where the user is the owner of the workspace
  const { count: projCount } = await supabase
    .from('projects')
    .select(`
      id,
      workspaces!inner(owner_id)
    `, { count: 'exact', head: true })
    .eq('workspaces.owner_id', userId)

  const plan = await getUserPlan(userId)
  const current = projCount || 0
  const limit = plan.projects_limit

  if (current >= limit) {
    return {
      allowed: false,
      reason: plan.plan === 'free'
        ? `Free tier allows ${limit} projects. Upgrade to Pro for unlimited projects.`
        : `You've reached your project limit of ${limit}.`,
      current,
      limit,
    }
  }
  return { allowed: true, current, limit }
}

// ─── WALLET HELPERS ───────────────────────────

export type Wallet = {
  gems: number
  coins: number
  coins_last_reset: string | null
  daily_coins_limit: number
  max_coins_banked: number
}

export async function getWallet(
  userId: string
): Promise<Wallet> {
  const supabase = getServiceSupabase()
  const { data } = await supabase
    .from('user_wallets')
    .select('gems, coins, coins_last_reset, daily_coins_limit, max_coins_banked')
    .eq('user_id', userId)
    .single()
  return data || { 
    gems: 0, 
    coins: 50, 
    coins_last_reset: null,
    daily_coins_limit: 50,
    max_coins_banked: 200,
  }
}

/**
 * Ensures a wallet row exists for the given user.
 * W-6: Uses ignoreDuplicates: true — this function is CREATE-only, not UPDATE.
 * If a wallet row already exists the upsert is a no-op regardless of the
 * `plan` argument. Do NOT call this to upgrade an existing user's limits;
 * use a direct UPDATE on user_wallets (as admin upgrade_pro / downgrade_free do).
 */
export async function ensureWallet(
  userId: string,
  plan: 'free' | 'pro' = 'free'
): Promise<void> {
  const supabase = getServiceSupabase()
  const isProPlan = plan === 'pro'
  await supabase
    .from('user_wallets')
    .upsert({
      user_id: userId,
      gems: 0,
      coins: isProPlan ? 200 : 50,
      daily_coins_limit: isProPlan ? 200 : 50,
      max_coins_banked: isProPlan ? 500 : 200,
      gems_monthly_grant: isProPlan ? 100 : 0,
    }, {
      onConflict: 'user_id',
      ignoreDuplicates: true,  // intentional: only creates, never overwrites existing limits
    })
}

// ─── RESET TIME HELPERS ───────────────────────────
/** Returns a human-readable string for how long until
 *  the next UTC midnight coin reset.
 *  e.g. "in 3h 42m" | "in 45m" | "in less than a minute"
 */
export function getTimeUntilUTCReset(): string {
  const now = new Date()
  const nextMidnightUTC = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1, // next day
      0, 0, 0, 0,
    ),
  )
  const msLeft = nextMidnightUTC.getTime() - now.getTime()
  if (msLeft <= 60_000) return 'in less than a minute'
  const totalMinutes = Math.floor(msLeft / 60_000)
  const hours   = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `in ${minutes}m`
  if (minutes === 0) return `in ${hours}h`
  return `in ${hours}h ${minutes}m`
}

// Check and apply daily reset if needed
export async function applyDailyReset(
  userId: string
): Promise<void> {
  const now = new Date()
  const todayKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`

  // W-7: Prune stale memo entries at midnight boundary to prevent unbounded
  // growth within a long-lived serverless instance. Entries from previous days
  // are safe to evict — the todayKey has changed, so they'll be re-evaluated.
  if (_resetMemo.size > 500) {
    for (const [uid, date] of Array.from(_resetMemo.entries())) {
      if (date !== todayKey) _resetMemo.delete(uid)
    }
  }

  // E-22: Process-local fast path — skip DB entirely if this instance already
  // confirmed today's reset for this user.
  if (_resetMemo.get(userId) === todayKey) return

  const supabase = getServiceSupabase()
  const wallet = await getWallet(userId)

  const lastReset = wallet.coins_last_reset
    ? new Date(wallet.coins_last_reset)
    : new Date(0)

  const todayUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )

  // Fast path: already reset today — memo and skip the DB write entirely
  if (lastReset >= todayUTC) {
    _resetMemo.set(userId, todayKey)
    return
  }

  // E-21: Warn when a misconfigured daily_limit exceeds max_coins_banked.
  // The cap below is still applied correctly, but the discrepancy means the
  // user's reset won't reach their intended daily limit — visible in logs.
  if (wallet.daily_coins_limit > wallet.max_coins_banked) {
    console.warn(
      `[wallet] applyDailyReset: daily_coins_limit (${wallet.daily_coins_limit}) > max_coins_banked (${wallet.max_coins_banked}) for user ${userId} — reset will be capped at max_coins_banked`
    )
  }
  const newCoins = Math.max(wallet.coins, wallet.daily_coins_limit)
  const capped   = Math.min(newCoins, wallet.max_coins_banked)
  const todayISO = todayUTC.toISOString()

  // ── E-2: Atomic reset via DB-level filter ────────────────────────────────
  // The UPDATE only fires if coins_last_reset is still before today at write
  // time. Two concurrent requests that both pass the fast-path check above
  // will race on this UPDATE; only the first will match the filter and win.
  // The second sees 0 rows returned and stops — preventing a double grant.
  const { data: resetResult } = await supabase
    .from('user_wallets')
    .update({
      coins:            capped,
      coins_last_reset: now.toISOString(),
      updated_at:       now.toISOString(),
    })
    .eq('user_id', userId)
    .or(`coins_last_reset.is.null,coins_last_reset.lt.${todayISO}`)
    .select('id')

  if (!resetResult || resetResult.length === 0) {
    // Lost the race to another concurrent request — memo today so we stop retrying
    _resetMemo.set(userId, todayKey)
    return
  }
  // Won the race — memo today's date so subsequent calls skip the DB entirely
  _resetMemo.set(userId, todayKey)

  // Log the reset only when coins actually increased
  if (capped - wallet.coins > 0) {
    // E-17: Check the insert result so a log failure surfaces in server logs.
    const { error: txErr } = await supabase
      .from('wallet_transactions')
      .insert({
        user_id:            userId,
        type:               'credit',
        amount:             capped - wallet.coins,
        currency:           'coins',
        description:        'Daily coin reset',
        transaction_source: 'daily_reset',
      })
    if (txErr) {
      console.error('[wallet] applyDailyReset: transaction log insert failed (reset still applied):', txErr.message)
    }
  }
}

// ─── COST DEDUCTION ───────────────────────────

export async function deductCost(
  userId: string,
  model: string,
  runId?: string,
  provider?: string,
): Promise<{
  success: boolean
  message?: string
  currency?: string
  amount?: number
}> {
  // Apply daily reset before checking balance
  await applyDailyReset(userId)

  const cost = await getModelCostInfo(model, provider)

  // Check if user is allowed to use gem models
  if (cost.tier === 'pro') {
    const plan = await getUserPlan(userId)
    if (plan.plan !== 'pro') {
      return {
        success: false,
        message: `${model.split('/').pop()} requires a Pro subscription. Upgrade to use premium models.`,
      }
    }
  }

  const supabase = getServiceSupabase()
  const costField = cost.currency === 'gems' ? 'gems' : 'coins'
  const now = new Date().toISOString()

  // ── E-1: Atomic deduction via optimistic locking ──────────────────────────
  // Read the current balance for the snapshot, then UPDATE only if the balance
  // is still that exact value at write time. If a concurrent request already
  // deducted, the WHERE coins = snapshot fails → 0 rows → we retry once with
  // a fresh read. This prevents two concurrent calls from both passing a
  // balance check and both deducting, which would send the balance negative.
  for (let attempt = 0; attempt < 2; attempt++) {
    const wallet = await getWallet(userId)
    const balance = cost.currency === 'gems' ? wallet.gems : wallet.coins

    if (balance < cost.amount) {
      const msg = cost.currency === 'gems'
        ? `Not enough gems. You have ${wallet.gems} gems. Pro subscribers receive 100 gems/month.`
        : `Not enough coins. You have ${wallet.coins} coins. Your daily allowance resets ${getTimeUntilUTCReset()} (midnight UTC). Note: individual AI provider quotas may reset at different times.`
      return { success: false, message: msg }
    }

    const updateField = cost.currency === 'gems'
      ? { gems: balance - cost.amount, updated_at: now }
      : { coins: balance - cost.amount, updated_at: now }

    // Optimistic lock: only commit if balance hasn't changed since we read it.
    const { data: updated } = await supabase
      .from('user_wallets')
      .update(updateField)
      .eq('user_id', userId)
      .eq(costField, balance)   // guard: only update if snapshot still matches
      .select('id')

    if (updated && updated.length > 0) {
      // Deduction succeeded — log the transaction
      // E-15: Check the insert result so a log failure surfaces in server logs
      // rather than silently breaking the audit trail.
      const { error: txErr } = await supabase
        .from('wallet_transactions')
        .insert({
          user_id:            userId,
          type:               'debit',
          amount:             -cost.amount,
          currency:           cost.currency,
          model_used:         model,
          run_id:             runId || null,
          description:        `Agent run: ${model}`,
          transaction_source: 'run',
        })
      if (txErr) {
        console.error('[wallet] deductCost: transaction log insert failed (deduction still applied):', txErr.message)
      }
      return { success: true, currency: cost.currency, amount: cost.amount }
    }
    // Concurrent modification — retry once with a fresh balance read
  }

  // Both attempts lost the optimistic lock — re-read for accurate error message
  const finalWallet = await getWallet(userId)
  const finalBalance = cost.currency === 'gems' ? finalWallet.gems : finalWallet.coins
  if (finalBalance < cost.amount) {
    const msg = cost.currency === 'gems'
      ? `Not enough gems. You have ${finalWallet.gems} gems. Pro subscribers receive 100 gems/month.`
      : `Not enough coins. You have ${finalWallet.coins} coins. Your daily allowance resets ${getTimeUntilUTCReset()} (midnight UTC).`
    return { success: false, message: msg }
  }
  // Extremely rare: lost both attempts but balance is sufficient — fail safe
  return { success: false, message: 'Wallet update conflict. Please try again.' }
}

// ─── REFUND ───────────────────────────────────

export async function refundCost(
  userId: string,
  model: string,
  runId?: string,
  provider?: string,
): Promise<void> {
  // W-9: The unique constraint on wallet_transactions (run_id, type='refund')
  // is the idempotency sentinel for this function. In PostgreSQL, NULL values
  // are never considered equal in a unique index — so (NULL, 'refund') is
  // distinct from every other (NULL, 'refund') row. This means every call
  // without a runId bypasses the duplicate guard and creates a new refund row,
  // potentially crediting the user multiple times.
  //
  // If runId is missing, generate a stable synthetic key from userId + model +
  // the current minute so that rapid retries within the same minute are
  // deduplicated, but a genuinely new charge in the next minute can still be
  // refunded. This is imperfect (two distinct charges in the same minute on the
  // same model for the same user would deduplicate), but is far safer than the
  // unlimited-duplicate behaviour of null.
  const effectiveRunId = runId || `synthetic-${userId}-${model}-${Math.floor(Date.now() / 60_000)}`

  const attemptRefund = async () => {
    const cost = await getModelCostInfo(model, provider)
    if (!cost) return
    const supabase = getServiceSupabase()
    const now = new Date().toISOString()

    // W-2 + W-3: Flip order — insert the transaction log row FIRST so it acts
    // as the atomic idempotency sentinel. The unique index on (run_id, type='refund')
    // ensures only one concurrent call can insert; the second gets a conflict error
    // (code 23505) and aborts before touching the wallet. This closes the TOCTOU
    // gap that existed when the count-check and wallet-update were separate steps.
    const { error: txErr } = await supabase
      .from('wallet_transactions')
      .insert({
        user_id:            userId,
        type:               'refund',
        amount:             cost.amount,
        currency:           cost.currency,
        model_used:         model,
        run_id:             effectiveRunId,
        description:        'Refund: run failed',
        transaction_source: 'refund',
      })

    if (txErr) {
      // Unique constraint violation — already refunded for this runId, skip.
      if (txErr.code === '23505') {
        console.warn('[wallet] refundCost: duplicate refund attempt blocked for runId', effectiveRunId)
        return
      }
      // Other DB error — log and let the retry handler deal with it.
      console.error('[wallet] refundCost: transaction log insert failed:', txErr.message)
      throw new Error(txErr.message)
    }

    // W-3: Optimistic locking on wallet update — mirrors deductCost's 2-attempt
    // pattern. Prevents a concurrent deduction from being silently overwritten
    // by a plain read-then-write refund.
    const costField = cost.currency === 'gems' ? 'gems' : 'coins'
    for (let attempt = 0; attempt < 2; attempt++) {
      const wallet = await getWallet(userId)
      const currentBalance = cost.currency === 'gems' ? wallet.gems : wallet.coins

      const updateField = cost.currency === 'gems'
        ? { gems: currentBalance + cost.amount, updated_at: now }
        : { coins: Math.min(currentBalance + cost.amount, wallet.max_coins_banked), updated_at: now }

      const { data: updated } = await supabase
        .from('user_wallets')
        .update(updateField)
        .eq('user_id', userId)
        .eq(costField, currentBalance)   // optimistic lock: only commit if balance unchanged
        .select('id')

      if (updated && updated.length > 0) return  // succeeded
      // Lost the lock to a concurrent write — retry once with a fresh read
    }

    // Both attempts lost the optimistic lock — log and let caller retry.
    console.error('[wallet] refundCost: optimistic lock failed after 2 attempts for user', userId)
    throw new Error('Wallet update conflict during refund')
  }

  // Attempt once, then retry once after a short delay before giving up.
  // Prevents a momentary Supabase timeout from permanently losing the refund.
  try {
    await attemptRefund()
  } catch (firstErr) {
    console.warn('[wallet] refundCost first attempt failed, retrying...', firstErr)
    try {
      await new Promise(r => setTimeout(r, 1500))
      await attemptRefund()
    } catch (secondErr) {
      console.error('[wallet] refundCost failed after retry — coin lost:', secondErr)
    }
  }
}

// ─── COIN REWARDS ─────────────────────────────

export type RewardEvent = 
  | 'wizard_complete'  // +25 coins, once per project
  | 'first_agent_run'  // +15 coins, once per project
  | 'daily_login'      // +10 coins, once per day
  | 'save_context'     // +5 coins, once per day

export async function awardCoins(
  userId: string,
  event: RewardEvent,
  referenceId?: string // projectId for per-project events
): Promise<{ awarded: boolean; amount: number }> {
  // E-18: Wallet update and transaction log are separated into two independent
  // steps so a log insert failure doesn't falsely report { awarded: false }
  // when coins were already credited to the wallet.
  try {
    const supabase = getServiceSupabase()

    const REWARDS: Record<RewardEvent, number> = {
      wizard_complete: 25,
      first_agent_run: 15,
      daily_login:     10,
      save_context:     5,
    }

    const amount = REWARDS[event]

    // ── W-1: Flip order — insert the transaction log FIRST as the idempotency
    // sentinel. The unique indices on wallet_transactions ensure only one
    // concurrent call can insert for the same (user, event, referenceId/day).
    // The second concurrent call hits a unique constraint violation (code 23505)
    // and returns {awarded: false} immediately — before any wallet update.
    // This closes the TOCTOU gap where both concurrent calls passed the old
    // count-check before either inserted the log row.
    const { error: txErr } = await supabase
      .from('wallet_transactions')
      .insert({
        user_id:            userId,
        type:               'credit',
        amount,
        currency:           'coins',
        description:        `Reward: ${event.replace(/_/g, ' ')}`,
        transaction_source: event,
        metadata:           { referenceId: referenceId || '' },
      })

    if (txErr) {
      if (txErr.code === '23505') {
        // Unique constraint hit — reward already granted, skip silently.
        return { awarded: false, amount: 0 }
      }
      console.warn('[wallet] awardCoins: transaction log insert failed:', txErr.message)
      return { awarded: false, amount: 0 }
    }

    // ── W-4: Optimistic locking on wallet credit — mirrors deductCost's
    // 2-attempt pattern. Prevents concurrent awards for different events
    // (e.g. daily_login + save_context firing simultaneously) from racing
    // on the balance update and silently losing one increment.
    let awarded = false
    for (let attempt = 0; attempt < 2; attempt++) {
      const wallet   = await getWallet(userId)
      const newCoins = Math.min(wallet.coins + amount, wallet.max_coins_banked)

      const { data: updated } = await supabase
        .from('user_wallets')
        .update({ coins: newCoins, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('coins', wallet.coins)   // optimistic lock: only commit if balance unchanged
        .select('id')

      if (updated && updated.length > 0) { awarded = true; break }
      // Concurrent modification — retry once with fresh balance read
    }

    if (!awarded) {
      // Both attempts lost the lock — coins are slightly delayed but the
      // transaction log row already exists so no double-award is possible.
      // W-8: Return awarded:false so callers know the wallet update failed,
      // even though the transaction log sentinel was inserted. The transaction
      // log prevents any retry from double-crediting — coins are permanently
      // undelivered if both lock attempts fail, which is acceptable at scale.
      console.warn('[wallet] awardCoins: optimistic lock failed after 2 attempts for user', userId, event)
    }

    return { awarded, amount }
  } catch (err) {
    console.warn('[wallet] awardCoins failed:', err)
    return { awarded: false, amount: 0 }
  }
}
