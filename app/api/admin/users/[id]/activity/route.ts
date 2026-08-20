import { NextResponse } from 'next/server'
import { verifyAdmin } from '@/lib/admin-auth'
import { getServiceSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const check = await verifyAdmin(req.headers.get('authorization'))
  if (!check.ok) return check.response

  const sb = getServiceSupabase()
  const userId = params.id

  // AD-8: Fetch both wallet transactions AND recent agent runs in parallel.
  // Previously agentRuns was hardcoded to [] — an incomplete implementation
  // that left the activity panel half-empty.
  const [
    { data: transactions },
    { data: agentRuns },
  ] = await Promise.all([
    sb
      .from('wallet_transactions')
      .select('type, amount, currency, description, transaction_source, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20),
    sb
      .from('agent_runs')
      .select('id, model_used, status, tokens_used, started_at, completed_at, error_message')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(10),
  ])

  return NextResponse.json({
    transactions: transactions ?? [],
    agentRuns:    agentRuns    ?? [],
  })
}
