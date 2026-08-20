'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/hooks/useTheme'
import { useIsMobile } from '@/hooks/useMediaQuery'
import {
  Users, Zap, BarChart2, ShieldAlert, LogOut, Star,
  Activity,
} from 'lucide-react'
import { toast } from 'sonner'

// Components
import { hexToRgba, btn } from '@/components/admin/shared'
import { AdminOverview } from '@/components/admin/overview'
import { AdminUsers } from '@/components/admin/users'
import { AdminModels } from '@/components/admin/models'
import { AdminActivity } from '@/components/admin/activity'
import { AdminLogs } from '@/components/admin/logs'
import { 
  BanModal, WalletModal, UserDetailModal, 
  ModelModal, ConfirmDeleteModal 
} from '@/components/admin/modals'
import { Stats, AdminUser, Model, AuditLog } from '@/components/admin/types'

type Tab = 'overview' | 'users' | 'models' | 'activity' | 'logs'

export default function AdminPage() {
  const { accent } = useTheme()
  const ac = accent || '#f59e0b'
  const router = useRouter()
  const isMobile = useIsMobile()

  const [tab,        setTab]        = useState<Tab>('overview')
  const [token,      setToken]      = useState<string | null>(null)
  const [stats,      setStats]      = useState<Stats | null>(null)
  const [users,      setUsers]      = useState<AdminUser[]>([])
  const [models,     setModels]     = useState<Model[]>([])
  const [logs,       setLogs]       = useState<AuditLog[]>([])
  const [userSearch, setUserSearch] = useState('')
  const [userPage,   setUserPage]   = useState(1)
  const [userTotal,  setUserTotal]  = useState(0)
  const [loading,    setLoading]    = useState(false)
  const [showProInPAM, setShowProInPAM] = useState(true)

  // Modals
  const [banModal,      setBanModal]      = useState<AdminUser | null>(null)
  const [walletModal,   setWalletModal]   = useState<AdminUser | null>(null)
  const [modelModal,    setModelModal]    = useState<Partial<Model> | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'user' | 'model'; id: string; label: string } | null>(null)
  const [viewUser,      setViewUser]      = useState<AdminUser | null>(null)
  const [viewUserActivity, setViewUserActivity] = useState<{ type: string, amount: number, currency: string, description: string, created_at: string }[]>([])


  // ── Auth ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setToken(session.access_token)
    })
  }, [])

  const headers = useCallback((): HeadersInit => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token ?? ''}`,
  }), [token])

  // ── Data fetchers ────────────────────────────────────────────────────────────

  const loadStats = useCallback(async () => {
    if (!token) return
    const res = await fetch('/api/admin/stats', { headers: headers() })
    const data = await res.json()
    if (!data.error) setStats(data)
  }, [token, headers])

  const loadUsers = useCallback(async () => {
    if (!token) return
    setLoading(true)
    const res = await fetch(
      `/api/admin/users?page=${userPage}&search=${encodeURIComponent(userSearch)}`,
      { headers: headers() }
    )
    const data = await res.json()
    setUsers(data.users ?? [])
    setUserTotal(data.total ?? 0)
    setLoading(false)
  }, [token, userPage, userSearch, headers])

  const loadModels = useCallback(async () => {
    if (!token) return
    const res = await fetch('/api/admin/models', { headers: headers() })
    const data = await res.json()
    const fetchedModels = data.models ?? []
    setModels(fetchedModels)
    // Derive the "Pro shown in picker" toggle from REAL DB state (visibility),
    // not a hardcoded default — so a reload reflects what's actually configured.
    const anyProVisible = fetchedModels.some((m: Model) => !m.is_free && m.visible)
    setShowProInPAM(anyProVisible)
  }, [token, headers])

  const loadLogs = useCallback(async () => {
    if (!token) return
    const res = await fetch('/api/admin/logs', { headers: headers() })
    const data = await res.json()
    setLogs(data.logs ?? [])
  }, [token, headers])

  useEffect(() => {
    if (!token) return
    loadStats()
    loadModels()
  }, [token, loadStats, loadModels])

  useEffect(() => {
    if (!token || tab !== 'users') return
    loadUsers()
  }, [token, tab, userPage, loadUsers])

  useEffect(() => {
    if (!token || tab !== 'logs') return
    loadLogs()
  }, [token, tab, loadLogs])

  useEffect(() => {
    if (!token || tab !== 'activity') return
    loadStats()
  }, [token, tab, loadStats])

  useEffect(() => {
    if (!viewUser || !token) { setViewUserActivity([]); return }
    fetch(`/api/admin/users/${viewUser.id}/activity`, { headers: headers() })
      .then(r => r.json())
      .then(d => setViewUserActivity(d.transactions ?? []))
      .catch(() => setViewUserActivity([]))
  }, [viewUser, token, headers])

  // ── Actions ──────────────────────────────────────────────────────────────────

  const userAction = async (userId: string, action: string, extra?: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH', headers: headers(),
        body: JSON.stringify({ action, ...extra }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        toast.error(data.error || `Action failed (${res.status})`)
        return
      }
      toast.success(`Action: ${action.replace(/_/g,' ')} applied`)
    } catch {
      toast.error('Network error')
      return
    }
    await Promise.all([loadUsers(), loadStats()])
  }

  const deleteUser = async (userId: string) => {
    const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE', headers: headers() })
    setConfirmDelete(null)
    if (res.ok) toast.success('User deleted')
    else toast.error('Delete failed')
    await Promise.all([loadUsers(), loadStats()])
  }

  const saveModel = async (m: Partial<Model>) => {
    try {
      const url = m.id ? `/api/admin/models/${m.id}` : '/api/admin/models'
      const method = m.id ? 'PATCH' : 'POST'
      const payload = { ...m, model_name: m.model_name || m.label || m.model_id }
      const res = await fetch(url, { method, headers: headers(), body: JSON.stringify(payload) })
      if (!res.ok) throw new Error('Failed to save')
      toast.success(m.id ? 'Model updated' : 'Model added')
    } catch {
      toast.error('Save failed')
    }
    setModelModal(null)
    await loadModels()
  }

  const toggleModel = async (m: Model) => {
    const res = await fetch(`/api/admin/models/${m.id}`, {
      method: 'PATCH', headers: headers(),
      body: JSON.stringify({ enabled: !m.enabled }),
    })
    if (res.ok) toast.success(`Model ${!m.enabled ? 'enabled' : 'disabled'}`)
    else toast.error('Toggle failed')
    await loadModels()
  }

  const deleteModel = async (id: string) => {
    const res = await fetch(`/api/admin/models/${id}`, { method: 'DELETE', headers: headers() })
    setConfirmDelete(null)
    if (res.ok) toast.success('Model deleted')
    else toast.error('Delete failed')
    await loadModels()
  }

  const toggleVisible = async (m: Model) => {
    const res = await fetch(`/api/admin/models/${m.id}`, {
      method: 'PATCH', headers: headers(),
      body: JSON.stringify({ visible: !m.visible }),
    })
    if (res.ok) toast.success(`Model ${!m.visible ? 'shown in' : 'hidden from'} picker`)
    else toast.error('Toggle failed')
    await loadModels()
  }

  const toggleProVisibility = async () => {
    // Flips picker VISIBILITY of all Pro models (not `enabled`). Hiding a model
    // from the picker no longer disables it platform-wide. Target the new state
    // explicitly so partially-visible sets converge instead of inverting per-row.
    const nextVisible = !showProInPAM
    const proModels = models.filter(m => !m.is_free)
    await Promise.all(proModels.map(m =>
      fetch(`/api/admin/models/${m.id}`, {
        method: 'PATCH', headers: headers(),
        body: JSON.stringify({ visible: nextVisible }),
      })
    ))
    setShowProInPAM(nextVisible)
    await loadModels()
    toast.success(nextVisible ? 'Pro models shown in picker' : 'Pro models hidden from picker')
  }

  // ── Rendering ────────────────────────────────────────────────────────────────

  const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'overview',  label: 'Overview',   icon: BarChart2    },
    { id: 'users',     label: 'Users',      icon: Users        },
    { id: 'models',    label: 'AI Models',  icon: Zap          },
    { id: 'activity',  label: 'Activity',   icon: Activity     },
    { id: 'logs',      label: 'Audit Log',  icon: ShieldAlert  },
  ]

  return (
    <div style={{ minHeight: '100vh', background: '#07070f', color: '#fff', display: 'flex', flexDirection: 'column' }}>
      
      {/* Header */}
      <header style={{ height: 54, borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', padding: '0 20px', gap: 12, background: 'rgba(8,8,20,0.85)', backdropFilter: 'blur(20px)', position: 'sticky', top: 0, zIndex: 50, flexShrink: 0 }}>
        <Star size={13} fill={ac} stroke={ac}/>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Reminisce</span>
        <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }}/>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#f87171', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 999, padding: '2px 9px' }}>
          Admin Console
        </span>
        <div style={{ flex: 1 }}/>
        <button onClick={() => router.push('/dashboard')} style={btn(undefined, true, ac)}>
          <LogOut size={11}/> Dashboard
        </button>
      </header>

      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', flex: 1, minHeight: 0 }}>
        
        {/* Sidebar */}
        <aside style={{ 
          width: isMobile ? '100%' : 196, 
          borderRight: isMobile ? 'none' : '1px solid rgba(255,255,255,0.07)', 
          padding: '12px 8px', display: 'flex', 
          flexDirection: isMobile ? 'row' : 'column', gap: 3, 
          background: 'rgba(8,8,20,0.4)', flexShrink: 0 
        }}>
          {TABS.map(t => {
            const active = tab === t.id
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderRadius: 9, border: 'none',
                background: active ? hexToRgba(ac, 0.1) : 'transparent', color: active ? ac : 'rgba(255,255,255,0.42)',
                cursor: 'pointer', fontSize: 12, fontWeight: active ? 600 : 400, textAlign: 'left', width: '100%',
              }}>
                <t.icon size={14}/> {!isMobile && t.label}
              </button>
            )
          })}
        </aside>

        {/* Main Content */}
        <main style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {tab === 'overview' && <AdminOverview stats={stats} models={models} accent={ac} isMobile={isMobile} onRefresh={loadStats}/>}
          {tab === 'users'    && <AdminUsers users={users} total={userTotal} page={userPage} loading={loading} search={userSearch} accent={ac} onSearchChange={setUserSearch} onPageChange={setUserPage} onRefresh={loadUsers} onAction={userAction} onView={setViewUser} onWallet={setWalletModal} onBan={setBanModal} onDelete={setConfirmDelete}/>}
          {tab === 'models'   && <AdminModels models={models} accent={ac} showProInPAM={showProInPAM} onToggleProVisibility={toggleProVisibility} onAddModel={() => setModelModal({ provider: '', model_id: '', label: '', is_free: true, enabled: true })} onRefresh={loadModels} onToggleEnabled={toggleModel} onToggleVisible={toggleVisible} onEdit={setModelModal} onDelete={setConfirmDelete}/>}
          {tab === 'activity' && <AdminActivity stats={stats} accent={ac} onRefresh={loadStats}/>}
          {tab === 'logs'     && <AdminLogs logs={logs} accent={ac} onRefresh={loadLogs}/>}
        </main>
      </div>

      {/* Modals */}
      {banModal && <BanModal user={banModal} onClose={() => setBanModal(null)} onAction={userAction} accent={ac}/>}
      {walletModal && <WalletModal user={walletModal} onClose={() => setWalletModal(null)} onAction={userAction} accent={ac}/>}
      {viewUser && <UserDetailModal user={viewUser} activity={viewUserActivity} onClose={() => setViewUser(null)} accent={ac}/>}
      {modelModal && <ModelModal model={modelModal} onClose={() => setModelModal(null)} onSave={saveModel} accent={ac}/>}
      {confirmDelete && <ConfirmDeleteModal target={confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={() => confirmDelete.type === 'user' ? deleteUser(confirmDelete.id) : deleteModel(confirmDelete.id)}/>}

    </div>
  )
}
