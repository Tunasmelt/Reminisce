import { NextRequest, NextResponse } from 'next/server'
import { supabase as clientSupabase, isUserBanned } from '@/lib/supabase'
import { awardCoins } from '@/lib/wallet'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.split(' ')[1]
    const { data: { user }, error } = await clientSupabase.auth.getUser(token)

    if (error || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // R-3: banned users must not receive daily coin rewards
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    const result = await awardCoins(user.id, 'daily_login')

    return NextResponse.json({
      success: true,
      awarded: result.awarded,
      amount:  result.amount,
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
