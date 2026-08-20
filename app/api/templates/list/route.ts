import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, isUserBanned } from '@/lib/supabase'

const MAX_SEARCH_LENGTH = 200

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

    // TL-2: banned check
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    const { searchParams } = new URL(req.url)
    const tag = searchParams.get('tag')
    const category = searchParams.get('category')
    const search = searchParams.get('search')

    const sb = getServiceSupabase()

    let query = sb
      .from('prompt_templates')
      .select('*')
      .eq('user_id', user.id)
      .order('use_count', { ascending: false })

    if (tag) {
      query = query.contains('tags', [tag])
    }
    if (category && category !== 'ALL') {
      query = query.eq('category', category)
    }
    if (search) {
      // TL-1: cap search length to prevent excessively long ilike patterns
      const safeSearch = search.slice(0, MAX_SEARCH_LENGTH)
      query = query.or(`title.ilike.%${safeSearch}%,content.ilike.%${safeSearch}%`)
    }

    const { data, error } = await query
    if (error) {
      console.error('[templates/list] query error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    return NextResponse.json({ templates: data })
  } catch (err: unknown) {
    console.error('[templates/list] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
