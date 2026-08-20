'use client'

import React from 'react'
import { Stats, Model } from './types'
import { StatCard, Pill, timeAgo, hexToRgba } from './shared'
import { 
  Users, Crown, Ban, Database, Coins, Zap, 
  TrendingUp, Activity, MessageSquare, Wand2, Bot, RefreshCw 
} from 'lucide-react'

interface OverviewProps {
  stats: Stats | null
  models: Model[]
  accent: string
  isMobile: boolean
  onRefresh: () => void
}

export function AdminOverview({ stats, models, accent, isMobile, onRefresh }: OverviewProps) {
  if (!stats) {
    return <div style={{ textAlign: 'center', padding: 60, color: 'rgba(255,255,255,0.3)' }}>Loading stats…</div>
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
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Platform Overview</h1>
        <button onClick={onRefresh} style={btn(undefined, true)}><RefreshCw size={11}/> Refresh</button>
      </div>

      {/* Row 1 — Users */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4,1fr)', gap: 10, marginBottom: 10 }}>
        <StatCard icon={Users}     label="Total users"     value={stats.users.total}     color="#60a5fa" trend={stats.users.newToday}/>
        <StatCard icon={Crown}     label="Pro subscribers" value={stats.users.pro}       color={accent}     sub={`${stats.users.free} free`}/>
        <StatCard icon={Ban}       label="Banned"          value={stats.users.banned}    color="#f87171"/>
        <StatCard icon={Database}  label="Projects"        value={stats.projects.total}  color="#34d399" sub={`${stats.projects.active} active`}/>
      </div>
      
      {/* Row 2 — Economy */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4,1fr)', gap: 10, marginBottom: 10 }}>
        <StatCard icon={Coins}       label="Coins in circulation" value={stats.economy.totalCoins}          color="#f59e0b"/>
        <StatCard icon={Zap}         label="Gems in circulation"  value={stats.economy.totalGems}           color="#a78bfa"/>
        <StatCard icon={TrendingUp}  label="Transactions today"   value={stats.economy.transactionsToday}   color="#34d399"/>
        <StatCard icon={Activity}    label="Agent runs today"     value={stats.activity.agentRunsToday}     color="#60a5fa"/>
      </div>

      {/* Row 3 — Activity */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3,1fr)', gap: 10, marginBottom: 20 }}>
        <StatCard icon={MessageSquare} label="PAM messages today"   value={stats.activity.pamMessagesToday}    color="#a78bfa"/>
        <StatCard icon={Wand2}         label="Wizard sessions today" value={stats.activity.wizardSessionsToday} color="#34d399"/>
        <StatCard icon={Bot}           label="Models active"         value={models.filter(m=>m.enabled).length} color={accent} sub={`${models.length} total`}/>
      </div>

      {/* Recent signups */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: 16, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Recent signups</div>
          {(stats.recentSignups ?? []).slice(0,6).map((s,i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11 }}>
              <span style={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', fontSize: 10 }}>{s.user_id.slice(0,20)}…</span>
              <Pill type={s.plan === 'pro' ? 'pro' : 'free'}/>
              <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10 }}>{timeAgo(s.created_at)}</span>
            </div>
          ))}
        </div>
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: 16, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Recent transactions</div>
          {(stats.recentTransactions ?? []).slice(0,6).map((t,i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11 }}>
              <span style={{ color: t.type === 'credit' ? '#34d399' : '#f87171', fontWeight: 600 }}>
                {t.type === 'credit' ? '+' : '−'}{t.amount} {t.currency}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.35)', flex: 1, marginLeft: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</span>
              <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 10, marginLeft: 8 }}>{timeAgo(t.created_at)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
