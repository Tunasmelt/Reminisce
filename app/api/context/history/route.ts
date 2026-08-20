import { NextResponse } from 'next/server'
import { getServiceSupabase, verifyProjectAccess, isUserBanned } from '@/lib/supabase'
import { authenticateRequest } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const { user, errorResponse } = await authenticateRequest(req)
    if (errorResponse) return errorResponse

    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId')
    const filePath = searchParams.get('filePath')

    if (!projectId || !filePath) {
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
    }

    // CT-2: banned check
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    if (!await verifyProjectAccess(user.id, projectId))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const supabase = getServiceSupabase()

    // Find the current context record
    const { data: context, error: contextErr } = await supabase
      .from('contexts')
      .select('*')
      .eq('project_id', projectId)
      .eq('file_path', filePath)
      .maybeSingle()

    if (contextErr) throw contextErr

    if (!context) {
      return NextResponse.json({ versions: [], currentVersion: 0 })
    }

    // Get recent versions — metadata + diff only, no full content per row.
    // CE-7: Cap at 50 most-recent — an unbounded query on a busy file returns
    //   hundreds of rows (each with a diff string), easily hitting megabytes.
    // CE-8: select id/diff/changed_at only — full content snapshots per version
    //   are not needed for diff display and multiply the response size by the
    //   file length × version count. Load full content on demand if required.
    const { data: versions, error: versionErr } = await supabase
      .from('context_versions')
      .select('id, diff, changed_at')
      .eq('context_id', context.id)
      .order('changed_at', { ascending: false })
      .limit(50)

    if (versionErr) throw versionErr

    return NextResponse.json({ versions, currentVersion: context.version })

  } catch (error: unknown) {
    console.error('[context/history] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
