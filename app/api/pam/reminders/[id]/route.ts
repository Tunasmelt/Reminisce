import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// PATCH /api/pam/reminders/[id]
// Marks a reminder as done or updates its text/due_date.
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

    const body = await req.json()
    const supabase = getServiceSupabase()

    // Verify ownership
    const { data: existing } = await supabase
      .from('project_reminders')
      .select('user_id')
      .eq('id', params.id)
      .single()

    if (!existing || existing.user_id !== user.id)
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const updateFields: Record<string, unknown> = {}
    // P-13: Map request body fields to the actual DB column names used by
    // GET (message, remind_at, notified) — the original code used 'text',
    // 'done', and 'due_date' which are different columns (or non-existent),
    // making PATCH edits invisible to the read path.
    if (typeof body.notified === 'boolean') updateFields.notified  = body.notified
    if (typeof body.done     === 'boolean') updateFields.notified  = body.done      // alias for convenience
    if (typeof body.text     === 'string')  updateFields.message   = body.text
    if (typeof body.message  === 'string')  updateFields.message   = body.message   // also accept direct field name
    if ('due_date' in body)                 updateFields.remind_at = body.due_date
    if ('remind_at' in body)                updateFields.remind_at = body.remind_at  // also accept direct field name

    const { error } = await supabase
      .from('project_reminders')
      .update(updateFields)
      .eq('id', params.id)
      .eq('user_id', user.id)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    console.error('[pam/reminders/[id]] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE /api/pam/reminders/[id]
export async function DELETE(
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

    const supabase = getServiceSupabase()

    // P-14: Verify existence before deleting — Supabase returns no error when
    // 0 rows are affected, so without this check a missing or already-deleted
    // reminder silently returns ok:true instead of a proper 404.
    const { data: existing } = await supabase
      .from('project_reminders')
      .select('user_id')
      .eq('id', params.id)
      .single()

    if (!existing || existing.user_id !== user.id)
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { error } = await supabase
      .from('project_reminders')
      .delete()
      .eq('id', params.id)
      .eq('user_id', user.id)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    console.error('[pam/reminders/[id]] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
