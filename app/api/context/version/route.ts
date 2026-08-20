import { NextResponse } from 'next/server'
import { getServiceSupabase, supabase as clientSupabase, verifyProjectAccess, isUserBanned, getProjectRole } from '@/lib/supabase'
import { diff_match_patch } from 'diff-match-patch'

export const dynamic = 'force-dynamic'

// CE-16: Server-side SHA-256 hash — matches the browser-side computeFileHash
// in lib/fsapi.ts byte-for-byte (same algo, same encoding).
// Kept inline to avoid importing the browser-only fsapi module on the server.
async function computeHash(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content)
  const buf = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// CE-9: Extract the <!-- REMINISCE:SUMMARY ... --> tag so the summary column
// stays populated when syncFromLocal routes through this endpoint.
function extractSummary(content: string): string | null {
  const match = content.match(/<!--\s*REMINISCE:SUMMARY\s*([\s\S]*?)\s*-->/i)
  if (!match) return null
  const lines = match[1]
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('OWNED_BY') && !l.startsWith('LAST_UPDATED') && !l.startsWith('VERSION'))
  return lines.join(' ').trim() || null
}

// CE-3: Hard cap on content size — protects diff_match_patch (O(n²)) and the
// OpenAI embedding fan-out from unbounded input.
const MAX_CONTENT_BYTES = 500_000 // 500 KB

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await clientSupabase.auth.getUser(token)
    if (!user || authError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (await isUserBanned(user.id))
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // CT-1: guard JSON parse so bad body returns 400 not 500
    let parsed: { projectId?: string; filePath?: string; content?: unknown }
    try {
      parsed = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { projectId, filePath, content } = parsed
    if (!projectId || !filePath || typeof content !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid parameters' }, { status: 400 })
    }

    // CE-3: Reject oversized content before any CPU/DB work.
    if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) {
      return NextResponse.json(
        { error: `Content exceeds the 500 KB limit (received ${Math.round(new TextEncoder().encode(content).length / 1024)} KB)` },
        { status: 413 },
      )
    }

    // CE-4: Validate filePath — must stay inside reminisce/ and must not
    // contain path traversal sequences. The stored path flows back to the
    // client where it could be passed to writeFile(), so an unchecked path
    // could escape the project folder.
    if (!filePath.startsWith('reminisce/') || filePath.includes('..') || filePath.includes('\0')) {
      return NextResponse.json(
        { error: 'Invalid file path — must start with reminisce/ and contain no path traversal sequences' },
        { status: 400 },
      )
    }

    if (!await verifyProjectAccess(user.id, projectId))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const role = await getProjectRole(user.id, projectId)
    if (role === 'viewer') {
      return NextResponse.json(
        { error: 'Viewers cannot save context' },
        { status: 403 },
      )
    }

    const supabase = getServiceSupabase()
    const dmp = new diff_match_patch()
    const now = new Date().toISOString()

    // CE-16: Compute hash here so the file_hash column stays current after
    // every web-editor save. Previously the hash was only written by
    // syncFromLocal, so web-editor saves left a stale hash and the next sync
    // check always flagged those files as conflicts.
    const hash = await computeHash(content)
    const summary = extractSummary(content)

    // 1. Read existing context record — needed for diff and version counter.
    const { data: currentContext, error: contextErr } = await supabase
      .from('contexts')
      .select('id, content, version')
      .eq('project_id', projectId)
      .eq('file_path', filePath)
      .maybeSingle()

    if (contextErr) throw contextErr

    const oldContent = currentContext?.content ?? ''
    const currentVersion = currentContext?.version ?? 0
    const newVersionNumber = currentVersion + 1

    // Compute diff (empty string for first save — no previous content).
    const diffs = currentContext ? dmp.diff_main(oldContent, content) : []
    if (currentContext) dmp.diff_cleanupSemantic(diffs)
    const diffJson = currentContext ? JSON.stringify(diffs) : ''

    let finalContextId: string

    if (currentContext) {
      // ── UPDATE path ────────────────────────────────────────────────────────
      // CE-2: Write contexts FIRST so the main record is always the source of
      // truth. If the subsequent context_versions insert fails, the content is
      // still correct — we only lose a single history entry (acceptable
      // degradation vs. the reverse which leaves content desynchronised).
      //
      // CE-5: Optimistic lock via .eq('version', currentVersion) — only
      // commit if no other request has incremented the version since we read
      // it. If two concurrent saves race, the second one sees 0 rows updated
      // and receives a 409 instead of silently producing a duplicate version.
      const { data: updated, error: updateErr } = await supabase
        .from('contexts')
        .update({
          content,
          version:        newVersionNumber,
          file_hash:      hash,          // CE-16
          summary:        summary ?? undefined,
          last_modified:  now,
          last_synced_at: now,
        })
        .eq('id', currentContext.id)
        .eq('version', currentVersion)  // CE-5: optimistic lock
        .select('id')

      if (updateErr) throw updateErr

      // CE-5: 0 rows → another request already incremented the version.
      if (!updated || updated.length === 0) {
        return NextResponse.json(
          { error: 'Concurrent save detected — please retry' },
          { status: 409 },
        )
      }

      finalContextId = currentContext.id

      // CE-2: Version history insert is now AFTER the main record is committed.
      const { error: versionErr } = await supabase
        .from('context_versions')
        .insert({
          context_id: finalContextId,
          content,
          diff:       diffJson,
          changed_at: now,
        })

      if (versionErr) {
        // Non-fatal: main record is intact; only this history entry is lost.
        console.error(
          '[context/version] context_versions insert failed (contexts record is intact):',
          versionErr.message,
        )
      }
    } else {
      // ── INSERT path (first save) ───────────────────────────────────────────
      // CE-1: Use upsert instead of INSERT so two concurrent first-saves don't
      // race to create the same (project_id, file_path) row and throw a
      // unique-violation 500. The second concurrent call will overwrite the
      // first with the same content — acceptable for a first save.
      const { data: newContext, error: upsertErr } = await supabase
        .from('contexts')
        .upsert(
          {
            project_id:     projectId,
            file_path:      filePath,
            content,
            version:        newVersionNumber,
            file_hash:      hash,         // CE-16
            summary:        summary ?? undefined,
            last_modified:  now,
            last_synced_at: now,
          },
          { onConflict: 'project_id,file_path' },
        )
        .select('id')
        .single()

      if (upsertErr) throw upsertErr
      finalContextId = newContext.id

      // Initial version row — no diff for a brand-new file.
      const { error: versionErr } = await supabase
        .from('context_versions')
        .insert({
          context_id: finalContextId,
          content,
          diff:       '',
          changed_at: now,
        })

      if (versionErr) {
        console.error(
          '[context/version] initial context_versions insert failed:',
          versionErr.message,
        )
      }
    }

    // CE-6: Non-blocking semantic re-index — log errors instead of silently
    // swallowing them so persistent failures (missing key, broken extension)
    // are visible in server logs.
    try {
      const { upsertMemoryChunks } = await import('@/lib/vector-memory')
      upsertMemoryChunks(
        projectId, user.id, 'context_file',
        finalContextId, content, filePath,
      ).catch((err) => {
        console.error('[context/version] vector indexing failed (non-fatal):', err)
      })
    } catch (err) {
      console.error('[context/version] vector indexing import failed (non-fatal):', err)
    }

    return NextResponse.json({ success: true, version: newVersionNumber })

  } catch (error: unknown) {
    console.error('[context/version] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
