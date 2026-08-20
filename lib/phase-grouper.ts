/**
 * lib/phase-grouper.ts
 * Rules-based phase assignment for the Import Existing Project feature.
 *
 * Takes a flat list of RawFeatures and buckets them into ordered phases
 * based on keyword matching and path analysis. No AI required.
 */

import type { RawFeature, FeatureStatus, FeatureType, ConfidenceLevel } from '@/lib/project-scanner'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScannedFeature {
  id: string
  name: string
  description: string
  phaseName: string
  status: FeatureStatus
  type: FeatureType
  confidence: ConfidenceLevel
  source: string
}

export interface ScannedPhase {
  name: string
  order: number
  features: ScannedFeature[]
}

// ── Phase definitions (ordered by coupling: data → auth → api → frontend → integrations → testing) ──

const PHASES: Array<{
  name: string
  order: number
  keywords: string[]
  types: FeatureType[]
}> = [
  {
    name: 'Data Layer',
    order: 1,
    keywords: ['database', 'schema', 'prisma', 'drizzle', 'migration', 'model', 'orm', 'mongo', 'supabase', 'sql', 'seed'],
    types: ['data'],
  },
  {
    name: 'Authentication',
    order: 2,
    keywords: ['auth', 'login', 'logout', 'signup', 'register', 'session', 'token', 'oauth', 'password', 'credential', 'nextauth', 'clerk', 'auth0', 'jwt'],
    types: ['auth'],
  },
  {
    name: 'API Layer',
    order: 3,
    keywords: ['api', 'endpoint', 'rest', 'graphql', 'trpc', 'route', 'handler', 'controller', 'webhook', 'middleware'],
    types: ['api'],
  },
  {
    name: 'Frontend',
    order: 4,
    keywords: ['page', 'component', 'ui', 'view', 'dashboard', 'settings', 'profile', 'layout', 'nav', 'sidebar', 'modal', 'form', 'table', 'list', 'detail', 'home', 'landing'],
    types: ['frontend'],
  },
  {
    name: 'Integrations',
    order: 5,
    keywords: ['stripe', 'payment', 'billing', 'checkout', 'email', 'sendgrid', 'mailgun', 'resend', 'aws', 's3', 'redis', 'cache', 'sentry', 'monitoring', 'slack', 'discord', 'twilio', 'openai', 'ai', 'llm', 'cloudflare', 'integration'],
    types: ['integration'],
  },
  {
    name: 'Testing',
    order: 6,
    keywords: ['test', 'spec', 'e2e', 'unit', 'integration', 'cypress', 'playwright', 'jest', 'vitest'],
    types: [],
  },
]

const FALLBACK_PHASE = 'Core'

// ── Assignment logic ──────────────────────────────────────────────────────────

function scoreFeatureForPhase(
  feature: RawFeature,
  phase: typeof PHASES[number]
): number {
  let score = 0

  // Type match is worth the most
  if (phase.types.includes(feature.type)) score += 10

  // Keyword matches in the feature's own keyword list
  const featureKeywords = [
    ...feature.keywords,
    feature.name.toLowerCase(),
    feature.source.toLowerCase(),
    feature.description.toLowerCase(),
  ].join(' ')

  for (const kw of phase.keywords) {
    if (featureKeywords.includes(kw)) score += 3
  }

  return score
}

function assignPhase(feature: RawFeature): string {
  let bestPhase = FALLBACK_PHASE
  let bestScore = 0

  for (const phase of PHASES) {
    const score = scoreFeatureForPhase(feature, phase)
    if (score > bestScore) {
      bestScore = score
      bestPhase = phase.name
    }
  }

  return bestPhase
}

// ── Public API ────────────────────────────────────────────────────────────────

let _idCounter = 0
function makeId(): string {
  return `feat_${Date.now()}_${++_idCounter}`
}

/**
 * Takes flat raw features and returns ordered phases, each with their assigned features.
 * Only phases that have at least one feature are included.
 */
export function groupIntoPhases(rawFeatures: RawFeature[]): ScannedPhase[] {
  const phaseMap = new Map<string, ScannedFeature[]>()

  for (const raw of rawFeatures) {
    const phaseName = assignPhase(raw)

    if (!phaseMap.has(phaseName)) {
      phaseMap.set(phaseName, [])
    }

    phaseMap.get(phaseName)!.push({
      id: makeId(),
      name: raw.name,
      description: raw.description,
      phaseName,
      status: inferStatus(raw),
      type: raw.type,
      confidence: raw.confidence,
      source: raw.source,
    })
  }

  // Build ordered phase list — use canonical order where known, append unknowns at the end
  const canonicalOrder = new Map(PHASES.map(p => [p.name, p.order]))

  const phases: ScannedPhase[] = []
  for (const [name, features] of Array.from(phaseMap.entries())) {
    if (features.length === 0) continue
    phases.push({
      name,
      order: canonicalOrder.get(name) ?? 99,
      features,
    })
  }

  // Sort phases by order
  phases.sort((a, b) => a.order - b.order)

  // Re-number order cleanly (1-based, contiguous)
  return phases.map((p, i) => ({ ...p, order: i + 1 }))
}

// ── Status inference ──────────────────────────────────────────────────────────

/**
 * Infers a starting status from the feature's context.
 * Routes and models that exist in a codebase are by definition at least "in_progress".
 * Low confidence features are "planned" until confirmed.
 */
function inferStatus(raw: RawFeature): FeatureStatus {
  if (raw.confidence === 'low') return 'planned'
  // Anything with high/medium confidence that was extracted from real file paths
  // is already built — mark as in_progress (user can promote to complete)
  if (raw.confidence === 'high') return 'in_progress'
  return 'planned'
}
