import { NextResponse } from 'next/server'
import { supabase as clientSupabase } from '@/lib/supabase'
import { getModels } from '@/lib/model-registry'

export const dynamic = 'force-dynamic'

// GET /api/keys/models — the model picker list for the agent + wizard UIs.
// Returns models that are BOTH enabled (globally usable) and visible (shown in
// the picker). Tier filtering (free vs pro) is applied client-side from the
// `free` flag. Now requires auth — both callers already send a Bearer token —
// so the catalogue isn't exposed to anonymous requests.
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

    // Single source of truth — the model registry. enabled && visible.
    const rows = await getModels({ enabledOnly: true, visibleOnly: true })
    // Preserve the previous ordering: free models first, then by sort_order.
    const sorted = [...rows].sort((a, b) => {
      if (a.is_free !== b.is_free) return a.is_free ? -1 : 1
      return a.sort_order - b.sort_order
    })

    const models = sorted.map(m => ({
      provider: m.provider,
      model:    m.model_id,
      label:    m.label || m.model_name,
      free:     m.is_free,
    }))

    return NextResponse.json({ models })
  } catch (error: unknown) {
    console.error('[keys/models] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
