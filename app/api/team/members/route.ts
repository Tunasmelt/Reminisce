import { NextResponse } from 'next/server'
import { supabase as clientSupabase, getServiceSupabase, verifyProjectAccess } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

type ServiceClient = ReturnType<typeof getServiceSupabase>

// GET /api/team/members?projectId=xxx
// Returns all accepted + pending members with their emails
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authErr } = await clientSupabase.auth.getUser(token)
  if (!user || authErr) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')
  if (!projectId) return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })

  if (!await verifyProjectAccess(user.id, projectId))
    return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const sb = getServiceSupabase()

  const { data: members, error } = await sb
    .from('project_members')
    .select('id, user_id, role, invite_status, invite_email, created_at, invited_by')
    .eq('project_id', projectId)
    .neq('invite_status', 'declined')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[team/members GET] query error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  // Build email map via paginated scan — same pattern as invite route
  const userIds = new Set(
    (members || [])
      .filter(m => m.user_id && m.invite_status === 'accepted')
      .map(m => m.user_id as string)
  )

  const emailMap: Record<string, string> = {}
  if (userIds.size > 0) {
    for (let page = 1; page <= 50; page++) {
      const { data: batch } = await sb.auth.admin.listUsers({ perPage: 100, page })
      if (!batch?.users || batch.users.length === 0) break
      batch.users.forEach(u => {
        if (userIds.has(u.id)) emailMap[u.id] = u.email ?? ''
      })
      // TM-11: Break immediately once every target ID is resolved — avoids
      // scanning additional pages when all members' emails are already found.
      if (Object.keys(emailMap).length === userIds.size) break
      if (batch.users.length < 100) break
    }
  }

  const result = (members || []).map(m => ({
    ...m,
    email: m.user_id ? (emailMap[m.user_id] ?? m.invite_email ?? '') : m.invite_email,
  }))

  return NextResponse.json({ members: result })
}

// DELETE /api/team/members?projectId=xxx&userId=xxx   (accepted members — by user_id)
// DELETE /api/team/members?projectId=xxx&memberId=xxx  (pending invites — by row id)
// Removes a member or cancels a pending invite. Only head can do this.
export async function DELETE(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authErr } = await clientSupabase.auth.getUser(token)
  if (!user || authErr) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')
  const targetUserId = searchParams.get('userId')
  const targetMemberId = searchParams.get('memberId')

  if (!projectId || (!targetUserId && !targetMemberId))
    return NextResponse.json({ error: 'Missing params: provide userId or memberId' }, { status: 400 })

  const sb = getServiceSupabase()

  const isHead = await resolveIsHead(sb, projectId, user.id)
  if (!isHead)
    return NextResponse.json({ error: 'Only the project head can remove members' }, { status: 403 })

  if (targetUserId === user.id)
    return NextResponse.json({ error: 'Cannot remove yourself as head' }, { status: 400 })

  // TM-6: Prevent removing another head. A project with two head rows (possible
  // via the workspace-owner upsert fallback) could have one head delete the
  // other, leaving the project with no head and an unrecoverable owner.
  if (targetUserId) {
    const { data: targetMember } = await sb
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', targetUserId)
      .eq('invite_status', 'accepted')
      .maybeSingle()
    if (targetMember?.role === 'head')
      return NextResponse.json(
        { error: 'Cannot remove the project head. Transfer ownership first.' },
        { status: 400 },
      )
  }

  let deleteError
  if (targetMemberId) {
    // Remove by row id — covers pending invites (user_id = null)
    const res = await sb
      .from('project_members')
      .delete()
      .eq('id', targetMemberId)
      .eq('project_id', projectId)  // Scope to this project — prevents cross-project deletion
    deleteError = res.error
  } else {
    const res = await sb
      .from('project_members')
      .delete()
      .eq('project_id', projectId)
      .eq('user_id', targetUserId!)
    deleteError = res.error
  }

  if (deleteError) {
    console.error('[team/members DELETE] error:', deleteError)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

// PATCH /api/team/members
// Body: { projectId, userId, role: 'collaborator' | 'viewer' }
// Changes an accepted member's role. Head-only. Cannot change own role.
export async function PATCH(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authErr } = await clientSupabase.auth.getUser(token)
  if (!user || authErr) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let projectId: string | undefined
  let targetUserId: string | undefined
  let role: string | undefined
  try {
    const body = await req.json()
    projectId    = body.projectId
    targetUserId = body.userId
    role         = body.role
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!projectId || !targetUserId || !role)
    return NextResponse.json({ error: 'Missing projectId, userId, or role' }, { status: 400 })

  if (!['collaborator', 'viewer'].includes(role))
    return NextResponse.json({ error: 'Role must be collaborator or viewer' }, { status: 400 })

  if (targetUserId === user.id)
    return NextResponse.json({ error: 'Cannot change your own role' }, { status: 400 })

  const sb = getServiceSupabase()

  const isHead = await resolveIsHead(sb, projectId, user.id)
  if (!isHead)
    return NextResponse.json({ error: 'Only the project head can change roles' }, { status: 403 })

  // TM-7: Prevent demoting a head. verifyProjectAccess uses workspace ownership
  // as a fallback — demoting the workspace owner via project_members would make
  // getProjectRole return 'collaborator'/'viewer' while verifyProjectAccess still
  // passes, creating a split-brain where write routes reject the actual owner.
  const { data: targetMember } = await sb
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', targetUserId)
    .eq('invite_status', 'accepted')
    .maybeSingle()
  if (targetMember?.role === 'head')
    return NextResponse.json(
      { error: 'Cannot change the role of the project head.' },
      { status: 400 },
    )

  // Update and verify at least one row was affected — returns 404 if member not found
  const { data: updated, error } = await sb
    .from('project_members')
    .update({ role })
    .eq('project_id', projectId)
    .eq('user_id', targetUserId)
    .eq('invite_status', 'accepted')
    .select('id')

  if (error) {
    console.error('[team/members PATCH] update error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!updated || updated.length === 0)
    return NextResponse.json({ error: 'Member not found or not accepted' }, { status: 404 })

  // TM-16: If somehow duplicate accepted rows exist for this user (data anomaly),
  // all rows will have been updated — log it so ops can investigate. The update
  // itself is still correct (all copies now have the new role), so we return 200.
  if (updated.length > 1) {
    console.warn(
      `[team/members PATCH] TM-16: ${updated.length} accepted rows updated for user ${targetUserId} in project ${projectId} — duplicate rows detected`
    )
  }

  return NextResponse.json({ ok: true })
}

// ── Shared helper ─────────────────────────────────────────────────────────────
// Checks if userId is the head of projectId.
// Side effect: if the user is the workspace owner but has no head row (pre-migration),
// one is upserted so subsequent RLS-gated queries work correctly.
async function resolveIsHead(sb: ServiceClient, projectId: string, userId: string): Promise<boolean> {
  // Use maybeSingle() to avoid throwing when 0 rows found
  const { data: callerMember, error: memberErr } = await sb
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('invite_status', 'accepted')
    .maybeSingle()

  if (!memberErr && callerMember?.role === 'head') return true

  // Fallback: workspace owner check for pre-migration projects
  const { data: projData, error: projErr } = await sb
    .from('projects')
    .select('workspaces!inner(owner_id)')
    .eq('id', projectId)
    .maybeSingle()

  if (projErr || !projData) return false

  type WorkspaceResult = { owner_id: string } | { owner_id: string }[]
  const ws = projData.workspaces as WorkspaceResult
  const ownerId = Array.isArray(ws) ? ws[0]?.owner_id : ws?.owner_id

  if (ownerId === userId) {
    // Belt-and-suspenders: ensure head row exists so RLS SELECT works for this user
    await sb.from('project_members').upsert(
      { project_id: projectId, user_id: userId, role: 'head', invite_status: 'accepted' },
      { onConflict: 'project_id,user_id' }
    )
    return true
  }
  return false
}
