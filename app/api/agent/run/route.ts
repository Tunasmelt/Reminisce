import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, verifyProjectAccess, getProjectRole } from '@/lib/supabase'
import { callAI, userHasOwnKey, type AIProvider } from '@/lib/ai-client'
import { deductCost, refundCost, ensureWallet, awardCoins, getUserPlan } from '@/lib/wallet'
import { ALLOWED_PROVIDERS } from '@/lib/constants'
import { getModel } from '@/lib/model-registry'
import { canUseModel } from '@/lib/model-permissions'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)
    if (!user || authError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })


    // Check if user is banned
    const { isUserBanned } = await import('@/lib/supabase')
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // AR-12: Guard JSON parse so a malformed body returns 400 instead of
    // letting a SyntaxError bubble up to the outer catch and leak via error.message.
    let body: { projectId?: string; featureId?: string; provider?: string; model?: string; prompt?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { projectId, featureId, provider, model, prompt: directPrompt } = body

    if (!projectId || !provider || !model) {
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
    }

    // AR-16: Validate provider against the canonical allow-list before it is
    // used for BYOK resolution / callAI. An unknown string would otherwise be
    // passed straight to the AI client. Also narrows the type to AIProvider.
    if (!ALLOWED_PROVIDERS.has(provider)) {
      return NextResponse.json({ error: 'Unknown provider' }, { status: 400 })
    }
    const validProvider = provider as AIProvider

    // AR-11 (extended): Cap directPrompt length to prevent oversized payloads
    // being stored in agent_runs.prompt_used and sent to the AI provider.
    const MAX_DIRECT_PROMPT_LENGTH = 8_000
    if (typeof directPrompt === 'string' && directPrompt.length > MAX_DIRECT_PROMPT_LENGTH) {
      return NextResponse.json(
        { error: `Prompt exceeds maximum length of ${MAX_DIRECT_PROMPT_LENGTH} characters` },
        { status: 400 },
      )
    }

    if (!await verifyProjectAccess(user.id, projectId))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // AR-4: Reject viewer role — viewers are read-only across all write routes.
    // verifyProjectAccess only checks membership, not role; getProjectRole provides
    // the actual role string.
    const role = await getProjectRole(user.id, projectId)
    if (role === 'viewer') {
      return NextResponse.json(
        { error: 'Viewers cannot run agents. Contact the project head to upgrade your role.' },
        { status: 403 },
      )
    }

    // E-23: Ensure wallet row exists before any balance operation. Wrapped in
    // its own try-catch so a failure here returns a clear 500 immediately and
    // never allows deductCost to proceed against a missing wallet row.
    try {
      await ensureWallet(user.id)
    } catch (walletSetupErr) {
      console.error('[agent/run] ensureWallet failed:', walletSetupErr)
      return NextResponse.json(
        { error: 'Failed to initialise wallet. Please try again.' },
        { status: 500 },
      )
    }

    // Skip economy if user has their own key (BYOK)
    const isBYOK = await userHasOwnKey(user.id, validProvider)

    // AR-9 / A2: Single permission gate via the shared resolver. Checks that the
    // model is enabled AND that the user's tier (or BYOK status) permits it —
    // replacing the old enabled-only check here plus a separate tier check that
    // lived inside deductCost. BYOK users bypass tier gating (documented policy
    // in canUseModel), but a disabled model is rejected for everyone.
    {
      const modelDef = await getModel(validProvider, model)
      const userPlan = await getUserPlan(user.id)
      const perm = canUseModel({ plan: userPlan.plan, isBYOK }, modelDef)
      if (!perm.ok) {
        return NextResponse.json({ error: perm.reason }, { status: perm.status })
      }
    }

    // AR-5: Guard against concurrent runs from the same user on the same project.
    // The wallet TOCTOU race (two requests both passing the balance check before
    // either deducts) is partially mitigated by also rejecting a second run while
    // one is already in progress. Using a DB query works across serverless instances
    // unlike a module-level Map which is instance-local.
    {
      const supabaseService = getServiceSupabase()
      // AR-5 + ST-15: also block while a run is 'pending' (inserted but not yet
      // deducted) so two rapid requests can't both slip through before either
      // flips to 'running'.
      const { count: runningCount } = await supabaseService
        .from('agent_runs')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .in('status', ['pending', 'running'])
      if ((runningCount ?? 0) > 0) {
        return NextResponse.json(
          { error: 'A run is already in progress for this project. Please wait for it to finish.' },
          { status: 429 },
        )
      }
    }

    const supabase = getServiceSupabase()

    // a. Load Feature + Project git state in parallel
    // AR-14: Scope the feature lookup to projectId so a caller who passes a
    // featureId from a different project cannot inject that project's context
    // into this run. maybeSingle() returns null if the feature doesn't belong
    // to this project rather than throwing, which we treat as "no feature".
    const [featureResult, projectResult] = await Promise.all([
      featureId
        ? supabase.from('features').select('*').eq('id', featureId).eq('project_id', projectId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('projects')
        .select('git_branch, git_last_commit')
        .eq('id', projectId)
        .single(),
    ])
    const feature = featureResult.data ?? null
    const gitBranch = (projectResult.data as { git_branch?: string | null } | null)
      ?.git_branch ?? null

    // b. Load Structured Prompt — also get prompt.id for run_count tracking
    let promptData: { id: string; structured_prompt: string } | null = null
    if (featureId) {
      const { data: p } = await supabase
        .from('prompts')
        .select('id, structured_prompt')
        .eq('feature_id', featureId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      promptData = p ?? null
    }

    // AR-11: Trim directPrompt before the fallback chain. An empty string or
    // whitespace-only value is falsy after trim, so it correctly falls through
    // to the structured_prompt / feature description / generic fallback.
    const basePrompt = (typeof directPrompt === 'string' ? directPrompt.trim() : '') ||
      promptData?.structured_prompt ||
      feature?.description ||
      'Implement this feature.'

    // c. Load Context Files — architecture + coding guidelines always loaded
    // tech-stack also loaded to give agent full stack awareness
    const contextPaths = [
      'reminisce/context/architecture.md',
      'reminisce/context/tech-stack.md',
      'reminisce/context/coding-guidelines.md',
    ]
    const { data: contexts } = await supabase
      .from('contexts')
      .select('file_path, content')
      .eq('project_id', projectId)
      .in('file_path', contextPaths)

    const contextText = contexts?.map(c => `File: ${c.file_path}\nContent:\n${c.content}`).join('\n\n---\n\n') || ''

    const finalPrompt = `
${basePrompt}

---PROJECT CONTEXT---
${contextText}
`.trim()

    // ST-15: Insert the run record as 'pending' BEFORE deducting coins so that
    // the run.id is available to pass to deductCost. This closes the audit-trail
    // gap where the wallet_transactions debit row had run_id: null (making it
    // impossible to trace a debit back to the specific run that caused it).
    //
    // AR-1 (original): previously the run was inserted after deduction, so a
    // failed insert left the user charged with no run record. With this order,
    // a failed insert returns 500 before any deduction — no refund needed.
    const { data: run, error: runErr } = await supabase
      .from('agent_runs')
      .insert({
        project_id:  projectId,
        feature_id:  featureId,
        model_used:  `${provider}/${model}`,
        status:      'pending',
        prompt_used: finalPrompt,
        started_at:  new Date().toISOString(),
      })
      .select()
      .single()

    if (runErr) {
      // Insert failed before any deduction — nothing to refund.
      throw runErr
    }

    // Deduct coins/gems now that we have a run.id to tie the transaction to.
    if (!isBYOK) {
      let costResult: { success: boolean; message?: string }
      try {
        costResult = await deductCost(user.id, model, run.id, validProvider)
      } catch (err) {
        console.error('[wallet] failed to deduct coins:', err)
        await supabase
          .from('agent_runs')
          .update({ status: 'failed', error_message: 'Wallet error' })
          .eq('id', run.id)
        return NextResponse.json({ error: 'Failed to process payment' }, { status: 500 })
      }

      if (!costResult.success) {
        // Insufficient balance — mark run failed and return 402.
        await supabase
          .from('agent_runs')
          .update({ status: 'failed', error_message: costResult.message ?? 'Insufficient balance' })
          .eq('id', run.id)
        return NextResponse.json({ error: costResult.message }, { status: 402 })
      }
    }

    // Flip the run to 'running' now that payment is confirmed.
    await supabase
      .from('agent_runs')
      .update({ status: 'running' })
      .eq('id', run.id)

    // ── Load product scope for drift detection ────────────────────────────
    const { data: scopeCtx } = await supabase
      .from('contexts')
      .select('content, summary')
      .eq('project_id', projectId)
      .eq('file_path', 'reminisce/context/product-scope.md')
      .maybeSingle()

    const productScope = scopeCtx?.content
      ? scopeCtx.content.slice(0, 1200)
      : scopeCtx?.summary || null

    let systemPrompt = 'You are an expert software developer. Implement the requested feature completely and correctly. Include full file paths, complete code, and brief explanations. Format code in markdown code blocks.'

    if (productScope) {
      systemPrompt += `\n\nSCOPE AWARENESS:
The project is bound by the following scope:
---
${productScope}
---
If the request or your planned implementation drifts outside this scope, you MUST begin your response with "⚠️ Scope alert:" followed by a concise 1-sentence warning about why it drifts.`
    }

    let aiRes: Response
    try {
      // f. Call AI with Stream
      aiRes = await callAI({
        userId: user.id,
        provider: validProvider,
        model,
        stream: true,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: finalPrompt
          }
        ]
      })
    } catch (aiErr) {
      // Refund if AI call itself fails before stream starts
      if (!isBYOK) {
        await refundCost(user.id, model, run?.id, validProvider)
      }
      throw aiErr
    }

    // g. Stream response
    const decoder = new TextDecoder()
    
    const stream = new ReadableStream({
      async start(controller) {
        let fullOutput = ''
        const reader = aiRes.body?.getReader()
        if (!reader) {
          controller.close()
          return
        }

        try {
          // AR-2: Carry-over buffer for fragmented SSE delivery.
          // A single TCP chunk may contain a partial SSE line. Splitting
          // each chunk naively on '\n' would drop the incomplete tail,
          // causing content to silently disappear from fullOutput.
          // We accumulate into sseBuffer and only process complete
          // '\n\n'-terminated messages.
          let sseBuffer = ''

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })
            controller.enqueue(value)

            // AR-2: Append to buffer; split on double-newline (SSE message boundary).
            sseBuffer += chunk
            const messages = sseBuffer.split('\n\n')
            // Last element may be an incomplete message — carry it over.
            sseBuffer = messages.pop() ?? ''

            for (const message of messages) {
              for (const line of message.split('\n')) {
                if (!line.startsWith('data: ')) continue
                const dataStr = line.slice(6)
                if (dataStr === '[DONE]') continue
                try {
                  const parsed = JSON.parse(dataStr)
                  const content = parsed.choices?.[0]?.delta?.content || ''
                  fullOutput += content
                } catch { /* non-JSON or empty line — skip */ }
              }
            }
          }

          // AR-13: Use a regex instead of a literal string match so drift is
          // detected regardless of emoji variant (⚠ vs ⚠️), capitalisation, or
          // whether the phrase appears mid-response rather than at the very start.
          // The previous literal '⚠️ Scope alert:' (with variation selector ️)
          // missed models that emit the single-codepoint ⚠ (U+26A0) form.
          const hasDrift = /⚠️?\s*scope\s+alert:/i.test(fullOutput)
          // AR-8: Use a named SSE event type ('agent_meta') rather than embedding
          // the meta flag inside a regular 'data:' line. Consumers that only listen
          // to the default 'message' event (unnamed events) will silently ignore
          // this packet instead of rendering the raw JSON as visible text.
          controller.enqueue(
            new TextEncoder().encode(
              `event: agent_meta\ndata: ${JSON.stringify({ scopeDrift: hasDrift })}\n\n`
            )
          )
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))

          // h. Update Supabase on Completion
          await supabase
            .from('agent_runs')
            .update({
              status: 'complete',
              output: fullOutput,
              completed_at: new Date().toISOString(),
              tokens_used: Math.floor(fullOutput.length / 4)
            })
            .eq('id', run.id)

          // ── Increment prompt run_count (non-fatal) ──────────────────────
          if (promptData?.id) {
            try {
              const { error: rpcError } = await supabase.rpc('increment_prompt_run_count', {
                prompt_id: promptData.id,
              })
              if (rpcError) {
                // RPC may not exist yet or failed — fall back to manual increment
                const { data: currentPrompt } = await supabase
                  .from('prompts')
                  .select('run_count')
                  .eq('id', promptData!.id)
                  .single()
                await supabase.from('prompts').update({
                  run_count:    ((currentPrompt?.run_count ?? 0) + 1),
                  last_used_at: new Date().toISOString(),
                }).eq('id', promptData!.id)
              }
            } catch { /* non-fatal */ }
          }

          // ── Append to agent-runs.md changelog (non-fatal) ──────────────
          try {
            const now         = new Date()
            const dateStr     = now.toISOString().slice(0, 16).replace('T', ' ')
            const featureName = feature?.name ?? 'Unknown feature'
            const modelLabel  = `${provider}/${model}`
            const promptSlug  = (basePrompt as string).slice(0, 100).replace(/\n/g, ' ')

            const entry = `\n## ${dateStr} — ${featureName}${gitBranch ? ` (${gitBranch})` : ''}\n**Model:** ${modelLabel}\n**Prompt:** ${promptSlug}...\n**Status:** complete\n---\n`

            const { data: existing } = await supabase
              .from('contexts')
              .select('content')
              .eq('project_id', projectId)
              .eq('file_path', 'reminisce/logs/agent-runs.md')
              .single()

            const HEADER = '# Agent Runs Log\n\nAutomatically appended by Reminisce after each agent run.\n\n'
            const currentContent = existing?.content ?? HEADER

            // AR-7: Cap the log at ~50 KB to prevent the file from growing
            // unbounded over hundreds of runs. Beyond ~2 MB it would hit the
            // readFile guard in fsapi.ts and become unreadable by the local
            // sync engine. Trim from the top (oldest entries) so the most
            // recent history is always preserved.
            const MAX_LOG_CHARS = 50_000
            const combined = currentContent + entry
            const trimmedContent = combined.length > MAX_LOG_CHARS
              ? HEADER +
                '_(older entries trimmed — full history in git)_\n\n' +
                combined.slice(combined.length - MAX_LOG_CHARS)
              : combined

            await supabase.from('contexts').upsert(
              {
                project_id:    projectId,
                file_path:     'reminisce/logs/agent-runs.md',
                content:       trimmedContent,
                owned_by:      'developer',
                last_modified: now.toISOString(),
              },
              { onConflict: 'project_id,file_path' },
            )
          } catch { /* non-fatal */ }

          // Award first-run coins
          try {
            await awardCoins(
              user.id,
              'first_agent_run', 
              projectId
            )
          } catch { /* non-fatal */ }

        } catch (error) {
          console.error('Stream error:', error)
          await supabase
            .from('agent_runs')
            .update({ 
               status: 'failed', 
               output: fullOutput,
               error_message: error instanceof Error ? error.message : String(error)
            })
            .eq('id', run.id)

          // Refund on failure
          if (!isBYOK) {
            await refundCost(user.id, model, run?.id, validProvider)
          }
        } finally {
          controller.close()
        }
      }
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })

  } catch (error: unknown) {
    console.error('[agent/run] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
