import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, isUserBanned } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// ── Shared ownership check ────────────────────────────────────────────────────
async function verifyThreadOwnership(
  threadId: string,
  userId: string,
  supabase: ReturnType<typeof getServiceSupabase>
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const { data: thread, error } = await supabase
    .from('pam_threads')
    .select('id, user_id')
    .eq('id', threadId)
    .single()

  if (error || !thread) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Thread not found' }, { status: 404 }),
    }
  }

  if (thread.user_id !== userId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    }
  }

  return { ok: true }
}

// GET /api/pam/thread/[id]
// Returns all messages in a thread in ascending order.
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } =
      await clientSupabase.auth.getUser(token)
    if (!user || authError)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    const supabase = getServiceSupabase()

    // ── Ownership check ────────────────────────────────────────────────────
    const check = await verifyThreadOwnership(params.id, user.id, supabase)
    if (!check.ok) return check.response

    const { data: messages, error } = await supabase
      .from('pam_messages')
      .select('id, role, content, model_used, tokens_used, action_type, action_payload, action_confirmed, created_at')
      .eq('thread_id', params.id)
      .order('created_at', { ascending: true })

    if (error) throw error
    return NextResponse.json({ messages })
  } catch (err: unknown) {
    console.error('[pam/thread] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PATCH /api/pam/thread/[id]
// Updates thread title (user rename) or archives it.
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } =
      await clientSupabase.auth.getUser(token)
    if (!user || authError)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    const supabase = getServiceSupabase()

    // ── Ownership check ────────────────────────────────────────────────────
    const check = await verifyThreadOwnership(params.id, user.id, supabase)
    if (!check.ok) return check.response

    let body: { title?: string; archived?: boolean }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const updateFields: Record<string, unknown> = {}
    if (typeof body.title === 'string') {
      // P-20: Reject empty strings — the DB trigger auto-titles at 60 chars
      // but manual renames have no guard, so "" would blank the title.
      if (body.title.trim().length === 0)
        return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 })
      // P-12: Cap manual titles at 100 chars to match auto-title intent and
      // prevent DB column overflow / UI layout breakage from unbounded input.
      updateFields.title = body.title.trim().slice(0, 100)
    }
    if (typeof body.archived === 'boolean') updateFields.archived = body.archived

    if (Object.keys(updateFields).length === 0)
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })

    const { error } = await supabase
      .from('pam_threads')
      .update(updateFields)
      .eq('id', params.id)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    console.error('[pam/thread] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
