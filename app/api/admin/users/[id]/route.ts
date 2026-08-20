import { NextResponse } from 'next/server'
import { verifyAdmin } from '@/lib/admin-auth'
import { getServiceSupabase } from '@/lib/supabase'
import { ensureWallet } from '@/lib/wallet'
import { writeAuditLog } from '@/lib/admin-audit'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const check = await verifyAdmin(req.headers.get('authorization'))
  if (!check.ok) return check.response

  let body: { action?: string; value?: unknown; reason?: string; notes?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const sb = getServiceSupabase()
  const targetUserId = params.id

  // Actions: upgrade, downgrade, ban, unban, add_coins, add_gems, set_notes
  const { action, value } = body

  if (!action) return NextResponse.json({ error: 'action required' }, { status: 400 })

  // AD-1: Prevent admins from taking destructive actions on their own account.
  // ban / remove_admin / downgrade_free on self causes immediate self-lockout.
  const SELF_DESTRUCTIVE_ACTIONS = ['ban', 'remove_admin', 'downgrade_free']
  if (SELF_DESTRUCTIVE_ACTIONS.includes(action) && targetUserId === check.userId)
    return NextResponse.json(
      { error: `Cannot perform "${action}" on your own account` },
      { status: 400 },
    )

  try {
    let updateError = null

    switch (action) {
      case 'upgrade_pro': {
        // A5: Atomic — admin_set_plan updates user_plans AND user_wallets in one
        // transaction, so the two tables can never drift (the old code did two
        // separate UPDATEs and only logged the inconsistency on partial failure).
        const { error } = await sb.rpc('admin_set_plan', {
          p_user_id: targetUserId,
          p_plan:    'pro',
        })
        updateError = error
        break
      }
      case 'downgrade_free': {
        const { error } = await sb.rpc('admin_set_plan', {
          p_user_id: targetUserId,
          p_plan:    'free',
        })
        updateError = error
        break
      }
      case 'add_coins': {
        const amount = parseInt(String(value), 10) || 0
        if (amount <= 0 || amount > 10000) {
          return NextResponse.json({ error: 'amount must be 1–10000' }, { status: 400 })
        }
        await ensureWallet(targetUserId)
        // AD-5: Atomic increment via SQL expression — avoids the read-then-write
        // TOCTOU race where two concurrent admin grants both read the same balance
        // and one increment is silently lost.
        const { error: err } = await sb.rpc('increment_wallet_field', {
          p_user_id: targetUserId,
          p_field:   'coins',
          p_amount:  amount,
        })
        if (!err) {
          await sb.from('wallet_transactions').insert({
            user_id:            targetUserId,
            type:               'credit',
            amount,
            currency:           'coins',
            description:        `Admin grant by ${check.userId}`,
            transaction_source: 'admin_grant',
          })
        }
        updateError = err
        break
      }
      case 'add_gems': {
        const amount = parseInt(String(value), 10) || 0
        if (amount <= 0 || amount > 1000) {
          return NextResponse.json({ error: 'amount must be 1–1000' }, { status: 400 })
        }
        await ensureWallet(targetUserId)
        // AD-5: Same atomic increment pattern as add_coins.
        const { error: err } = await sb.rpc('increment_wallet_field', {
          p_user_id: targetUserId,
          p_field:   'gems',
          p_amount:  amount,
        })
        if (!err) {
          await sb.from('wallet_transactions').insert({
            user_id:            targetUserId,
            type:               'credit',
            amount,
            currency:           'gems',
            description:        `Admin grant by ${check.userId}`,
            transaction_source: 'admin_grant',
          })
        }
        updateError = err
        break
      }
      case 'ban': {
        const { error: err } = await sb.from('user_plans').update({
          banned_at: new Date().toISOString(),
          ban_reason: (value as string) || (body.reason as string) || 'Admin action',
          updated_at: new Date().toISOString(),
        }).eq('user_id', targetUserId)
        updateError = err
        break
      }
      case 'unban': {
        const { error: err } = await sb.from('user_plans').update({
          banned_at: null,
          ban_reason: null,
          updated_at: new Date().toISOString(),
        }).eq('user_id', targetUserId)
        updateError = err
        break
      }
      case 'set_notes': {
        const { error: err } = await sb.from('user_plans').update({
          notes: (value as string) || (body.notes as string) || null,
          updated_at: new Date().toISOString(),
        }).eq('user_id', targetUserId)
        updateError = err
        break
      }
      case 'make_admin': {
        const { error: err } = await sb.from('user_plans').update({
          is_admin: true, updated_at: new Date().toISOString(),
        }).eq('user_id', targetUserId)
        updateError = err
        break
      }
      case 'remove_admin': {
        // AD-2: Prevent removing the last admin — if this is the only admin row,
        // removing it leaves the system with zero admins and no recovery path
        // short of direct DB access.
        const { count: adminCount } = await sb
          .from('user_plans')
          .select('user_id', { count: 'exact', head: true })
          .eq('is_admin', true)
        if ((adminCount ?? 0) <= 1)
          return NextResponse.json(
            { error: 'Cannot remove the last admin. Promote another user first.' },
            { status: 400 },
          )
        const { error: err } = await sb.from('user_plans').update({
          is_admin: false, updated_at: new Date().toISOString(),
        }).eq('user_id', targetUserId)
        updateError = err
        break
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }

    if (updateError) {
      console.error('[AdminAPI] Update error:', updateError)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    // AD-3 / A8: Non-fatal audit write via the shared helper.
    await writeAuditLog({
      adminId:    check.userId,
      action,
      targetId:   targetUserId,
      targetType: 'user',
      metadata:   body as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true, action, targetUserId })
  } catch (err: unknown) {
    console.error('[AdminAPI] Fatal error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  const check = await verifyAdmin(req.headers.get('authorization'))
  if (!check.ok) return check.response

  const sb = getServiceSupabase()
  const targetUserId = params.id

  // AD-4: Prevent self-deletion — an admin deleting their own account via this
  // route would cascade-delete all their workspaces/projects and call
  // auth.admin.deleteUser on themselves, irreversibly destroying their account.
  if (targetUserId === check.userId)
    return NextResponse.json(
      { error: 'Cannot delete your own admin account' },
      { status: 400 },
    )

  try {
    // A1: Atomic deletion. Every user-owned table cascades from auth.users
    // (directly, or via workspaces → projects), so deleting the auth row removes
    // ALL of the user's data in one transaction. admin_delete_user is a
    // SECURITY DEFINER RPC that does exactly `DELETE FROM auth.users WHERE id=…`.
    //
    // This replaces the old approach of 6 sequential, non-transactional manual
    // deletes that ran BEFORE a *non-fatal* auth delete — an ordering that could
    // wipe a user's plan/wallet/workspaces while leaving them able to log in
    // (a zombie account that errors on every page load). Here the delete is
    // all-or-nothing and its failure is fatal.
    const { error: delErr } = await sb.rpc('admin_delete_user', {
      p_user_id: targetUserId,
    })
    if (delErr) {
      console.error('[Admin DELETE] admin_delete_user error:', delErr)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    // Audit AFTER successful deletion. The helper writes target_id (plain text,
    // no FK), so referencing the now-deleted user id does not violate any FK.
    await writeAuditLog({
      adminId:    check.userId,
      action:     'delete_user',
      targetId:   targetUserId,
      targetType: 'user',
      metadata:   { userId: targetUserId },
    })

    return NextResponse.json({ ok: true, deleted: targetUserId })
  } catch (err: unknown) {
    console.error('[Admin DELETE] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
