import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, isUserBanned } from '@/lib/supabase'
import { encrypt } from '@/lib/encryption'
import { ALLOWED_PROVIDERS } from '@/lib/constants'

export const dynamic = 'force-dynamic'

// K-5: Hard caps on user-supplied string fields
const MAX_API_KEY_LENGTH = 512
const MAX_LABEL_LENGTH   = 100

export async function POST(req: Request) {
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

    // K-1: parse body with explicit try/catch so malformed JSON returns 400 not 500
    let body: { provider?: string; apiKey?: string; label?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { provider, apiKey, label } = body

    if (!provider || !apiKey) {
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
    }

    // K-3: validate provider against known list
    if (!ALLOWED_PROVIDERS.has(provider)) {
      return NextResponse.json(
        { error: `Unknown provider "${provider}". Allowed: ${Array.from(ALLOWED_PROVIDERS).join(', ')}` },
        { status: 400 },
      )
    }

    // K-5: cap field lengths
    if (apiKey.length > MAX_API_KEY_LENGTH) {
      return NextResponse.json(
        { error: `API key exceeds maximum length of ${MAX_API_KEY_LENGTH} characters` },
        { status: 400 },
      )
    }

    const safeLabel = label ? String(label).slice(0, MAX_LABEL_LENGTH) : undefined

    const encrypted_key = encrypt(apiKey)

    const { error } = await supabase
      .from('user_api_keys')
      .upsert(
        {
          user_id: user.id,
          provider,
          encrypted_key,
          label: safeLabel,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id, provider' }
      )

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    console.error('[keys/save] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
