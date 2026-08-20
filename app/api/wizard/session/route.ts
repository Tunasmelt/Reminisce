import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, verifyProjectAccess, isUserBanned, getProjectRole } from '@/lib/supabase'
import type { ConfirmedFeature, TechStackOption } from '@/lib/wizard-stages'

export const dynamic = 'force-dynamic'

// PATCH /api/wizard/session
// The single authoritative write point for user-confirmed wizard data.
// Called by the wizard page ONLY when the user explicitly confirms
// features (clicks Confirm Features button) or selects a stack (clicks a card).
// The chat route NEVER writes confirmed_features or selected_stack — only this endpoint does.

export async function PATCH(req: Request) {
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

    let body: {
      sessionId: string
      confirmed_features?: ConfirmedFeature[]
      selected_stack?: TechStackOption
      stage?: string
      completed_stages?: string[]
    }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { sessionId, confirmed_features, selected_stack, stage, completed_stages } = body

    if (!sessionId)
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 })

    const supabase = getServiceSupabase()

    // Verify session belongs to a project this user owns
    const { data: session } = await supabase
      .from('wizard_sessions')
      .select('id, project_id, stage')
      .eq('id', sessionId)
      .single()

    if (!session)
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })

    if (!await verifyProjectAccess(user.id, session.project_id))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const role = await getProjectRole(user.id, session.project_id)
    if (role !== 'head') {
      return NextResponse.json(
        { error: 'Only the project head can run the Wizard' },
        { status: 403 }
      )
    }

    // W-15: reject stage rollback on terminal sessions
    const TERMINAL = ['complete', 'generating']
    if (stage !== undefined && TERMINAL.includes(session.stage) && !TERMINAL.includes(stage)) {
      return NextResponse.json(
        { error: 'Cannot roll back a completed or generating session' },
        { status: 409 }
      )
    }

    // Build update — only write fields that were explicitly passed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: Record<string, any> = {}

    if (confirmed_features !== undefined) {
      update.confirmed_features = confirmed_features
    }

    if (selected_stack !== undefined) {
      update.selected_stack = selected_stack
    }

    if (stage !== undefined) {
      update.stage = stage
    }

    // W-9: accept completed_stages from client (was accidentally dropped before)
    if (completed_stages !== undefined) {
      update.completed_stages = completed_stages
    }

    const { error } = await supabase
      .from('wizard_sessions')
      .update(update)
      .eq('id', sessionId)

    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    console.error('[wizard/session] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
