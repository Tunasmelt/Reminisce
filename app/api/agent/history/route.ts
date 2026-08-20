import { NextResponse } from 'next/server'
import { getServiceSupabase, verifyProjectAccess } from '@/lib/supabase'
import { authenticateRequest } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const { user, errorResponse } = await authenticateRequest(req)
    if (errorResponse) return errorResponse

    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId')

    if (!projectId) {
      return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })
    }

    if (!await verifyProjectAccess(user.id, projectId))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // AR-15: Support cursor-based pagination so callers can load more than the
    // initial 20 rows. `offset` defaults to 0; the response includes `hasMore`
    // so the UI can decide whether to show a "Load more" button.
    const PAGE_SIZE = 20
    const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10))

    const supabase = getServiceSupabase()

    const { data: runs, error } = await supabase
      .from('agent_runs')
      .select(`
        *,
        features (
          name
        )
      `)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) throw error

    // AR-10: Normalise the nullable `features` join before returning. When a
    // feature is deleted its FK row is gone but agent_runs.feature_id is not
    // nulled (no SET NULL on delete). The join returns `features: null` for
    // these rows. Surface this as a flat `feature_name` string so the UI can
    // render "Deleted feature" rather than crashing on null?.name.
    const normalised = (runs ?? []).map(r => ({
      ...r,
      feature_name: (r.features as { name: string } | null)?.name ?? null,
    }))

    return NextResponse.json({
      runs: normalised,
      // AR-15: hasMore lets the UI know whether a "Load more" button should be shown.
      hasMore: normalised.length === PAGE_SIZE,
      offset,
    })

  } catch (error: unknown) {
    console.error('[agent/history] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
