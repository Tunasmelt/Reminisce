export interface Stats {
  users: { total: number; pro: number; free: number; banned: number; newToday: number }
  projects: { total: number; active: number }
  economy: { totalCoins: number; totalGems: number; transactionsToday: number }
  activity: { agentRunsToday: number; pamMessagesToday: number; wizardSessionsToday: number }
  recentSignups: Array<{ user_id: string; plan: string; created_at: string }>
  recentTransactions: Array<{ type: string; amount: number; currency: string; description: string; created_at: string }>
}

export interface AdminUser {
  id: string
  email: string
  created_at: string
  last_sign_in: string | null
  plan: string
  is_admin: boolean
  banned_at: string | null
  ban_reason: string | null
  projects_limit: number
  coins: number
  gems: number
  project_count?: number
}

export interface Model {
  id: string
  provider: string
  model_id: string
  label: string
  model_name: string
  is_free: boolean
  enabled: boolean
  visible: boolean
  tier_required: string
  cost_coins: number | null
  cost_gems: number | null
  context_window: number | null
  rate_limit_rpm: number | null
  rate_limit_rpd: number | null
  sort_order: number
  notes: string | null
}

export interface AuditLog {
  id: string
  admin_id: string
  action: string
  target_id: string | null
  target_type: string | null
  payload: Record<string, unknown>
  created_at: string
}
