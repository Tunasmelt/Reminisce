import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getServiceSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured')
  // @ts-expect-error Stripe types are incorrectly hardcoded to a future version
  return new Stripe(key, { apiVersion: '2024-06-20' })
}

export async function POST(req: Request) {
  const stripe = getStripe()
  const body = await req.text()
  const sig = req.headers.get('stripe-signature') as string
  
  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Missing sig' }, { status: 400 })
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      body, 
      sig,
      process.env.STRIPE_WEBHOOK_SECRET as string
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Webhook signature failed:', message)
    return NextResponse.json(
      { error: `Invalid signature: ${message}` },
      { status: 400 }
    )
  }

  const supabase = getServiceSupabase()

  try {
    switch (event.type) {

      // ── SUBSCRIPTION CREATED / RENEWED ──────
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const metadata = (session.metadata || {}) as Record<string, string>
        const userId = metadata.supabase_user_id
        const type = metadata.type

        if (!userId) break

        if (type === 'subscription') {
          // ST-10: Idempotency guard for subscription upgrades. Stripe retries
          // checkout.session.completed for up to 72 hours on non-2xx responses.
          // A retry after the plan was already upgraded would re-run the wallet
          // update, overwriting any coins the user spent since the first call.
          // Guard by checking if the subscription ID is already recorded.
          const subscriptionId = session.subscription as string
          if (subscriptionId) {
            const { count: alreadyUpgraded } = await supabase
              .from('user_plans')
              .select('id', { count: 'exact', head: true })
              .eq('user_id', userId)
              .eq('stripe_subscription_id', subscriptionId)
              .eq('plan', 'pro')

            if ((alreadyUpgraded ?? 0) > 0) {
              console.log(`[stripe] subscription checkout.session.completed: already processed ${subscriptionId} — skipping`)
              break
            }
          }

          // Upgrade plan to pro — wallet limits + coin allowance.
          // ST-1: The 100-gem initial grant is intentionally NOT done here.
          // invoice.paid fires on the same event and is the canonical grant
          // path for both initial subscriptions and renewals. Granting here
          // AND in invoice.paid would double-credit the user on signup.
          await supabase
            .from('user_plans')
            .update({
              plan: 'pro',
              status: 'active',
              projects_limit: 999,
              stripe_subscription_id: subscriptionId,
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId)

          // ST-11: Read current coins before upgrading so we never reduce a
          // user's balance. If they already have 350 banked coins from the
          // free tier, upgrading should set their limit to 500 but keep their
          // coins intact (or top up to 200, whichever is higher).
          const { data: currentWallet } = await supabase
            .from('user_wallets')
            .select('coins')
            .eq('user_id', userId)
            .single()

          await supabase
            .from('user_wallets')
            .update({
              // Take the max of current balance and the Pro starting allowance
              // so upgrading never decreases what the user already has.
              coins: Math.max(currentWallet?.coins ?? 0, 200),
              daily_coins_limit: 200,
              max_coins_banked: 500,
              gems_monthly_grant: 100,
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId)

        } else if (type === 'gems') {
          // One-time gem purchase
          const gemsAmount = parseInt(metadata.gems_amount || '0')
          const packId = metadata.pack_id
          const paymentIntentId = session.payment_intent as string

          // ST-9: parseInt returns NaN for non-numeric strings (e.g. tampered
          // or corrupted metadata). NaN > 0 is false so the block would silently
          // skip — but log an explicit warning so ops can investigate.
          if (isNaN(gemsAmount)) {
            console.warn(`[stripe] gems checkout.session.completed: invalid gems_amount "${metadata.gems_amount}" in session ${session.id} — skipping`)
            break
          }

          if (gemsAmount > 0 && paymentIntentId) {
            // ST-2: Idempotency guard — Stripe retries webhooks on non-2xx
            // responses for up to 72 hours. If the handler crashes after
            // crediting the wallet but before returning 200, a retry would
            // double-credit the user. Guard by checking gem_purchases for an
            // existing row with this payment_intent_id before touching the wallet.
            const { count: existingPurchase } = await supabase
              .from('gem_purchases')
              .select('id', { count: 'exact', head: true })
              .eq('stripe_payment_intent_id', paymentIntentId)

            if ((existingPurchase ?? 0) > 0) {
              console.log(`[stripe] gems checkout.session.completed: already processed ${paymentIntentId} — skipping`)
              break
            }

            // ST-12: Optimistic-lock gem credit to prevent TOCTOU when two
            // simultaneous webhook deliveries both pass the idempotency check
            // above (e.g. two different payment_intent_ids arriving at the same
            // time). Read current balance, then update only if it hasn't changed.
            // Two attempts mirror the pattern used in deductCost / refundCost.
            let gemsCredited = false
            for (let attempt = 0; attempt < 2; attempt++) {
              const { data: wallet } = await supabase
                .from('user_wallets')
                .select('gems')
                .eq('user_id', userId)
                .single()

              const currentGems = wallet?.gems ?? 0
              const { data: updated } = await supabase
                .from('user_wallets')
                .update({
                  gems: currentGems + gemsAmount,
                  updated_at: new Date().toISOString(),
                })
                .eq('user_id', userId)
                .eq('gems', currentGems)   // optimistic lock
                .select('id')

              if (updated && updated.length > 0) { gemsCredited = true; break }
              // Concurrent modification — retry with fresh balance read
            }

            if (!gemsCredited) {
              console.error(`[stripe] gems: optimistic lock failed after 2 attempts for user ${userId}, payment ${paymentIntentId}`)
              // Do not insert gem_purchases sentinel — a retry will re-attempt
              break
            }

            await supabase
              .from('wallet_transactions')
              .insert({
                user_id: userId,
                type: 'credit',
                amount: gemsAmount,
                currency: 'gems',
                description: `Gem purchase: ${packId}`,
                transaction_source: 'purchase',
              })

            // Record purchase — this is also the idempotency sentinel row.
            await supabase
              .from('gem_purchases')
              .insert({
                user_id: userId,
                amount_gems: gemsAmount,
                amount_paid_cents: session.amount_total || 0,
                stripe_payment_intent_id: paymentIntentId,
                status: 'complete',
              })
          }
        }
        break
      }

      // ── SUBSCRIPTION CANCELLED ───────────────
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        const subscriptionId = subscription.id

        // ── Primary: look up user by stripe_subscription_id in our DB ─────────
        // This is reliable regardless of metadata presence.
        let userId: string | null = null

        const { data: planBySubId } = await supabase
          .from('user_plans')
          .select('user_id')
          .eq('stripe_subscription_id', subscriptionId)
          .maybeSingle()

        if (planBySubId?.user_id) {
          userId = planBySubId.user_id
        } else {
          // ── Fallback: metadata (works for subscriptions created after the fix) ─
          const metadata = (subscription.metadata || {}) as Record<string, string>
          userId = metadata.supabase_user_id || null
        }

        if (!userId) {
          console.error(
            `[stripe] subscription.deleted: could not resolve user for sub ${subscriptionId}`
          )
          break
        }

        // Downgrade to free
        await supabase
          .from('user_plans')
          .update({
            plan: 'free',
            status: 'cancelled',
            projects_limit: 2,
            stripe_subscription_id: null,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)

        // Reset wallet to free limits
        await supabase
          .from('user_wallets')
          .update({
            daily_coins_limit: 50,
            max_coins_banked: 200,
            gems_monthly_grant: 0,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)

        break
      }

      // ── SUBSCRIPTION RENEWED ─────────────────
      case 'invoice.paid': {
        const invoice = event.data.object as unknown as { subscription: string }
        const subId = invoice.subscription
        if (!subId) break

        const subscription = await stripe.subscriptions.retrieve(subId as string)
        const metadata = (subscription.metadata || {}) as Record<string, string>

        // ST-3: Resolve user via DB lookup first (reliable for all subscriptions),
        // fall back to metadata only for subscriptions created after the metadata
        // fix. Mirrors the same dual-path used in customer.subscription.deleted.
        let userId: string | null = metadata.supabase_user_id || null

        if (!userId) {
          const { data: planRow } = await supabase
            .from('user_plans')
            .select('user_id')
            .eq('stripe_subscription_id', subId)
            .maybeSingle()
          userId = planRow?.user_id ?? null
        }

        if (!userId) {
          console.error(`[stripe] invoice.paid: could not resolve user for sub ${subId} — skipping gem grant`)
          break
        }

        // ST-1: invoice.paid is the single canonical path for the monthly gem
        // grant — covers both initial subscriptions (where checkout.session.
        // completed previously also granted gems, causing a double-credit) and
        // all subsequent renewals. The idempotency guard uses the Stripe invoice
        // ID stored in wallet_transactions so retried webhooks are safe.
        const invoiceId = (event.data.object as unknown as { id: string }).id

        // Idempotency: skip if we already granted gems for this invoice.
        const { count: alreadyGranted } = await supabase
          .from('wallet_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('transaction_source', 'monthly_grant')
          .eq('metadata->>invoiceId', invoiceId)

        if ((alreadyGranted ?? 0) > 0) {
          console.log(`[stripe] invoice.paid: gems already granted for invoice ${invoiceId} — skipping`)
          break
        }

        const { data: wallet } = await supabase
          .from('user_wallets')
          .select('gems')
          .eq('user_id', userId)
          .single()

        const currentGems = wallet?.gems || 0
        const newGems = Math.min(currentGems + 100, 500) // cap at 500 banked gems

        await supabase
          .from('user_wallets')
          .update({
            gems: newGems,
            gems_last_granted: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)

        await supabase
          .from('wallet_transactions')
          .insert({
            user_id: userId,
            type: 'credit',
            amount: 100,
            currency: 'gems',
            description: 'Monthly gem grant',
            transaction_source: 'monthly_grant',
            metadata: { invoiceId },
          })
        break
      }
    }

    return NextResponse.json({ received: true })
  
  } catch (error: unknown) {
    console.error('Webhook handler error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
