import { NextResponse } from 'next/server'
import { verifyAdmin } from '@/lib/admin-auth'
import { getServiceSupabase } from '@/lib/supabase'
import { invalidateModelCache } from '@/lib/ai-client'
import { writeAuditLog } from '@/lib/admin-audit'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const check = await verifyAdmin(req.headers.get('authorization'))
  if (!check.ok) return check.response

  const sb = getServiceSupabase()
  const { data, error } = await sb
    .from('provider_models')
    .select('*')
    .order('sort_order', { ascending: true })

  if (error) {
    console.error('[admin/models GET] query error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  return NextResponse.json({ models: data })
}

export async function POST(req: Request) {
  const check = await verifyAdmin(req.headers.get('authorization'))
  if (!check.ok) return check.response

  let body: {
    provider?: string; model_id?: string; model_name?: string; label?: string
    is_free?: boolean; enabled?: boolean; visible?: boolean; tier_required?: string; sort_order?: number
    cost_coins?: number; cost_gems?: number; context_window?: number
    rate_limit_rpm?: number; rate_limit_rpd?: number; notes?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { provider, model_id, model_name, label, is_free, enabled, visible, tier_required, sort_order, cost_coins, cost_gems, context_window, rate_limit_rpm, rate_limit_rpd, notes } = body

  if (!provider || !model_id || !model_name) {
    return NextResponse.json({ error: 'provider, model_id, model_name required' }, { status: 400 })
  }

  const sb = getServiceSupabase()
  const { data, error } = await sb
    .from('provider_models')
    .insert({
      provider,
      model_id,
      model_name,
      label: label || model_name,
      is_free: is_free ?? true,
      enabled: enabled ?? true,
      visible: visible ?? true,
      tier_required: tier_required || (is_free ? 'free' : 'pro'),
      sort_order: sort_order ?? 99,
      cost_coins,
      cost_gems,
      context_window,
      rate_limit_rpm: rate_limit_rpm ?? 5,
      rate_limit_rpd: rate_limit_rpd ?? 200,
      notes,
    })
    .select()
    .single()

  if (error) {
    // Friendly 409 on the UNIQUE(provider, model_id) violation instead of a
    // generic 500, so the admin sees "already exists" rather than a server error.
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `A model "${model_id}" already exists for provider "${provider}".` },
        { status: 409 },
      )
    }
    console.error('[admin/models POST] insert error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  invalidateModelCache()

  await writeAuditLog({
    adminId:    check.userId,
    action:     'create_model',
    targetId:   model_id,
    targetType: 'model',
    metadata:   { model_id, provider },
  })

  return NextResponse.json({ model: data })
}
