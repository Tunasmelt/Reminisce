import { NextResponse } from 'next/server'
import { verifyAdmin } from '@/lib/admin-auth'
import { getServiceSupabase } from '@/lib/supabase'
import { invalidateModelCache } from '@/lib/ai-client'
import { writeAuditLog } from '@/lib/admin-audit'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const check = await verifyAdmin(req.headers.get('authorization'))
  if (!check.ok) return check.response

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const sb = getServiceSupabase()

  const allowed = [
    'label', 'enabled', 'visible', 'is_free', 'tier_required',
    'sort_order', 'notes', 'model_name',
    'cost_coins', 'cost_gems', 'context_window',
    'rate_limit_rpm', 'rate_limit_rpd',
  ]
  const updates: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields' }, { status: 400 })
  }

  if ('is_free' in updates) {
    updates.tier_required = updates.is_free ? 'free' : 'pro'
  }

  const { data, error } = await sb
    .from('provider_models')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) {
    console.error('[admin/models PATCH] update error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  invalidateModelCache()

  await writeAuditLog({
    adminId:    check.userId,
    action:     'update_model',
    targetId:   params.id,
    targetType: 'model',
    metadata:   { model_id: params.id, updates },
  })

  return NextResponse.json({ model: data })
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  const check = await verifyAdmin(req.headers.get('authorization'))
  if (!check.ok) return check.response

  const sb = getServiceSupabase()
  // AD-9: model_used on agent_runs is a free-text string (not an FK), so
  // deleting a model is DB-safe — it won't cascade-break existing rows.
  // Historical run records will retain the model string for reference even
  // after the model entry is removed from provider_models.
  const { error } = await sb
    .from('provider_models')
    .delete()
    .eq('id', params.id)

  if (error) {
    console.error('[admin/models DELETE] delete error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  invalidateModelCache()

  await writeAuditLog({
    adminId:    check.userId,
    action:     'delete_model',
    targetId:   params.id,
    targetType: 'model',
    metadata:   { model_id: params.id },
  })

  return NextResponse.json({ ok: true })
}
