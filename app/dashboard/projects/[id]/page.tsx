'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import Link from 'next/link'
import { useTheme } from '@/hooks/useTheme'
import { FolderOpen, Wand2, GitBranch, Bot } from 'lucide-react'
import ExportBriefModal from '@/components/ExportBriefModal'
import { useFileSystem } from '@/hooks/useFileSystem'
import { useIsMobile } from '@/hooks/useMediaQuery'

import { Project } from '@/types/project'

interface Phase {
  id: string
  name: string
  description: string
  order_index?: number
}

interface Feature {
  id: string
  name: string
  description?: string
  phase_id: string
  status?: string
  phases?: { name: string }
}

function hexToRgba(hex: string, a: number) {
  if (!hex || hex.length < 7) return `rgba(245,158,11,${a})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

function ThreeDCard({
  children, style, onClick,
}: {
  children: React.ReactNode
  style?: React.CSSProperties
  onClick?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [tilt, setTilt] = useState({ x: 0, y: 0 })
  const [hov, setHov] = useState(false)
  return (
    <div
      ref={ref}
      onClick={onClick}
      onMouseMove={e => {
        if (!ref.current) return
        const rect = ref.current.getBoundingClientRect()
        setTilt({
          x: ((e.clientY - rect.top - rect.height / 2) / rect.height) * 6,
          y: -((e.clientX - rect.left - rect.width / 2) / rect.width) * 6,
        })
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => { setTilt({ x: 0, y: 0 }); setHov(false) }}
      style={{
        transform: `perspective(800px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
        transition: hov ? 'transform 0.1s ease' : 'transform 0.45s cubic-bezier(0.23,1,0.32,1)',
        position: 'relative', overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        ...style,
      }}
    >
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(135deg,rgba(255,255,255,0.04) 0%,transparent 60%)',
        opacity: hov ? 1 : 0, transition: 'opacity 0.3s',
        pointerEvents: 'none', zIndex: 1,
      }}/>
      <div style={{ position: 'relative', zIndex: 2, height: '100%' }}>{children}</div>
    </div>
  )
}

export default function ProjectOverviewPage() {
  const params = useParams()
  const router = useRouter()
  const { accent } = useTheme()
  const isMobile = useIsMobile()
  const projectId = params.id as string

  const {
    isConnected, isSupported,
    openFolder, folderName,
    gitState, pendingChanges,
  } = useFileSystem(projectId)

  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [phases, setPhases] = useState<Phase[]>([])
  const [features, setFeatures] = useState<Feature[]>([])
  const [contextDoc, setContextDoc] = useState('')
  const [showExport, setShowExport] = useState(false)
  const [lastSynced, setLastSynced] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return localStorage.getItem(`blueprint_synced_${projectId}`) ?? null
  })
  const [hasBlueprint, setHasBlueprint] = useState(false)
  const [members, setMembers] = useState<Array<{
    id: string
    user_id: string | null
    email: string
    role: 'head' | 'collaborator' | 'viewer'
    invite_status: string
  }>>([])
  const [myRole, setMyRole] = useState<'head' | 'collaborator' | 'viewer' | null>(null)
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'collaborator' | 'viewer'>('collaborator')
  const [inviting, setInviting] = useState(false)
  const [currentUser, setCurrentUser] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      const authHeader = { Authorization: `Bearer ${session.access_token}` }
      setCurrentUser(session.user.id)

      // ── Primary fetch via API (service role, no RLS issues) ──────────────────
      const projRes = await fetch(`/api/projects/${projectId}`, { headers: authHeader })
      if (!projRes.ok) {
        const body = await projRes.json().catch(() => ({}))
        throw new Error(body.error || `Failed to load project (${projRes.status})`)
      }
      const { project: proj, phases: pData, features: fData, contextDoc: ctxContent, hasBlueprint: bp } = await projRes.json()

      setProject(proj as Project)
      setPhases(pData || [])
      setFeatures(fData || [])
      setContextDoc(ctxContent || '')
      setHasBlueprint(!!bp)

      // ── Team members (non-fatal) ──────────────────────────────────────────────
      try {
        const res = await fetch(`/api/team/members?projectId=${projectId}`, { headers: authHeader })
        const d = await res.json()
        if (d.members) {
          setMembers(d.members)
          const me = d.members.find((m: { user_id: string }) => m.user_id === session.user.id)
          if (me) {
            setMyRole(me.role)
          } else {
            // Workspace owner fallback for pre-migration projects
            const ws = proj.workspaces as { owner_id: string } | null
            setMyRole(ws?.owner_id === session.user.id ? 'head' : null)
          }
        }
      } catch { /* non-fatal */ }

    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error ? err.message : 'Query failure')
      router.push('/dashboard')
    } finally { setLoading(false) }
  }, [projectId, router])

  const handleInvite = async () => {
    if (!inviteEmail.trim() || inviting) return
    setInviting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ projectId, email: inviteEmail.trim(), role: inviteRole }),
      })
      const d = await res.json()
      if (d.ok) {
        toast.success(d.status === 'pending'
          ? `Invite sent to ${inviteEmail} — they need to sign up with this email`
          : `${inviteEmail} added to project`)
        setInviteEmail('')
        setShowInviteModal(false)
        loadData()
      } else {
        toast.error(d.error || 'Invite failed')
      }
    } catch {
      toast.error('Invite failed')
    }
    setInviting(false)
  }

  const handleRemoveMember = async (userId: string) => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`/api/team/members?projectId=${projectId}&userId=${userId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session?.access_token}` },
    })
    const d = await res.json()
    if (d.ok) { toast.success('Member removed'); loadData() }
    else toast.error(d.error || 'Remove failed')
  }

  const roleColor = (role: string) => {
    if (role === 'head') return { color: accent, bg: hexToRgba(accent, 0.1), border: hexToRgba(accent, 0.25) }
    if (role === 'collaborator') return { color: '#60a5fa', bg: 'rgba(96,165,250,0.1)', border: 'rgba(96,165,250,0.25)' }
    return { color: 'rgba(255,255,255,0.4)', bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.1)' }
  }

  useEffect(() => { loadData() }, [loadData])

  if (loading) return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '48px 32px' }}>
      <div style={{ width: 300, height: 48, background: 'rgba(255,255,255,0.05)', borderRadius: 8 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginTop: 48 }}>
        {[...Array(4)].map((_, i) => <div key={i} style={{ height: 100, background: 'rgba(255,255,255,0.03)', borderRadius: 18, animation: 'skeletonPulse 1.5s ease infinite', animationDelay: `${i*0.1}s` }} />)}
      </div>
    </div>
  )

  if (!project) return (
    <div style={{ padding: 100, textAlign: 'center', color: '#ef4444', fontWeight: 900 }}>
      404: MISSING PROJECT DOMAIN
    </div>
  )

  const activeFeatures = features.filter(f => f.status === 'in_progress' || f.status === 'active').length
  const doneFeatures   = features.filter(f => f.status === 'done' || f.status === 'complete').length
  const progress       = features.length > 0 ? Math.round((doneFeatures / features.length) * 100) : 0

  return (
    <div style={{ background: 'transparent' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '24px 16px 64px' : '40px 32px 80px' }}>
        <title>{`Reminisce — ${project.name}`}</title>

        {/* ── Header ─────────────────────────────────────── */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#10b981', display: 'inline-block', flexShrink: 0,
              boxShadow: '0 0 8px #10b98166',
            }}/>
            <span style={{
              fontSize: 9, fontWeight: 800, letterSpacing: '0.16em',
              textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)',
            }}>
              Live · {project.name}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                <h1 style={{
                  fontSize: 'clamp(28px,3.5vw,44px)', fontWeight: 900,
                  color: '#fff', letterSpacing: '-0.04em',
                  margin: 0, lineHeight: 1,
                }}>
                  {project.name}
                </h1>
                {project.created_via === 'import' && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span style={{
                      fontSize: 9, fontWeight: 800, padding: '3px 9px',
                      borderRadius: 999, letterSpacing: '0.08em',
                      background: 'rgba(99,102,241,0.1)',
                      border: '1px solid rgba(99,102,241,0.25)',
                      color: '#818cf8', textTransform: 'uppercase',
                      flexShrink: 0,
                    }}>
                      Imported
                    </span>
                    {project.scan_source && (
                      <span style={{
                        fontSize: 9, fontWeight: 800, padding: '3px 9px',
                        borderRadius: 999, letterSpacing: '0.08em',
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase',
                        flexShrink: 0,
                      }}>
                        {project.scan_source}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', margin: 0, lineHeight: 1.5 }}>
                {project.description || 'No description — edit in Settings'}
              </p>
            </div>
            <button
              onClick={() => setShowExport(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '9px 18px',
                border: '1px solid rgba(255,255,255,0.09)',
                borderRadius: 10, background: 'rgba(255,255,255,0.04)',
                color: 'rgba(255,255,255,0.45)', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', transition: 'all 0.15s', flexShrink: 0,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = hexToRgba(accent, 0.35)
                e.currentTarget.style.color = accent
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'
                e.currentTarget.style.color = 'rgba(255,255,255,0.45)'
              }}
            >
              ↓ Export Brief
            </button>
          </div>
        </div>

        {/* ── Stats row — single glass pill ─────────────── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
          background: 'rgba(255,255,255,0.025)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 20, overflow: 'hidden',
          marginBottom: 24,
        }}>
          {[
            { label: 'Phases',   value: phases.length,   icon: '⊕' },
            { label: 'Features', value: features.length, icon: '</>' },
            { label: 'Active',   value: activeFeatures,  icon: '↗'  },
            { label: 'Progress', value: `${progress}%`,  icon: '◎'  },
          ].map((stat, i) => (
            <div key={i} style={{
              padding: '20px 24px',
              borderRight: i < 3 ? '1px solid rgba(255,255,255,0.06)' : 'none',
              position: 'relative',
            }}>
              <div style={{
                position: 'absolute', inset: 0,
                background: `radial-gradient(ellipse at 50% 0%,${hexToRgba(accent, 0.05)} 0%,transparent 70%)`,
                pointerEvents: 'none',
              }}/>
              <div style={{
                fontSize: 9, fontWeight: 800, letterSpacing: '0.16em',
                textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)',
                marginBottom: 8,
              }}>{stat.icon} {stat.label}</div>
              <div style={{
                fontSize: 32, fontWeight: 900, color: '#fff',
                letterSpacing: '-0.04em', lineHeight: 1,
              }}>{stat.value}</div>
            </div>
          ))}
        </div>

        {/* ── Overall progress bar ───────────────────────── */}
        <div style={{
          background: 'rgba(255,255,255,0.025)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 16, padding: '16px 20px',
          marginBottom: 20,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>
              Overall Progress
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, color: accent }}>
              {doneFeatures}/{features.length} features complete
            </span>
          </div>
          <div style={{ height: 6, background: 'rgba(255,255,255,0.07)', borderRadius: 999, overflow: 'hidden', marginBottom: 10 }}>
            <div style={{
              height: '100%', width: `${progress}%`,
              background: `linear-gradient(to right, ${accent}, ${hexToRgba(accent, 0.7)})`,
              borderRadius: 999, transition: 'width 0.6s ease',
            }}/>
          </div>
          <div style={{ display: 'flex', gap: 16 }}>
            {[
              { dot: '#10b981', label: `${doneFeatures} Complete` },
              { dot: accent,    label: `${activeFeatures} Active` },
              { dot: 'rgba(255,255,255,0.45)', label: `${features.length - doneFeatures - activeFeatures} Pending` },
            ].map((item, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: item.dot, flexShrink: 0 }}/>
                {item.label}
              </span>
            ))}
          </div>
        </div>

        {/* ── Quick action cards (ThreeDCard, flat glass) ── */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 10, marginBottom: 24 }}>
          {[
            {
              icon: <Wand2 size={20} color={accent}/>,
              label: 'Run Wizard',
              desc: 'Generate or update your blueprint',
              href: `/dashboard/projects/${projectId}/wizard`,
            },
            {
              icon: <GitBranch size={20} color={accent}/>,
              label: 'View Graph',
              desc: 'Explore phase and feature relationships',
              href: `/dashboard/projects/${projectId}/graph`,
            },
            {
              icon: <Bot size={20} color={accent}/>,
              label: 'Ask Agent',
              desc: 'Converse with your project context',
              href: `/dashboard/projects/${projectId}/agent`,
            },
          ].map(action => (
            <ThreeDCard
              key={action.label}
              onClick={() => router.push(action.href)}
              style={{
                background: 'rgba(255,255,255,0.025)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 18, padding: '20px 22px',
              }}
            >
              <span style={{
                position: 'absolute', top: 14, right: 16,
                color: 'rgba(255,255,255,0.15)', fontSize: 13, zIndex: 3,
              }}>→</span>
              <div style={{ marginBottom: 16 }}>{action.icon}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 5 }}>{action.label}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.38)', lineHeight: 1.5 }}>{action.desc}</div>
            </ThreeDCard>
          ))}
        </div>

        {/* ── Local folder connect banner ─────────────────── */}
        {isSupported && !isConnected && (
          <div style={{
            margin: '0 0 20px',
            padding: '14px 20px',
            background: hexToRgba(accent, 0.05),
            border: `1px solid ${hexToRgba(accent, 0.18)}`,
            borderRadius: 14,
            display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', gap: 16,
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 3 }}>
                Connect your project folder
              </div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.38)' }}>
                Link a local folder to read and write context files directly to disk.
              </div>
            </div>
            <button
              onClick={openFolder}
              style={{
                flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 16px', background: accent, color: '#000',
                border: 'none', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}
            >
              <FolderOpen size={14}/> Connect Folder
            </button>
          </div>
        )}

        {isConnected && (
          <div style={{
            margin: '0 0 20px', padding: '12px 16px',
            background: 'rgba(16,185,129,0.05)',
            border: '1px solid rgba(16,185,129,0.18)',
            borderRadius: 12,
            display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', gap: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14, color: '#10b981' }}>✓</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#10b981' }}>
                  {folderName ? `"${folderName}" connected` : 'Local folder connected'}
                  {lastSynced ? ` · Synced ${new Date(lastSynced).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : hasBlueprint ? ' · Blueprint ready to inject' : ''}
                </div>
                {gitState.branch && (
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.32)', marginTop: 2, fontFamily: 'monospace' }}>
                    {gitState.branch}{gitState.lastCommit ? ` · ${gitState.lastCommit.slice(0, 60)}` : ''}
                  </div>
                )}
                {pendingChanges.length > 0 && (
                  <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 3 }}>
                    ⚠ {pendingChanges.length} local file{pendingChanges.length !== 1 ? 's' : ''} changed — open Context to review
                  </div>
                )}
              </div>
            </div>
            {hasBlueprint && !lastSynced && (
              <Link href={`/dashboard/projects/${projectId}/wizard`} style={{ fontSize: 11, fontWeight: 700, color: '#10b981', textDecoration: 'underline', textUnderlineOffset: 3, whiteSpace: 'nowrap', flexShrink: 0 }}>
                Go to Wizard →
              </Link>
            )}
            {lastSynced && (
              <button
                onClick={() => { localStorage.removeItem(`blueprint_synced_${projectId}`); setLastSynced(null) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: 'rgba(255,255,255,0.22)', textDecoration: 'underline', textUnderlineOffset: 2, flexShrink: 0 }}
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* ── Phases section ──────────────────────────────── */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <h2 style={{ fontSize: 13, fontWeight: 800, color: '#fff', letterSpacing: '0.04em', margin: 0, textTransform: 'uppercase' }}>
              Phases
            </h2>
            <span style={{
              fontSize: 10, fontWeight: 700,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.09)',
              color: 'rgba(255,255,255,0.5)',
              borderRadius: 999, padding: '2px 9px',
            }}>{phases.length}</span>
          </div>

          {phases.length === 0 ? (
            <div style={{
              padding: '64px 32px', textAlign: 'center',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
              background: 'rgba(255,255,255,0.02)',
              borderRadius: 20, border: '1px dashed rgba(255,255,255,0.08)',
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: 14,
                background: hexToRgba(accent, 0.08),
                border: `1px solid ${hexToRgba(accent, 0.2)}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 22,
              }}>✦</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'rgba(255,255,255,0.45)' }}>
                No phases yet
              </div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.25)', maxWidth: 280, lineHeight: 1.6 }}>
                Run the Wizard to generate phases and features for this project.
              </div>
              <Link
                href={`/dashboard/projects/${projectId}/wizard`}
                style={{
                  marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '9px 20px', background: accent, color: '#000',
                  borderRadius: 999, fontSize: 12, fontWeight: 800, textDecoration: 'none',
                  boxShadow: `0 0 24px ${hexToRgba(accent, 0.35)}`,
                }}
              >
                Open Wizard → 
              </Link>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {phases.map((phase) => {
                const phaseFeatures = features.filter(f => f.phase_id === phase.id)
                const phaseDone = phaseFeatures.filter(f => f.status === 'done' || f.status === 'complete').length
                return (
                  <div key={phase.id} style={{
                    padding: '18px 22px',
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.07)',
                    borderRadius: 16,
                    display: 'flex', alignItems: 'flex-start', gap: 16,
                    transition: 'border-color 0.2s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = hexToRgba(accent, 0.2)}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'}
                  >
                    <div style={{
                      width: 34, height: 34, borderRadius: 10,
                      background: hexToRgba(accent, 0.1),
                      border: `1px solid ${hexToRgba(accent, 0.25)}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 800, color: accent, flexShrink: 0,
                    }}>
                      P{(phase.order_index || 0) + 1}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{phase.name}</span>
                        <span style={{
                          fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 999,
                          background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)',
                          letterSpacing: '0.06em', flexShrink: 0, marginLeft: 8,
                        }}>
                          {phaseDone}/{phaseFeatures.length} features
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5, marginBottom: 10 }}>
                        {phase.description}
                      </div>
                      <div style={{ height: 3, background: 'rgba(255,255,255,0.07)', borderRadius: 999, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%',
                          width: phaseFeatures.length > 0 ? `${(phaseDone / phaseFeatures.length) * 100}%` : '0%',
                          background: accent, borderRadius: 999, transition: 'width 0.4s ease',
                        }}/>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ── Team ─────────────────────────────────────── */}
        <section style={{ marginTop: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={{ fontSize: 13, fontWeight: 800, color: '#fff', letterSpacing: '0.04em', margin: 0, textTransform: 'uppercase' }}>
                Team
              </h2>
              <span style={{
                fontSize: 10, fontWeight: 700,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.09)',
                color: 'rgba(255,255,255,0.5)',
                borderRadius: 999, padding: '2px 9px',
              }}>{members.filter(m => m.invite_status === 'accepted').length}/8</span>
            </div>
            {myRole === 'head' && members.filter(m => m.invite_status !== 'declined').length < 8 && (
              <button
                onClick={() => setShowInviteModal(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 14px', borderRadius: 10,
                  background: hexToRgba(accent, 0.1),
                  border: `1px solid ${hexToRgba(accent, 0.25)}`,
                  color: accent, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                }}
              >
                + Invite member
              </button>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {members.map(member => {
              const rc = roleColor(member.role)
              const isPending = member.invite_status === 'pending'
              return (
                <div key={member.id} style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '14px 18px',
                  background: 'rgba(255,255,255,0.025)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: 12,
                  opacity: isPending ? 0.65 : 1,
                }}>
                  {/* Avatar */}
                  <div style={{
                    width: 34, height: 34, borderRadius: '50%',
                    background: isPending ? 'rgba(255,255,255,0.06)' : hexToRgba(accent, 0.1),
                    border: `1px solid ${isPending ? 'rgba(255,255,255,0.1)' : hexToRgba(accent, 0.2)}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 700, color: isPending ? 'rgba(255,255,255,0.3)' : accent,
                    flexShrink: 0,
                  }}>
                    {isPending ? '?' : (member.email?.[0]?.toUpperCase() || '?')}
                  </div>
                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {member.email || 'Unknown'}
                      {member.user_id === currentUser && (
                        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginLeft: 8 }}>you</span>
                      )}
                    </div>
                    {isPending && (
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>Invite pending — awaiting sign-up</div>
                    )}
                  </div>
                  {/* Role badge */}
                  <span style={{
                    fontSize: 9, fontWeight: 800, padding: '3px 9px',
                    borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.08em',
                    background: rc.bg, color: rc.color, border: `1px solid ${rc.border}`,
                    flexShrink: 0,
                  }}>
                    {member.role}
                  </span>
                  {/* Remove (head only, not self) */}
                  {myRole === 'head' && member.user_id !== currentUser && member.role !== 'head' && (
                    <button
                      onClick={() => member.user_id && handleRemoveMember(member.user_id)}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'rgba(255,255,255,0.2)', fontSize: 16, padding: '0 4px',
                        lineHeight: 1, flexShrink: 0,
                        transition: 'color 0.15s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                      onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.2)'}
                      title="Remove member"
                    >
                      ×
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </section>

        {/* ── Invite Modal ─────────────────────────────── */}
        {showInviteModal && (
          <div style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(10px)',
            zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}>
            <div style={{
              background: 'rgba(10,10,24,0.98)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 20, padding: '32px',
              maxWidth: 420, width: '100%',
              boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
            }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: '#fff', marginBottom: 6 }}>Invite a team member</div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginBottom: 24, lineHeight: 1.6 }}>
                They must have or create a Reminisce account with this email address.
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Email</div>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="colleague@example.com"
                  onKeyDown={e => { if (e.key === 'Enter') handleInvite() }}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 10, padding: '11px 14px',
                    fontSize: 13, color: '#fff', outline: 'none',
                  }}
                  autoFocus
                />
              </div>

              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Role</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['collaborator', 'viewer'] as const).map(r => (
                    <button
                      key={r}
                      onClick={() => setInviteRole(r)}
                      style={{
                        flex: 1, padding: '12px 16px', borderRadius: 10,
                        background: inviteRole === r ? hexToRgba(accent, 0.12) : 'rgba(255,255,255,0.04)',
                        border: `1px solid ${inviteRole === r ? hexToRgba(accent, 0.3) : 'rgba(255,255,255,0.09)'}`,
                        color: inviteRole === r ? accent : 'rgba(255,255,255,0.5)',
                        cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 3 }}>
                        {r.charAt(0).toUpperCase() + r.slice(1)}
                      </div>
                      <div style={{ fontSize: 10, opacity: 0.65, lineHeight: 1.4 }}>
                        {r === 'collaborator'
                          ? 'Can view and edit features, use PAM, view graph/board/prompts/API lab'
                          : 'Read-only access to graph, board, prompts, and API lab'}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => { setShowInviteModal(false); setInviteEmail('') }}
                  style={{
                    flex: 1, padding: '11px', background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 10, fontSize: 13, fontWeight: 600,
                    color: 'rgba(255,255,255,0.5)', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleInvite}
                  disabled={!inviteEmail.trim() || inviting}
                  style={{
                    flex: 2, padding: '11px',
                    background: inviteEmail.trim() && !inviting ? accent : 'rgba(255,255,255,0.08)',
                    border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 800,
                    color: inviteEmail.trim() && !inviting ? '#000' : 'rgba(255,255,255,0.25)',
                    cursor: inviteEmail.trim() && !inviting ? 'pointer' : 'not-allowed',
                  }}
                >
                  {inviting ? 'Inviting…' : 'Send invite'}
                </button>
              </div>
            </div>
          </div>
        )}

        {showExport && project && (
          <ExportBriefModal
            data={{
              project: { name: project.name, created_at: project.created_at },
              phases: phases.map(p => ({ id: p.id, name: p.name, description: p.description, order: p.order_index })),
              features: features.map(f => ({ id: f.id, name: f.name, description: f.description, phase_id: f.phase_id, status: f.status })),
              context: contextDoc || '',
            }}
            onClose={() => setShowExport(false)}
          />
        )}
      </div>
    </div>
  )
}