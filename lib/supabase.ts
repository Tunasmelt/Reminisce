import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Browser client using anon key
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Server client using service role key (for API routes only)
export const getServiceSupabase = () => {
  return createClient(supabaseUrl, supabaseServiceRoleKey)
}

/**
 * Verifies that userId owns the project (via workspace ownership).
 * Use in any API route that calls getServiceSupabase() and accepts projectId.
 * Returns true if the user owns the project, false otherwise.
 */
export async function verifyProjectAccess(
  userId: string,
  projectId: string,
): Promise<boolean> {
  const sb = getServiceSupabase()

  // Check 1: user owns the workspace (head)
  const { data: ownerData } = await sb
    .from('projects')
    .select('id, workspaces!inner(owner_id)')
    .eq('id', projectId)
    .maybeSingle()

  if (ownerData) {
    const ownerId = (ownerData.workspaces as unknown as { owner_id: string }).owner_id
    if (ownerId === userId) return true
  }

  // Check 2: user is an accepted member of the project.
  // TM-3: Use maybeSingle() instead of single() — if a race condition or
  // manual data fix produced two accepted rows for the same user, single()
  // throws PGRST116 and the user is locked out. maybeSingle() returns the
  // first row and treats "multiple rows" as "access granted" (correct intent).
  const { data: memberData } = await sb
    .from('project_members')
    .select('id, role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('invite_status', 'accepted')
    .maybeSingle()

  return !!memberData
}

/**
 * Returns the user's role in a project.
 * TM-3: Uses maybeSingle() so a duplicate accepted row (from a race or data
 * anomaly) doesn't throw — the first row returned is used.
 * TM-13: Falls back to workspace-owner check when no project_members row exists.
 * verifyProjectAccess already has this fallback; without it here, the workspace
 * owner would receive role=null on routes that call getProjectRole (e.g. agent/run),
 * causing them to be treated as a non-member even though access was granted.
 */
export async function getProjectRole(
  userId: string,
  projectId: string,
): Promise<'head' | 'collaborator' | 'viewer' | null> {
  const sb = getServiceSupabase()
  const { data } = await sb
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('invite_status', 'accepted')
    .maybeSingle()

  if (data?.role) return data.role as 'head' | 'collaborator' | 'viewer'

  // TM-13: Workspace owner fallback — mirrors verifyProjectAccess logic.
  // A project owner may have no project_members row if the assign_project_head
  // trigger did not fire (pre-migration projects) or the row was accidentally
  // deleted. Treat workspace owner as 'head' in that case.
  const { data: projData } = await sb
    .from('projects')
    .select('workspaces!inner(owner_id)')
    .eq('id', projectId)
    .maybeSingle()

  if (projData) {
    type WorkspaceResult = { owner_id: string } | { owner_id: string }[]
    const ws = projData.workspaces as WorkspaceResult
    const ownerId = Array.isArray(ws) ? ws[0]?.owner_id : ws?.owner_id
    if (ownerId === userId) return 'head'
  }

  return null
}

/**
 * Checks if a user is banned. Call at the start of sensitive API routes.
 * Returns true if banned (caller should return 403).
 */
export async function isUserBanned(userId: string): Promise<boolean> {
  const sb = getServiceSupabase()
  const { data } = await sb
    .from('user_plans')
    .select('banned_at')
    .eq('user_id', userId)
    .single()
  return !!data?.banned_at
}


