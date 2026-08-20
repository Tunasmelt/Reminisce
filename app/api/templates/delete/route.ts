import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, isUserBanned } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function DELETE(req: Request) {
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

    const sb = getServiceSupabase()

    // TD-1: guard JSON parse so bad body returns 400 not 500
    let body: { id?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { id } = body

    // TD-2: require a non-empty id — a missing/null id would cause
    // .eq('id', null) which silently matches no rows (or unexpected rows)
    if (!id || typeof id !== 'string' || !id.trim()) {
      return NextResponse.json({ error: 'Missing template id' }, { status: 400 })
    }

    const { error } = await sb
      .from('prompt_templates')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)

    if (error) {
      console.error('[templates/delete] error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    console.error('[templates/delete] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
