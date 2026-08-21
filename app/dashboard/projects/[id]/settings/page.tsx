'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  Trash2,
  AlertTriangle,
  UserPlus,
  Crown,
  Users,
  Clock,
  X,
  ChevronDown,
  Check,
} from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { toast } from 'sonner'
import { ThemeSwitcher } from '@/components/theme-switcher'
import type { User as SupabaseUser } from '@supabase/supabase-js'

function hexToRgba(hex: string, a: number) {
  if (!hex || hex.length < 7) return `rgba(255,255,255,${a})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

function getInitials(email: string) {
  const parts = email.split('@')[0].split(/[._-]/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return email.slice(0, 2).toUpperCase()
}

import { Project } from '@/types/project'

interface TeamMember {
  id:            string
  user_id:       string | null
  role:          'head' | 'collaborator' | 'viewer'
  invite_status: 'accepted' | 'pending' | 'declined'
  invite_email:  string | null
  email:         string
  created_at:    string
  invited_by:    string | null
}

const PROVIDERS = [
  { id: 'anthropic',  name: 'Anthropic',  placeholder: 'sk-ant-...' },
  { id: 'openrouter', name: 'OpenRouter', placeholder: 'sk-or-...' },
  { id: 'mistral',    name: 'Mistral',    placeholder: '...' },
  { id: 'google',     name: 'Google AI',  placeholder: 'AIza...' },
  { id: 'minimax',    name: 'MiniMax',    placeholder: '...' },
]

const ROLE_LABELS: Record<string, string> = {
  head:         'Head',
  collaborator: 'Collaborator',
  viewer:       'Viewer',
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  collaborator: 'Can edit features, run agents, and manage context.',
  viewer:       'Read-only access to all project content.',
}

export default function SettingsPage() {
  const params   = useParams()
  const router   = useRouter()
  const projectId = params.id as string
  const { accent } = useTheme()

  const [activeTab,       setActiveTab]       = useState('aesthetics')
  const [loading,         setLoading]         = useState(true)
  const [project,         setProject]         = useState<Project | null>(null)
  const [user,            setUser]            = useState<SupabaseUser | null>(null)
  const [authHeader,      setAuthHeader]      = useState<Record<string, string>>({})

  const [configuredProviders, setConfiguredProviders] = useState<string[]>([])
  const [keyInputs,       setKeyInputs]       = useState<Record<string, string>>({})
  const [userPlan,        setUserPlan]        = useState<'free' | 'pro'>('free')

  const [isMobile,        setIsMobile]        = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDeletingProject, setIsDeletingProject] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [isHead,          setIsHead]          = useState(false)

  const [cancelling,      setCancelling]      = useState(false)
  const [cancelConfirm,   setCancelConfirm]   = useState(false)
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>('active')
  const [savingProject,   setSavingProject]   = useState(false)
  const [savingProvider,  setSavingProvider]  = useState<string | null>(null)

  // ── Team state ───────────────────────────────────────────────────────────────
  const [members,         setMembers]         = useState<TeamMember[]>([])
  const [membersLoading,  setMembersLoading]  = useState(false)
  const [inviteEmail,     setInviteEmail]     = useState('')
  const [inviteRole,      setInviteRole]      = useState<'collaborator' | 'viewer'>('collaborator')
  const [inviting,        setInviting]        = useState(false)
  const [removingId,      setRemovingId]      = useState<string | null>(null)
  const [roleChangingId,  setRoleChangingId]  = useState<string | null>(null)
  const [openRoleMenu,    setOpenRoleMenu]    = useState<string | null>(null)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const fetchKeys = useCallback(async (headers: Record<string, string>) => {
    try {
      const res = await fetch('/api/keys/list', { headers })
      const data = await res.json()
      if (data.providers) setConfiguredProviders(data.providers)
    } catch { }
  }, [])

  const fetchMembers = useCallback(async (headers: Record<string, string>) => {
    setMembersLoading(true)
    try {
      const res = await fetch(`/api/team/members?projectId=${projectId}`, { headers })
      const data = await res.json()
      if (data.members) setMembers(data.members)
    } catch {
      toast.error('Failed to load team members')
    } finally {
      setMembersLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setLoading(false); return }

        const headers = { Authorization: `Bearer ${session.access_token}` }
        setAuthHeader(headers)

        // Fetch project via service-role API (no RLS issues)
        const [projRes, authUserRes] = await Promise.all([
          fetch(`/api/projects/${projectId}`, { headers }),
          supabase.auth.getUser(),
        ])

        if (projRes.ok) {
          const projData = await projRes.json()
          if (projData.project) setProject(projData.project)
        }

        const u = authUserRes.data?.user
        if (u) {
          setUser(u)

          const { data: planData } = await supabase
            .from('user_plans')
            .select('plan, status')
            .eq('user_id', u.id)
            .maybeSingle()

          if (planData) {
            const plan = planData.plan
            setUserPlan(plan === 'pro' ? 'pro' : 'free')
            setSubscriptionStatus(planData.status ?? 'active')
          }
        }

        // Determine head status from the members list (service role, no RLS)
        const membersRes = await fetch(`/api/team/members?projectId=${projectId}`, { headers })
        if (membersRes.ok) {
          const membersData = await membersRes.json()
          if (membersData.members) {
            setMembers(membersData.members)
            const me = membersData.members.find(
              (m: TeamMember) => m.user_id === u?.id && m.invite_status === 'accepted'
            )
            setIsHead(me?.role === 'head')
          }
        }

        await fetchKeys(headers)
      } catch (err) {
        console.error('[settings] init failed:', err)
        toast.error('Failed to load settings')
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [projectId, fetchKeys])

  useEffect(() => {
    if (!loading && !isHead && activeTab === 'workspace') setActiveTab('aesthetics')
  }, [loading, isHead, activeTab])

  // Close role menu on outside click
  useEffect(() => {
    if (!openRoleMenu) return
    const close = () => setOpenRoleMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [openRoleMenu])

  // ── Key management ────────────────────────────────────────────────────────────
  const saveKey = async (provider: string) => {
    const apiKey = keyInputs[provider]
    if (!apiKey || savingProvider) return
    setSavingProvider(provider)
    try {
      const res = await fetch('/api/keys/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ provider, apiKey }),
      })
      if (!res.ok) throw new Error()
      toast.success(`${provider.toUpperCase()} key secured`)
      setKeyInputs(prev => ({ ...prev, [provider]: '' }))
      fetchKeys(authHeader)
    } catch { toast.error('Failed to secure key') }
    finally { setSavingProvider(null) }
  }

  const deleteKey = async (provider: string) => {
    if (savingProvider) return
    setSavingProvider(provider)
    try {
      const res = await fetch('/api/keys/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ provider }),
      })
      if (!res.ok) throw new Error()
      toast.success(`${provider.toUpperCase()} key purged`)
      fetchKeys(authHeader)
    } catch { toast.error('Purge failed') }
    finally { setSavingProvider(null) }
  }

  // ── Project settings ──────────────────────────────────────────────────────────
  const handleUpdateProject = async () => {
    if (!project || savingProject) return
    setSavingProject(true)
    try {
      const { error } = await supabase.from('projects').update({
        name:              project.name,
        repo_url:          project.repo_url ?? null,
        editor_preference: project.editor_preference ?? 'generic',
      }).eq('id', projectId)
      if (error) throw error
      toast.success('Project configuration updated')
    } catch { toast.error('Update failed') }
    finally { setSavingProject(false) }
  }

  const handleDeleteProject = async () => {
    setIsDeletingProject(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: authHeader,
      })
      if (!res.ok) throw new Error('Delete failed')
      toast.success('Project deleted')
      router.push('/dashboard')
    } catch {
      toast.error('Delete failed')
      setIsDeletingProject(false)
      setShowDeleteConfirm(false)
    }
  }

  const handleCancelSubscription = async () => {
    if (cancelling) return
    setCancelling(true)
    try {
      const res = await fetch('/api/stripe/cancel', {
        method: 'POST',
        headers: authHeader,
      })
      const data = await res.json()
      if (data.ok) {
        toast.success('Subscription cancelled — you keep Pro until the end of your billing period.')
        setSubscriptionStatus('cancelled')
        setCancelConfirm(false)
      } else {
        toast.error(data.error || 'Cancellation failed')
      }
    } catch { toast.error('Cancellation failed') }
    setCancelling(false)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // ── Team actions ──────────────────────────────────────────────────────────────
  const handleInvite = async () => {
    if (!inviteEmail.trim()) return
    setInviting(true)
    try {
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ projectId, email: inviteEmail.trim(), role: inviteRole }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Invite failed'); return }
      if (data.status === 'pending') {
        toast.success(`Invite sent to ${inviteEmail.trim()} — they'll join when they sign up.`)
      } else {
        toast.success(`${inviteEmail.trim()} added to the project.`)
      }
      setInviteEmail('')
      fetchMembers(authHeader)
    } catch { toast.error('Invite failed') }
    finally { setInviting(false) }
  }

  const handleRemoveMember = async (member: TeamMember) => {
    setRemovingId(member.id)
    try {
      const params = new URLSearchParams({ projectId })
      // Pending invites have no user_id — remove by row id
      if (member.invite_status === 'pending' || !member.user_id) {
        params.set('memberId', member.id)
      } else {
        params.set('userId', member.user_id)
      }
      const res = await fetch(`/api/team/members?${params}`, {
        method: 'DELETE',
        headers: authHeader,
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Remove failed'); return }
      toast.success(member.invite_status === 'pending' ? 'Invite cancelled.' : 'Member removed.')
      fetchMembers(authHeader)
    } catch { toast.error('Remove failed') }
    finally { setRemovingId(null) }
  }

  const handleRoleChange = async (member: TeamMember, newRole: 'collaborator' | 'viewer') => {
    setRoleChangingId(member.id)
    setOpenRoleMenu(null)
    try {
      const res = await fetch('/api/team/members', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ projectId, userId: member.user_id, role: newRole }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Role change failed'); return }
      toast.success(`Role updated to ${ROLE_LABELS[newRole]}.`)
      fetchMembers(authHeader)
    } catch { toast.error('Role change failed') }
    finally { setRoleChangingId(null) }
  }

  if (loading) return (
    <div style={{ padding: 48, background: '#07070f', color: '#fff' }} className="page-enter">
      Calibrating Settings…
    </div>
  )

  const acceptedCount = members.filter(m => m.invite_status === 'accepted').length
  const pendingCount  = members.filter(m => m.invite_status === 'pending').length
  const totalNonDeclined = members.filter(m => m.invite_status !== 'declined').length
  const atCap = totalNonDeclined >= 8

  return (
    <div style={{ minHeight: '100vh', background: '#05050f', paddingBottom: 80 }}>
      <div
        style={{ maxWidth: 840, margin: '0 auto', padding: isMobile ? '32px 20px' : '64px 32px' }}
        className="page-enter"
      >
        <title>{`Settings — ${project?.name}`}</title>

        <div style={{ marginBottom: 48 }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase', color: accent, marginBottom: 8 }}>
            Project Configuration
          </div>
          <h1 style={{ fontSize: 32, fontWeight: 900, color: '#fff', letterSpacing: '-0.03em', marginBottom: 8, lineHeight: 1 }}>
            Settings
          </h1>
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>
            Configure your project, team, and workspace preferences.
          </p>
        </div>

        {/* TAB NAVIGATION */}
        <div style={{
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          marginBottom: 32,
          display: 'flex', gap: 0,
          overflowX: 'auto',
          padding: '0 4px',
        }} className="hide-scrollbar">
          {[
            ...(isHead ? [{ id: 'workspace', label: 'Workspace' }] : []),
            { id: 'team',         label: 'Team' },
            { id: 'subscription', label: 'Subscription' },
            { id: 'models',       label: 'Models' },
            { id: 'aesthetics',   label: 'Aesthetics' },
            { id: 'advanced',     label: 'Advanced' },
          ].map(t => {
            const isActive = activeTab === t.id
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                style={{
                  padding: '12px 0', marginRight: 24,
                  background: 'transparent', border: 'none',
                  borderBottom: isActive ? `2px solid ${accent}` : '2px solid transparent',
                  color: isActive ? '#fff' : 'rgba(255,255,255,0.4)',
                  fontSize: 13, fontWeight: isActive ? 700 : 400,
                  cursor: 'pointer', transition: 'all 0.15s',
                  marginBottom: -1, minWidth: 'max-content',
                  position: 'relative',
                }}
              >
                {t.label}
                {t.id === 'team' && pendingCount > 0 && (
                  <span style={{
                    position: 'absolute', top: 8, right: -8,
                    width: 6, height: 6, borderRadius: '50%',
                    background: accent,
                  }}/>
                )}
              </button>
            )
          })}
        </div>

        {/* TAB CONTENT */}
        <div>

          {/* ── AESTHETICS ── */}
          {activeTab === 'aesthetics' && (
            <div className="page-enter">
              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 18, padding: '24px 28px', marginBottom: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Accent theme</h3>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', lineHeight: 1.7, marginBottom: 20 }}>
                  Personalize the visual identity of your project dashboard.
                </p>
                <ThemeSwitcher />
              </div>
            </div>
          )}

          {/* ── TEAM ── */}
          {activeTab === 'team' && (
            <div className="page-enter">

              {/* Member count header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Users size={15} color={accent} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
                    {acceptedCount} member{acceptedCount !== 1 ? 's' : ''}
                  </span>
                  {pendingCount > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: hexToRgba(accent, 0.1), color: accent, border: `1px solid ${hexToRgba(accent, 0.25)}` }}>
                      {pendingCount} pending
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace' }}>
                  {totalNonDeclined}/8
                </span>
              </div>

              {/* Member list */}
              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 18, overflow: 'hidden', marginBottom: 16 }}>
                {membersLoading ? (
                  <div style={{ padding: '32px', textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>
                    Loading members…
                  </div>
                ) : members.length === 0 ? (
                  <div style={{ padding: '40px 28px', textAlign: 'center' }}>
                    <Users size={32} color="rgba(255,255,255,0.12)" style={{ marginBottom: 12 }} />
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.35)', marginBottom: 6 }}>No team members yet</div>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.2)' }}>Invite collaborators below to get started.</div>
                  </div>
                ) : (
                  members.map((m, i) => {
                    const isMe = m.user_id === user?.id
                    const isPending = m.invite_status === 'pending'
                    const displayEmail = m.email || m.invite_email || 'Unknown'
                    const isRemoving = removingId === m.id
                    const isChangingRole = roleChangingId === m.id
                    const showRoleMenu = openRoleMenu === m.id
                    const canEdit = isHead && !isMe && m.role !== 'head'

                    return (
                      <div
                        key={m.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 14,
                          padding: '16px 24px',
                          borderBottom: i < members.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                          opacity: isRemoving ? 0.4 : 1,
                          transition: 'opacity 0.15s',
                        }}
                      >
                        {/* Avatar */}
                        <div style={{
                          width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                          background: m.role === 'head'
                            ? hexToRgba(accent, 0.15)
                            : isPending
                            ? 'rgba(255,255,255,0.04)'
                            : 'rgba(255,255,255,0.07)',
                          border: `1px solid ${m.role === 'head' ? hexToRgba(accent, 0.3) : 'rgba(255,255,255,0.08)'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 11, fontWeight: 800,
                          color: m.role === 'head' ? accent : isPending ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.5)',
                        }}>
                          {isPending ? <Clock size={14} /> : getInitials(displayEmail)}
                        </div>

                        {/* Info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{
                              fontSize: 13, fontWeight: 600, color: isPending ? 'rgba(255,255,255,0.4)' : '#fff',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {displayEmail}
                            </span>
                            {isMe && (
                              <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 999, background: hexToRgba(accent, 0.1), color: accent, border: `1px solid ${hexToRgba(accent, 0.2)}`, letterSpacing: '0.06em' }}>
                                YOU
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginTop: 2 }}>
                            {isPending ? 'Invite pending — waiting to sign up' : `Joined ${new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
                          </div>
                        </div>

                        {/* Role badge / dropdown */}
                        <div style={{ position: 'relative', flexShrink: 0 }}>
                          {canEdit && !isPending ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); setOpenRoleMenu(showRoleMenu ? null : m.id) }}
                              disabled={isChangingRole}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 5,
                                padding: '5px 10px', borderRadius: 8,
                                background: showRoleMenu ? hexToRgba(accent, 0.1) : 'rgba(255,255,255,0.04)',
                                border: `1px solid ${showRoleMenu ? hexToRgba(accent, 0.3) : 'rgba(255,255,255,0.08)'}`,
                                color: showRoleMenu ? accent : 'rgba(255,255,255,0.5)',
                                fontSize: 11, fontWeight: 700, cursor: 'pointer',
                                transition: 'all 0.15s',
                              }}
                            >
                              {isChangingRole ? '…' : ROLE_LABELS[m.role]}
                              {!isChangingRole && <ChevronDown size={10} />}
                            </button>
                          ) : (
                            <span style={{
                              padding: '4px 10px', borderRadius: 8,
                              background: m.role === 'head'
                                ? hexToRgba(accent, 0.1)
                                : isPending
                                ? 'rgba(255,255,255,0.03)'
                                : 'rgba(255,255,255,0.04)',
                              border: `1px solid ${m.role === 'head' ? hexToRgba(accent, 0.25) : 'rgba(255,255,255,0.07)'}`,
                              color: m.role === 'head' ? accent : isPending ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.4)',
                              fontSize: 11, fontWeight: 700,
                              display: 'flex', alignItems: 'center', gap: 5,
                            }}>
                              {m.role === 'head' && <Crown size={9} />}
                              {isPending ? 'Pending' : ROLE_LABELS[m.role]}
                            </span>
                          )}

                          {/* Role dropdown */}
                          {showRoleMenu && (
                            <div
                              onClick={e => e.stopPropagation()}
                              style={{
                                position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 50,
                                background: 'rgba(10,10,24,0.98)', border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: 12, overflow: 'hidden', minWidth: 200,
                                boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
                              }}
                            >
                              {(['collaborator', 'viewer'] as const).map(r => (
                                <button
                                  key={r}
                                  onClick={() => handleRoleChange(m, r)}
                                  style={{
                                    width: '100%', display: 'flex', alignItems: 'flex-start', gap: 10,
                                    padding: '12px 16px', background: 'transparent', border: 'none',
                                    borderBottom: r === 'collaborator' ? '1px solid rgba(255,255,255,0.05)' : 'none',
                                    cursor: 'pointer', textAlign: 'left',
                                  }}
                                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                >
                                  <Check size={12} color={m.role === r ? accent : 'transparent'} style={{ flexShrink: 0, marginTop: 2 }} />
                                  <div>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 2 }}>{ROLE_LABELS[r]}</div>
                                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', lineHeight: 1.4 }}>{ROLE_DESCRIPTIONS[r]}</div>
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Remove button */}
                        {isHead && !isMe && (
                          <button
                            onClick={() => handleRemoveMember(m)}
                            disabled={isRemoving}
                            title={isPending ? 'Cancel invite' : 'Remove member'}
                            style={{
                              flexShrink: 0, padding: '6px 8px',
                              background: 'transparent', border: 'none',
                              color: 'rgba(255,255,255,0.2)', cursor: 'pointer',
                              borderRadius: 8, transition: 'all 0.15s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.background = 'rgba(248,113,113,0.08)' }}
                            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.2)'; e.currentTarget.style.background = 'transparent' }}
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    )
                  })
                )}
              </div>

              {/* Invite form — head only */}
              {isHead && (
                <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 18, padding: '24px 28px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                    <UserPlus size={14} color={accent} />
                    <h3 style={{ fontSize: 13, fontWeight: 700, color: '#fff', margin: 0 }}>Invite a teammate</h3>
                  </div>

                  {atCap ? (
                    <div style={{ padding: '14px 18px', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 12, fontSize: 13, color: '#f87171' }}>
                      Team is at the 8-member limit. Remove a member to invite someone new.
                    </div>
                  ) : (
                    <>
                      <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', lineHeight: 1.65, marginBottom: 20 }}>
                        Existing Reminisce users are added immediately. New users will appear as pending until they sign up with this email.
                      </p>
                      <div style={{ display: 'flex', gap: 10, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                        <input
                          type="email"
                          placeholder="teammate@example.com"
                          value={inviteEmail}
                          onChange={e => setInviteEmail(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleInvite()}
                          style={{
                            flex: 1, minWidth: isMobile ? '100%' : 0,
                            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
                            borderRadius: 12, padding: '11px 14px', fontSize: 13, color: '#fff', outline: 'none',
                            transition: 'border-color 0.2s',
                          }}
                          onFocus={e => e.currentTarget.style.borderColor = accent}
                          onBlur={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'}
                        />

                        {/* Role selector */}
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          {(['collaborator', 'viewer'] as const).map(r => (
                            <button
                              key={r}
                              onClick={() => setInviteRole(r)}
                              style={{
                                padding: '8px 14px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                                background: inviteRole === r ? hexToRgba(accent, 0.12) : 'rgba(255,255,255,0.04)',
                                border: `1px solid ${inviteRole === r ? hexToRgba(accent, 0.3) : 'rgba(255,255,255,0.08)'}`,
                                color: inviteRole === r ? accent : 'rgba(255,255,255,0.4)',
                                cursor: 'pointer', transition: 'all 0.15s',
                              }}
                            >
                              {ROLE_LABELS[r]}
                            </button>
                          ))}
                        </div>

                        <button
                          onClick={handleInvite}
                          disabled={inviting || !inviteEmail.trim()}
                          style={{
                            padding: '10px 20px', borderRadius: 10,
                            background: inviteEmail.trim() ? accent : 'rgba(255,255,255,0.04)',
                            border: inviteEmail.trim() ? 'none' : '1px solid rgba(255,255,255,0.08)',
                            color: inviteEmail.trim() ? '#000' : 'rgba(255,255,255,0.2)',
                            fontSize: 12, fontWeight: 800,
                            cursor: inviteEmail.trim() && !inviting ? 'pointer' : 'not-allowed',
                            flexShrink: 0, transition: 'all 0.15s',
                            opacity: inviting ? 0.6 : 1,
                          }}
                        >
                          {inviting ? 'Inviting…' : 'Invite'}
                        </button>
                      </div>

                      {/* Role descriptions */}
                      <div style={{ marginTop: 14, padding: '12px 16px', background: 'rgba(255,255,255,0.02)', borderRadius: 10 }}>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', lineHeight: 1.65 }}>
                          <strong style={{ color: 'rgba(255,255,255,0.45)' }}>Collaborator</strong> — {ROLE_DESCRIPTIONS.collaborator}<br />
                          <strong style={{ color: 'rgba(255,255,255,0.45)' }}>Viewer</strong> — {ROLE_DESCRIPTIONS.viewer}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Non-head: viewer notice */}
              {!isHead && (
                <div style={{ padding: '16px 20px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14 }}>
                  <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', margin: 0, lineHeight: 1.6 }}>
                    Only the project head can invite or remove members.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── MODELS ── */}
          {activeTab === 'models' && (
            <div className="page-enter">
              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 18, padding: '24px 28px', marginBottom: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 16 }}>API Key Configuration</h3>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', lineHeight: 1.7, marginBottom: 24 }}>
                  Connect your AI providers to enable model routing and context injection.
                </p>

                {userPlan !== 'pro' ? (
                  <div style={{ border: `1px solid ${hexToRgba(accent, 0.25)}`, borderRadius: 16, padding: '32px 28px', background: hexToRgba(accent, 0.05), textAlign: 'center' }}>
                    <div style={{ fontSize: 32, marginBottom: 14 }}>🔒</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 8 }}>BYOK is a Pro feature</div>
                    <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', lineHeight: 1.65, marginBottom: 24, maxWidth: 380, margin: '0 auto 24px' }}>
                      Bring Your Own Key (BYOK) lets you use your personal API keys for Anthropic, OpenRouter, Mistral, and more.
                    </p>
                    <button
                      onClick={() => window.location.href = '/upgrade'}
                      style={{ padding: '10px 24px', background: accent, color: '#000', border: 'none', borderRadius: 999, fontSize: 12, fontWeight: 800, textTransform: 'uppercase', cursor: 'pointer' }}
                    >
                      Upgrade to Pro
                    </button>
                  </div>
                ) : (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, padding: '11px 16px', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 12 }}>
                      <span style={{ color: '#34d399', fontSize: 11, fontWeight: 700 }}>Configured</span>
                      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>Your own keys have no usage limits.</span>
                    </div>
                    {PROVIDERS.map(p => {
                      const isConfigured = configuredProviders.includes(p.id)
                      const isSaving = savingProvider === p.id
                      const anyBusy = savingProvider !== null
                      return (
                        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', opacity: anyBusy && !isSaving ? 0.5 : 1, transition: 'opacity 0.15s' }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.6)', minWidth: 90 }}>{p.name}</div>
                          <div style={{ flex: 1, display: 'flex', gap: 8 }}>
                            <input
                              type="password"
                              placeholder={isConfigured ? '••••••••••••••••' : p.placeholder}
                              value={keyInputs[p.id] || ''}
                              onChange={e => setKeyInputs(prev => ({ ...prev, [p.id]: e.target.value }))}
                              disabled={anyBusy}
                              style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 12, padding: '11px 14px', fontSize: 13, color: '#fff', fontFamily: 'monospace', outline: 'none', transition: 'border-color 0.2s' }}
                              onFocus={e => e.currentTarget.style.borderColor = accent}
                              onBlur={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'}
                            />
                            <button
                              onClick={() => saveKey(p.id)}
                              disabled={!keyInputs[p.id] || anyBusy}
                              style={{ padding: '8px 16px', background: keyInputs[p.id] && !anyBusy ? accent : 'rgba(255,255,255,0.04)', color: keyInputs[p.id] && !anyBusy ? '#000' : 'rgba(255,255,255,0.2)', border: keyInputs[p.id] && !anyBusy ? 'none' : '1px solid rgba(255,255,255,0.09)', borderRadius: 10, fontSize: 11, fontWeight: 700, cursor: keyInputs[p.id] && !anyBusy ? 'pointer' : 'not-allowed', minWidth: 56 }}
                            >
                              {isSaving ? '…' : 'Save'}
                            </button>
                            {isConfigured && (
                              <button
                                onClick={() => deleteKey(p.id)}
                                disabled={anyBusy}
                                style={{ padding: '8px 12px', background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 10, color: anyBusy ? 'rgba(248,113,113,0.3)' : 'rgba(248,113,113,0.6)', cursor: anyBusy ? 'not-allowed' : 'pointer' }}
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── SUBSCRIPTION ── */}
          {activeTab === 'subscription' && (
            <div className="page-enter" style={{ maxWidth: 480 }}>
              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 18, padding: '24px 28px', marginBottom: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Subscription</h3>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginBottom: 24, lineHeight: 1.6 }}>
                  {userPlan === 'pro' && subscriptionStatus === 'cancelled'
                    ? 'Your subscription is cancelled. Pro access continues until the end of your billing period.'
                    : userPlan === 'pro'
                    ? 'You\'re on the Pro plan.'
                    : 'You\'re on the Free plan.'}
                </p>
                <div style={{ padding: '16px 20px', background: userPlan === 'pro' ? hexToRgba(accent, 0.06) : 'rgba(255,255,255,0.03)', border: `1px solid ${userPlan === 'pro' ? hexToRgba(accent, 0.2) : 'rgba(255,255,255,0.08)'}`, borderRadius: 14, marginBottom: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>{userPlan === 'pro' ? 'Pro' : 'Free'}</div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 3 }}>
                        {userPlan === 'pro'
                          ? subscriptionStatus === 'cancelled' ? 'Cancelled — active until period end' : 'Active subscription'
                          : '2 projects · 50 coins/day'}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 999, background: userPlan === 'pro' ? hexToRgba(accent, 0.15) : 'rgba(255,255,255,0.06)', color: userPlan === 'pro' ? accent : 'rgba(255,255,255,0.4)', border: `1px solid ${userPlan === 'pro' ? hexToRgba(accent, 0.3) : 'rgba(255,255,255,0.1)'}` }}>
                      {userPlan === 'pro' ? 'PRO' : 'FREE'}
                    </span>
                  </div>
                </div>
                {userPlan === 'free' && (
                  <a href="/upgrade" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 24px', background: accent, color: '#000', borderRadius: 10, fontSize: 13, fontWeight: 800, textDecoration: 'none', boxShadow: `0 0 20px ${hexToRgba(accent, 0.3)}` }}>
                    Upgrade to Pro →
                  </a>
                )}
                {userPlan === 'pro' && subscriptionStatus !== 'cancelled' && (
                  !cancelConfirm ? (
                    <button onClick={() => setCancelConfirm(true)} style={{ padding: '10px 20px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 10, fontSize: 13, fontWeight: 600, color: '#f87171', cursor: 'pointer' }}>
                      Cancel subscription
                    </button>
                  ) : (
                    <div style={{ padding: '16px', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 12 }}>
                      <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', marginBottom: 14, lineHeight: 1.6 }}>
                        Are you sure? You&apos;ll keep Pro access until the end of your current billing period, then revert to Free.
                      </p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => setCancelConfirm(false)} style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#fff', cursor: 'pointer' }}>Keep Pro</button>
                        <button onClick={handleCancelSubscription} disabled={cancelling} style={{ padding: '8px 16px', background: cancelling ? 'rgba(248,113,113,0.3)' : '#f87171', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 800, color: '#000', cursor: cancelling ? 'not-allowed' : 'pointer' }}>
                          {cancelling ? 'Cancelling…' : 'Yes, cancel'}
                        </button>
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {/* ── WORKSPACE ── */}
          {activeTab === 'workspace' && project && (
            <div className="page-enter">
              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 18, padding: '24px 28px', marginBottom: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Workspace info</h3>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', lineHeight: 1.7, marginBottom: 24 }}>
                  Global metadata for your project and blueprint identification.
                </p>
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', marginBottom: 6 }}>Project Name</div>
                  <input type="text" value={project.name} onChange={e => setProject({ ...project, name: e.target.value })} style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 12, padding: '11px 14px', fontSize: 13, color: '#fff', outline: 'none', transition: 'border-color 0.2s' }} onFocus={e => e.currentTarget.style.borderColor = accent} onBlur={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'} />
                </div>
                <div style={{ marginBottom: 0 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', marginBottom: 6 }}>Repository URL</div>
                  <input type="url" placeholder="https://github.com/username/repo" value={project.repo_url ?? ''} onChange={e => setProject({ ...project, repo_url: e.target.value || null })} style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 12, padding: '11px 14px', fontSize: 13, color: '#fff', outline: 'none', fontFamily: 'monospace', transition: 'border-color 0.2s' }} onFocus={e => e.currentTarget.style.borderColor = accent} onBlur={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'} />
                </div>
              </div>

              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 18, padding: '24px 28px', marginBottom: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 16 }}>AI Coding Editor</h3>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', lineHeight: 1.7, marginBottom: 20 }}>
                  Select your preferred IDE to optimize context file generation.
                </p>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {[
                    { value: 'cursor',      label: 'Cursor',       file: '.cursorrules' },
                    { value: 'claude-code', label: 'Claude Code',  file: 'CLAUDE.md' },
                    { value: 'copilot',     label: 'Copilot',      file: 'copilot-instructions.md' },
                    { value: 'windsurf',    label: 'Windsurf',     file: '.windsurfrules' },
                    { value: 'generic',     label: 'Other / None', file: 'reminisce-context.md' },
                  ].map(opt => {
                    const isActive = (project.editor_preference ?? 'generic') === opt.value
                    return (
                      <button key={opt.value} onClick={() => setProject({ ...project, editor_preference: opt.value as NonNullable<Project['editor_preference']> })} style={{ padding: '10px 18px', borderRadius: 12, background: isActive ? hexToRgba(accent, 0.12) : 'rgba(255,255,255,0.04)', border: `1px solid ${isActive ? hexToRgba(accent, 0.3) : 'rgba(255,255,255,0.09)'}`, color: isActive ? accent : 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s', textAlign: 'left' }}>
                        <div style={{ fontWeight: 800 }}>{opt.label}</div>
                        <div style={{ fontSize: 9, opacity: 0.5, marginTop: 2 }}>{opt.file}</div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 40 }}>
                <button
                  onClick={handleUpdateProject}
                  disabled={savingProject}
                  style={{ background: accent, color: '#000', border: 'none', borderRadius: 999, padding: '12px 32px', fontSize: 12, fontWeight: 800, boxShadow: `0 8px 24px ${hexToRgba(accent, 0.2)}`, cursor: savingProject ? 'not-allowed' : 'pointer', opacity: savingProject ? 0.6 : 1, transition: 'opacity 0.15s' }}
                >
                  {savingProject ? 'Saving…' : 'Save Changes'}
                </button>
              </div>

              {isHead && (
                <div style={{ background: 'rgba(248,113,113,0.04)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: 18, padding: '24px 28px' }}>
                  <h3 style={{ fontSize: 13, fontWeight: 700, color: '#f87171', marginBottom: 12 }}>Danger Zone</h3>
                  <p style={{ fontSize: 13, color: 'rgba(248,113,113,0.5)', lineHeight: 1.7, marginBottom: 20 }}>
                    Deleting this project will permanently purge all archived metadata. This action is irreversible.
                  </p>
                  <button onClick={() => setShowDeleteConfirm(true)} style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', borderRadius: 10, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                    Delete Project
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── ADVANCED ── */}
          {activeTab === 'advanced' && user && (
            <div className="page-enter">
              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 18, padding: '24px 28px', marginBottom: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Advanced</h3>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', lineHeight: 1.7, marginBottom: 24 }}>
                  System-level attributes and session management.
                </p>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', padding: '14px 0', gap: 16 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)', flexShrink: 0, letterSpacing: '0.08em' }}>EMAIL</span>
                  <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', fontFamily: 'monospace' }}>{user.email}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', padding: '14px 0', gap: 16 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)', flexShrink: 0, letterSpacing: '0.08em' }}>USER ID</span>
                  <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', fontFamily: 'monospace' }}>{user.id.slice(0, 16)}…</span>
                </div>
                <button
                  onClick={handleSignOut}
                  style={{ marginTop: 32, border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.5)', background: 'transparent', borderRadius: 10, padding: '10px 24px', fontSize: 12, fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)'; e.currentTarget.style.color = '#fff' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = 'rgba(255,255,255,0.5)' }}
                >
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Delete confirm modal ── */}
        {showDeleteConfirm && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <div style={{ background: 'rgba(10,10,24,0.98)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 24, padding: '32px', maxWidth: 440, width: '100%', boxShadow: '0 32px 80px rgba(0,0,0,0.6)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <AlertTriangle size={20} color="#f87171"/>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>Delete project permanently?</div>
              </div>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', lineHeight: 1.7, marginBottom: 20 }}>
                This will permanently delete <strong style={{ color: '#fff' }}>{project?.name}</strong> including all blueprint data, prompts, and history.
              </p>
              <div style={{ fontSize: 12, color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 10, padding: '12px', marginBottom: 28 }}>
                This action cannot be undone.
              </div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>
                  Type <strong style={{ color: '#fff' }}>{project?.name}</strong> to confirm:
                </div>
                <input
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  placeholder={project?.name}
                  style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#fff', outline: 'none' }}
                  autoFocus
                />
              </div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                <button onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText('') }} disabled={isDeletingProject} style={{ padding: '10px 20px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>
                  Cancel
                </button>
                <button
                  onClick={handleDeleteProject}
                  disabled={isDeletingProject || deleteConfirmText !== project?.name}
                  style={{ padding: '10px 20px', background: '#ef4444', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 800, color: '#fff', opacity: deleteConfirmText !== project?.name ? 0.4 : 1, cursor: deleteConfirmText !== project?.name ? 'not-allowed' : 'pointer' }}
                >
                  {isDeletingProject ? 'Purging...' : 'Delete Project'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
