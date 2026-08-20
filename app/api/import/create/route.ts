import { NextResponse } from 'next/server'
import { supabase as clientSupabase, getServiceSupabase, isUserBanned } from '@/lib/supabase'
import { canCreateProject } from '@/lib/wallet'
import type { ScanResult } from '@/lib/project-scanner'
import type { ScannedPhase } from '@/lib/phase-grouper'

// R-1: moved after imports — const declarations must not precede import statements
// IC-1/IC-2: caps to prevent runaway bulk inserts from a crafted scanResult body
const MAX_PHASES   = 20
const MAX_FEATURES = 200
const MAX_PROJECT_NAME_LENGTH = 120

export const dynamic = 'force-dynamic'

// POST /api/import/create
// Body: { scanResult: ScanResult & { phases: ScannedPhase[] }, workspaceId: string, generateContextFiles: boolean }
// Creates: project + phases + features + (optionally) context files
export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authErr } = await clientSupabase.auth.getUser(token)
  if (!user || authErr) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // IC-3: banned check
  if (await isUserBanned(user.id))
    return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

  // Check project limit
  const check = await canCreateProject(user.id)
  if (!check.allowed) {
    return NextResponse.json(
      { error: check.reason, code: 'PROJECT_LIMIT_REACHED', current: check.current, limit: check.limit },
      { status: 403 }
    )
  }

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const { scanResult, workspaceId, generateContextFiles = true } = body as {
    scanResult: ScanResult & { phases: ScannedPhase[] }
    workspaceId: string
    generateContextFiles: boolean
  }

  if (!scanResult || !workspaceId) {
    return NextResponse.json({ error: 'Missing scanResult or workspaceId' }, { status: 400 })
  }

  // IC-1: cap project name length
  if (scanResult.name && scanResult.name.length > MAX_PROJECT_NAME_LENGTH) {
    scanResult.name = scanResult.name.slice(0, MAX_PROJECT_NAME_LENGTH)
  }

  // IC-2: cap phases and features to prevent runaway bulk inserts from crafted bodies
  if (Array.isArray(scanResult.phases)) {
    scanResult.phases = scanResult.phases.slice(0, MAX_PHASES).map(phase => ({
      ...phase,
      features: Array.isArray(phase.features) ? phase.features.slice(0, MAX_FEATURES) : [],
    }))
  }

  const sb = getServiceSupabase()

  // Verify workspace ownership
  const { data: ws, error: wsErr } = await sb
    .from('workspaces')
    .select('id, owner_id')
    .eq('id', workspaceId)
    .single()

  if (wsErr || !ws) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  if (ws.owner_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    // 1. Create project
    const { data: project, error: projErr } = await sb
      .from('projects')
      .insert({
        workspace_id: workspaceId,
        name: scanResult.name,
        description: scanResult.description || null,
        repo_url: scanResult.repoUrl || null,
        tech_stack: scanResult.techStack || [],
        created_via: 'import',
        scan_source: scanResult.scanSource,
        editor_preference: 'generic',
      })
      .select()
      .single()

    if (projErr || !project) throw projErr ?? new Error('Project insert failed')

    // 2. Belt-and-suspenders: ensure head member row exists
    await sb.from('project_members').upsert(
      { project_id: project.id, user_id: user.id, role: 'head', invite_status: 'accepted' },
      { onConflict: 'project_id,user_id', ignoreDuplicates: true }
    )

    // 3. Insert phases (in order)
    const phases = scanResult.phases ?? []
    if (phases.length > 0) {
      const phaseInserts = phases.map((phase, i) => ({
        project_id: project.id,
        name: phase.name,
        description: `Imported phase ${i + 1}`,
        order_index: phase.order ?? i + 1,
        status: 'in_progress',
      }))

      const { data: insertedPhases, error: phaseErr } = await sb
        .from('phases')
        .insert(phaseInserts)
        .select()

      if (phaseErr) throw phaseErr

      // 4. Insert features per phase
      const phaseIdMap = new Map(
        (insertedPhases ?? []).map((p: { name: string; id: string }) => [p.name, p.id])
      )

      const featureInserts = phases.flatMap(phase => {
        const phaseId = phaseIdMap.get(phase.name)
        if (!phaseId) return []
        return (phase.features ?? []).map(f => ({
          project_id: project.id,
          phase_id: phaseId,
          name: f.name,
          description: f.description || null,
          status: f.status || 'planned',
          type: f.type || 'other',
          priority: 0,
        }))
      })

      if (featureInserts.length > 0) {
        const { error: featErr } = await sb.from('features').insert(featureInserts)
        if (featErr) throw featErr
      }
    }

    // 5. Optionally generate context files from scan data
    if (generateContextFiles) {
      const contextFiles = buildContextFiles(scanResult)

      for (const [filePath, content] of Object.entries(contextFiles)) {
        const { data: ctx, error: ctxErr } = await sb
          .from('contexts')
          .upsert({
            project_id: project.id,
            file_path: filePath,
            content,
            version: 1,
            owned_by: 'reminisce',
            last_modified: new Date().toISOString(),
          }, { onConflict: 'project_id,file_path' })
          .select('id')
          .single()

        if (ctxErr || !ctx) continue

        // Write first context version
        await sb.from('context_versions').insert({
          context_id: ctx.id,
          project_id: project.id,
          content,
          label: 'Initial import',
          sha: null,
          diff: null,
        })
      }
    }

    return NextResponse.json({ project: { id: project.id, name: project.name } })
  } catch (err: unknown) {
    console.error('[import/create] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── Context file templates ────────────────────────────────────────────────────

function buildContextFiles(scan: ScanResult & { phases: ScannedPhase[] }): Record<string, string> {
  const files: Record<string, string> = {}

  // tech-stack.md
  const stackList = scan.techStack.map(t => `- ${t}`).join('\n')
  const frameworkLabel = {
    nextjs: 'Next.js (App Router)',
    express: 'Express.js',
    mixed: 'Next.js + Express.js',
    unknown: 'Unknown',
  }[scan.framework]

  files['reminisce/tech-stack.md'] = `# Tech Stack

**Framework:** ${frameworkLabel}
**Language:** ${scan.language === 'typescript' ? 'TypeScript' : scan.language === 'javascript' ? 'JavaScript' : 'Unknown'}

## Dependencies

${stackList || '- No dependencies detected'}

## Notes

This file was auto-generated from an import scan on ${new Date(scan.scannedAt).toLocaleDateString()}.
Edit it to reflect your actual stack and add architecture decisions.
`

  // architecture.md
  const phaseList = (scan.phases ?? []).map(p => {
    const featureList = p.features
      .slice(0, 5)
      .map(f => `  - ${f.name}`)
      .join('\n')
    const extra = p.features.length > 5 ? `\n  - ...and ${p.features.length - 5} more` : ''
    return `### ${p.name}\n${featureList}${extra}`
  }).join('\n\n')

  files['reminisce/architecture.md'] = `# Architecture Overview

**Project:** ${scan.name}
${scan.description ? `**Description:** ${scan.description}\n` : ''}
**Source:** Imported from ${scan.scanSource === 'github' ? scan.repoUrl ?? 'GitHub' : 'local folder'}
**Scan date:** ${new Date(scan.scannedAt).toLocaleDateString()}

## Structure

${phaseList || 'No phases detected.'}

## Notes

This file was auto-generated. Update it with your actual architecture decisions,
design patterns, and structural conventions to give AI tools accurate context.
`

  return files
}
