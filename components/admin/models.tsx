'use client'

import React from 'react'
import { Model } from './types'
import { Pill, td, th, hexToRgba, pill } from './shared'
import {
  Plus, RefreshCw, CheckCircle, XCircle, Edit2, Trash2, Eye, EyeOff
} from 'lucide-react'

interface ModelsProps {
  models: Model[]
  accent: string
  showProInPAM: boolean
  onToggleProVisibility: () => void
  onAddModel: () => void
  onRefresh: () => void
  onToggleEnabled: (model: Model) => void
  onToggleVisible: (model: Model) => void
  onEdit: (model: Model) => void
  onDelete: (payload: { type: 'model'; id: string; label: string }) => void
}

export function AdminModels({
  models, accent, showProInPAM,
  onToggleProVisibility, onAddModel, onRefresh,
  onToggleEnabled, onToggleVisible, onEdit, onDelete
}: ModelsProps) {

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
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, flex: 1 }}>AI Models</h1>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>
          {models.filter(m=>m.enabled).length} active / {models.length} total
        </span>
        <button
          onClick={onToggleProVisibility}
          title="Toggles picker VISIBILITY of all Pro models — does not disable them"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 12px', borderRadius: 7,
            background: showProInPAM ? 'rgba(248,113,113,0.08)' : 'rgba(52,211,153,0.08)',
            border: `1px solid ${showProInPAM ? 'rgba(248,113,113,0.2)' : 'rgba(52,211,153,0.2)'}`,
            color: showProInPAM ? '#f87171' : '#34d399',
            fontSize: 11, fontWeight: 700, cursor: 'pointer',
          }}
        >
          {showProInPAM ? '👁 Hide Pro from picker' : '👁 Show Pro in picker'}
        </button>
        <button onClick={onAddModel} style={btn(accent)}>
          <Plus size={11}/> Add Model
        </button>
        <button onClick={onRefresh} style={btn(undefined, true)}><RefreshCw size={11}/></button>
      </div>

      {['free','pro'].map(tier => {
        const tierModels = models.filter(m => m.tier_required === tier || (tier === 'free' && m.is_free) || (tier === 'pro' && !m.is_free))
        const seen = new Set<string>()
        const unique = tierModels.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true })
        
        return (
          <div key={tier} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Pill custom={pill(tier === 'free' ? '#34d399' : accent, tier === 'free' ? 'Free Tier (🪙 Coins)' : 'Pro Tier (💎 Gems)')}/>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{unique.length} models</span>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Model', 'Provider', 'Model ID', 'Context', 'Cost', 'Status', 'Actions'].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {unique.map(m => (
                    <tr key={m.id} style={{ opacity: m.enabled ? 1 : 0.5 }}>
                      <td style={td}>
                        <div style={{ fontWeight: 600, color: '#fff' }}>{m.label || m.model_name}</div>
                      </td>
                      <td style={{ ...td, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{m.provider}</td>
                      <td style={{ ...td, fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.4)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.model_id}
                      </td>
                      <td style={{ ...td, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                        {m.context_window ? `${(m.context_window/1000).toFixed(0)}K` : '—'}
                      </td>
                      <td style={{ ...td, fontSize: 11 }}>
                        {m.is_free
                          ? <span style={{ color: '#f59e0b' }}>🪙 {m.cost_coins ?? '?'}</span>
                          : <span style={{ color: '#a78bfa' }}>💎 {m.cost_gems ?? '?'}</span>
                        }
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {/* enabled = globally usable (gates execution + cost) */}
                          <button onClick={() => onToggleEnabled(m)} style={btn(m.enabled ? '#34d399' : '#f87171')} title={m.enabled ? 'Enabled — usable platform-wide' : 'Disabled — not usable by anyone'}>
                            {m.enabled ? <CheckCircle size={10}/> : <XCircle size={10}/>}
                            {m.enabled ? ' On' : ' Off'}
                          </button>
                          {/* visible = shown in the PAM/agent model picker only */}
                          <button onClick={() => onToggleVisible(m)} style={btn(m.visible ? accent : undefined, !m.visible)} title={m.visible ? 'Visible in the model picker' : 'Hidden from the picker (still usable via API if enabled)'}>
                            {m.visible ? <Eye size={10}/> : <EyeOff size={10}/>}
                          </button>
                        </div>
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={() => onEdit(m)} style={btn(undefined, true)}><Edit2 size={10}/></button>
                          <button onClick={() => onDelete({ type: 'model', id: m.id, label: m.label || m.model_id })}
                            style={btn('#f87171')}><Trash2 size={10}/></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {unique.length === 0 && (
                    <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: 'rgba(255,255,255,0.25)' }}>No {tier} tier models</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}
