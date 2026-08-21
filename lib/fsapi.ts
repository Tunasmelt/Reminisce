import { get, set } from 'idb-keyval'

// ─────────────────────────────────────────────────────────────────────────────
//  Handle storage — per-project folder handle persisted in IndexedDB
// ─────────────────────────────────────────────────────────────────────────────

export function getHandleKey(projectId: string): string {
  return `reminisce_folder_${projectId}`
}

export async function openProjectFolder(
  projectId: string,
): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  await set(getHandleKey(projectId), handle)
  return handle
}

export async function saveHandle(
  projectId: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  await set(getHandleKey(projectId), handle)
}

export async function getStoredHandle(
  projectId: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await get<FileSystemDirectoryHandle>(getHandleKey(projectId))
    if (!handle) return null
    const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' }
    const perm = await handle.queryPermission(opts)
    // FS-2: Only return the handle when permission is already granted.
    // requestPermission() requires a user activation (click/keyboard event).
    // Calling it from a useEffect on mount — without a gesture — causes Chrome
    // to silently return 'denied', discarding a still-valid stored handle and
    // breaking the auto-reconnect flow on every page load.
    // Callers that need to prompt the user must use requestStoredPermission()
    // from inside a click handler instead.
    return perm === 'granted' ? handle : null
  } catch (err) {
    console.error('Error getting stored handle', err)
    return null
  }
}

/**
 * Re-request readwrite permission for a stored handle.
 * MUST be called from a user-gesture handler (button click / key press).
 * Returns the handle on success, null if the user denies or the handle is gone.
 */
export async function requestStoredPermission(
  projectId: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await get<FileSystemDirectoryHandle>(getHandleKey(projectId))
    if (!handle) return null
    const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' }
    const perm = await handle.requestPermission(opts)
    return perm === 'granted' ? handle : null
  } catch (err) {
    console.error('Error requesting stored handle permission', err)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Directory traversal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getDirHandle(
  base: FileSystemDirectoryHandle,
  path: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const parts = path.split('/').filter(Boolean)
  let cur = base
  for (const part of parts) {
    cur = await cur.getDirectoryHandle(part, { create })
  }
  return cur
}

// ─────────────────────────────────────────────────────────────────────────────
//  File read / write
// ─────────────────────────────────────────────────────────────────────────────

// FS-6: Cap to prevent browser freeze when a large file is accidentally read.
// Context files are markdown — anything over 2 MB is almost certainly wrong.
const MAX_READ_SIZE_BYTES = 2 * 1024 * 1024 // 2 MB

export async function readFile(
  handle: FileSystemDirectoryHandle,
  path: string,
): Promise<string> {
  const slash = path.lastIndexOf('/')
  const dirHandle = slash === -1
    ? handle
    : await getDirHandle(handle, path.slice(0, slash), false)
  const name = slash === -1 ? path : path.slice(slash + 1)
  const fh = await dirHandle.getFileHandle(name, { create: false })
  const file = await fh.getFile()
  // FS-6: Reject oversized files before reading into a JS string.
  // file.text() on a 100 MB file blocks the UI thread for several seconds.
  if (file.size > MAX_READ_SIZE_BYTES) {
    throw new Error(
      `"${name}" is too large to read (${(file.size / 1024 / 1024).toFixed(1)} MB — max 2 MB). ` +
      `Only markdown context files should live in the reminisce/ folder.`
    )
  }
  return await file.text()
}

export async function writeFile(
  handle: FileSystemDirectoryHandle,
  path: string,
  content: string,
): Promise<void> {
  const slash = path.lastIndexOf('/')
  const dirHandle = slash === -1
    ? handle
    : await getDirHandle(handle, path.slice(0, slash), true)
  const name = slash === -1 ? path : path.slice(slash + 1)
  const fh = await dirHandle.getFileHandle(name, { create: true })
  const writable = await fh.createWritable()
  // FS-1: createWritable() truncates the file to 0 bytes immediately
  // (keepExistingData defaults to false). If write() throws — disk full,
  // permission revoked mid-write, etc — the previous content is already
  // gone. abort() discards the incomplete write and closes the stream
  // safely. Without it the writable is abandoned open and the file is
  // left as an empty 0-byte stub.
  try {
    await writable.write(content)
    await writable.close()
  } catch (err) {
    try { await writable.abort() } catch { /* abort may itself throw if stream already closed */ }
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Git state reading — reads plain-text files from .git/ directory.
//  Works for any git provider (GitHub, GitLab, Bitbucket, self-hosted).
//  No API calls, no auth, no rate limits. Works offline.
// ─────────────────────────────────────────────────────────────────────────────

export async function readGitBranch(
  handle: FileSystemDirectoryHandle,
): Promise<string | null> {
  try {
    // .git/HEAD contains either:
    //   "ref: refs/heads/main\n"  (normal branch)
    //   "<sha>\n"                  (detached HEAD)
    const raw = await readFile(handle, '.git/HEAD')
    const trimmed = raw.trim()
    // FS-11: Guard against an empty HEAD file (e.g. mid-clone, or a corrupted
    // repo). Without this, an empty string would fall through to the SHA branch
    // and return ' (detached)' with a leading space and an 8-char empty string.
    if (!trimmed) return null
    if (trimmed.startsWith('ref: refs/heads/')) {
      return trimmed.replace('ref: refs/heads/', '')
    }
    // Detached HEAD — return short SHA
    return trimmed.slice(0, 8) + ' (detached)'
  } catch {
    return null
  }
}

export async function readGitLastCommit(
  handle: FileSystemDirectoryHandle,
): Promise<string | null> {
  // CE-15: Prefer .git/logs/HEAD — updated by every commit, pull, merge, and
  // rebase, whereas COMMIT_EDITMSG is only written when the user types a commit
  // message (not on pull/merge/rebase).  Each line ends with \t<message>.
  try {
    const raw = await readFile(handle, '.git/logs/HEAD')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const last = lines[lines.length - 1]
    if (last) {
      const tabIdx = last.indexOf('\t')
      if (tabIdx !== -1) return last.slice(tabIdx + 1).trim() || null
    }
  } catch {
    // logs/HEAD missing (shallow clone, very old git, or not a git repo) —
    // fall back to COMMIT_EDITMSG.
  }
  try {
    // Fallback: .git/COMMIT_EDITMSG — take the first meaningful line.
    const raw = await readFile(handle, '.git/COMMIT_EDITMSG')
    const line = raw
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0 && !l.startsWith('#'))
    return line ?? null
  } catch {
    return null
  }
}

export async function readGitLastSyncedCommit(
  handle: FileSystemDirectoryHandle,
): Promise<string | null> {
  try {
    // .reminisce/sync contains the SHA of the last commit synced to Supabase.
    const raw = await readFile(handle, '.reminisce/sync')
    return raw.trim()
  } catch {
    return null
  }
}

export async function readGitRemoteUrl(
  handle: FileSystemDirectoryHandle,
): Promise<string | null> {
  try {
    // .git/config contains [remote "origin"] url = https://...
    const raw = await readFile(handle, '.git/config')
    const lines = raw.split('\n')
    let inOrigin = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '[remote "origin"]') { inOrigin = true; continue }
      if (inOrigin && trimmed.startsWith('[')) break // next section
      if (inOrigin && trimmed.startsWith('url =')) {
        return trimmed.replace('url =', '').trim()
      }
    }
    return null
  } catch {
    return null
  }
}

// Reads all three git values in a single parallel call.
export async function readGitState(
  handle: FileSystemDirectoryHandle,
): Promise<{ branch: string | null; lastCommit: string | null; remoteUrl: string | null }> {
  const [branch, lastCommit, remoteUrl] = await Promise.all([
    readGitBranch(handle),
    readGitLastCommit(handle),
    readGitRemoteUrl(handle),
  ])
  return { branch, lastCommit, remoteUrl }
}

// ─────────────────────────────────────────────────────────────────────────────
//  File hash — SHA-256 of content string.
//  Used by the sync engine to detect whether a local file differs
//  from the version stored in the contexts table.
// ─────────────────────────────────────────────────────────────────────────────

export async function computeFileHash(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bulk context file reader — reads every file inside reminisce/
//  Returns a map of file_path → content for all files that exist.
//  Non-existent or unreadable files are silently skipped.
// ─────────────────────────────────────────────────────────────────────────────

// All paths Reminisce owns and may want to sync.
// Logs are excluded — they are developer-owned and never read back.
export const REMINISCE_OWNED_PATHS = [
  'reminisce/context/architecture.md',
  'reminisce/context/tech-stack.md',
  'reminisce/context/coding-guidelines.md',
  'reminisce/context/product-scope.md',
  'reminisce/workflow/phases.md',
  'reminisce/workflow/features.md',
  'reminisce/prompts/master-prompt.md',
] as const

export const DEVELOPER_OWNED_PATHS = [
  'reminisce/logs/agent-runs.md',
  'reminisce/logs/changes.md',
] as const

// FS-13: Per-read timeout to prevent a single stalled File System Access API
// call from hanging the entire readAllContextFiles batch indefinitely.
// Chrome's FS API can stall (e.g. on a network drive) without ever throwing.
// 8 seconds is generous for any local file read; callers get partial results
// for files that do respond.
const READ_TIMEOUT_MS = 8_000

function withReadTimeout(promise: Promise<string>, label: string): Promise<string> {
  return Promise.race([
    promise,
    new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Read timed out after ${READ_TIMEOUT_MS / 1000}s: ${label}`)),
        READ_TIMEOUT_MS,
      )
    ),
  ])
}

export async function readAllContextFiles(
  handle: FileSystemDirectoryHandle,
  paths: readonly string[] = REMINISCE_OWNED_PATHS,
): Promise<Record<string, string>> {
  const results: Record<string, string> = {}
  await Promise.allSettled(
    paths.map(async (path) => {
      try {
        // FS-13: Race each read against a timeout so a single stalled call
        // cannot block the batch forever.
        const content = await withReadTimeout(readFile(handle, path), path)
        if (content.trim().length > 0) results[path] = content
      } catch {
        // File doesn't exist, timed out, or is unreadable — skip silently.
      }
    }),
  )
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
//  Project structure initialisation
//  Creates the reminisce/ folder layout without overwriting existing files.
//  Called once when user first connects a folder, or manually from settings.
//  Only creates directories and empty placeholder files.
//  Actual content is written by the wizard generate route via writeFile.
// ─────────────────────────────────────────────────────────────────────────────

// Directories to create (no placeholder files — content comes from wizard)
const REMINISCE_DIRS = [
  'reminisce/context',
  'reminisce/workflow',
  'reminisce/prompts/features',
  'reminisce/logs',
  'reminisce/editor',
] as const

// Log files get placeholder text because they are developer-owned
// and accumulate over time — they should exist from day one.
const LOG_PLACEHOLDERS: Record<string, string> = {
  'reminisce/logs/agent-runs.md':
    '# Agent Runs Log\n\nThis file is automatically appended by Reminisce after each agent run.\nDo not delete — it is your project\'s AI activity history.\n',
  'reminisce/logs/changes.md':
    '# Project Changes Log\n\nThis file is automatically appended by Reminisce when PAM makes project changes.\nDo not delete — it is your project\'s decision history.\n',
}

export async function initProjectStructure(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  // 1. Create all required directories.
  // FS-12: Collect per-directory failures rather than throwing on the first one.
  // A single failure (e.g. permission error on one sub-path) previously aborted
  // the entire init, leaving the structure half-created with no indication of
  // which directories were missing. Now we surface all failures in one message.
  const dirErrors: string[] = []
  for (const dir of REMINISCE_DIRS) {
    try {
      await getDirHandle(handle, dir, true)
    } catch {
      dirErrors.push(dir)
    }
  }
  if (dirErrors.length > 0) {
    const s = dirErrors.length > 1 ? 'ies' : 'y'
    throw new Error(
      `Could not create ${dirErrors.length} director${s}: ${dirErrors.join(', ')}. ` +
      `Check that the folder is writable and try again.`
    )
  }

  // 2. Create log placeholder files only if they don't already exist
  for (const [path, placeholder] of Object.entries(LOG_PLACEHOLDERS)) {
    try {
      await readFile(handle, path)
      // File exists — leave it alone
    } catch {
      // Doesn't exist — create with placeholder
      await writeFile(handle, path, placeholder)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Directory scanner — returns a FileTree for the reminisce/ folder.
//  Used by the context page file tree panel.
// ─────────────────────────────────────────────────────────────────────────────

export type FileTree = {
  name: string
  kind: 'file' | 'directory'
  path: string
  children?: FileTree[]
}

// FS-7: Cap entries per directory level to prevent browser freeze on
// directories with thousands of files (e.g. node_modules/.cache/).
// The depth guard (CE-14) only limits recursion depth, not breadth.
const MAX_ENTRIES_PER_DIR = 500

export async function scanDirectory(
  handle: FileSystemDirectoryHandle,
  path = '',
  // CE-14: depth guard — prevents stack overflow on deeply nested folder trees
  // (e.g. node_modules or generated output inside the project root).
  depth = 0,
): Promise<FileTree[]> {
  // Hard cap: anything deeper than 10 levels cannot be a reminisce/ context
  // file and would risk blowing the call stack on adversarial inputs.
  if (depth > 10) return []

  const tree: FileTree[] = []
  let count = 0
  for await (const entry of handle.values()) {
    // FS-7: Bail out if this directory is abnormally large (e.g. node_modules).
    // Push a sentinel entry so the UI can show a truncation warning.
    if (++count > MAX_ENTRIES_PER_DIR) {
      tree.push({
        name: `… (${MAX_ENTRIES_PER_DIR}+ entries, truncated)`,
        kind: 'file',
        path: path ? `${path}/…` : '…',
      })
      break
    }
    const entryPath = path ? `${path}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      tree.push({
        name: entry.name,
        kind: 'directory',
        path: entryPath,
        children: await scanDirectory(entry, entryPath, depth + 1),
      })
    } else {
      tree.push({ name: entry.name, kind: 'file', path: entryPath })
    }
  }
  return tree.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}
