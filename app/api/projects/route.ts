import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, isUserBanned } from '@/lib/supabase'
import { canCreateProject } from '@/lib/wallet'

// PR-1: valid values for created_via — must match the DB CHECK constraint
const VALID_CREATED_VIA = new Set(['wizard', 'blank', 'import'])
// PR-4: cap project name length to avoid DB varchar overflow and UI issues
const MAX_PROJECT_NAME_LENGTH = 120

export const dynamic = 'force-dynamic'

// ─── GET /api/projects ────────────────────────────────────────────────────────
// Returns all projects belonging to the current user's owned workspaces.
// Uses service role to bypass RLS — eliminates ghost-project / project_members
// sync issues permanently.
export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)
    if (!user || authError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // PR-6: banned check on list
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    const supabase = getServiceSupabase()

    // Fetch all projects where the user owns the workspace
    const { data: projects, error: projErr } = await supabase
      .from('projects')
      .select('*, workspaces!inner(id, name, owner_id)')
      .eq('workspaces.owner_id', user.id)
      .order('created_at', { ascending: false })

    if (projErr) throw projErr

    // Also fetch projects where user is an accepted member (shared projects)
    const { data: memberProjects } = await supabase
      .from('project_members')
      .select('project_id, role, projects!inner(*, workspaces(id, name))')
      .eq('user_id', user.id)
      .eq('invite_status', 'accepted')

    // Merge owned + shared, de-duplicate by id
    const ownedIds = new Set((projects ?? []).map((p: Record<string, unknown>) => p.id as string))
    const sharedList = (memberProjects ?? [])
      .map((m: Record<string, unknown>) => m.projects as Record<string, unknown>)
      .filter((p): p is Record<string, unknown> => !!p && !ownedIds.has(p.id as string))

    // Normalize workspaces field to { name } to match client-side shape
    const normalize = (p: Record<string, unknown>) => {
      const ws = p.workspaces as Record<string, unknown> | null
      return { ...p, workspaces: ws ? { name: ws.name } : null }
    }

    const all = [...(projects ?? []).map(normalize), ...sharedList.map(normalize)]

    return NextResponse.json({ projects: all })
  } catch (err: unknown) {
    console.error('[projects] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── POST /api/projects ───────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)
    if (!user || authError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // PR-2: banned check — prevent banned users from creating projects
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // Check project limit
    const check = await canCreateProject(user.id)
    if (!check.allowed) {
      return NextResponse.json(
        { error: check.reason, code: 'PROJECT_LIMIT_REACHED', current: check.current, limit: check.limit },
        { status: 403 }
      )
    }

    // PR-3: parse body with try/catch so bad JSON returns 400 not 500
    let body: {
      name?: string
      description?: string
      workspaceId?: string
      repoUrl?: string
      techStack?: string[]
      created_via?: string
    }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { name, description, workspaceId, repoUrl, techStack, created_via } = body
    if (!name || !workspaceId) return NextResponse.json({ error: 'Missing name or workspaceId' }, { status: 400 })

    // PR-4: cap project name length
    if (name.length > MAX_PROJECT_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or fewer` },
        { status: 400 },
      )
    }

    // PR-1: validate and use the caller-supplied created_via, defaulting to 'blank'
    // Callers: dashboard new-project button → 'blank', wizard → 'wizard', import → 'import'
    const resolvedCreatedVia = VALID_CREATED_VIA.has(created_via ?? '')
      ? (created_via as 'wizard' | 'blank' | 'import')
      : 'blank'

    const supabase = getServiceSupabase()

    // Verify workspace ownership
    const { data: ws, error: wsErr } = await supabase
      .from('workspaces').select('id, owner_id').eq('id', workspaceId).single()
    if (wsErr || !ws) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    if (ws.owner_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Insert project
    const { data: project, error: projErr } = await supabase
      .from('projects')
      .insert({
        workspace_id: workspaceId,
        name,
        description:  description || null,
        repo_url:     repoUrl     || null,
        tech_stack:   techStack   || [],
        created_via:  resolvedCreatedVia,
      })
      .select()
      .single()

    if (projErr || !project) throw projErr ?? new Error('Project insert returned no data')

    // ── Belt-and-suspenders: explicitly insert head member row ────────────────
    // The DB trigger on_project_created uses auth.uid() which is NULL when
    // called via service role. We insert manually to ensure RLS SELECT works.
    const { error: memberErr } = await supabase
      .from('project_members')
      .upsert(
        { project_id: project.id, user_id: user.id, role: 'head' },
        { onConflict: 'project_id,user_id', ignoreDuplicates: true }
      )

    if (memberErr) {
      // Non-fatal — log and continue. The trigger may have succeeded.
      console.warn('[projects] project_members upsert failed (trigger may have handled it):', memberErr.message)
    }

    return NextResponse.json({ project })
  } catch (err: unknown) {
    console.error('[projects] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
