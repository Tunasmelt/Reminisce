import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, verifyProjectAccess } from '@/lib/supabase'
import { callAI, userHasOwnKey } from '@/lib/ai-client'
import type { AIProvider } from '@/lib/ai-client'
import { deductCost, ensureWallet } from '@/lib/wallet'

export const dynamic = 'force-dynamic'

// POST /api/pam/summarise
// Summarises a completed thread and stores the summary for
// cross-thread memory. Called when a thread is archived or
// when the user starts a new thread (background, non-blocking).
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

    const { threadId, provider = 'groq', model = 'llama-3.1-8b-instant' } = await req.json()
    if (!threadId)
      return NextResponse.json({ error: 'Missing threadId' }, { status: 400 })

    const supabase = getServiceSupabase()

    // Load thread messages
    const { data: messages } = await supabase
      .from('pam_messages')
      .select('role, content, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })

    if (!messages || messages.length < 2)
      return NextResponse.json({ ok: true, skipped: true })

    // Load thread + project info
    const { data: thread } = await supabase
      .from('pam_threads')
      // user_id for P-10 ownership check; summarised for P-15 idempotency guard
      .select('project_id, user_id, title, message_count, summarised')
      .eq('id', threadId)
      .single()

    if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

    // P-28 + P-15: Atomically claim the thread before doing any work.
    // The read→check→write pattern is a TOCTOU race: two concurrent calls
    // could both see summarised=false and both proceed to insert duplicate
    // pam_thread_summaries rows, crowding out other threads' cross-thread memory.
    // Fix: attempt to flip summarised=true with a WHERE summarised=false guard.
    // If the UPDATE affects 0 rows, another call already claimed it — skip.
    const { data: claimData } = await supabase
      .from('pam_threads')
      .update({ summarised: true })
      .eq('id', threadId)
      .eq('summarised', false)   // ← atomic claim: only one caller wins
      .select('id')

    if (!claimData || claimData.length === 0)
      return NextResponse.json({ ok: true, skipped: true })

    // Already-summarised shortcut (skip the project access check too)
    if (thread.summarised)
      return NextResponse.json({ ok: true, skipped: true })

    if (!await verifyProjectAccess(user.id, thread.project_id))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // P-10: Thread ownership check — project collaborators should not be
    // able to trigger summarisation (and indirect transcript exposure) of
    // another user's private PAM thread.
    if (thread.user_id !== user.id)
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // P-9: Deduct cost for the summarise AI call. This is a background
    // operation so we skip (return early) rather than blocking on failure —
    // that way a coin shortage degrades gracefully (no summary stored) rather
    // than crashing the caller. BYOK users bypass the economy as normal.
    const isBYOK = await userHasOwnKey(user.id, provider as AIProvider)
    if (!isBYOK) {
      try {
        await ensureWallet(user.id)
        const costResult = await deductCost(user.id, model)
        if (!costResult.success) {
          console.warn('[pam/summarise] insufficient balance — skipping summarise for user', user.id)
          return NextResponse.json({ ok: true, skipped: true })
        }
      } catch (walletErr) {
        console.error('[pam/summarise] wallet error — skipping summarise:', walletErr)
        return NextResponse.json({ ok: true, skipped: true })
      }
    }

    // Build compact transcript for summarisation
    const transcript = messages
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'user' ? 'User' : 'PAM'}: ${m.content.slice(0, 400)}`)
      .join('\n')
      .slice(0, 4000) // keep well within context window

    const summaryPrompt = `You are summarising a conversation between a developer and PAM (Project Action Manager).
    
Conversation title: "${thread.title ?? 'Untitled'}"

TRANSCRIPT:
${transcript}

Write a concise summary (3-5 sentences max) covering:
1. What the user was working on or asking about
2. Any decisions made or actions confirmed
3. Key information that would be useful in a future conversation

Be specific. Include feature names, phase names, or technical details mentioned.
Do NOT add padding or generic statements.`

    const aiRes = await callAI({
      userId:   user.id,
      provider: provider as AIProvider,
      model,
      stream:   false,
      messages: [
        { role: 'system', content: 'You summarise developer project conversations concisely and accurately.' },
        { role: 'user',   content: summaryPrompt },
      ],
    }) as { choices: Array<{ message: { content: string } }> }

    const rawSummary = aiRes.choices?.[0]?.message?.content?.trim() ?? ''
    if (!rawSummary) return NextResponse.json({ ok: true, skipped: true })

    // P-19: Cap at 1000 chars — a runaway model response should not bloat the
    // cross-thread memory injected into every future PAM turn for this project.
    const summary = rawSummary.slice(0, 1000)

    // Store summary
    await supabase.from('pam_thread_summaries').insert({
      thread_id:     threadId,
      project_id:    thread.project_id,
      summary,
      message_count: thread.message_count ?? messages.length,
    })

    // P-28: summarised=true was already flipped atomically at the top of this
    // function (the atomic claim). No need to update it again here.

    return NextResponse.json({ ok: true, summary })
  } catch (err: unknown) {
    console.error('[pam/summarise] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
