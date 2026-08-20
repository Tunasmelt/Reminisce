'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { useTheme } from '@/hooks/useTheme'
import {
  FolderOpen, Github, ArrowLeft, ArrowRight, Check,
  ChevronDown, ChevronRight, Pencil, Trash2, Plus, Loader2,
} from 'lucide-react'
import {
  buildScanResult, parseGitHead, parseGitLog,
  type ScanResult, type FileMap, type GitState,
} from '@/lib/project-scanner'
import { groupIntoPhases, type ScannedPhase, type ScannedFeature } from '@/lib/phase-grouper'

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3
type Source = 'local' | 'github'
type EditableScan = Omit<ScanResult, 'phases'> & { phases: ScannedPhase[] }

interface Workspace { id: string; name: string }

function hexToRgba(hex: string, a: number) {
  if (!hex || hex.length < 7) return `rgba(245,158,11,${a})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'rgba(16,185,129,0.7)',
  medium: 'rgba(234,179,8,0.7)',
  low: 'rgba(156,163,175,0.5)',
}

const TYPE_COLORS: Record<string, string> = {
  api: 'rgba(96,165,250,0.6)',
  frontend: 'rgba(167,139,250,0.6)',
  auth: 'rgba(52,211,153,0.6)',
  data: 'rgba(251,146,60,0.6)',
  integration: 'rgba(232,121,249,0.6)',
  other: 'rgba(156,163,175,0.4)',
}

// ── Local folder scanner ──────────────────────────────────────────────────────

const KEY_FILE_PATHS = [
  'package.json', 'README.md', 'readme.md', '.env.example', '.env.sample',
  'next.config.ts', 'next.config.js', 'next.config.mjs',
  'prisma/schema.prisma', 'drizzle.config.ts',
  '.git/HEAD', '.git/logs/HEAD',
]

async function readFileFromHandle(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<string | null> {
  try {
    const parts = path.split('/')
    let current: FileSystemDirectoryHandle = root
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i])
    }
    const fileHandle = await current.getFileHandle(parts[parts.length - 1])
    const file = await fileHandle.getFile()
    return await file.text()
  } catch {
    return null
  }
}

async function walkDirectory(
  handle: FileSystemDirectoryHandle,
  prefix = '',
  maxFiles = 500
): Promise<string[]> {
  const SKIP_DIRS = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo',
    'coverage', '.cache', '__pycache__', 'vendor', 'venv', '.venv',
    'target', 'tmp', 'temp', '.idea', '.vscode',
  ])
  const paths: string[] = []

  const entries: Array<[string, FileSystemHandle]> = []
  for await (const [name, entry] of handle.entries()) {
    entries.push([name, entry])
  }

  for (const [name, entry] of entries) {
    if (paths.length >= maxFiles) break
    const fullPath = prefix ? `${prefix}/${name}` : name
    if (entry.kind === 'directory') {
      if (SKIP_DIRS.has(name)) continue
      const subPaths = await walkDirectory(entry as FileSystemDirectoryHandle, fullPath, maxFiles - paths.length)
      paths.push(...subPaths)
    } else {
      paths.push(fullPath)
    }
  }

  return paths
}

async function scanLocalFolder(
  dirHandle: FileSystemDirectoryHandle,
  onProgress: (msg: string) => void
): Promise<EditableScan> {
  onProgress('Reading file tree…')
  const fileTree = await walkDirectory(dirHandle)

  onProgress('Reading key files…')
  const files: FileMap = {}

  // Always read key files
  await Promise.all(KEY_FILE_PATHS.map(async (path) => {
    const content = await readFileFromHandle(dirHandle, path)
    if (content !== null) files[path] = content
  }))

  // Read route files (up to 20)
  const routeFiles = fileTree
    .filter(f =>
      /app[/\\]api[/\\].*route\.(ts|js)$/.test(f) ||
      /(routes?|controllers?)[/\\].*\.(ts|js)$/.test(f)
    )
    .slice(0, 20)

  await Promise.all(routeFiles.map(async (path) => {
    const content = await readFileFromHandle(dirHandle, path)
    if (content !== null) files[path] = content
  }))

  // Git state
  let gitState: GitState | null = null
  if (files['.git/HEAD']) {
    const branch = parseGitHead(files['.git/HEAD'])
    const logContent = files['.git/logs/HEAD']
    const { message, daysAgo } = logContent ? parseGitLog(logContent) : { message: null, daysAgo: null }
    gitState = { branch, lastCommitMessage: message, daysSinceLastCommit: daysAgo }
  }

  onProgress('Analysing project structure…')
  const result = buildScanResult({
    name: dirHandle.name,
    repoUrl: null,
    fileTree,
    files,
    gitState,
    scanSource: 'local',
  })

  const phases = groupIntoPhases(result.rawFeatures)
  const { rawFeatures: _, ...rest } = result
  void _

  return { ...rest, phases }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ImportPage() {
  const { accent } = useTheme()
  const router = useRouter()

  const [step, setStep] = useState<Step>(1)
  const [source, setSource] = useState<Source>('local')
  const [githubUrl, setGithubUrl] = useState('')
  const [githubPat, setGithubPat] = useState('')
  const [showPat, setShowPat] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState('')
  const [scan, setScan] = useState<EditableScan | null>(null)
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set())
  const [editingFeature, setEditingFeature] = useState<{ phaseIdx: number; featIdx: number } | null>(null)
  const [editDraft, setEditDraft] = useState<Partial<ScannedFeature>>({})
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedWs, setSelectedWs] = useState('')
  const [generateContextFiles, setGenerateContextFiles] = useState(true)
  const [creating, setCreating] = useState(false)

  // Load workspaces when reaching step 3
  const loadWorkspaces = useCallback(async () => {
    const { data } = await supabase.from('workspaces').select('id, name').order('created_at')
    if (data && data.length > 0) {
      setWorkspaces(data as Workspace[])
      setSelectedWs(data[0].id)
    }
  }, [])

  // ── Step 1: source scan ──────────────────────────────────────────────────

  const handleLocalScan = async () => {
    try {
      const dirHandle = await (window as unknown as {
        showDirectoryPicker: (opts: object) => Promise<FileSystemDirectoryHandle>
      }).showDirectoryPicker({ mode: 'read' })

      setScanning(true)
      setScanProgress('Opening folder…')

      const result = await scanLocalFolder(dirHandle, setScanProgress)
      setScan(result)
      // Expand all phases by default
      setExpandedPhases(new Set(result.phases.map(p => p.name)))
      setStep(2)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toast.error('Could not read folder. Make sure you grant read permission.')
    } finally {
      setScanning(false)
      setScanProgress('')
    }
  }

  const handleGithubScan = async () => {
    if (!githubUrl.trim()) return toast.error('Enter a GitHub URL')

    setScanning(true)
    setScanProgress('Fetching repository…')

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/import/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ url: githubUrl.trim(), pat: githubPat.trim() || undefined }),
      })

      setScanProgress('Analysing project structure…')
      const body = await res.json()

      if (!res.ok) {
        toast.error(body.error ?? 'Scan failed')
        return
      }

      setScan(body as EditableScan)
      setExpandedPhases(new Set((body as EditableScan).phases.map((p: ScannedPhase) => p.name)))
      setStep(2)
    } catch {
      toast.error('Scan failed. Check your connection and try again.')
    } finally {
      setScanning(false)
      setScanProgress('')
    }
  }

  // ── Step 2: edit helpers ─────────────────────────────────────────────────

  const togglePhase = (name: string) => {
    setExpandedPhases(prev => {
      const next = new Set(prev)
      if (next.has(name)) { next.delete(name) } else { next.add(name) }
      return next
    })
  }

  const startEditFeature = (phaseIdx: number, featIdx: number) => {
    const feat = scan!.phases[phaseIdx].features[featIdx]
    setEditingFeature({ phaseIdx, featIdx })
    setEditDraft({ name: feat.name, description: feat.description, status: feat.status })
  }

  const saveEditFeature = () => {
    if (!editingFeature || !scan) return
    const { phaseIdx, featIdx } = editingFeature
    setScan(prev => {
      if (!prev) return prev
      const phases = prev.phases.map((p, pi) => pi !== phaseIdx ? p : {
        ...p,
        features: p.features.map((f, fi) => fi !== featIdx ? f : { ...f, ...editDraft }),
      })
      return { ...prev, phases }
    })
    setEditingFeature(null)
  }

  const deleteFeature = (phaseIdx: number, featIdx: number) => {
    setScan(prev => {
      if (!prev) return prev
      const phases = prev.phases.map((p, pi) => pi !== phaseIdx ? p : {
        ...p,
        features: p.features.filter((_, fi) => fi !== featIdx),
      }).filter(p => p.features.length > 0)
      return { ...prev, phases }
    })
  }

  const addFeature = (phaseIdx: number) => {
    setScan(prev => {
      if (!prev) return prev
      const newFeat: ScannedFeature = {
        id: `feat_${Date.now()}`,
        name: 'New feature',
        description: '',
        phaseName: prev.phases[phaseIdx].name,
        status: 'planned',
        type: 'other',
        confidence: 'low',
        source: 'manual',
      }
      const phases = prev.phases.map((p, pi) => pi !== phaseIdx ? p : {
        ...p,
        features: [...p.features, newFeat],
      })
      return { ...prev, phases }
    })
    // Auto-start editing the new feature
    const featIdx = (scan?.phases[phaseIdx].features.length ?? 0)
    setTimeout(() => startEditFeature(phaseIdx, featIdx), 50)
  }

  const totalFeatures = scan?.phases.reduce((sum, p) => sum + p.features.length, 0) ?? 0

  // ── Step 3: create ───────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!scan || !selectedWs) return toast.error('Select a workspace')
    setCreating(true)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/import/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ scanResult: scan, workspaceId: selectedWs, generateContextFiles }),
      })

      const body = await res.json()
      if (!res.ok) {
        if (body.code === 'PROJECT_LIMIT_REACHED') {
          toast.error(`Project limit reached (${body.current}/${body.limit}). Upgrade to Pro for unlimited projects.`)
        } else {
          toast.error(body.error ?? 'Failed to create project')
        }
        return
      }

      toast.success(`"${scan.name}" imported successfully!`)
      router.push(`/dashboard/projects/${body.project.id}`)
    } catch {
      toast.error('Import failed. Please try again.')
    } finally {
      setCreating(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const isFsSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg, rgba(var(--accent-rgb),0.03) 0%, transparent 40%)' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '52px 24px 80px' }} className="page-enter">
        <title>Reminisce — Import Project</title>

        {/* Back link */}
        <button
          onClick={() => step > 1 ? setStep(prev => (prev - 1) as Step) : router.push('/dashboard')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 32,
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.35)', fontSize: 12, fontWeight: 600,
            letterSpacing: '0.04em', padding: 0,
          }}
        >
          <ArrowLeft size={14} /> {step > 1 ? 'Back' : 'Dashboard'}
        </button>

        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 9, letterSpacing: '0.22em', color: hexToRgba(accent, 0.7), marginBottom: 10, textTransform: 'uppercase', fontWeight: 800 }}>
            Import Project
          </div>
          <h1 style={{ fontSize: 'clamp(28px, 3.5vw, 42px)', fontWeight: 900, letterSpacing: '-0.04em', color: '#fff', lineHeight: 1, margin: 0 }}>
            {step === 1 ? 'Choose a source' : step === 2 ? 'Review & edit' : 'Finalise import'}
          </h1>
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', marginTop: 10, lineHeight: 1.6 }}>
            {step === 1 && 'Reminisce will scan your project and extract phases, features, and context — no AI needed.'}
            {step === 2 && `Found ${scan?.phases.length ?? 0} phases and ${totalFeatures} features. Edit anything before importing.`}
            {step === 3 && 'Choose your workspace and set import options.'}
          </p>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 40, alignItems: 'center' }}>
          {([1, 2, 3] as Step[]).map((s) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: step === s ? accent : step > s ? hexToRgba(accent, 0.3) : 'rgba(255,255,255,0.06)',
                border: `1px solid ${step === s ? accent : step > s ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.1)'}`,
                fontSize: 11, fontWeight: 800,
                color: step === s ? '#000' : step > s ? accent : 'rgba(255,255,255,0.3)',
                transition: 'all 0.2s',
              }}>
                {step > s ? <Check size={12} /> : s}
              </div>
              {s < 3 && (
                <div style={{ width: 32, height: 1, background: step > s ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.08)' }} />
              )}
            </div>
          ))}
        </div>

        {/* ── STEP 1: Source picker ──────────────────────────────────────── */}
        {step === 1 && (
          <div>
            {/* Source tabs */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
              {(['local', 'github'] as Source[]).map(s => (
                <button
                  key={s}
                  onClick={() => setSource(s)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 20px', borderRadius: 10,
                    border: `1px solid ${source === s ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.08)'}`,
                    background: source === s ? hexToRgba(accent, 0.08) : 'rgba(255,255,255,0.03)',
                    color: source === s ? accent : 'rgba(255,255,255,0.45)',
                    fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >
                  {s === 'local' ? <FolderOpen size={15} /> : <Github size={15} />}
                  {s === 'local' ? 'Local folder' : 'GitHub URL'}
                </button>
              ))}
            </div>

            {/* Local source */}
            {source === 'local' && (
              <div style={{
                background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 16, padding: '32px',
              }}>
                {!isFsSupported ? (
                  <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
                    Local folder scanning requires Chrome or Edge. Try the GitHub URL option instead.
                  </div>
                ) : (
                  <>
                    <div style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      gap: 16, padding: '32px 0',
                    }}>
                      <div style={{
                        width: 64, height: 64, borderRadius: 16,
                        background: hexToRgba(accent, 0.1),
                        border: `1px solid ${hexToRgba(accent, 0.2)}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <FolderOpen size={28} style={{ color: accent }} />
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', marginBottom: 6 }}>
                          Open your project folder
                        </div>
                        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', lineHeight: 1.6, maxWidth: 360 }}>
                          Pick the root directory of your project. Reminisce will scan it in your browser — nothing is uploaded.
                        </div>
                      </div>
                      <button
                        onClick={handleLocalScan}
                        disabled={scanning}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '12px 28px', borderRadius: 999,
                          background: accent, color: '#000',
                          border: 'none', fontSize: 13, fontWeight: 700,
                          cursor: scanning ? 'not-allowed' : 'pointer',
                          opacity: scanning ? 0.6 : 1, transition: 'all 0.15s',
                        }}
                      >
                        {scanning ? (
                          <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> {scanProgress}</>
                        ) : (
                          <><FolderOpen size={14} /> Choose folder</>
                        )}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* GitHub source */}
            {source === 'github' && (
              <div style={{
                background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 16, padding: '28px',
              }}>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', display: 'block', marginBottom: 8 }}>
                    GitHub repository URL
                  </label>
                  <input
                    type="url"
                    placeholder="https://github.com/owner/repo"
                    value={githubUrl}
                    onChange={e => setGithubUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !scanning && handleGithubScan()}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 10, padding: '11px 14px',
                      fontSize: 13, color: '#fff', outline: 'none', fontFamily: 'inherit',
                    }}
                  />
                </div>

                {/* PAT toggle */}
                <button
                  onClick={() => setShowPat(p => !p)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, marginBottom: showPat ? 14 : 24,
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'rgba(255,255,255,0.35)', fontSize: 12, padding: 0,
                  }}
                >
                  {showPat ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  Private repo? Add a Personal Access Token
                </button>

                {showPat && (
                  <div style={{ marginBottom: 24 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', display: 'block', marginBottom: 8 }}>
                      GitHub PAT <span style={{ fontWeight: 400, opacity: 0.6 }}>(repo scope, never stored)</span>
                    </label>
                    <input
                      type="password"
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                      value={githubPat}
                      onChange={e => setGithubPat(e.target.value)}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 10, padding: '11px 14px',
                        fontSize: 13, color: '#fff', outline: 'none', fontFamily: 'inherit',
                      }}
                    />
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginTop: 6, lineHeight: 1.5 }}>
                      The token is used only for this scan request and is never persisted.
                      Create one at github.com/settings/tokens (classic) with repo scope.
                    </div>
                  </div>
                )}

                <button
                  onClick={handleGithubScan}
                  disabled={scanning || !githubUrl.trim()}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '12px 28px', borderRadius: 999,
                    background: githubUrl.trim() && !scanning ? accent : 'rgba(255,255,255,0.08)',
                    color: githubUrl.trim() && !scanning ? '#000' : 'rgba(255,255,255,0.3)',
                    border: 'none', fontSize: 13, fontWeight: 700,
                    cursor: scanning || !githubUrl.trim() ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {scanning ? (
                    <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> {scanProgress || 'Scanning…'}</>
                  ) : (
                    <><Github size={14} /> Scan repository</>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── STEP 2: Review ─────────────────────────────────────────────── */}
        {step === 2 && scan && (
          <div>
            {/* Summary card */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 28,
            }}>
              {[
                { label: 'Phases', value: scan.phases.length },
                { label: 'Features', value: totalFeatures },
                { label: 'Files scanned', value: scan.filesScanned },
                { label: 'Source', value: scan.scanSource === 'github' ? 'GitHub' : 'Local' },
              ].map(stat => (
                <div key={stat.label} style={{
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: 12, padding: '14px 16px',
                }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', lineHeight: 1 }}>{stat.value}</div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 4 }}>{stat.label}</div>
                </div>
              ))}
            </div>

            {/* Editable name + description */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 24 }}>
              <div>
                <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Project name</label>
                <input
                  value={scan.name}
                  onChange={e => setScan(s => s ? { ...s, name: e.target.value } : s)}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#fff',
                    outline: 'none', fontFamily: 'inherit',
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Description</label>
                <input
                  value={scan.description}
                  onChange={e => setScan(s => s ? { ...s, description: e.target.value } : s)}
                  placeholder="Short description (optional)"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#fff',
                    outline: 'none', fontFamily: 'inherit',
                  }}
                />
              </div>
            </div>

            {/* Tech stack chips */}
            {scan.techStack.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 28 }}>
                {scan.techStack.map(t => (
                  <span key={t} style={{
                    fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                    color: 'rgba(255,255,255,0.5)', letterSpacing: '0.05em', textTransform: 'uppercase',
                  }}>{t}</span>
                ))}
              </div>
            )}

            {/* Phases + features */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {scan.phases.map((phase, phaseIdx) => {
                const expanded = expandedPhases.has(phase.name)
                return (
                  <div key={phase.name} style={{
                    background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)',
                    borderRadius: 14, overflow: 'hidden',
                  }}>
                    {/* Phase header */}
                    <button
                      onClick={() => togglePhase(phase.name)}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '14px 18px', background: 'none', border: 'none', cursor: 'pointer',
                        borderBottom: expanded ? '1px solid rgba(255,255,255,0.06)' : 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {expanded ? <ChevronDown size={14} style={{ color: 'rgba(255,255,255,0.3)' }} /> : <ChevronRight size={14} style={{ color: 'rgba(255,255,255,0.3)' }} />}
                        <span style={{
                          fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 999,
                          background: hexToRgba(accent, 0.1), border: `1px solid ${hexToRgba(accent, 0.2)}`,
                          color: accent, letterSpacing: '0.08em', textTransform: 'uppercase',
                        }}>{`Phase ${phase.order}`}</span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{phase.name}</span>
                      </div>
                      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
                        {phase.features.length} feature{phase.features.length !== 1 ? 's' : ''}
                      </span>
                    </button>

                    {/* Feature list */}
                    {expanded && (
                      <div style={{ padding: '8px 12px 12px' }}>
                        {phase.features.map((feat, featIdx) => {
                          const isEditing = editingFeature?.phaseIdx === phaseIdx && editingFeature?.featIdx === featIdx
                          return (
                            <div key={feat.id} style={{
                              display: 'flex', alignItems: isEditing ? 'flex-start' : 'center',
                              gap: 10, padding: '8px 8px',
                              borderRadius: 8, marginBottom: 2,
                              background: isEditing ? 'rgba(255,255,255,0.04)' : 'transparent',
                            }}>
                              {isEditing ? (
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  <input
                                    autoFocus
                                    value={editDraft.name ?? ''}
                                    onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))}
                                    style={{
                                      background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
                                      borderRadius: 6, padding: '6px 10px', fontSize: 13, color: '#fff',
                                      outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
                                    }}
                                  />
                                  <input
                                    value={editDraft.description ?? ''}
                                    onChange={e => setEditDraft(d => ({ ...d, description: e.target.value }))}
                                    placeholder="Description (optional)"
                                    style={{
                                      background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
                                      borderRadius: 6, padding: '6px 10px', fontSize: 12, color: 'rgba(255,255,255,0.7)',
                                      outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
                                    }}
                                  />
                                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <select
                                      value={editDraft.status ?? 'planned'}
                                      onChange={e => setEditDraft(d => ({ ...d, status: e.target.value as ScannedFeature['status'] }))}
                                      style={{
                                        background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
                                        borderRadius: 6, padding: '5px 8px', fontSize: 11, color: 'rgba(255,255,255,0.7)',
                                        outline: 'none', fontFamily: 'inherit',
                                      }}
                                    >
                                      <option value="planned">Planned</option>
                                      <option value="in_progress">In progress</option>
                                      <option value="complete">Complete</option>
                                    </select>
                                    <button
                                      onClick={saveEditFeature}
                                      style={{
                                        display: 'flex', alignItems: 'center', gap: 4,
                                        padding: '5px 12px', borderRadius: 6,
                                        background: accent, color: '#000', border: 'none',
                                        fontSize: 11, fontWeight: 700, cursor: 'pointer',
                                      }}
                                    >
                                      <Check size={11} /> Save
                                    </button>
                                    <button
                                      onClick={() => setEditingFeature(null)}
                                      style={{
                                        padding: '5px 10px', borderRadius: 6,
                                        background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.45)',
                                        border: 'none', fontSize: 11, cursor: 'pointer',
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                      <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{feat.name}</span>
                                      <span style={{
                                        fontSize: 8, fontWeight: 800, padding: '1px 6px', borderRadius: 999,
                                        background: TYPE_COLORS[feat.type] ?? TYPE_COLORS.other,
                                        color: '#fff', letterSpacing: '0.07em', textTransform: 'uppercase',
                                      }}>{feat.type}</span>
                                      <span style={{
                                        fontSize: 8, fontWeight: 700, padding: '1px 6px', borderRadius: 999,
                                        background: `${CONFIDENCE_COLORS[feat.confidence]}22`,
                                        border: `1px solid ${CONFIDENCE_COLORS[feat.confidence]}`,
                                        color: CONFIDENCE_COLORS[feat.confidence],
                                        letterSpacing: '0.07em', textTransform: 'uppercase',
                                      }}>{feat.confidence}</span>
                                    </div>
                                    {feat.description && (
                                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>{feat.description}</div>
                                    )}
                                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', marginTop: 2 }}>
                                      {feat.source}
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                    <button
                                      onClick={() => startEditFeature(phaseIdx, featIdx)}
                                      title="Edit"
                                      style={{
                                        width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        background: 'transparent', border: 'none', borderRadius: 6,
                                        color: 'rgba(255,255,255,0.2)', cursor: 'pointer', transition: 'color 0.15s',
                                      }}
                                      onMouseEnter={e => { e.currentTarget.style.color = accent; e.currentTarget.style.background = hexToRgba(accent, 0.1) }}
                                      onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.2)'; e.currentTarget.style.background = 'transparent' }}
                                    >
                                      <Pencil size={12} />
                                    </button>
                                    <button
                                      onClick={() => deleteFeature(phaseIdx, featIdx)}
                                      title="Remove"
                                      style={{
                                        width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        background: 'transparent', border: 'none', borderRadius: 6,
                                        color: 'rgba(255,255,255,0.2)', cursor: 'pointer', transition: 'all 0.15s',
                                      }}
                                      onMouseEnter={e => { e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.background = 'rgba(239,68,68,0.1)' }}
                                      onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.2)'; e.currentTarget.style.background = 'transparent' }}
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          )
                        })}

                        {/* Add feature button */}
                        <button
                          onClick={() => addFeature(phaseIdx)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            marginTop: 6, padding: '6px 10px', borderRadius: 8,
                            background: 'transparent',
                            border: `1px dashed rgba(255,255,255,0.1)`,
                            color: 'rgba(255,255,255,0.25)', fontSize: 11, fontWeight: 600,
                            cursor: 'pointer', transition: 'all 0.15s', width: '100%',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = hexToRgba(accent, 0.3); e.currentTarget.style.color = accent }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = 'rgba(255,255,255,0.25)' }}
                        >
                          <Plus size={12} /> Add feature
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Next button */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 28 }}>
              <button
                onClick={() => { setStep(3); loadWorkspaces() }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '12px 28px', borderRadius: 999,
                  background: accent, color: '#000',
                  border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                }}
              >
                Continue <ArrowRight size={14} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3: Options + Create ────────────────────────────────────── */}
        {step === 3 && scan && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Workspace */}
            <div style={{
              background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 14, padding: '20px 22px',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginBottom: 12 }}>
                Workspace
              </div>
              {workspaces.length === 0 ? (
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>
                  No workspaces found. Create one from the dashboard first.
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {workspaces.map(ws => (
                    <button
                      key={ws.id}
                      onClick={() => setSelectedWs(ws.id)}
                      style={{
                        padding: '8px 16px', borderRadius: 8,
                        border: `1px solid ${selectedWs === ws.id ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.1)'}`,
                        background: selectedWs === ws.id ? hexToRgba(accent, 0.08) : 'transparent',
                        color: selectedWs === ws.id ? accent : 'rgba(255,255,255,0.5)',
                        fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >
                      {ws.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Options */}
            <div style={{
              background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 14, padding: '20px 22px',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginBottom: 16 }}>
                Options
              </div>

              <label style={{
                display: 'flex', alignItems: 'flex-start', gap: 14, cursor: 'pointer',
              }}>
                <div
                  onClick={() => setGenerateContextFiles(v => !v)}
                  style={{
                    width: 36, height: 20, borderRadius: 999, flexShrink: 0, marginTop: 1,
                    background: generateContextFiles ? accent : 'rgba(255,255,255,0.1)',
                    border: `1px solid ${generateContextFiles ? accent : 'rgba(255,255,255,0.15)'}`,
                    position: 'relative', transition: 'all 0.2s', cursor: 'pointer',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 2,
                    left: generateContextFiles ? 18 : 2,
                    width: 14, height: 14, borderRadius: '50%',
                    background: '#fff', transition: 'left 0.2s',
                  }} />
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>Generate context files</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2, lineHeight: 1.5 }}>
                    Auto-generates <code style={{ fontSize: 10, color: accent }}>architecture.md</code> and{' '}
                    <code style={{ fontSize: 10, color: accent }}>tech-stack.md</code> from the scan data.
                    No AI — template-filled with what was detected. You can edit them afterwards.
                  </div>
                </div>
              </label>
            </div>

            {/* Summary */}
            <div style={{
              background: hexToRgba(accent, 0.04), border: `1px solid ${hexToRgba(accent, 0.15)}`,
              borderRadius: 14, padding: '18px 22px',
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 8 }}>
                Ready to import: <span style={{ color: accent }}>{scan.name}</span>
              </div>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                {[
                  { label: 'Phases', value: scan.phases.length },
                  { label: 'Features', value: totalFeatures },
                  { label: 'Context files', value: generateContextFiles ? 2 : 0 },
                ].map(s => (
                  <span key={s.label} style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
                    <strong style={{ color: '#fff' }}>{s.value}</strong> {s.label}
                  </span>
                ))}
              </div>
            </div>

            {/* Create button */}
            <button
              onClick={handleCreate}
              disabled={creating || !selectedWs}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '14px 32px', borderRadius: 999,
                background: creating || !selectedWs ? 'rgba(255,255,255,0.08)' : accent,
                color: creating || !selectedWs ? 'rgba(255,255,255,0.3)' : '#000',
                border: 'none', fontSize: 14, fontWeight: 800,
                cursor: creating || !selectedWs ? 'not-allowed' : 'pointer',
                transition: 'all 0.15s', letterSpacing: '-0.01em',
              }}
            >
              {creating ? (
                <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Importing…</>
              ) : (
                'Import project →'
              )}
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
