'use client'

import React, { useState } from 'react'
import { AdminUser, Model } from './types'
import { Modal, btn as btnStyle, inputStyle, timeAgo } from './shared'
import { AlertTriangle } from 'lucide-react'


export function BanModal({ user, onClose, onAction, accent }: { user: AdminUser, onClose: () => void, onAction: (userId: string, action: string, extra?: Record<string, unknown>) => void, accent: string }) {
  const [reason, setReason] = useState('')
  const btn = (color = accent, ghost = false) => btnStyle(color, ghost)
  
  return (
    <Modal title={`Ban user — ${user.email}`} onClose={onClose}>
      <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', marginBottom: 16, lineHeight: 1.6 }}>
        This immediately signs the user out and blocks their access. Their data is preserved.
      </p>
      <label style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 6 }}>Reason (visible in audit log)</label>
      <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Spam, ToS violation, abuse…" style={{ ...inputStyle, marginBottom: 16 }}/>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={btn(undefined, true)}>Cancel</button>
        <button onClick={() => { onAction(user.id, 'ban', { reason }); onClose() }}
          style={{ ...btn('#f87171'), background: '#f87171', color: '#000', border: 'none' }}>
          Confirm Ban
        </button>
      </div>
    </Modal>
  )
}

export function WalletModal({ user, onClose, onAction, accent }: { user: AdminUser, onClose: () => void, onAction: (userId: string, action: string, extra?: Record<string, unknown>) => void, accent: string }) {
  const [coins, setCoins] = useState(0)
  const [gems, setGems] = useState(0)
  const btn = (color = accent, ghost = false) => btnStyle(color, ghost)

  return (
    <Modal title={`Adjust wallet — ${user.email}`} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 6 }}>🪙 Coins to add</label>
          <input type="number" value={coins} onChange={e => setCoins(parseInt(e.target.value)||0)} style={inputStyle}/>
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 6 }}>💎 Gems to add</label>
          <input type="number" value={gems} onChange={e => setGems(parseInt(e.target.value)||0)} style={inputStyle}/>
        </div>
      </div>
      <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', margin: '8px 0 0' }}>
        Amounts are added to the user&apos;s existing balance.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={btn(undefined, true)}>Cancel</button>
        <button onClick={() => { 
            if (coins > 0) onAction(user.id, 'add_coins', { value: coins })
            if (gems > 0) onAction(user.id, 'add_gems', { value: gems })
            onClose() 
          }}
          style={{ ...btn(accent), background: accent, color: '#000', border: 'none' }}>Save</button>
      </div>
    </Modal>
  )
}

export function UserDetailModal({ user, activity, onClose }: { 
  user: AdminUser, 
  activity: { type: string, amount: number, currency: string, description: string, created_at: string }[], 
  onClose: () => void, 
  accent: string 
}) {
  return (
    <Modal title={`User detail — ${user.email}`} onClose={onClose} width={540}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {[
          { label: 'User ID',      value: user.id,            mono: true  },
          { label: 'Email',        value: user.email,         mono: false },
          { label: 'Plan',         value: user.plan,          mono: false },
          { label: 'Admin',        value: user.is_admin ? 'Yes' : 'No', mono: false },
          { label: 'Coins',        value: String(user.coins), mono: false },
          { label: 'Gems',         value: String(user.gems),  mono: false },
          { label: 'Projects limit', value: String(user.projects_limit), mono: false },
          { label: 'Joined',       value: new Date(user.created_at).toLocaleDateString(), mono: false },
          { label: 'Last active',  value: timeAgo(user.last_sign_in), mono: false },
          { label: 'Banned',       value: user.banned_at ? new Date(user.banned_at).toLocaleDateString() : 'No', mono: false },
        ].map(f => (
          <div key={f.label} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{f.label}</div>
            <div style={{ fontSize: 12, color: '#fff', fontFamily: f.mono ? 'monospace' : 'inherit', wordBreak: 'break-all' }}>{f.value}</div>
          </div>
        ))}
      </div>
      {user.ban_reason && (
        <div style={{ marginTop: 12, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#f87171', marginBottom: 4 }}>BAN REASON</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>{user.ban_reason}</div>
        </div>
      )}

      {activity.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)',
            marginBottom: 10,
          }}>
            Recent transactions
          </div>
          {activity.slice(0, 6).map((tx, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', padding: '6px 0',
              borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11,
            }}>
              <span style={{
                color: tx.type === 'credit' ? '#34d399' : '#f87171',
                fontWeight: 700, minWidth: 60,
              }}>
                {tx.type === 'credit' ? '+' : '−'}{tx.amount} {tx.currency}
              </span>
              <span style={{
                flex: 1, color: 'rgba(255,255,255,0.45)', marginLeft: 10,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {tx.description}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.2)', marginLeft: 8 }}>
                {timeAgo(tx.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

export function ModelModal({ model, onClose, onSave, accent }: { model: Partial<Model>, onClose: () => void, onSave: (m: Partial<Model>) => void, accent: string }) {
  const [data, setData] = useState<Partial<Model>>(model)
  const btn = (color = accent, ghost = false) => btnStyle(color, ghost)

  return (
    <Modal title={data.id ? 'Edit model' : 'Add new model'} onClose={onClose} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {([
            { key: 'provider',         label: 'Provider',          placeholder: 'groq / gemini / anthropic' },
            { key: 'model_id',         label: 'Model ID',          placeholder: 'llama-3.3-70b-versatile'  },
            { key: 'label',            label: 'Display name',      placeholder: 'Llama 3.3 70B ⚡'         },
            { key: 'context_window',   label: 'Context window',    placeholder: '131072'                    },
            { key: 'cost_coins',       label: '🪙 Coin cost',      placeholder: '2'                        },
            { key: 'cost_gems',        label: '💎 Gem cost',       placeholder: '6'                        },
            { key: 'rate_limit_rpm',   label: '⏱ RPM (per user)', placeholder: '5'                        },
            { key: 'rate_limit_rpd',   label: '📅 RPD (per user)', placeholder: '200'                      },
            { key: 'sort_order',       label: 'Sort order',        placeholder: '0'                        },
          ] as { key: keyof Model; label: string; placeholder: string }[]).map(({ key, label, placeholder }) => (
            <div key={key}>
              <label style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</label>
              <input
                value={String(data[key] ?? '')}
                onChange={e => setData(p => ({ ...p, [key]: e.target.value }))}
                placeholder={placeholder}
                style={{ ...inputStyle, fontSize: 12 }}
              />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {[
            { key: 'is_free',  label: 'Free tier (costs coins)' },
            { key: 'enabled',  label: 'Enabled (visible to users)' },
          ].map(({ key, label }) => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>
              <input
                type="checkbox"
                checked={Boolean(data[key as keyof Model])}
                onChange={e => {
                  const v = e.target.checked
                  setData(p => ({
                    ...p,
                    [key]: v,
                    ...(key === 'is_free' ? { tier_required: v ? 'free' : 'pro' } : {}),
                  }))
                }}
                style={{ width: 14, height: 14 }}
              />
              {label}
            </label>
          ))}
        </div>
        <div>
          <label style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Notes (internal)</label>
          <textarea
            value={String(data.notes ?? '')}
            onChange={e => setData(p => ({ ...p, notes: e.target.value }))}
            placeholder="Deprecated March 2026, replaced by…"
            rows={2}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
        <button onClick={onClose} style={btn(undefined, true)}>Cancel</button>
        <button onClick={() => onSave(data)} style={{ ...btn(accent), background: accent, color: '#000', border: 'none' }}>
          {data.id ? 'Save changes' : 'Add model'}
        </button>
      </div>
    </Modal>
  )
}

export function ConfirmDeleteModal({ target, onConfirm, onClose }: { target: { type: 'user' | 'model', id: string, label: string }, onConfirm: () => void, onClose: () => void }) {
  return (
    <Modal title="Confirm permanent deletion" onClose={onClose}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 20 }}>
        <AlertTriangle size={20} color="#f87171" style={{ flexShrink: 0, marginTop: 2 }}/>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.7, margin: 0 }}>
          You are about to permanently delete <strong style={{ color: '#fff' }}>{target.label}</strong>.
          {target.type === 'user' && ' All their projects, context files, PAM threads, and wallet data will be erased. This cannot be undone.'}
          {target.type === 'model' && ' Users will no longer be able to select this model. This cannot be undone.'}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={btnStyle(undefined, true)}>Cancel</button>
        <button onClick={onConfirm} style={{ padding: '7px 18px', borderRadius: 8, background: '#f87171', color: '#000', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 800 }}>
          Delete permanently
        </button>
      </div>
    </Modal>
  )
}
