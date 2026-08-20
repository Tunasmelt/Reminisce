import { NextResponse } from 'next/server'
import JSZip from 'jszip'
import { getServiceSupabase, isUserBanned } from '@/lib/supabase'
import { authenticateRequest } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

// EX-1: caps to prevent OOM while building the ZIP in memory
const MAX_FILE_ENTRIES = 500
const MAX_TOTAL_CONTENT_BYTES = 50 * 1024 * 1024 // 50 MB

export async function POST(req: Request) {
  try {
    // ── Auth ─────────────────────────────────────────────────────────────────
    const { user, errorResponse } = await authenticateRequest(req)
    if (errorResponse) return errorResponse

    // EX-4: banned check
    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // EX-3: guard JSON parse so bad body returns 400 not 500
    let body: { projectId?: string; files?: Record<string, unknown> }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { projectId, files } = body

    if (!projectId || !files)
      return NextResponse.json({ error: 'Missing projectId or files' }, { status: 400 })

    // EX-1: cap entry count before doing any work
    const entries = Object.entries(files)
    if (entries.length > MAX_FILE_ENTRIES) {
      return NextResponse.json(
        { error: `Export limited to ${MAX_FILE_ENTRIES} files. Received ${entries.length}.` },
        { status: 400 },
      )
    }

    // ── Ownership check ───────────────────────────────────────────────────────
    // Verify the project belongs to this user's workspace
    const supabase = getServiceSupabase()
    const { data: project } = await supabase
      .from('projects')
      .select('id, workspaces!inner(owner_id)')
      .eq('id', projectId)
      .single()

    if (!project || (project.workspaces as unknown as { owner_id: string }).owner_id !== user.id)
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // ── Build zip ────────────────────────────────────────────────────────────
    const zip = new JSZip()
    let totalBytes = 0
    for (const [path, content] of entries) {
      const contentStr = String(content ?? '')

      // EX-1: check cumulative size
      totalBytes += new TextEncoder().encode(contentStr).length
      if (totalBytes > MAX_TOTAL_CONTENT_BYTES) {
        return NextResponse.json(
          { error: `Total export size exceeds the ${MAX_TOTAL_CONTENT_BYTES / 1024 / 1024} MB limit` },
          { status: 413 },
        )
      }

      // EX-2: strict path sanitization — strip any .. segment and leading slashes
      // regardless of slash direction or encoding
      const normalised = String(path)
        .replace(/\\/g, '/')           // normalise backslashes
        .replace(/^\/+/, '')           // strip leading slashes
        .split('/')
        .filter(segment => segment !== '..' && segment !== '.' && segment !== '')
        .join('/')
      if (!normalised) continue        // skip empty paths after sanitisation
      zip.file(`reminisce/${normalised}`, contentStr)
    }

    const zipBuffer = await zip.generateAsync({ type: 'uint8array' })

    return new Response(zipBuffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="reminisce-${projectId}.zip"`,
      },
    })
  } catch (error: unknown) {
    console.error('[export] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
