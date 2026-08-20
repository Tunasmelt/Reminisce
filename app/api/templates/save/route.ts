import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, isUserBanned } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

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

    // TS-3: Use the canonical isUserBanned() helper instead of an ad-hoc
    // inline query so the ban check stays in sync if the ban logic ever changes
    // (e.g. if we add a second banned column or move the check to a DB function).
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    const sb = getServiceSupabase()

    // TS-1: guard JSON parse so bad body returns 400 not 500
    let body: { id?: string; title?: string; content?: string; tags?: string[]; category?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { id, title, content, tags, category } = body

    // TS-2: cap field lengths to prevent multi-MB inserts
    if (title && title.length > 200)
      return NextResponse.json({ error: 'Title must be 200 characters or fewer' }, { status: 400 })
    if (content && content.length > 50_000)
      return NextResponse.json({ error: 'Template content must be 50,000 characters or fewer' }, { status: 400 })

    if (id) {
      // Update existing
      const { data, error } = await sb
        .from('prompt_templates')
        .update({ 
          title, content, tags, category,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .eq('user_id', user.id)
        .select()
        .single()
      if (error) {
        console.error('[templates/save] update error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
      return NextResponse.json({ template: data })
    } else {
      // Create new
      const { data, error } = await sb
        .from('prompt_templates')
        .insert({
          user_id: user.id,
          title, content,
          tags: tags || [],
          category: category || 'GENERAL',
        })
        .select()
        .single()
      if (error) {
        console.error('[templates/save] insert error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
      return NextResponse.json({ template: data })
    }
  } catch (err: unknown) {
    console.error('[templates/save] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
