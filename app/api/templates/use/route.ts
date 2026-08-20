import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, verifyProjectAccess, isUserBanned } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

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

    // TU-4: banned check
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // TU-1: guard JSON parse so bad body returns 400 not 500
    let body: { templateId?: string; projectId?: string; featureId?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { templateId, projectId, featureId } = body

    if (!templateId || !projectId)
      return NextResponse.json({ error: 'Missing templateId or projectId' }, { status: 400 })

    const sb = getServiceSupabase()

    // Verify the user owns the target project
    if (!await verifyProjectAccess(user.id, projectId))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Get the template — must belong to this user
    // R-5: use maybeSingle() so a missing row returns null/null not an error,
    // and check the error explicitly to distinguish DB failure from "not found"
    const { data: template, error: templateErr } = await sb
      .from('prompt_templates')
      .select('*')
      .eq('id', templateId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (templateErr) {
      console.error('[templates/use] fetch error:', templateErr)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!template)
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })

    // TU-3: scope featureId to the target project to prevent cross-project FK
    let resolvedFeatureId: string | null = null
    if (featureId) {
      const { data: feat } = await sb
        .from('features')
        .select('id')
        .eq('id', featureId)
        .eq('project_id', projectId)
        .maybeSingle()
      resolvedFeatureId = feat?.id ?? null
    }

    // Insert into project's prompts
    const { data: prompt, error } = await sb
      .from('prompts')
      .insert({
        project_id:        projectId,
        feature_id:        resolvedFeatureId,
        raw_prompt:        template.content,
        structured_prompt: template.content,
        prompt_type:       template.category,
      })
      .select()
      .single()

    if (error) {
      console.error('[templates/use] insert error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    // TU-2: atomic use_count increment — avoids TOCTOU race where two concurrent
    // calls both read use_count=n and both write n+1 instead of n+2
    await sb.rpc('increment_template_use_count', { p_template_id: templateId })

    return NextResponse.json({ success: true, prompt })
  } catch (err: unknown) {
    console.error('[templates/use] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
