import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, isUserBanned } from '@/lib/supabase'
import { ALLOWED_PROVIDERS } from '@/lib/constants'

export const dynamic = 'force-dynamic'

export async function DELETE(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // K-4: banned check
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // BYOK is Pro-only
    const supabase = getServiceSupabase()
    const { data: planData } = await supabase
      .from('user_plans')
      .select('plan')
      .eq('user_id', user.id)
      .single()

    if (!planData || planData.plan !== 'pro') {
      return NextResponse.json(
        {
          error: 'BYOK requires a Pro subscription.',
          code: 'BYOK_PRO_REQUIRED'
        },
        { status: 403 }
      )
    }

    // K-2: parse body with explicit try/catch so malformed JSON returns 400 not 500
    let body: { provider?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { provider } = body
    if (!provider) return NextResponse.json({ error: 'Missing provider' }, { status: 400 })

    // K-3: validate provider against known list
    if (!ALLOWED_PROVIDERS.has(provider)) {
      return NextResponse.json(
        { error: `Unknown provider "${provider}"` },
        { status: 400 },
      )
    }

    const { error } = await supabase
      .from('user_api_keys')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', provider)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    console.error('[keys/delete] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
