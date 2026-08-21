'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  getStoredHandle,
  requestStoredPermission,
  openProjectFolder,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  initProjectStructure as fsInitProjectStructure,
  readGitState as fsReadGitState,
  readAllContextFiles,
  computeFileHash,
  REMINISCE_OWNED_PATHS,
} from '@/lib/fsapi'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GitState {
  branch: string | null
  lastCommit: string | null
  remoteUrl: string | null
}

export interface PendingChange {
  filePath: string        // e.g. 'reminisce/context/architecture.md'
  localContent: string    // what is on disk right now
  dbContent: string       // what is stored in contexts table
  localHash: string       // SHA-256 of localContent
  dbHash: string | null   // file_hash from contexts table (null if never synced)
}

export type SyncStatus = 'idle' | 'syncing' | 'conflict' | 'clean'

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useFileSystem(projectId: string) {
  const [handle, setHandle]           = useState<FileSystemDirectoryHandle | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isSupported, setIsSupported] = useState(true)
  const [folderName, setFolderName]   = useState<string | null>(null)
  // FS-2: set true when IndexedDB has a stored handle but Chrome has downgraded
  // its permission to 'prompt' (requires a user gesture to re-request).
  // The UI should show a "Reconnect folder" button instead of "Connect folder".
  const [needsReconnect, setNeedsReconnect] = useState(false)

  // Git state — populated on connect and refreshed on focus
  const [gitState, setGitState]       = useState<GitState>({
    branch: null, lastCommit: null, remoteUrl: null,
  })

  // Sync engine state
  const [syncStatus, setSyncStatus]         = useState<SyncStatus>('idle')
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([])

  // Ref so visibilitychange handler always has the current handle
  const handleRef = useRef<FileSystemDirectoryHandle | null>(null)
  useEffect(() => { handleRef.current = handle }, [handle])

  // FS-15: Timestamp of the last tab-focus git-read. Prevents firing readGitState
  // + runSyncCheck on every rapid tab switch (e.g. copy-pasting from docs).
  // 10 s is short enough to catch a git commit that landed while away.
  const lastFocusReadRef = useRef<number>(0)
  const FOCUS_DEBOUNCE_MS = 10_000

  // ── Initial connection check ────────────────────────────────────────────
  useEffect(() => {
    if (typeof window !== 'undefined' && !('showDirectoryPicker' in window)) {
      setIsSupported(false)
      return
    }
    if (!projectId) return

    const check = async () => {
      try {
        const stored = await getStoredHandle(projectId)
        if (stored) {
          setHandle(stored)
          setIsConnected(true)
          setNeedsReconnect(false)
          setFolderName(stored.name)
          // Read git state immediately on restore
          const git = await fsReadGitState(stored)
          setGitState(git)
          // Persist branch + last commit to DB (non-fatal)
          persistGitState(git).catch(() => {})
        } else {
          // FS-2: getStoredHandle returns null either because no handle is stored
          // OR because one is stored but permission dropped to 'prompt'. Check
          // the IDB key to distinguish the two cases so the UI can show a
          // "Reconnect folder" button instead of "Connect folder".
          const { get: idbGet } = await import('idb-keyval')
          const { getHandleKey } = await import('@/lib/fsapi')
          const rawHandle = await idbGet<FileSystemDirectoryHandle>(getHandleKey(projectId))
          if (rawHandle) {
            setNeedsReconnect(true)
            setFolderName(rawHandle.name)
          }
        }
      } catch (err) {
        console.error('useFileSystem: initial handle check failed', err)
      }
    }
    check()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // ── Focus sync — fires when user returns to this browser tab ────────────
  useEffect(() => {
    const onVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return
      const h = handleRef.current
      if (!h) return
      // FS-15: Skip if we read git state less than FOCUS_DEBOUNCE_MS ago.
      // Rapid alt-tab (e.g. copy-pasting from docs) previously fired a full
      // git read + sync check on every switch, hammering the File System API.
      const now = Date.now()
      if (now - lastFocusReadRef.current < FOCUS_DEBOUNCE_MS) return
      lastFocusReadRef.current = now
      // Refresh git state silently
      try {
        const git = await fsReadGitState(h)
        setGitState(git)
        persistGitState(git).catch(() => {})
      } catch { /* non-fatal */ }
      // Run sync check silently — surfaces conflicts without auto-applying
      try {
        await runSyncCheck(h)
      } catch { /* non-fatal */ }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // ── Persist git state to DB ──────────────────────────────────────────────
  const persistGitState = useCallback(async (git: GitState) => {
    if (!projectId) return
    const updates: Record<string, string | null> = {}
    if (git.branch !== null)     updates.git_branch      = git.branch
    if (git.lastCommit !== null) updates.git_last_commit = git.lastCommit
    if (Object.keys(updates).length === 0) return
    // CE-17: Check the result instead of silently dropping it — a failed write
    // (RLS, network) leaves the displayed git state in the DB stale with no
    // signal. Non-fatal but at least visible in the console.
    const { error } = await supabase.from('projects').update(updates).eq('id', projectId)
    if (error) console.warn('[useFileSystem] persistGitState failed (non-fatal):', error.message)
  }, [projectId])

  // ── Sync check — reads local files, compares hashes to DB ───────────────
  // Returns array of PendingChange (files that differ).
  // Does NOT apply changes — just surfaces them.
  const runSyncCheck = useCallback(async (
    h: FileSystemDirectoryHandle,
  ): Promise<PendingChange[]> => {
    setSyncStatus('syncing')
    try {
      // 1. Read all Reminisce-owned files from local folder
      const localFiles = await readAllContextFiles(h, REMINISCE_OWNED_PATHS)

      // 2. Load current DB state for these files
      // FS-17: Use Array.from() instead of the brittle double-cast
      // `as unknown as string[]`. The readonly tuple type is not assignable to
      // string[] without the cast, but Array.from() produces a proper mutable
      // copy that TypeScript accepts without bypassing the type system.
      const { data: dbRows } = await supabase
        .from('contexts')
        .select('file_path, content, file_hash')
        .eq('project_id', projectId)
        .in('file_path', Array.from(REMINISCE_OWNED_PATHS))

      const dbMap = new Map<string, { content: string; hash: string | null }>(
        (dbRows ?? []).map(r => [r.file_path, { content: r.content ?? '', hash: r.file_hash }])
      )

      // 3. Compare hashes
      const changes: PendingChange[] = []
      for (const [path, localContent] of Object.entries(localFiles)) {
        const localHash = await computeFileHash(localContent)
        const db        = dbMap.get(path)
        const dbContent = db?.content ?? ''
        const dbHash    = db?.hash ?? null

        let isDifferent: boolean
        if (dbHash !== null) {
          // Normal path: hash comparison is O(1) and reliable.
          isDifferent = localHash !== dbHash
        } else {
          // CE-11: dbHash is null when the DB row was created by the wizard
          // generate route (which doesn't store a hash). Comparing hashes
          // against null always returns true — every such file appeared as a
          // permanent conflict even when content was identical.
          // Fall back to content equality for these rows.
          isDifferent = localContent !== dbContent
        }

        if (isDifferent) {
          changes.push({ filePath: path, localContent, dbContent, localHash, dbHash })
        }
      }

      setPendingChanges(changes)
      setSyncStatus(changes.length > 0 ? 'conflict' : 'clean')
      return changes
    } catch (err) {
      setSyncStatus('idle')
      console.error('useFileSystem: sync check failed', err)
      return []
    }
  }, [projectId])

  // ── syncFromLocal — applies local→DB for the given file paths ────────────
  // Call this after the user confirms a conflict resolution.
  const syncFromLocal = useCallback(async (
    filePaths?: string[],
  ): Promise<void> => {
    if (!handle) throw new Error('No folder connected')
    setSyncStatus('syncing')
    try {
      const paths = filePaths ?? pendingChanges.map(c => c.filePath)
      const localFiles = await readAllContextFiles(handle, paths as readonly string[])

      // CE-9: Route through POST /context/version instead of a raw supabase
      // upsert. This ensures every sync goes through the same code path as the
      // web editor: ban check, viewer-role rejection, diff computation, version
      // history tracking, file_hash update, and semantic re-indexing.
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      // FS-3: Use per-file Promise.allSettled so one failed upload does not
      // abort the rest. Previously a single rejection threw, leaving files
      // 3–N unsynced with no indication of which ones had succeeded.
      const entries = Object.entries(localFiles)
      const results = await Promise.allSettled(
        entries.map(async ([path, content]) => {
          const res = await fetch('/api/context/version', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ projectId, filePath: path, content }),
          })
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error || `Server rejected sync for ${path} (${res.status})`)
          }
          return path
        })
      )

      const succeeded: string[] = []
      const failed: Array<{ path: string; reason: string }> = []
      results.forEach((result, i) => {
        const [path] = entries[i]
        if (result.status === 'fulfilled') {
          succeeded.push(path)
        } else {
          failed.push({ path, reason: result.reason?.message ?? String(result.reason) })
        }
      })

      // Clear pendingChanges only for files that actually succeeded
      setPendingChanges(prev => prev.filter(c => !succeeded.includes(c.filePath)))
      setSyncStatus(failed.length > 0 ? 'conflict' : 'clean')

      if (succeeded.length > 0) {
        toast.success(`Synced ${succeeded.length} file${succeeded.length !== 1 ? 's' : ''} from local folder`)
      }
      if (failed.length > 0) {
        const names = failed.map(f => f.path.split('/').pop()).join(', ')
        toast.error(`${failed.length} file${failed.length !== 1 ? 's' : ''} failed to sync: ${names}`)
      }
    } catch (err) {
      // Unexpected upstream error (e.g. readAllContextFiles threw, getSession failed)
      setSyncStatus('idle')
      const msg = err instanceof Error ? err.message : String(err)
      toast.error('Sync failed: ' + msg)
      throw err
    }
  }, [handle, pendingChanges, projectId])

  // ── pushToLocal — writes DB content back to local files ──────────────────
  // Used after wizard generation to inject new blueprint files.
  const pushToLocal = useCallback(async (
    files: Record<string, string>,
  ): Promise<number> => {
    if (!handle) throw new Error('No folder connected')
    let written = 0
    const skipped: string[] = []
    const now = new Date().toISOString()

    // CE-10: Fetch current DB hashes upfront so we can detect whether a local
    // file has been modified since its last sync before overwriting it.
    const paths = Object.keys(files)
    const { data: dbRows } = await supabase
      .from('contexts')
      .select('file_path, file_hash')
      .eq('project_id', projectId)
      .in('file_path', paths)
    const dbHashMap = new Map((dbRows ?? []).map(r => [r.file_path, r.file_hash as string | null]))

    for (const [path, content] of Object.entries(files)) {
      try {
        // CE-10: Read the local file (if it exists) and check whether it was
        // modified after the last known sync hash. If so, skip the overwrite
        // and surface it as a pending conflict — the user's local edits must
        // not be silently clobbered.
        const lastSyncedHash = dbHashMap.get(path) ?? null
        if (lastSyncedHash !== null) {
          try {
            const localContent = await fsReadFile(handle, path)
            const localHash    = await computeFileHash(localContent)
            if (localHash !== lastSyncedHash) {
              skipped.push(path)
              console.warn(`[pushToLocal] skipping ${path} — local edits detected since last sync`)
              continue
            }
          } catch {
            // File doesn't exist locally yet — safe to create, fall through.
          }
        }

        await fsWriteFile(handle, path, content)
        const hash = await computeFileHash(content)
        // FS-4: Check the DB hash update result. If it fails, the file is on
        // disk but file_hash in the DB is still stale. The next runSyncCheck
        // would see localHash ≠ dbHash and flag a permanent false conflict —
        // indistinguishable from a real edit. Don't count as written; skip so
        // the caller knows to retry rather than treating this as success.
        const { error: hashErr } = await supabase
          .from('contexts')
          .update({ file_hash: hash, last_synced_at: now })
          .eq('project_id', projectId)
          .eq('file_path', path)
        if (hashErr) {
          console.error(`[pushToLocal] DB hash update failed for ${path}:`, hashErr.message)
          skipped.push(path)
          continue
        }
        written++
      } catch (err) {
        console.error(`pushToLocal: failed to write ${path}`, err)
        // Non-fatal — continue with other files
      }
    }

    if (skipped.length > 0) {
      // Surface skipped files as pending conflicts so the UI reflects them.
      setSyncStatus('conflict')
      toast.error(
        `${skipped.length} file${skipped.length > 1 ? 's' : ''} skipped — local edits would be overwritten. Resolve conflicts first.`,
      )
    } else if (written > 0) {
      setSyncStatus('clean')
      setPendingChanges([])
    }

    return written
  }, [handle, projectId])

  // ── readGitState — manual refresh ────────────────────────────────────────
  const readGitState = useCallback(async (): Promise<GitState> => {
    if (!handle) return { branch: null, lastCommit: null, remoteUrl: null }
    const git = await fsReadGitState(handle)
    setGitState(git)
    persistGitState(git).catch(() => {})
    return git
  }, [handle, persistGitState])

  // ── openFolder ───────────────────────────────────────────────────────────
  const openFolder = useCallback(async (): Promise<FileSystemDirectoryHandle | null> => {
    try {
      const newHandle = await openProjectFolder(projectId)
      setHandle(newHandle)
      setIsConnected(true)
      setNeedsReconnect(false)
      setFolderName(newHandle.name)
      toast.success(`Folder "${newHandle.name}" connected`)
      // Read git state immediately
      const git = await fsReadGitState(newHandle)
      setGitState(git)
      persistGitState(git).catch(() => {})
      // Run initial sync check
      await runSyncCheck(newHandle)
      return newHandle
    } catch (err) {
      // CE-18: AbortError means the user dismissed the picker — not an error.
      // Show no toast; just return null so callers can handle it gracefully.
      if (err instanceof Error && err.name === 'AbortError') return null
      console.error('useFileSystem: openFolder failed', err)
      toast.error('Failed to connect project folder.')
      return null
    }
  }, [projectId, persistGitState, runSyncCheck])

  // ── reconnectFolder — call from a button click to re-request permission ──
  // FS-2: getStoredHandle never calls requestPermission() without a user
  // gesture. This function is the gesture-gated alternative — bind it to an
  // onClick handler so the browser allows the permission prompt.
  const reconnectFolder = useCallback(async (): Promise<FileSystemDirectoryHandle | null> => {
    try {
      const restored = await requestStoredPermission(projectId)
      if (!restored) {
        toast.error('Permission denied — try connecting your folder again.')
        return null
      }
      setHandle(restored)
      setIsConnected(true)
      setNeedsReconnect(false)
      setFolderName(restored.name)
      toast.success(`Folder "${restored.name}" reconnected`)
      const git = await fsReadGitState(restored)
      setGitState(git)
      persistGitState(git).catch(() => {})
      await runSyncCheck(restored)
      return restored
    } catch (err) {
      console.error('useFileSystem: reconnectFolder failed', err)
      toast.error('Failed to reconnect folder.')
      return null
    }
  }, [projectId, persistGitState, runSyncCheck])

  // ── NotAllowedError handler — surfaces mid-session permission revocation ──
  // FS-10: Chrome can downgrade a previously-granted handle to 'prompt' at any
  // time (e.g. the user revoked it in chrome://settings, the OS security policy
  // changed, or the handle was idle for a very long time). Any FS API call on a
  // revoked handle throws a NotAllowedError. Without this, the caller receives a
  // raw DOMException with no indication that "Reconnect folder" would fix it.
  const handleFsError = useCallback((err: unknown): void => {
    if (err instanceof Error && err.name === 'NotAllowedError') {
      setIsConnected(false)
      setNeedsReconnect(true)
      toast.error('Folder permission was revoked — click "Reconnect folder" to restore access.')
    }
  }, [])

  // ── Simple wrappers (unchanged API for existing consumers) ───────────────
  const readFile = useCallback(async (path: string): Promise<string> => {
    if (!handle) throw new Error('No folder connected')
    try {
      return await fsReadFile(handle, path)
    } catch (err) {
      handleFsError(err)
      throw err
    }
  }, [handle, handleFsError])

  const writeFile = useCallback(async (path: string, content: string): Promise<void> => {
    if (!handle) throw new Error('No folder connected')
    try {
      return await fsWriteFile(handle, path, content)
    } catch (err) {
      handleFsError(err)
      throw err
    }
  }, [handle, handleFsError])

  const initProject = useCallback(async (): Promise<void> => {
    if (!handle) throw new Error('No folder connected')
    try {
      await fsInitProjectStructure(handle)
      toast.success('Project structure initialised in folder')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(err)
      toast.error('Failed to initialise structure: ' + msg)
    }
  }, [handle])

  return {
    // ── Existing API (unchanged — no consumer changes needed) ──
    handle,
    isConnected,
    isSupported,
    folderName,
    openFolder,
    readFile,
    writeFile,
    initProject,
    // ── New additions ──────────────────────────────────────────
    gitState,          // { branch, lastCommit, remoteUrl }
    syncStatus,        // 'idle' | 'syncing' | 'conflict' | 'clean'
    pendingChanges,    // PendingChange[] — files that differ local vs DB
    needsReconnect,    // true when stored handle exists but perm dropped to 'prompt'
    readGitState,      // () => Promise<GitState> — manual refresh
    syncFromLocal,     // (paths?) => Promise<void> — apply local→DB
    pushToLocal,       // (files) => Promise<number> — write DB→local
    reconnectFolder,   // () => Promise<handle|null> — call from click handler to re-request perm
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

// Extracts the summary paragraph from a <!-- REMINISCE:SUMMARY ... --> tag.
// Returns null if the tag is not present.
function extractSummary(content: string): string | null {
  const match = content.match(
    /<!--\s*REMINISCE:SUMMARY\s*([\s\S]*?)\s*-->/i,
  )
  if (!match) return null
  // Strip the OWNED_BY / LAST_UPDATED metadata lines — keep only prose
  const lines = match[1]
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('OWNED_BY') && !l.startsWith('LAST_UPDATED') && !l.startsWith('VERSION'))
  return lines.join(' ').trim() || null
}
