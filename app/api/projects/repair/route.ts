import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, isUserBanned } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// POST /api/projects/repair
// Heals orphaned project_members rows for the current user.
// Call this when a user owns workspaces with projects but can't see them
// (ghost-project symptom caused by the on_project_created trigger firing
// with auth.uid() = NULL under service role).
//
// Safe to call on every login / dashboard mount — upserts are idempotent.
export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)
    if (!user || authError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // PR-7: banned check — this endpoint is called on every login/dashboard mount;
    // skip entirely for suspended accounts to avoid unnecessary DB load
    if (await isUserBanned(user.id))
      return NextResponse.json({ repaired: 0 })

    const supabase = getServiceSupabase()

    // 1. Find all projects in workspaces this user owns
    const { data: ownedProjects, error: fetchErr } = await supabase
      .from('projects')
      .select('id, workspaces!inner(owner_id)')
      .eq('workspaces.owner_id', user.id)

    if (fetchErr) throw fetchErr

    if (!ownedProjects || ownedProjects.length === 0) {
      return NextResponse.json({ repaired: 0 })
    }

    // 2. Check which ones already have an accepted head row for this user
    const projectIds = ownedProjects.map(p => p.id)

    const { data: existingMembers } = await supabase
      .from('project_members')
      .select('project_id')
      .eq('user_id', user.id)
      .eq('role', 'head')
      .eq('invite_status', 'accepted')
      .in('project_id', projectIds)

    const alreadyHaveRow = new Set((existingMembers ?? []).map(m => m.project_id))
    const toRepair = projectIds.filter(id => !alreadyHaveRow.has(id))

    if (toRepair.length === 0) {
      return NextResponse.json({ repaired: 0 })
    }

    // 3. Upsert missing head rows
    const rows = toRepair.map(projectId => ({
      project_id: projectId,
      user_id: user.id,
      role: 'head',
      invite_status: 'accepted',
    }))

    const { error: upsertErr } = await supabase
      .from('project_members')
      .upsert(rows, { onConflict: 'project_id,user_id', ignoreDuplicates: false })

    if (upsertErr) throw upsertErr

    console.log(`[projects/repair] Repaired ${toRepair.length} project_members rows for user ${user.id}`)
    return NextResponse.json({ repaired: toRepair.length, projectIds: toRepair })
  } catch (err: unknown) {
    console.error('[projects/repair] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
