import { NextResponse } from 'next/server'
import { supabase as clientSupabase, getServiceSupabase, isUserBanned } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// POST /api/team/invite
// Body: { projectId, email, role: 'collaborator' | 'viewer' }
// Invites a user by email. If they have an account, creates accepted member row.
// If not, creates pending row with invite_email set.
export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authErr } = await clientSupabase.auth.getUser(token)
  if (!user || authErr) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let projectId: string | undefined
  let email: string | undefined
  let role: string | undefined
  try {
    const body = await req.json()
    projectId = body.projectId
    email     = body.email
    role      = body.role
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!projectId || !email || !role)
    return NextResponse.json({ error: 'Missing projectId, email, or role' }, { status: 400 })

  if (!['collaborator', 'viewer'].includes(role))
    return NextResponse.json({ error: 'Role must be collaborator or viewer' }, { status: 400 })

  const emailLower = email.toLowerCase().trim()

  // TM-14 (low): basic format guard
  if (!emailLower.includes('@'))
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })

  const sb = getServiceSupabase()

  // TM-9: Banned heads must not be able to send invites.
  if (await isUserBanned(user.id))
    return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

  // Verify caller is head — maybeSingle() avoids throwing on 0 rows
  const { data: callerMember } = await sb
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .eq('invite_status', 'accepted')
    .maybeSingle()

  // Fallback: check workspace ownership for pre-migration projects
  let isHead = callerMember?.role === 'head'
  if (!isHead) {
    const { data: projData } = await sb
      .from('projects')
      .select('workspaces!inner(owner_id)')
      .eq('id', projectId)
      .maybeSingle()

    type WorkspaceResult = { owner_id: string } | { owner_id: string }[]
    const ws = projData?.workspaces as WorkspaceResult | undefined
    const ownerId = Array.isArray(ws) ? ws[0]?.owner_id : ws?.owner_id

    if (ownerId === user.id) {
      await sb.from('project_members').upsert({
        project_id: projectId,
        user_id: user.id,
        role: 'head',
        invite_status: 'accepted',
      }, { onConflict: 'project_id,user_id' })
      isHead = true
    }
  }

  if (!isHead)
    return NextResponse.json({ error: 'Only the project head can invite members' }, { status: 403 })

  // Check current member count (excluding declined)
  const { count: currentCount } = await sb
    .from('project_members')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .neq('invite_status', 'declined')

  if ((currentCount ?? 0) >= 8)
    return NextResponse.json({ error: 'Team is at the 8-member limit. Remove a member first.' }, { status: 400 })

  // Use paginated search to find user by email
  let invitee: { id: string; email: string } | null = null
  let page = 1
  let keepSearching = true

  while (keepSearching) {
    const { data: batch } = await sb.auth.admin.listUsers({ perPage: 100, page })
    if (!batch?.users || batch.users.length === 0) { keepSearching = false; break }

    const found = batch.users.find(u => u.email?.toLowerCase() === emailLower)
    if (found) { invitee = { id: found.id, email: found.email ?? '' }; keepSearching = false }
    else if (batch.users.length < 100) keepSearching = false
    else page++
    if (page > 50) keepSearching = false
  }

  if (invitee) {
    // TM-1: Prevent a head from inviting themselves. The upsert would silently
    // overwrite their own role from 'head' to 'collaborator'/'viewer', locking
    // them out of all head-only operations.
    if (invitee.id === user.id)
      return NextResponse.json({ error: 'You cannot invite yourself' }, { status: 400 })

    // User exists — check their current membership status
    const { data: existing } = await sb
      .from('project_members')
      .select('id, invite_status, role')
      .eq('project_id', projectId)
      .eq('user_id', invitee.id)
      .maybeSingle()

    if (existing) {
      if (existing.invite_status === 'accepted')
        return NextResponse.json({ error: 'User is already a member' }, { status: 400 })

      if (existing.invite_status === 'declined') {
        // TM-5: A declined invite previously blocked all future re-invites with
        // no escape hatch. The head should be able to re-invite someone who
        // declined (e.g. they changed their mind). Update the existing row
        // rather than inserting a duplicate.
        const { error } = await sb
          .from('project_members')
          .update({ role, invite_status: 'accepted', invited_by: user.id, invite_email: emailLower })
          .eq('id', existing.id)
        if (error) {
          console.error('[team/invite] re-add declined member error:', error)
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
        }
        return NextResponse.json({ ok: true, status: 'readded', email: emailLower })
      }
      // 'pending' status: allow re-sending (upsert will update role if needed)
    }

    const { error } = await sb
      .from('project_members')
      .upsert({
        project_id:    projectId,
        user_id:       invitee.id,
        role,
        invite_status: 'accepted',
        invite_email:  emailLower,
        invited_by:    user.id,
      }, { onConflict: 'project_id,user_id' })

    // TM-4: The enforce_member_limit() DB trigger fires synchronously on insert.
    // If the count raced past 8 between our check and the insert, the trigger
    // raises an exception (Postgres P0001). Detect this and return 400 rather
    // than propagating a 500 to the client.
    if (error) {
      if (error.code === 'P0001' || error.message?.toLowerCase().includes('limit')) {
        return NextResponse.json({ error: 'Team is at the 8-member limit. Remove a member first.' }, { status: 400 })
      }
      console.error('[team/invite] upsert member error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, status: 'added', email: emailLower })
  } else {
    // User doesn't exist yet — check for existing pending invite with this email
    const { data: existingPending } = await sb
      .from('project_members')
      .select('id')
      .eq('project_id', projectId)
      .eq('invite_email', emailLower)
      .eq('invite_status', 'pending')
      .maybeSingle()

    if (existingPending)
      return NextResponse.json({ error: 'An invite has already been sent to this email.' }, { status: 400 })

    const { error } = await sb
      .from('project_members')
      .insert({
        project_id:    projectId,
        user_id:       null,
        role,
        invite_status: 'pending',
        invite_email:  emailLower,
        invited_by:    user.id,
      })

    // TM-4: same trigger guard for the pending insert path.
    if (error) {
      if (error.code === 'P0001' || error.message?.toLowerCase().includes('limit')) {
        return NextResponse.json({ error: 'Team is at the 8-member limit. Remove a member first.' }, { status: 400 })
      }
      console.error('[team/invite] insert pending error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    return NextResponse.json({
      ok: true,
      status: 'pending',
      email: emailLower,
      note: 'User does not have a Reminisce account yet. They must sign up with this email to join.',
    })
  }
}
