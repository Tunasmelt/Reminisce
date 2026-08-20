import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabase as clientSupabase, getServiceSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured')
  // @ts-expect-error Stripe types are incorrectly hardcoded to a future version
  return new Stripe(key, { apiVersion: '2024-06-20' })
}

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

    const sb = getServiceSupabase()

    const { data: plan } = await sb
      .from('user_plans')
      .select('stripe_subscription_id, plan, status')
      .eq('user_id', user.id)
      .single()

    if (!plan || plan.plan !== 'pro') {
      return NextResponse.json({ error: 'No active Pro subscription' }, { status: 400 })
    }

    if (!plan.stripe_subscription_id) {
      // Manual upgrade — downgrade immediately
      await sb.from('user_plans').update({
        plan: 'free', status: 'cancelled',
        projects_limit: 2, stripe_subscription_id: null,
        updated_at: new Date().toISOString(),
      }).eq('user_id', user.id)

      await sb.from('user_wallets').update({
        daily_coins_limit: 50, max_coins_banked: 200,
        gems_monthly_grant: 0, updated_at: new Date().toISOString(),
      }).eq('user_id', user.id)

      return NextResponse.json({ ok: true, cancelled: true, method: 'manual' })
    }

    const stripe = getStripe()

    // ST-5: Retrieve the live subscription to check if cancel_at_period_end is
    // already true. A second click (page refresh, or after a Stripe portal
    // change) would otherwise make a redundant API call and re-write the DB.
    const liveSub = await stripe.subscriptions.retrieve(plan.stripe_subscription_id)

    if (liveSub.cancel_at_period_end) {
      // Already scheduled for cancellation — nothing to do.
      return NextResponse.json({ ok: true, cancelled: true, method: 'stripe', already_cancelling: true })
    }

    // Cancel at period end — user keeps Pro until billing cycle ends.
    await stripe.subscriptions.update(plan.stripe_subscription_id, {
      cancel_at_period_end: true,
    })

    // ST-12: Use 'cancelling' rather than 'cancelled' to distinguish "will be
    // cancelled at period end" (user still has Pro access) from "actually
    // cancelled" (set by customer.subscription.deleted webhook). Any Pro-feature
    // gate must check plan === 'pro', not status === 'active', so current
    // behaviour is safe — but the status string is now semantically accurate.
    await sb.from('user_plans').update({
      status: 'cancelling',
      updated_at: new Date().toISOString(),
    }).eq('user_id', user.id)

    return NextResponse.json({
      ok: true, cancelled: true, method: 'stripe',
    })

  } catch (err: unknown) {
    console.error('[stripe/cancel] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
