'use client'

import React from 'react'
import { Stats } from './types'
import { StatCard, timeAgo, hexToRgba } from './shared'
import { 
  Bot, RefreshCw, MessageSquare, Wand2, TrendingUp, Users, Database
} from 'lucide-react'

interface ActivityProps {
  stats: Stats | null
  accent: string
  onRefresh: () => void
}

export function AdminActivity({ stats, accent, onRefresh }: ActivityProps) {
  if (!stats) {
    return <div style={{ textAlign: 'center', padding: 60, color: 'rgba(255,255,255,0.3)' }}>Loading activity…</div>
  }

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Platform Activity</h1>
        <button onClick={onRefresh} style={btn(undefined, true)}><RefreshCw size={11}/> Refresh</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 20 }}>
        <StatCard icon={Bot}           label="Agent runs today"      value={stats.activity.agentRunsToday}     color="#60a5fa"/>
        <StatCard icon={MessageSquare} label="PAM messages today"    value={stats.activity.pamMessagesToday}    color="#a78bfa"/>
        <StatCard icon={Wand2}         label="Wizard sessions today" value={stats.activity.wizardSessionsToday} color="#34d399"/>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 20 }}>
        <StatCard icon={TrendingUp} label="Transactions today"     value={stats.economy.transactionsToday}  color="#f59e0b"/>
        <StatCard icon={Users}      label="New users today"        value={stats.users.newToday}             color="#60a5fa"/>
        <StatCard icon={Database}   label="Active projects"        value={stats.projects.active}            color="#34d399"/>
      </div>

      <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: 20, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.35)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Recent platform transactions
        </div>
        {(stats.recentTransactions ?? []).map((t, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 12 }}>
            <span style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: t.type === 'credit' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)', color: t.type === 'credit' ? '#34d399' : '#f87171', fontWeight: 800, fontSize: 13 }}>
              {t.type === 'credit' ? '+' : '−'}
            </span>
            <span style={{ fontWeight: 700, color: t.type === 'credit' ? '#34d399' : '#f87171', minWidth: 60 }}>
              {t.amount} {t.currency}
            </span>
            <span style={{ flex: 1, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.description}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 11, whiteSpace: 'nowrap' }}>
              {timeAgo(t.created_at)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
