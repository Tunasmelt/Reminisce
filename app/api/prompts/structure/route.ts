import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, verifyProjectAccess, isUserBanned, getProjectRole } from '@/lib/supabase'
import { callAI } from '@/lib/ai-client'
import { deductCost, refundCost, ensureWallet } from '@/lib/wallet'

export const dynamic = 'force-dynamic'

// PS-3: cap rawPrompt to avoid blowing the model's context window
const MAX_RAW_PROMPT_LENGTH = 8_000

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)
    if (!user || authError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // PS-4: banned check
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // PS-6: guard JSON parse so bad body returns 400 not 500
    let body: { rawPrompt?: string; projectId?: string; featureId?: string; provider?: string; model?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { rawPrompt, projectId, featureId, provider, model } = body

    if (!rawPrompt || !projectId || !provider || !model) {
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
    }

    // PS-3: cap rawPrompt length
    if (rawPrompt.length > MAX_RAW_PROMPT_LENGTH) {
      return NextResponse.json(
        { error: `Prompt exceeds maximum length of ${MAX_RAW_PROMPT_LENGTH} characters` },
        { status: 400 },
      )
    }

    if (!await verifyProjectAccess(user.id, projectId))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // PS-5: viewer role guard — viewers must not trigger AI calls or write prompts
    const role = await getProjectRole(user.id, projectId)
    if (role === 'viewer')
      return NextResponse.json({ error: 'Viewers cannot create prompts' }, { status: 403 })

    const supabase = getServiceSupabase()

    // 1. Detect Prompt Type
    let promptType = 'FEATURE_BUILD'
    const lowerRaw = rawPrompt.toLowerCase()
    if (lowerRaw.match(/fix|bug|error|broken|crash/)) promptType = 'BUG_FIX'
    else if (lowerRaw.match(/refactor|clean|restructure|optimize/)) promptType = 'REFACTOR'
    else if (lowerRaw.match(/test|endpoint|api|postman|swagger/)) promptType = 'API_TEST'
    else if (lowerRaw.match(/design|architect|system|structure/)) promptType = 'ARCHITECTURE'
    else if (lowerRaw.match(/build|implement|create|add|develop/)) promptType = 'FEATURE_BUILD'

    // 2. Load Context Files
    const contextPaths = ['reminisce/context/ai-governance.md', 'reminisce/context/architecture.md']
    
    // PS-2: featureId must belong to this project — scope the fetch to project_id
    // to prevent cross-project data leakage into the prompt context
    let featureData = null
    if (featureId) {
      const { data: feature } = await supabase
        .from('features')
        .select('*')
        .eq('id', featureId)
        .eq('project_id', projectId)
        .maybeSingle()
      featureData = feature
    }

    const { data: contexts } = await supabase
      .from('contexts')
      .select('file_path, content')
      .eq('project_id', projectId)
      .in('file_path', contextPaths)

    const archContent = contexts?.find(c => c.file_path.endsWith('architecture.md'))?.content || 'Architecture not defined.'
    const govContent = contexts?.find(c => c.file_path.endsWith('ai-governance.md'))?.content || 'AI constraints not defined.'

    // 3. Build Structured Template
    let expectedOutput = 'Full implementation with file paths and code.'
    if (promptType === 'BUG_FIX') expectedOutput = 'Patch-style fix with explanation.'
    else if (promptType === 'API_TEST') expectedOutput = 'Test cases + example requests.'
    else if (promptType === 'REFACTOR') expectedOutput = 'Refactored code with changes noted.'
    else if (promptType === 'ARCHITECTURE') expectedOutput = 'System design diagram + decisions.'

    const structuredTemplate = `
GOAL
${rawPrompt}

PROJECT CONTEXT
${archContent.substring(0, 500)}

FEATURE SCOPE
${featureData ? `${featureData.name}: ${featureData.description}` : 'N/A'}

CONSTRAINTS
${govContent.substring(0, 300)}

EXPECTED OUTPUT
${expectedOutput}
`.trim()

    // PS-1: deduct cost before AI call — this endpoint was previously a free
    // AI call; now it follows the standard deduct-before-call / refund-on-error
    // pattern used by agent/run and wizard/chat
    await ensureWallet(user.id)
    const structureRunId = `prompt-structure-${user.id}-${Date.now()}`
    let deducted = false
    try {
      const costResult = await deductCost(user.id, model, structureRunId)
      if (!costResult.success) {
        return NextResponse.json({ error: costResult.message }, { status: 402 })
      }
      deducted = true
    } catch (deductErr) {
      console.error('[prompts/structure] deductCost failed:', deductErr)
      // Non-fatal — proceed; the AI call is low-cost and this is a best-effort charge
    }

    // 4. Call AI to improve
    let aiResponse
    try {
      aiResponse = await callAI({
        userId: user.id,
        provider: provider as import('@/lib/ai-client').AIProvider,
        model,
        messages: [
          {
            role: 'system',
            content: 'You are Codeck, a prompt engineering assistant. Take the raw developer prompt and context provided and rewrite it as a clear, structured, production-ready AI development prompt. Be specific, include file paths if relevant, and make the expected output explicit. Return ONLY the final structured prompt, no conversational filler.'
          },
          {
            role: 'user',
            content: structuredTemplate
          }
        ]
      })
    } catch (aiErr) {
      // Refund if deduction succeeded but AI call failed
      if (deducted) {
        try { await refundCost(user.id, model, structureRunId) } catch { /* non-fatal */ }
      }
      throw aiErr
    }

    const finalPrompter = aiResponse.choices?.[0]?.message?.content || aiResponse.text || 'Error generating prompt.'

    // 5. Save to database
    // R-2: use featureData?.id — not the raw body featureId — so the FK value
    // is always the project-scoped, DB-validated id. If the body featureId
    // belonged to another project featureData is null and we insert null here.
    const { data: newPrompt, error: saveErr } = await supabase
      .from('prompts')
      .insert({
        project_id: projectId,
        feature_id: featureData?.id ?? null,
        raw_prompt: rawPrompt,
        structured_prompt: finalPrompter,
        prompt_type: promptType,
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    if (saveErr) throw saveErr

    return NextResponse.json({
      promptId: newPrompt.id,
      structuredPrompt: finalPrompter,
      promptType
    })

  } catch (error: unknown) {
    console.error('[prompts/structure] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
