import { getServiceSupabase } from '@/lib/supabase'

// ─────────────────────────────────────────────────────────────────────────────
//  Model Registry — the single source of truth in code for provider_models.
//
//  Every consumer (agent/run gating, keys/models picker, wallet cost lookup,
//  ai-client rate limits) reads ModelDef objects from here instead of querying
//  provider_models directly. This kills the previous fragmentation where the
//  table was read in five places with three different cache strategies and two
//  different keys (some by model_id alone — which is NOT unique; uniqueness is
//  (provider, model_id) — causing silent mis-charges when two providers share a
//  model_id).
//
//  One cache, one owner, one invalidate(). Cache is process-local with a short
//  TTL; admin mutations call invalidate() to clear the serving instance, and
//  other warm instances converge within the TTL (acceptable for current scale —
//  a distributed cache would fully close the cross-instance gap).
// ─────────────────────────────────────────────────────────────────────────────

export type ModelDef = {
  id: string
  provider: string
  model_id: string
  model_name: string
  label: string | null
  is_free: boolean
  enabled: boolean
  visible: boolean
  tier_required: string
  cost_coins: number | null
  cost_gems: number | null
  context_window: number | null
  sort_order: number
  rate_limit_rpm: number
  rate_limit_rpd: number
}

const TTL_MS = 5 * 60 * 1000

let _cache: { data: ModelDef[]; expires: number } | null = null
// In-flight dedup: concurrent callers that find the cache stale share one DB hit.
let _refresh: Promise<ModelDef[]> | null = null

async function load(): Promise<ModelDef[]> {
  if (_cache && Date.now() < _cache.expires) return _cache.data
  if (!_refresh) {
    _refresh = (async () => {
      const sb = getServiceSupabase()
      const { data, error } = await sb
        .from('provider_models')
        .select(
          'id, provider, model_id, model_name, label, is_free, enabled, visible, ' +
          'tier_required, cost_coins, cost_gems, context_window, sort_order, ' +
          'rate_limit_rpm, rate_limit_rpd',
        )
        .order('sort_order', { ascending: true })
      if (error) {
        console.error('[model-registry] load error:', error.message)
        // Don't poison the cache with an empty set on a transient error —
        // return the previous data if we have it, else an empty list.
        return _cache?.data ?? []
      }
      // Cast via unknown: the generated Supabase types predate the `visible`
      // column (migration 0038), so the typed client widens this select to an
      // error type. The runtime shape is correct once the migration has run.
      const rows = (data ?? []) as unknown as ModelDef[]
      _cache = { data: rows, expires: Date.now() + TTL_MS }
      return rows
    })().finally(() => { _refresh = null })
  }
  return _refresh
}

/** All models, optionally filtered. Returns a copy-safe snapshot. */
export async function getModels(opts?: {
  enabledOnly?: boolean
  visibleOnly?: boolean
}): Promise<ModelDef[]> {
  let rows = await load()
  if (opts?.enabledOnly) rows = rows.filter(m => m.enabled)
  if (opts?.visibleOnly) rows = rows.filter(m => m.visible)
  return rows
}

/**
 * Resolve a single model by its authoritative key (provider, model_id).
 * Returns null if not found. Keying by both columns prevents the cross-provider
 * model_id collision the old `.find(r => r.model_id === model)` lookups had.
 */
export async function getModel(
  provider: string,
  modelId: string,
): Promise<ModelDef | null> {
  const rows = await load()
  return rows.find(m => m.provider === provider && m.model_id === modelId) ?? null
}

/**
 * Legacy-compatible lookup by model_id alone, for call sites that only have the
 * model string (no provider in scope). Prefer getModel(provider, modelId).
 * If multiple providers expose the same model_id this returns the first by
 * sort_order and logs a warning so the ambiguity is detectable.
 */
export async function getModelByIdLoose(modelId: string): Promise<ModelDef | null> {
  const rows = await load()
  const matches = rows.filter(m => m.model_id === modelId)
  if (matches.length > 1) {
    console.warn(
      `[model-registry] model_id "${modelId}" is offered by ${matches.length} ` +
      `providers; resolving to "${matches[0].provider}". Pass provider explicitly.`,
    )
  }
  return matches[0] ?? null
}

/** Clear the cache. Called after any admin mutation to provider_models. */
export function invalidate(): void {
  _cache = null
}
