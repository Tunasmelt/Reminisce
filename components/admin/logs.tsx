'use client'

import React from 'react'
import { AuditLog } from './types'
import { Pill, td, th, hexToRgba, pill } from './shared'
import { 
  RefreshCw, Clock
} from 'lucide-react'

interface LogsProps {
  logs: AuditLog[]
  accent: string
  onRefresh: () => void
}

export function AdminLogs({ logs, accent, onRefresh }: LogsProps) {
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

  const actionColor = (a: string) => {
    if (a.includes('delete') || a.includes('ban')) return '#f87171'
    if (a.includes('add') || a.includes('unban') || a.includes('pro')) return '#34d399'
    return accent
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Audit Log</h1>
        <button onClick={onRefresh} style={btn(undefined, true)}><RefreshCw size={11}/></button>
      </div>
      <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>{['Time', 'Action', 'Target', 'Admin', 'Details'].map(h=><th key={h} style={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: 'rgba(255,255,255,0.3)' }}>No admin actions logged yet.</td></tr>
            ) : logs.map(log => (
              <tr key={log.id}>
                <td style={{ ...td, fontSize: 11, color: 'rgba(255,255,255,0.3)', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Clock size={10}/>{new Date(log.created_at).toLocaleString()}
                  </div>
                </td>
                <td style={td}>
                  <Pill custom={pill(actionColor(log.action), log.action.replace(/_/g,' '))}/>
                </td>
                <td style={{ ...td, fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.4)' }}>
                  <div>{log.target_type}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>{log.target_id?.slice(0,20)}…</div>
                </td>
                <td style={{ ...td, fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)' }}>
                  {log.admin_id.slice(0,12)}…
                </td>
                <td style={{ ...td, fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                  {Object.keys(log.payload ?? {}).filter(k => k !== 'action').slice(0,2).map(k =>
                    <div key={k}>{k}: {String(log.payload[k]).slice(0,20)}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
