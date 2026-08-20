'use client'

import React from 'react'
import { AdminUser } from './types'
import { Pill, timeAgo, td, th, hexToRgba, inputStyle } from './shared'
import { 
  Search, RefreshCw, Eye, Coins, Ban, CheckCircle, Trash2,
  ChevronLeft, ChevronRight
} from 'lucide-react'

interface UsersProps {
  users: AdminUser[]
  total: number
  page: number
  loading: boolean
  search: string
  accent: string
  onSearchChange: (val: string) => void
  onPageChange: (page: number | ((p: number) => number)) => void
  onRefresh: () => void
  onAction: (userId: string, action: string, extra?: Record<string, unknown>) => void
  onView: (user: AdminUser) => void
  onWallet: (user: AdminUser) => void
  onBan: (user: AdminUser) => void
  onDelete: (payload: { type: 'user'; id: string; label: string }) => void
}

export function AdminUsers({
  users, total, page, loading, search, accent,
  onSearchChange, onPageChange, onRefresh, onAction,
  onView, onWallet, onBan, onDelete
}: UsersProps) {

  const btn = (color = accent, ghost = false): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 7, border: ghost
      ? '1px solid rgba(255,255,255,0.1)'
      : `1px solid ${hexToRgba(color, 0.3)}`,
    background: ghost ? 'rgba(255,255,255,0.04)' : hexToRgba(color, 0.1),
    color: ghost ? 'rgba(255,255,255,0.55)' : color,
    cursor: 'pointer', fontSize: 11, fontWeight: 700,
    display: 'inline-flex', alignItems: 'center', gap: 5,
    transition: 'all 0.15s',
  })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, flex: 1 }}>Users</h1>
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.3)' }}/>
          <input
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search email or ID…"
            style={{ ...inputStyle, paddingLeft: 28, height: 32, width: 220, fontSize: 12 }}
          />
        </div>
        <button onClick={onRefresh} style={btn(undefined, true)}><RefreshCw size={11}/></button>
      </div>

      <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['User', 'Plan', 'Status', 'Wallet', 'Projects', 'Last active', 'Actions'].map(h => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: 'rgba(255,255,255,0.3)' }}>Loading…</td></tr>
            ) : users.map(u => (
              <tr key={u.id} style={{ background: u.banned_at ? 'rgba(248,113,113,0.04)' : 'transparent' }}>
                <td style={td}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200, color: u.banned_at ? '#f87171' : '#fff' }}>
                    {u.email}
                    {u.is_admin && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 800, color: '#a78bfa' }}>ADMIN</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace', marginTop: 2 }}>{u.id.slice(0,18)}…</div>
                </td>
                <td style={td}><Pill type={u.plan === 'pro' ? 'pro' : 'free'}/></td>
                <td style={td}><Pill type={u.banned_at ? 'banned' : 'active'}/></td>
                <td style={{ ...td, fontSize: 11 }}>
                  <div>🪙 {u.coins.toLocaleString()}</div>
                  <div>💎 {u.gems.toLocaleString()}</div>
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.6)' }}>{u.project_count ?? '—'}</span>
                </td>
                <td style={{ ...td, fontSize: 11, color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap' }}>
                  {timeAgo(u.last_sign_in)}
                </td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button onClick={() => onView(u)} style={btn('#60a5fa')}><Eye size={10}/></button>
                    <button
                      onClick={() => onAction(u.id, u.is_admin ? 'remove_admin' : 'make_admin')}
                      style={btn('#a78bfa')}
                    >
                      {u.is_admin ? '↓ Admin' : '↑ Admin'}
                    </button>
                    <button onClick={() => onAction(u.id, u.plan === 'pro' ? 'downgrade_free' : 'upgrade_pro')}
                      style={btn(accent)}>{u.plan === 'pro' ? '↓ Free' : '↑ Pro'}</button>
                    <button onClick={() => onWallet(u)}
                      style={btn('#f59e0b')}><Coins size={10}/></button>
                    {u.banned_at
                      ? <button onClick={() => onAction(u.id, 'unban')} style={btn('#34d399')}><CheckCircle size={10}/></button>
                      : <button onClick={() => onBan(u)} style={btn('#f87171')}><Ban size={10}/></button>
                    }
                    <button onClick={() => onDelete({ type: 'user', id: u.id, label: u.email ?? u.id })}
                      style={btn('#f87171')}><Trash2 size={10}/></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>{total.toLocaleString()} users total</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={() => onPageChange(p => Math.max(1, p-1))} disabled={page === 1} style={btn(undefined, true)}><ChevronLeft size={12}/></button>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>Page {page}</span>
          <button onClick={() => onPageChange(p => p+1)} style={btn(undefined, true)}><ChevronRight size={12}/></button>
        </div>
      </div>
    </div>
  )
}
