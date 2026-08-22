import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, verifyProjectAccess, getProjectRole } from '@/lib/supabase'
import { callAI, userHasOwnKey } from '@/lib/ai-client'
import type { AIProvider } from '@/lib/ai-client'
import { deductCost, refundCost, ensureWallet, getUserPlan } from '@/lib/wallet'
import { getModel } from '@/lib/model-registry'
import { canUseModel } from '@/lib/model-permissions'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
//  Smart context loader
//  Detects keywords in the user message and returns the file paths
//  that should be fully loaded for this turn.
//  All other files get summary-only injection to save tokens.
// ─────────────────────────────────────────────────────────────────────────────

const SMART_LOAD_RULES: Array<{ keywords: RegExp; filePath: string }> = [
  {
    keywords: /architect|component|system design|data flow|structure|integrat/i,
    filePath: 'reminisce/context/architecture.md',
  },
  {
    keywords: /stack|framework|library|dependenc|version|package|npm|pip|install/i,
    filePath: 'reminisce/context/tech-stack.md',
  },
  {
    keywords: /convention|style|pattern|folder|naming|guideline|lint|format/i,
    filePath: 'reminisce/context/coding-guidelines.md',
  },
  {
    keywords: /scope|v1|out of scope|roadmap|success metric|what.*build|should.*include/i,
    filePath: 'reminisce/context/product-scope.md',
  },
]

function detectSmartLoadPaths(userMessage: string): string[] {
  return SMART_LOAD_RULES
    .filter(rule => rule.keywords.test(userMessage))
    .map(rule => rule.filePath)
}

// ─────────────────────────────────────────────────────────────────────────────
//  System prompt builder — tiered context injection
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(ctx: {
  projectName:       string
  projectDesc:       string | null
  gitBranch:         string | null
  gitLastCommit:     string | null
  phases:            Array<{ name: string; status: string; featureCount: number }>
  features:          Array<{ name: string; status: string; phase: string; type: string }>
  // Summaries: all context files, one paragraph each (~100 chars)
  contextSummaries:  Array<{ file_path: string; summary: string }>
  // Full content: only smart-loaded files for this turn
  contextFull:       Array<{ file_path: string; content: string }>
  // Workflow files always loaded in full (they are concise by design)
  workflowPhases:    string | null   // reminisce/workflow/phases.md content
  workflowFeatures:  string | null   // reminisce/workflow/features.md content
  currentDate:       string
  pastMemory:        Array<{ summary: string; created_at: string }>
  semanticMemory?:   string[]
}): string {
  // ── Phase + feature summary ──────────────────────────────────────────────
  const phasesSummary = ctx.phases.length > 0
    ? ctx.phases.map(p => {
        const done = ctx.features.filter(
          f => f.phase === p.name &&
               (f.status === 'done' || f.status === 'complete'),
        ).length
        const pct = p.featureCount > 0
          ? Math.round((done / p.featureCount) * 100)
          : 0
        return `  - ${p.name} [${p.status}] — ${done}/${p.featureCount} features (${pct}% done)`
      }).join('\n')
    : '  (no phases yet — run the Wizard to generate a blueprint)'

  const featuresSummary = ctx.features.length > 0
    ? ctx.features.map(f =>
        `  - ${f.name} [${f.status}] (${f.type}) → ${f.phase}`,
      ).join('\n')
    : '  (no features yet)'

  // ── Tiered context injection ─────────────────────────────────────────────
  // Tier 1: always inject — one-paragraph summaries for all context files
  const summaryBlock = ctx.contextSummaries.length > 0
    ? '## Context File Summaries (reference these files for detailed info)\n' +
      ctx.contextSummaries.map(c =>
        `### ${c.file_path}\n${c.summary}`
      ).join('\n\n')
    : ''

  // Tier 2: smart-loaded — full content for files relevant to this turn
  const fullBlock = ctx.contextFull.length > 0
    ? '## Loaded Context Files (full content for this turn)\n' +
      ctx.contextFull.map(c =>
        `### ${c.file_path}\n${c.content}`
      ).join('\n\n---\n\n')
    : ''

  // Tier 3: workflow files always in full (they are auto-generated and concise)
  const workflowBlock = [
    ctx.workflowPhases
      ? `### reminisce/workflow/phases.md\n${ctx.workflowPhases}`
      : null,
    ctx.workflowFeatures
      ? `### reminisce/workflow/features.md\n${ctx.workflowFeatures}`
      : null,
  ].filter(Boolean).join('\n\n')

  // ── Git state ────────────────────────────────────────────────────────────
  const gitBlock = (ctx.gitBranch || ctx.gitLastCommit)
    ? `Current branch: ${ctx.gitBranch ?? 'unknown'}\nLast commit: ${ctx.gitLastCommit ?? 'unknown'}`
    : ''

  // Tier 0: semantic memory (most relevant fragments)
  const semanticBlock = ctx.semanticMemory && ctx.semanticMemory.length > 0
    ? `## Semantic Memory (most relevant to this message)\n${ctx.semanticMemory.join('\n\n---\n\n')}\n\n`
    : ''

  // ── Past memory ──────────────────────────────────────────────────────────
  const memoryBlock = ctx.pastMemory.length > 0
    ? 'Memory from previous conversations:\n' +
      ctx.pastMemory.map((m, i) =>
        `[${i + 1}] ${new Date(m.created_at).toLocaleDateString()} — ${m.summary}`
      ).join('\n')
    : ''

  return `You are PAM — Project Action Manager — the embedded AI assistant inside Reminisce, a developer project management platform.

PAM's personality:
- Direct, precise, and useful. No padding, no filler.
- Speaks like a sharp senior colleague who knows the project inside out.
- Proactively spots issues and makes concrete suggestions.
- When uncertain, asks one focused clarifying question rather than guessing.

PAM's capabilities:
- Answer any question about the project using the full context below.
- Summarise progress, phases, and feature status.
- Suggest next steps, identify risks, and give architectural opinions.
- Generate development prompts on request (user can save them).
- Explain what any feature or phase involves.
- Give a full project status briefing on request.
- Users can prefix messages with /commands for fast actions:
    /status or /briefing       → full project status report
    /done @feature:[name]      → mark a feature as done (emit UPDATE_FEATURE_STATUS)
    /active @feature:[name]    → start a feature (emit UPDATE_FEATURE_STATUS)
    /block @feature:[name]     → mark a feature as blocked (emit UPDATE_FEATURE_STATUS)
    /prompt @feature:[name]    → generate a build prompt for that feature
    /add [feature] to @phase:[name] → add a new feature to a phase
    /remind [text] on [date]   → create a project reminder
- Users can @mention features or phases to scope their question.
  Example: "@feature:Auth Flow — what's the best approach for OAuth2?"

SCOPE AWARENESS:
You have access to product-scope.md (summary below, full content loaded when relevant).
If a user requests something that appears outside the defined v1 scope, warn them before proceeding:
"⚠️ Scope alert: [requested thing] wasn't in your original blueprint scope. Adding it may impact [affected phase]. Do you want to proceed or keep it noted for v2?"
Only raise this alert when you are confident the request contradicts the scope — do not over-trigger.

ACTIONS:
When PAM proposes to UPDATE something, it MUST emit a structured action signal at the END of its response:

[PAM_ACTION]
{"type":"UPDATE_FEATURE_STATUS","featureId":"<uuid>","featureName":"<name>","newStatus":"<status>"}
[/PAM_ACTION]

[PAM_ACTION]
{"type":"UPDATE_PHASE_STATUS","phaseId":"<uuid>","phaseName":"<name>","newStatus":"<status>"}
[/PAM_ACTION]

[PAM_ACTION]
{"type":"CREATE_PROMPT","featureName":"<name>","featureId":"<uuid or null>","promptText":"<full prompt>"}
[/PAM_ACTION]

[PAM_ACTION]
{"type":"ADD_FEATURE","phaseName":"<name>","phaseId":"<uuid>","featureName":"<new name>","featureType":"frontend","description":"<brief description>"}
[/PAM_ACTION]

[PAM_ACTION]
{"type":"CREATE_REMINDER","text":"<reminder text>","due_date":"<YYYY-MM-DD or null>"}
[/PAM_ACTION]

Valid status values: planned | todo | in_progress | review | blocked | done
Only emit [PAM_ACTION] when the user explicitly asks PAM to update something.
Never emit it speculatively. Always confirm the action in your text before emitting.

═══════════════════════════════════════
PROJECT: ${ctx.projectName}
DATE: ${ctx.currentDate}
${ctx.projectDesc ? `DESCRIPTION: ${ctx.projectDesc}` : ''}
${gitBlock ? `\nGIT:\n${gitBlock}` : ''}

PHASES:
${phasesSummary}

FEATURES:
${featuresSummary}
${workflowBlock ? `\nWORKFLOW:\n${workflowBlock}` : ''}
${summaryBlock ? `\n${summaryBlock}` : ''}
${fullBlock ? `\n${fullBlock}` : ''}
${semanticBlock ? `\n${semanticBlock}` : ''}
${memoryBlock ? `\n${memoryBlock}` : ''}
═══════════════════════════════════════

When answering, draw on the project context above. If the user asks about something
not covered by the context, say so clearly rather than guessing.`
}

// ─────────────────────────────────────────────────────────────────────────────
//  Action signal parser
// ─────────────────────────────────────────────────────────────────────────────

// P-8: Use global replace so ALL [PAM_ACTION] blocks are stripped from the
// displayed text — PAM may emit multiple blocks for compound commands but we
// only execute the first one to avoid ambiguity.
function extractAction(text: string): {
  cleanText: string
  actionType: string | null
  actionPayload: Record<string, unknown> | null
} {
  const match = text.match(/\[PAM_ACTION\]([\s\S]*?)\[\/PAM_ACTION\]/m)
  // Always strip every action block from display text (global flag 'g')
  const cleanText = text.replace(/\[PAM_ACTION\][\s\S]*?\[\/PAM_ACTION\]/gm, '').trim()

  if (!match) return { cleanText, actionType: null, actionPayload: null }

  const jsonStr = match[1].trim()

  try {
    const payload = JSON.parse(jsonStr) as Record<string, unknown>
    return {
      cleanText,
      actionType: (payload.type as string) ?? null,
      actionPayload: payload,
    }
  } catch {
    return { cleanText, actionType: null, actionPayload: null }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Changelog appender — writes to changes.md in contexts table
//  Non-fatal: if this fails the action still completes
// ─────────────────────────────────────────────────────────────────────────────

async function appendToChangelog(
  supabase: ReturnType<typeof getServiceSupabase>,
  projectId: string,
  entry: string,
): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from('contexts')
      .select('content')
      .eq('project_id', projectId)
      .eq('file_path', 'reminisce/logs/changes.md')
      .single()

    const currentContent = existing?.content ??
      '# Project Changes Log\n\nAutomatically appended by Reminisce when PAM makes project changes.\n\n'

    const updated = currentContent + entry

    await supabase.from('contexts').upsert(
      {
        project_id:    projectId,
        file_path:     'reminisce/logs/changes.md',
        content:       updated,
        owned_by:      'developer',
        last_modified: new Date().toISOString(),
      },
      { onConflict: 'project_id,file_path' },
    )
  } catch (err) {
    console.error('[PAM] changelog append failed:', err)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/pam/message
//  Sends a user message, streams PAM response, saves both to DB.
// ─────────────────────────────────────────────────────────────────────────────

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

    // Check if user is banned
    const { isUserBanned } = await import('@/lib/supabase')
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // PM-1: Guard JSON parse so a malformed body returns 400 not 500.
    let pamBody: { threadId?: string; projectId?: string; provider?: string; model?: string; content?: string }
    try {
      pamBody = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { threadId, projectId, provider, model, content } = pamBody

    if (!threadId || !projectId || !provider || !model || !content?.trim())
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })

    // PM-2: Cap message length to prevent excessively large system prompts and
    // runaway token usage. 12,000 chars ≈ ~3,000 tokens — generous for any
    // single chat turn while still bounding server-side token costs.
    const MAX_MESSAGE_LENGTH = 12_000
    if (content.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json(
        { error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` },
        { status: 400 },
      )
    }

    if (!await verifyProjectAccess(user.id, projectId))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const role = await getProjectRole(user.id, projectId)
    if (role === 'viewer') {
      return NextResponse.json(
        { error: 'Viewers cannot send PAM messages' },
        { status: 403 }
      )
    }

    // P-5: Isolate ensureWallet so a setup failure returns a clear 500
    // immediately, before any deduction or DB work begins.
    try {
      await ensureWallet(user.id)
    } catch (walletSetupErr) {
      console.error('[pam/message] ensureWallet failed:', walletSetupErr)
      return NextResponse.json(
        { error: 'Failed to initialise wallet. Please try again.' },
        { status: 500 },
      )
    }

    const supabase = getServiceSupabase()

    // ── Thread ownership check ────────────────────────────────────────────
    // Verify the thread belongs to this user AND this project
    const { data: threadRow, error: threadErr } = await supabase
      .from('pam_threads')
      .select('id, user_id, project_id')
      .eq('id', threadId)
      .single()

    if (threadErr || !threadRow) {
      return NextResponse.json(
        { error: 'Thread not found' },
        { status: 404 }
      )
    }

    if (threadRow.user_id !== user.id || threadRow.project_id !== projectId) {
      return NextResponse.json(
        { error: 'Forbidden: thread does not belong to you' },
        { status: 403 }
      )
    }

    // ── BYOK check ───────────────────────────────────────────────────────
    const isBYOK = await userHasOwnKey(user.id, provider as AIProvider)

    // ── Model permission gate (A2) ────────────────────────────────────────
    // Enforce enabled + tier BEFORE any charge, via the shared resolver (the
    // same gate agent/run uses). Applies to BYOK users too — a disabled model is
    // rejected for everyone; BYOK bypasses only tier gating. Plain-JSON response
    // matches this route's other pre-flight failures (e.g. the 402 balance path).
    {
      const modelDef = await getModel(provider, model)
      const userPlan = await getUserPlan(user.id)
      const perm = canUseModel({ plan: userPlan.plan, isBYOK }, modelDef)
      if (!perm.ok) {
        return NextResponse.json({ error: perm.reason }, { status: perm.status })
      }
    }

    if (!isBYOK) {
      // P-6: Wrap deductCost so a DB failure mid-deduction returns a clear
      // error rather than falling through to callAI with an uncommitted charge.
      try {
        const costResult = await deductCost(user.id, model)
        if (!costResult.success)
          return NextResponse.json({ error: costResult.message }, { status: 402 })
      } catch (err) {
        console.error('[pam/message] deductCost failed:', err)
        return NextResponse.json({ error: 'Failed to process payment' }, { status: 500 })
      }
    }

    // ── Detect which files to smart-load for this turn ──────────────────────
    const smartLoadPaths = detectSmartLoadPaths(content)

    // ── Load all context in parallel ────────────────────────────────────────
    const [
      { data: project },
      { data: phases },
      { data: features },
      { data: allContextRows },
      { data: previousMessages },
      { data: pastSummaries },
    ] = await Promise.all([
      // Now also loads git_branch and git_last_commit (Phase 1 columns)
      supabase
        .from('projects')
        .select('name, description, git_branch, git_last_commit')
        .eq('id', projectId)
        .single(),
      supabase
        .from('phases')
        .select('id, name, status, order_index')
        .eq('project_id', projectId)
        .order('order_index'),
      supabase
        .from('features')
        .select('id, name, status, type, phase_id, phases(name)')
        .eq('project_id', projectId)
        .order('priority'),
      // Load summary + content for all context files
      // summary for all, full content only for smart-loaded files
      supabase
        .from('contexts')
        .select('file_path, summary, content')
        .eq('project_id', projectId),
      supabase
        .from('pam_messages')
        .select('role, content')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true })
        .limit(40),
      supabase
        .from('pam_thread_summaries')
        .select('summary, created_at')
        .eq('project_id', projectId)
        .neq('thread_id', threadId)
        .order('created_at', { ascending: false })
        .limit(4),
    ])

    // ── Semantic search ─────────────────────────────────────────────────────
    let semanticMemory: string[] = []
    try {
      const { searchMemory } = await import('@/lib/vector-memory')
      const chunks = await searchMemory(projectId, content.trim(), 3)
      if (chunks.length > 0) {
        semanticMemory = chunks
          .filter(c => c.similarity > 0.75) // only high-confidence
          .map(c => `[Memory — ${c.sourceType}${c.sourcePath ? ` / ${c.sourcePath}` : ''}]\n${c.content}`)
      }
    } catch (semanticErr) {
      // P-18: Log rather than silently swallow — a missing OPENAI_API_KEY or
      // pgvector misconfiguration causes PAM to silently degrade without any
      // server-side signal. This surfaces it without blocking the request.
      console.warn('[pam/message] semantic search failed (non-fatal):', semanticErr)
    }

    // ── Save user message ───────────────────────────────────────────────────
    await supabase
      .from('pam_messages')
      .insert({
        thread_id:  threadId,
        project_id: projectId,
        role:       'user',
        content:    content.trim(),
      })
      .select('id')
      .single()

    // ── Build tiered context ────────────────────────────────────────────────
    const allRows = allContextRows ?? []

    // Summaries: all files that have a summary — injected every turn
    const contextSummaries = allRows
      .filter(r =>
        r.summary &&
        r.summary.trim().length > 0 &&
        !r.file_path.includes('/workflow/') &&
        !r.file_path.includes('/logs/'),
      )
      .map(r => ({ file_path: r.file_path, summary: r.summary! }))

    // Full content: only smart-loaded files this turn
    const contextFull = allRows
      .filter(r =>
        smartLoadPaths.includes(r.file_path) &&
        r.content &&
        r.content.trim().length > 0,
      )
      .map(r => ({ file_path: r.file_path, content: r.content! }))

    // Workflow files: always inject in full (they are short by design)
    const workflowPhases = allRows
      .find(r => r.file_path === 'reminisce/workflow/phases.md')?.content ?? null
    const workflowFeatures = allRows
      .find(r => r.file_path === 'reminisce/workflow/features.md')?.content ?? null

    // ── Build phase context with feature counts ─────────────────────────────
    const phasesWithCount = (phases ?? []).map(p => ({
      name:         p.name,
      status:       p.status ?? 'planned',
      featureCount: (features ?? []).filter(f => f.phase_id === p.id).length,
    }))

    const flatFeatures = (features ?? []).map(f => ({
      id:     f.id,
      name:   f.name,
      status: f.status ?? 'planned',
      type:   f.type ?? 'frontend',
      phase:  (
        Array.isArray(f.phases)
          ? (f.phases[0] as { name: string })?.name
          : (f.phases as unknown as { name: string })?.name
      ) ?? 'Unknown',
    }))

    // ── Build system prompt ─────────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt({
      projectName:      project?.name ?? 'Unknown Project',
      projectDesc:      project?.description ?? null,
      gitBranch:        (project as { git_branch?: string | null } | null)?.git_branch ?? null,
      gitLastCommit:    (project as { git_last_commit?: string | null } | null)?.git_last_commit ?? null,
      phases:           phasesWithCount,
      features:         flatFeatures,
      contextSummaries,
      contextFull,
      workflowPhases,
      workflowFeatures,
      currentDate: new Date().toLocaleDateString('en-GB', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      }),
      pastMemory: (pastSummaries ?? []).map(s => ({
        summary:    s.summary,
        created_at: s.created_at,
      })),
      semanticMemory,
    })

    // ── Build message array ─────────────────────────────────────────────────
    const history = (previousMessages ?? []).map(m => ({
      role:    m.role as 'user' | 'assistant',
      content: m.content,
    }))

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history,
      { role: 'user' as const, content: content.trim() },
    ]

    // ── Call AI ─────────────────────────────────────────────────────────────
    let aiRes: Response
    try {
      aiRes = await callAI({
        userId:   user.id,
        provider: provider as AIProvider,
        model,
        stream:   true,
        messages,
      }) as Response
    } catch (aiErr) {
      // P-22: PAM messages are not tracked in agent_runs, so runId is always
      // null here. refundCost works without a run_id — the refund transaction
      // simply has no run link in the audit trail, which is acceptable for PAM.
      if (!isBYOK) await refundCost(user.id, model)
      throw aiErr
    }

    const decoder = new TextDecoder()

    const stream = new ReadableStream({
      async start(controller) {
        let fullText = ''
        const reader = aiRes.body?.getReader()
        if (!reader) { controller.close(); return }

        try {
          // P-21: Carry-over buffer for fragmented SSE delivery — same pattern
          // as agent/run (AR-2). A TCP chunk may contain a partial SSE line;
          // splitting each chunk naively on '\n' drops the incomplete tail.
          // We accumulate into sseBuffer and only process '\n\n'-terminated
          // complete SSE messages.
          let sseBuffer = ''

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const chunk = decoder.decode(value, { stream: true })
            controller.enqueue(value)

            sseBuffer += chunk
            const messages = sseBuffer.split('\n\n')
            sseBuffer = messages.pop() ?? ''

            for (const message of messages) {
              for (const line of message.split('\n')) {
                if (!line.startsWith('data: ')) continue
                const data = line.slice(6)
                if (data === '[DONE]') continue
                try {
                  const parsed = JSON.parse(data)
                  fullText += parsed.choices?.[0]?.delta?.content ?? ''
                } catch { /* partial chunk */ }
              }
            }
          }

          // ── Parse action signal ─────────────────────────────────────────
          const { cleanText, actionType, actionPayload } = extractAction(fullText)

          // ── Save assistant message ──────────────────────────────────────
          await supabase.from('pam_messages').insert({
            thread_id:        threadId,
            project_id:       projectId,
            role:             'assistant',
            content:          cleanText,
            model_used:       `${provider}/${model}`,
            tokens_used:      Math.floor(fullText.length / 4),
            action_type:      actionType,
            action_payload:   actionPayload,
            action_confirmed: actionType ? null : undefined,
          })

          // ── Update thread metadata ──────────────────────────────────────
          await supabase.from('pam_threads').update({
            model_used:      `${provider}/${model}`,
            provider_used:   provider,
            last_message_at: new Date().toISOString(),
          }).eq('id', threadId)

          // ── Send meta event to client ───────────────────────────────────
          // P-24: Use regex instead of literal string — same fix as AR-13 in
          // agent/run. Models may emit ⚠ (U+26A0, no variation selector) rather
          // than ⚠️ (U+26A0 + U+FE0F), causing the literal includes() to miss it.
          const hasDrift = /⚠️?\s*scope\s+alert:/i.test(fullText)
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                __pam_meta: true,
                scopeDrift: hasDrift,
              })}\n\n`,
            ),
          )

          if (actionType && actionPayload) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ __pam_action: true, actionType, actionPayload })}\n\n`,
              ),
            )
          }

          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        } catch (err) {
          console.error('PAM stream error:', err)
          if (!isBYOK) await refundCost(user.id, model) // P-22: no run_id for PAM — see note above
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      },
    })
  } catch (err: unknown) {
    console.error('[pam/message POST] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// P-2: Allowed values for feature and phase status fields.
// Any PAM action payload that carries a different value is rejected before
// the DB write so prompt-injection or malformed AI output can't write
// arbitrary strings into features.status / phases.status.
const VALID_STATUSES = new Set([
  'planned', 'todo', 'in_progress', 'review', 'blocked', 'done',
])

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /api/pam/message
//  Confirms or rejects a pending PAM action.
//  On confirm: executes DB write + appends to changes.md changelog.
// ─────────────────────────────────────────────────────────────────────────────

export async function PATCH(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } =
      await clientSupabase.auth.getUser(token)
    if (!user || authError)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { messageId, confirmed } = await req.json()
    if (!messageId || typeof confirmed !== 'boolean')
      return NextResponse.json({ error: 'Missing messageId or confirmed' }, { status: 400 })

    const supabase = getServiceSupabase()

    const { data: msg } = await supabase
      .from('pam_messages')
      // P-1: also select action_confirmed (idempotency check)
      // P-4: also select thread_id (ownership check)
      .select('action_type, action_payload, action_confirmed, project_id, thread_id')
      .eq('id', messageId)
      .single()

    if (!msg || !await verifyProjectAccess(user.id, msg.project_id))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // P-4: Verify the calling user owns the thread — project collaborators
    // should not be able to confirm/reject another user's PAM actions.
    const { data: threadOwner } = await supabase
      .from('pam_threads')
      .select('user_id')
      .eq('id', msg.thread_id as string)
      .single()
    if (!threadOwner || threadOwner.user_id !== user.id)
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // P-11: Viewers cannot execute PAM actions that mutate project data.
    const userRole = await getProjectRole(user.id, msg.project_id as string)
    if (userRole === 'viewer')
      return NextResponse.json(
        { error: 'Viewers cannot confirm PAM actions' },
        { status: 403 },
      )

    // P-1: Idempotency guard — if already confirmed or rejected, return early
    // without re-executing. Prevents duplicate inserts from concurrent PATCHes.
    if (msg.action_confirmed !== null && msg.action_confirmed !== undefined)
      return NextResponse.json({ ok: true, executed: msg.action_confirmed as boolean, skipped: true })

    // Rejection path: persist immediately and return — no action to execute.
    if (!confirmed) {
      await supabase.from('pam_messages')
        .update({ action_confirmed: false })
        .eq('id', messageId)
      return NextResponse.json({ ok: true, executed: false })
    }

    // P-30: Do NOT persist action_confirmed = true until AFTER the action
    // executes successfully. The previous order wrote confirmed=true first,
    // then ran the switch — if the switch threw, the message was permanently
    // marked confirmed with no actual DB change, with no way to retry.

    const payload    = msg.action_payload as Record<string, unknown>
    const projectId  = msg.project_id as string
    const now        = new Date()
    const dateStr    = now.toISOString().slice(0, 16).replace('T', ' ')

    // Load git_branch for changelog entries
    const { data: proj } = await supabase
      .from('projects')
      .select('git_branch')
      .eq('id', projectId)
      .single()
    const branch = (proj as { git_branch?: string | null } | null)?.git_branch ?? null

    let changelogEntry = ''

    switch (msg.action_type) {
      case 'UPDATE_FEATURE_STATUS': {
        const { featureId, newStatus, featureName } = payload
        // P-2: Reject unrecognised status strings before writing to DB.
        if (!VALID_STATUSES.has(newStatus as string))
          return NextResponse.json(
            { error: `Invalid status value: "${newStatus}". Must be one of: ${Array.from(VALID_STATUSES).join(', ')}` },
            { status: 400 },
          )
        // P-25: Only write the changelog (and the ID-based update) when featureId
        // is present. When absent, the name-based fallback below is the actual
        // write path — emitting the changelog unconditionally would record a
        // successful update even when the ID-based write matched zero rows.
        if (featureId) {
          await supabase.from('features')
            .update({ status: newStatus as string })
            .eq('id', featureId as string)
            .eq('project_id', projectId)
          changelogEntry = `\n## ${dateStr} — Feature Status Update${branch ? ` (${branch})` : ''}\n**Action:** UPDATE_FEATURE_STATUS\n**Feature:** ${featureName} → \`${newStatus}\`\n---\n`
        }
        break
      }
      case 'UPDATE_PHASE_STATUS': {
        const { phaseId, newStatus, phaseName } = payload
        // P-2: Same enum guard for phase status.
        if (!VALID_STATUSES.has(newStatus as string))
          return NextResponse.json(
            { error: `Invalid status value: "${newStatus}". Must be one of: ${Array.from(VALID_STATUSES).join(', ')}` },
            { status: 400 },
          )
        await supabase.from('phases')
          .update({ status: newStatus as string })
          .eq('id', phaseId as string)
          .eq('project_id', projectId)
        changelogEntry = `\n## ${dateStr} — Phase Status Update${branch ? ` (${branch})` : ''}\n**Action:** UPDATE_PHASE_STATUS\n**Phase:** ${phaseName} → \`${newStatus}\`\n---\n`
        break
      }
      case 'CREATE_PROMPT': {
        const { featureId, promptText, featureName } = payload
        // P-27: Cap prompt text at 20 KB — a runaway model response could
        // insert an extremely large row that degrades prompt list performance.
        const safePromptText = (promptText as string).slice(0, 20_000)
        await supabase.from('prompts').insert({
          project_id:        projectId,
          feature_id:        featureId ?? null,
          raw_prompt:        safePromptText,
          structured_prompt: safePromptText,
          prompt_type:       'PAM_GENERATED',
          title:             `PAM: ${featureName ?? 'Generated prompt'}`,
        })
        changelogEntry = `\n## ${dateStr} — Prompt Created${branch ? ` (${branch})` : ''}\n**Action:** CREATE_PROMPT\n**Feature:** ${featureName}\n---\n`
        break
      }
      case 'ADD_FEATURE': {
        const { phaseId, featureName, featureType, description } = payload
        const { data: phase } = await supabase
          .from('phases')
          .select('id')
          .eq('id', phaseId as string)
          .eq('project_id', projectId)
          .single()
        // P-7: Return a real error when the phase doesn't exist or doesn't
        // belong to this project — previously this silently returned ok:true
        // while skipping the insert entirely.
        if (!phase)
          return NextResponse.json(
            { error: 'Phase not found or does not belong to this project' },
            { status: 404 },
          )
        await supabase.from('features').insert({
          project_id:  projectId,
          phase_id:    phaseId as string,
          name:        featureName as string,
          type:        (featureType as string) ?? 'frontend',
          description: (description as string) ?? null,
          status:      'planned',
          priority:    0,
        })
        changelogEntry = `\n## ${dateStr} — Feature Added${branch ? ` (${branch})` : ''}\n**Action:** ADD_FEATURE\n**Feature:** ${featureName} (${featureType}) added to phase ${(payload.phaseName as string) ?? ''}\n---\n`
        break
      }
      case 'CREATE_REMINDER': {
        const { text, due_date } = payload
        // P-13: Use 'message' and 'remind_at' — the actual DB column names
        // (matching GET /pam/reminders). The previous code used 'text' and
        // 'due_date' which silently inserted into the wrong columns.
        await supabase.from('project_reminders').insert({
          project_id: projectId,
          user_id:    user.id,
          message:    (text as string).trim(),
          remind_at:  (due_date as string) ?? null,
        })
        // Reminders don't go in changelog — they're ephemeral
        break
      }
    }

    // ── Name-based fallback for UPDATE_FEATURE_STATUS ─────────────────────────
    // P-16: Only run when featureId was absent from the AI payload — i.e. the
    // ID-based update above had nothing to target. Previously this ran
    // unconditionally, producing a second write on every confirm and risking
    // updating the wrong feature when two features share a similar name.
    if (
      msg.action_type === 'UPDATE_FEATURE_STATUS' &&
      payload?.featureName &&
      !payload?.featureId   // ← fallback only when ID was missing
    ) {
      const { newStatus, featureName } = payload
      const { data: matchedFeature } = await supabase
        .from('features')
        .select('id')
        .eq('project_id', projectId)
        .ilike('name', (featureName as string).trim())
        .limit(1)
        .maybeSingle()

      if (matchedFeature?.id) {
        await supabase
          .from('features')
          .update({ status: newStatus as string })
          .eq('id', matchedFeature.id)
        // P-25: Write changelog for the name-based path too, now that we know
        // the update actually targeted a real row.
        changelogEntry = `\n## ${dateStr} — Feature Status Update${branch ? ` (${branch})` : ''}\n**Action:** UPDATE_FEATURE_STATUS\n**Feature:** ${featureName} → \`${newStatus}\`\n---\n`
      }
    }

    // Append to changes.md — non-fatal
    if (changelogEntry) {
      await appendToChangelog(supabase, projectId, changelogEntry)
    }

    // P-30: Mark action confirmed only after all mutations succeeded.
    // If the switch or fallback threw, we never reach this line — the message
    // stays with action_confirmed=null so the user can retry.
    await supabase.from('pam_messages')
      .update({ action_confirmed: true })
      .eq('id', messageId)

    return NextResponse.json({ ok: true, executed: true })
  } catch (err: unknown) {
    console.error('[pam/message PATCH] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
