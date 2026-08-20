import { getServiceSupabase } from '@/lib/supabase'

// ─────────────────────────────────────────────────────────────────────────────
//  Single audit-log writer for admin actions.
//
//  Previously every admin route hand-built an admin_logs insert, duplicating the
//  same object into BOTH `payload` and `details`, and into BOTH `target_id` and
//  `target_user`, then wrapped it in its own try/catch. This helper centralizes
//  that: writes one canonical shape, never throws (a log failure must not fail an
//  already-applied action), and deliberately does NOT populate the `target_user`
//  FK column — writing a FK to a just-deleted user would itself fail. The logs
//  GET route already coalesces target_id ?? target_user, so target_id (a plain
//  text column, no FK) is sufficient and delete-safe.
// ─────────────────────────────────────────────────────────────────────────────

export async function writeAuditLog(entry: {
  adminId: string
  action: string
  targetId?: string | null
  targetType?: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  try {
    const sb = getServiceSupabase()
    await sb.from('admin_logs').insert({
      admin_id:    entry.adminId,
      action:      entry.action,
      target_id:   entry.targetId ?? null,
      target_type: entry.targetType ?? null,
      // Both columns kept populated so the logs GET reader (payload ?? details)
      // works regardless of which generation of the schema it expects.
      payload:     entry.metadata ?? {},
      details:     entry.metadata ?? {},
    })
  } catch (err) {
    console.error('[admin-audit] log insert failed (action already applied):', err)
  }
}
