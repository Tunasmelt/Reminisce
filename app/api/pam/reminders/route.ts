import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, verifyProjectAccess } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// GET /api/pam/reminders?projectId=xxx
// Returns all non-done reminders for a project, sorted by due_date.
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

    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId')
    if (!projectId)
      return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })

    if (!await verifyProjectAccess(user.id, projectId))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const supabase = getServiceSupabase()
    // P-29: Scope to the calling user's reminders — without this filter every
    // team member can read every other member's personal reminders. The PATCH
    // and DELETE routes already scope to user_id; GET must be consistent.
    const { data: reminders, error } = await supabase
      .from('project_reminders')
      .select('id, message, remind_at, notified, created_at')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .eq('notified', false)
      .order('remind_at', { ascending: true, nullsFirst: false })
      .limit(20)

    if (error) throw error
    return NextResponse.json({ reminders })
  } catch (err: unknown) {
    console.error('[pam/reminders] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/pam/reminders
// Creates a new reminder.
export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } =
      await clientSupabase.auth.getUser(token)
    if (!user || authError)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { projectId, text, due_date } = await req.json()
    if (!projectId || !text?.trim())
      return NextResponse.json({ error: 'Missing projectId or text' }, { status: 400 })

    if (!await verifyProjectAccess(user.id, projectId))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const supabase = getServiceSupabase()
    const { data: reminder, error } = await supabase
      .from('project_reminders')
      .insert({
        project_id: projectId,
        user_id:    user.id,
        message:    text.trim(),
        remind_at:  due_date ?? null,
      })
      .select('id, message, remind_at, notified, created_at')
      .single()

    if (error) throw error
    return NextResponse.json({ reminder })
  } catch (err: unknown) {
    console.error('[pam/reminders] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
