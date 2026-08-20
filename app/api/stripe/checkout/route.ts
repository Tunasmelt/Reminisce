import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import {
  supabase as clientSupabase,
  getServiceSupabase,
  isUserBanned,
} from '@/lib/supabase'

export const dynamic = 'force-dynamic'

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured')
  // @ts-expect-error Stripe types are incorrectly hardcoded to a future version
  return new Stripe(key, { apiVersion: '2024-06-20' })
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL 
  || 'http://localhost:3000'

// Gem pack definitions — amounts in cents
const GEM_PACKS: Record<string, {
  gems: number
  amount: number
  name: string
}> = {
  gems_50:  { gems: 50,  amount: 500,  
               name: '50 Gems — Starter' },
  gems_150: { gems: 150, amount: 1200, 
               name: '150 Gems — Builder' },
  gems_400: { gems: 400, amount: 2500, 
               name: '400 Gems — Power' },
}

export async function POST(req: Request) {
  try {
    const stripe = getStripe()
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json(
        { error: 'Unauthorized' }, 
        { status: 401 }
      )
    }
    
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = 
      await clientSupabase.auth.getUser(token)
    if (!user || authError) {
      return NextResponse.json(
        { error: 'Unauthorized' }, 
        { status: 401 }
      )
    }

    // ST-13: Banned users must not be able to purchase Pro or gems.
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // ST-14: Guard JSON parse so a malformed request body returns 400 not 500.
    let body: { type?: string; packId?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { type, packId } = body

    // ST-15: Whitelist the type field early — reject anything that isn't a
    // recognised checkout kind before making any Stripe API calls, so unknown
    // values don't slip through to the later if/else and return a 200 with
    // an "Invalid type" body that is easy for callers to miss.
    const ALLOWED_TYPES = new Set(['subscription', 'gems'])
    if (!type || !ALLOWED_TYPES.has(type)) {
      return NextResponse.json(
        { error: `Invalid type "${type ?? ''}". Must be one of: ${Array.from(ALLOWED_TYPES).join(', ')}` },
        { status: 400 },
      )
    }

    const supabase = getServiceSupabase()

    // ST-8: Validate required env var before attempting any Stripe call so the
    // error is immediately actionable rather than a cryptic Stripe API 400.
    if (type === 'subscription' && !process.env.STRIPE_PRO_PRICE_ID) {
      console.error('[stripe/checkout] STRIPE_PRO_PRICE_ID is not configured')
      return NextResponse.json(
        { error: 'Subscription unavailable — contact support.' },
        { status: 503 },
      )
    }

    // Get or create Stripe customer.
    // ST-4: Guard against duplicate customer creation from two concurrent
    // checkout requests (e.g. subscription + gem pack opened in two tabs).
    // Both requests may read stripe_customer_id = null simultaneously, then
    // both call stripe.customers.create, leaving an orphaned Stripe customer.
    // Defence: search Stripe for an existing customer by email before creating.
    const { data: planData } = await supabase
      .from('user_plans')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .single()

    let customerId = planData?.stripe_customer_id

    if (!customerId) {
      // Check for an existing Stripe customer with this email before creating.
      const email = user.email
      let existingCustomerId: string | null = null

      if (email) {
        const existing = await stripe.customers.list({ email, limit: 1 })
        if (existing.data.length > 0) {
          existingCustomerId = existing.data[0].id
        }
      }

      if (existingCustomerId) {
        customerId = existingCustomerId
      } else {
        const customer = await stripe.customers.create({
          email: email || undefined,
          metadata: { supabase_user_id: user.id },
        })
        customerId = customer.id
      }

      // Write back — use a conditional update so a concurrent request that
      // already wrote a customer ID wins and we don't overwrite it.
      await supabase
        .from('user_plans')
        .update({ stripe_customer_id: customerId })
        .eq('user_id', user.id)
        .is('stripe_customer_id', null)
    }

    // Narrow customerId to a definite string before handing it to Stripe.
    // (planData?.stripe_customer_id is string | undefined.)
    if (!customerId) {
      console.error('[stripe/checkout] Failed to resolve a Stripe customer id')
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    if (type === 'subscription') {
      // Pro monthly subscription
      const session = await stripe.checkout.sessions
        .create({
          customer: customerId,
          mode: 'subscription',
          line_items: [{
            price: process.env.STRIPE_PRO_PRICE_ID!,
            quantity: 1,
          }],
          success_url: 
            `${APP_URL}/dashboard?upgraded=true`,
          cancel_url: 
            `${APP_URL}/upgrade?cancelled=true`,
          metadata: {
            supabase_user_id: user.id,
            type: 'subscription',
          },
          subscription_data: {
            metadata: {
              supabase_user_id: user.id,
            },
          },
        })
      return NextResponse.json({ url: session.url })

    } else if (type === 'gems') {
      if (!packId) {
        return NextResponse.json(
          { error: 'Missing packId' },
          { status: 400 }
        )
      }
      const pack = GEM_PACKS[packId]
      if (!pack) {
        return NextResponse.json(
          { error: 'Invalid pack' }, 
          { status: 400 }
        )
      }
      
      // One-time gem purchase
      const session = await stripe.checkout.sessions
        .create({
          customer: customerId,
          mode: 'payment',
          line_items: [{
            price_data: {
              currency: 'usd',
              unit_amount: pack.amount,
              product_data: { name: pack.name },
            },
            quantity: 1,
          }],
          success_url:
            `${APP_URL}/dashboard?gems_purchased=${pack.gems}`,
          cancel_url:
            `${APP_URL}/upgrade?cancelled=true`,
          metadata: {
            supabase_user_id: user.id,
            type: 'gems',
            gems_amount: String(pack.gems),
            pack_id: packId,
          },
        })
      return NextResponse.json({ url: session.url })
    }

    return NextResponse.json(
      { error: 'Invalid type' }, 
      { status: 400 }
    )

  } catch (err: unknown) {
    console.error('[stripe/checkout] error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
