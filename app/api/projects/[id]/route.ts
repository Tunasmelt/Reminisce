import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, isUserBanned } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// ─── GET /api/projects/:id ────────────────────────────────────────────────────
// Returns project + phases + features + latest context_version for a project the
// current user owns or is a member of. Uses service role — bypasses RLS entirely
// so project detail pages never get "Query failure" due to missing project_members.
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)
    if (!user || authError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const projectId = params.id
    if (!projectId) return NextResponse.json({ error: 'Missing project id' }, { status: 400 })

    // PR-6: banned check on project detail view
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    const supabase = getServiceSupabase()

    // Verify access: user owns workspace OR is an accepted member
    const { data: project, error: projErr } = await supabase
      .from('projects')
      .select('*, workspaces!inner(id, name, owner_id)')
      .eq('id', projectId)
      .single()

    if (projErr || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const ws = project.workspaces as { owner_id: string }
    const isOwner = ws.owner_id === user.id

    if (!isOwner) {
      // Check membership
      const { data: member } = await supabase
        .from('project_members')
        .select('role')
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .eq('invite_status', 'accepted')
        .single()

      if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Fetch all related data in parallel
    const [
      { data: phases },
      { data: features },
      { data: ctxVersion },
      { count: contextCount },
    ] = await Promise.all([
      supabase.from('phases').select('*').eq('project_id', projectId).order('order_index', { ascending: true }),
      supabase.from('features').select('*, phases(name)').eq('project_id', projectId).order('created_at', { ascending: false }),
      supabase.from('context_versions').select('content').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('contexts').select('id', { count: 'exact', head: true }).eq('project_id', projectId),
    ])

    // PR-5: strip owner_id from workspace before returning — collaborators and
    // viewers must not see the workspace owner's UUID
    const safeProject = {
      ...project,
      workspaces: project.workspaces
        ? { id: (project.workspaces as Record<string, unknown>).id, name: (project.workspaces as Record<string, unknown>).name }
        : null,
    }

    return NextResponse.json({
      project: safeProject,
      phases: phases ?? [],
      features: features ?? [],
      contextDoc: ctxVersion?.content ?? '',
      hasBlueprint: (contextCount ?? 0) > 0,
    })
  } catch (err: unknown) {
    console.error('[projects/[id]] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── DELETE /api/projects/:id ─────────────────────────────────────────────────
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)
    if (!user || authError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const projectId = params.id
    if (!projectId) return NextResponse.json({ error: 'Missing project id' }, { status: 400 })

    // PR-3: banned check — prevent banned users from cascade-deleting their projects
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    const supabase = getServiceSupabase()

    // Verify the user owns the project (via workspace owner_id)
    const { data: project, error: projErr } = await supabase
      .from('projects')
      .select('id, workspace_id, workspaces!inner(owner_id)')
      .eq('id', projectId)
      .single()

    if (projErr || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Type assertion for nested join
    const workspaceOwnerId = (project as unknown as { workspaces: { owner_id: string } }).workspaces.owner_id
    if (workspaceOwnerId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Delete project — DB cascade handles: phases, features, agent_runs,
    // project_members, codebase_sessions, kanban_columns, kanban_cards, etc.
    const { error: deleteErr } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)

    if (deleteErr) throw deleteErr

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    console.error('[projects/[id]] DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
