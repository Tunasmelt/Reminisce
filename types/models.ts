export interface ProviderModel {
  id: string // uuid
  provider: string
  model_id: string
  model_name: string
  label: string | null
  is_free: boolean
  enabled: boolean
  tier_required: 'free' | 'pro'
  cost_coins: number | null
  cost_gems: number | null
  context_window: number | null
  sort_order: number
  notes: string | null
  created_at: string
}

export type ModelTier = 'free' | 'pro'
