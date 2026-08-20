'use client'

import React from 'react'
// U-1: hexToRgba moved to lib/utils. Import it into local scope (this module
// uses it directly in pill()/StatCard()) AND re-export so admin components
// that already import it from this file continue to work unchanged.
// NOTE: a bare `export { hexToRgba } from '...'` does NOT bind the name
// locally, so the in-file calls below would be undefined — hence the import.
import { hexToRgba } from '@/lib/utils'
export { hexToRgba }

export function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function pill(color: string, text: string) {
  return { color, bg: hexToRgba(color, 0.1), border: hexToRgba(color, 0.25), text }
}

export const STATUS_PILL: Record<string, ReturnType<typeof pill>> = {
  pro:        pill('#f59e0b', 'Pro'),
  free:       pill('#94a3b8', 'Free'),
  active:     pill('#34d399', 'Active'),
  banned:     pill('#f87171', 'Banned'),
  admin:      pill('#a78bfa', 'Admin'),
  enabled:    pill('#34d399', 'On'),
  disabled:   pill('#f87171', 'Off'),
}

export function Pill({ type, custom }: { type?: keyof typeof STATUS_PILL; custom?: ReturnType<typeof pill> }) {
  const p = custom ?? STATUS_PILL[type ?? 'free']
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700,
      background: p.bg, border: `1px solid ${p.border}`, color: p.color,
      whiteSpace: 'nowrap',
    }}>
      {p.text}
    </span>
  )
}

export function StatCard({ icon: Icon, label, value, sub, color, trend }: {
  icon: React.ElementType; label: string; value: string | number
  sub?: string; color?: string; trend?: number
}) {
  const c = color ?? '#f59e0b'
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 14, padding: '16px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: hexToRgba(c, 0.1), border: `1px solid ${hexToRgba(c, 0.2)}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={14} color={c}/>
        </div>
        {trend !== undefined && (
          <span style={{ fontSize: 10, fontWeight: 700, color: trend >= 0 ? '#34d399' : '#f87171' }}>
            {trend >= 0 ? '+' : ''}{trend} today
          </span>
        )}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', lineHeight: 1 }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{label}</span>
        {sub && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>{sub}</span>}
      </div>
    </div>
  )
}

export const th: React.CSSProperties = {
  fontSize: 11, fontWeight: 800, letterSpacing: '0.05em',
  color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase',
  padding: '10px 14px', background: 'rgba(255,255,255,0.04)',
}

export const td: React.CSSProperties = {
  padding: '10px 14px', fontSize: 12,
  borderTop: '1px solid rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.8)', verticalAlign: 'middle',
}

export const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '9px 12px',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8, color: '#fff', fontSize: 13, outline: 'none',
}

export function btn(color: string | undefined, ghost = false, accent = '#f59e0b'): React.CSSProperties {
  const c = color || accent
  return {
    padding: '5px 12px', borderRadius: 7, border: ghost
      ? '1px solid rgba(255,255,255,0.1)'
      : `1px solid ${hexToRgba(c, 0.3)}`,
    background: ghost ? 'rgba(255,255,255,0.04)' : hexToRgba(c, 0.1),
    color: ghost ? 'rgba(255,255,255,0.55)' : c,
    cursor: 'pointer', fontSize: 11, fontWeight: 700,
    display: 'inline-flex', alignItems: 'center', gap: 5,
    transition: 'all 0.15s',
  }
}

export function Modal({ title, onClose, children, width = 480 }: {
  title: string; onClose: () => void
  children: React.ReactNode; width?: number
}) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', zIndex: 200 }}/>
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%,-50%)',
        width, maxWidth: 'calc(100vw - 32px)', maxHeight: '90vh', overflowY: 'auto',
        background: 'rgba(8,8,22,0.99)', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 18, padding: 28, zIndex: 201,
        boxShadow: '0 40px 100px rgba(0,0,0,0.9)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 20, lineHeight: 1 }}>✕</button>
        </div>
        {children}
      </div>
    </>
  )
}
