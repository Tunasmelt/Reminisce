// verify-models.mjs — ground-truth model verifier (DB-free).
//
// Checks every seeded model_id against the provider's LIVE /models catalogue and
// prints which are LIVE vs DEAD, plus the full live catalogue per provider so new
// free models can be discovered. All calls are free GETs — no token cost.
//
//   node scripts/verify-models.mjs
//
import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}

// Current seed (from migration 0036 / update-models.ts) ────────────────────────
const SEED = {
  groq: ['llama-3.1-8b-instant','llama-3.3-70b-versatile','meta-llama/llama-4-scout-17b-16e-instruct','meta-llama/llama-4-maverick-17b-128e-instruct','moonshotai/kimi-k2-instruct','qwen/qwen3-32b'],
  cerebras: ['llama3.1-8b','llama3.3-70b','llama-4-scout-17b-16e-instruct','gpt-oss-120b'],
  sambanova: ['Meta-Llama-3.3-70B-Instruct','Llama-4-Maverick-17B-128E-Instruct','DeepSeek-V3.2','DeepSeek-R1-Distill-Llama-70B'],
  openrouter: ['meta-llama/llama-3.3-70b-instruct:free','meta-llama/llama-4-maverick:free','deepseek/deepseek-chat-v3.1:free','deepseek/deepseek-r1:free','qwen/qwen3-235b-a22b:free','google/gemma-3-12b-it:free'],
  gemini: ['gemini-2.0-flash','gemini-2.5-flash','gemini-2.5-pro'],
  anthropic: ['claude-haiku-4-5-20251001','claude-3-5-haiku-20241022','claude-3-5-sonnet-20241022','claude-sonnet-4-20250514'],
  openai: ['gpt-4o-mini','gpt-4o','gpt-4.1'],
  mistral: ['codestral-latest','mistral-small-latest','mistral-large-latest'],
  kimi: [],
  minimax: [],
}

const KEY_ENV = { groq:'GROQ_API_KEY',cerebras:'CEREBRAS_API_KEY',sambanova:'SAMBANOVA_API_KEY',openai:'OPENAI_API_KEY',mistral:'MISTRAL_API_KEY',kimi:'KIMI_API_KEY',minimax:'MINIMAX_API_KEY',openrouter:'OPENROUTER_API_KEY',gemini:'GEMINI_API_KEY',anthropic:'ANTHROPIC_API_KEY' }

async function openaiCompat(base, key) {
  const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0,100)}`)
  return (await r.json()).data?.map(m => m.id) ?? []
}
const FETCH = {
  groq: k => openaiCompat('https://api.groq.com/openai/v1', k),
  cerebras: k => openaiCompat('https://api.cerebras.ai/v1', k),
  sambanova: k => openaiCompat('https://api.sambanova.ai/v1', k),
  openai: k => openaiCompat('https://api.openai.com/v1', k),
  mistral: k => openaiCompat('https://api.mistral.ai/v1', k),
  kimi: k => openaiCompat('https://api.moonshot.ai/v1', k),
  minimax: k => openaiCompat('https://api.minimax.io/v1', k),
  openrouter: async k => {
    const r = await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${k}` } })
    if (!r.ok) throw new Error(`${r.status}`)
    return (await r.json()).data?.map(m => m.id) ?? []
  },
  gemini: async k => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${k}&pageSize=200`)
    if (!r.ok) throw new Error(`${r.status}`)
    return (await r.json()).models?.map(m => (m.name||'').replace(/^models\//,'')) ?? []
  },
  anthropic: async k => {
    const r = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } })
    if (!r.ok) throw new Error(`${r.status}`)
    return (await r.json()).data?.map(m => m.id) ?? []
  },
}

const DUMP = process.argv.includes('--dump')

for (const provider of Object.keys(SEED)) {
  const key = env[KEY_ENV[provider]]
  let catalog = null, err = null
  if (!key) err = 'no key'
  else { try { catalog = await FETCH[provider](key) } catch (e) { err = e.message } }

  console.log(`\n━━ ${provider.toUpperCase()} ${err ? `(⚠ ${err})` : `— ${catalog.length} live models`} ━━`)
  if (catalog) {
    const live = new Set(catalog)
    for (const id of SEED[provider]) console.log(`  ${live.has(id) ? '✓' : '✗ DEAD'}  ${id}`)
    if (SEED[provider].length === 0) console.log('  (none seeded)')
    if (DUMP) { console.log('  ── full catalogue:'); catalog.sort().forEach(id => console.log(`     ${id}`)) }
  } else {
    for (const id of SEED[provider]) console.log(`  ?  ${id} (unverified)`)
  }
}
console.log('\nTip: re-run with --dump to print each provider\'s full live catalogue.')
