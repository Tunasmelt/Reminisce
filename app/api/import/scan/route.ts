import { NextResponse } from 'next/server'
import { supabase as clientSupabase, isUserBanned } from '@/lib/supabase'
import {
  buildScanResult,
  type FileMap,
} from '@/lib/project-scanner'
import { groupIntoPhases } from '@/lib/phase-grouper'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Files we always try to fetch — fetching targeted files is much more
// rate-limit friendly than sampling randomly.
const KEY_FILES = [
  'package.json',
  'README.md',
  'readme.md',
  '.env.example',
  '.env.sample',
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'prisma/schema.prisma',
  'drizzle.config.ts',
  'drizzle.config.js',
]

// POST /api/import/scan
// Body: { url: string, pat?: string }
// Returns: ScanResult
export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authErr } = await clientSupabase.auth.getUser(token)
  if (!user || authErr) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // IS-1: banned check
  if (await isUserBanned(user.id))
    return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

  const body = await req.json().catch(() => ({})) as { url?: string; pat?: string }
  const { url, pat } = body

  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 })

  // Parse owner/repo from GitHub URL
  const parsed = parseGitHubUrl(url)
  if (!parsed) {
    return NextResponse.json({ error: 'Invalid GitHub URL. Expected: https://github.com/owner/repo' }, { status: 400 })
  }
  const { owner, repo } = parsed

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Reminisce-Scanner/1.0',
  }
  if (pat) headers['Authorization'] = `Bearer ${pat}`

  try {
    // 1. Fetch file tree (recursive) — single API call
    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
      { headers }
    )

    if (!treeRes.ok) {
      const msg = treeRes.status === 404
        ? 'Repository not found. Check the URL or make sure the repo is public.'
        : treeRes.status === 401 || treeRes.status === 403
          ? 'Access denied. For private repos, provide a Personal Access Token with repo scope.'
          : `GitHub API error: ${treeRes.status}`
      return NextResponse.json({ error: msg }, { status: treeRes.status >= 500 ? 502 : 400 })
    }

    type TreeItem = { path: string; type: string }
    const treeData = await treeRes.json() as { tree?: TreeItem[]; truncated?: boolean }
    const fileTree = (treeData.tree ?? [])
      .filter((item: TreeItem) => item.type === 'blob')
      .map((item: TreeItem) => item.path)

    // 2. Fetch key files in parallel
    const filesToFetch = [
      ...KEY_FILES,
      // Also fetch route files: up to 20 route files from the tree
      ...fileTree
        .filter(f =>
          /app[/\\]api[/\\].*route\.(ts|js)$/.test(f) ||
          /app[/\\].*page\.(tsx|jsx|ts|js)$/.test(f) ||
          /(routes?|controllers?)[/\\].*\.(ts|js)$/.test(f)
        )
        .slice(0, 20),
    ]

    const fileContents = await fetchFilesInParallel(owner, repo, filesToFetch, headers)

    // 3. Build scan result
    const result = buildScanResult({
      name: repo.replace(/-/g, ' '),
      repoUrl: `https://github.com/${owner}/${repo}`,
      fileTree,
      files: fileContents,
      gitState: null,  // Git state not available via GitHub API without extra calls
      scanSource: 'github',
    })

    // 4. Group into phases
    const phases = groupIntoPhases(result.rawFeatures)

    const { rawFeatures: _, ...rest } = result
    void _  // suppress unused var warning

    return NextResponse.json({ ...rest, phases })
  } catch (err: unknown) {
    console.error('[import/scan] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url.trim())
    if (u.hostname !== 'github.com') return null
    const parts = u.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
    if (parts.length < 2) return null
    const [owner, repo] = parts
    if (!owner || !repo) return null
    return { owner, repo }
  } catch {
    return null
  }
}

// IS-2: Cap individual file content so a single giant file (e.g. a minified
// bundle committed to the repo) cannot OOM the Vercel function. 512 KB is
// well above any reasonable source file; key files like package.json and
// README.md are tiny in practice.
const MAX_FILE_BYTES = 512 * 1024 // 512 KB

async function fetchFilesInParallel(
  owner: string,
  repo: string,
  paths: string[],
  headers: Record<string, string>
): Promise<FileMap> {
  const CONCURRENCY = 8
  const results: FileMap = {}

  for (let i = 0; i < paths.length; i += CONCURRENCY) {
    const batch = paths.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async (path) => {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
          { headers }
        )
        if (!res.ok) return
        const data = await res.json() as { content?: string; encoding?: string; size?: number }

        // IS-2: Skip files larger than the per-file byte cap.
        if (typeof data.size === 'number' && data.size > MAX_FILE_BYTES) return

        if (data.encoding === 'base64' && data.content) {
          const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64')
          // Double-check after decode in case the GitHub API size field was absent.
          if (decoded.byteLength > MAX_FILE_BYTES) return
          results[path] = decoded.toString('utf-8')
        }
      } catch {
        // Non-fatal — file may not exist
      }
    }))
  }

  return results
}
