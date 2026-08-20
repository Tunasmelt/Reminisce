import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, verifyProjectAccess, isUserBanned } from '@/lib/supabase'

const VALID_TABS = new Set(['blueprint', 'custom', 'changelog'])

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } =
      await clientSupabase.auth.getUser(token)
    if (!user || authError)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // PL-1: banned check
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId')
    const rawTab    = searchParams.get('tab') ?? 'blueprint'

    // PL-2: reject unrecognised tab values — an unknown tab bypassed all filters
    // and returned every prompt row for the project
    const tab = VALID_TABS.has(rawTab) ? rawTab : 'blueprint'

    if (!projectId)
      return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })

    if (!await verifyProjectAccess(user.id, projectId))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const supabase = getServiceSupabase()

    // Blueprint tab: master + phase + feature prompts (wizard-generated)
    // Custom tab:    user-created prompts
    // Changelog tab: reads from contexts table directly
    if (tab === 'changelog') {
      const [{ data: agentRuns }, { data: changes }] = await Promise.all([
        supabase
          .from('contexts')
          .select('content, last_modified')
          .eq('project_id', projectId)
          .eq('file_path', 'reminisce/logs/agent-runs.md')
          .single(),
        supabase
          .from('contexts')
          .select('content, last_modified')
          .eq('project_id', projectId)
          .eq('file_path', 'reminisce/logs/changes.md')
          .single(),
      ])
      return NextResponse.json({
        agentRunsLog:  agentRuns?.content  ?? null,
        changesLog:    changes?.content    ?? null,
      })
    }

    // Blueprint prompts: master + PHASE_OVERVIEW + FEATURE_BUILD (wizard-generated)
    // Custom prompts:    everything user-created or PAM-generated
    const isBlueprintTab = tab === 'blueprint'

    let query = supabase
      .from('prompts')
      .select(`
        id,
        title,
        raw_prompt,
        structured_prompt,
        prompt_type,
        is_master_prompt,
        phase_id,
        feature_id,
        context_files,
        checklist,
        expected_output,
        model_suggested,
        run_count,
        last_used_at,
        created_at,
        updated_at,
        features (
          id,
          name,
          status,
          type,
          phases ( id, name )
        )
      `)
      .eq('project_id', projectId)

    if (isBlueprintTab) {
      // Blueprint tab: master prompt + wizard-generated phase + feature prompts
      query = query.in('prompt_type', ['MASTER', 'PHASE_OVERVIEW', 'FEATURE_BUILD'])
    } else {
      // Custom tab: user-created and PAM-generated prompts
      // Excludes MASTER and PHASE_OVERVIEW (those are wizard-owned)
      query = query
        .eq('is_master_prompt', false)
        .not('prompt_type', 'in', '("MASTER","PHASE_OVERVIEW")')
    }

    // Master always first, then by phase order, then creation date
    const { data: prompts, error } = await query
      .order('is_master_prompt', { ascending: false })
      .order('created_at', { ascending: true })

    if (error) throw error

    return NextResponse.json({ prompts: prompts ?? [] })
  } catch (error: unknown) {
    console.error('[prompts/list] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
