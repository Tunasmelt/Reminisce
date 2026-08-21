import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, isUserBanned } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // K-6: banned check — even read endpoints should block suspended accounts
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    const supabase = getServiceSupabase()
    const { data, error } = await supabase
      .from('user_api_keys')
      .select('provider')
      .eq('user_id', user.id)

    if (error) throw error

    return NextResponse.json({ providers: data.map(d => d.provider) })
  } catch (error: unknown) {
    console.error('[keys/list] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
