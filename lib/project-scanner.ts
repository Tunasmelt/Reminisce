/**
 * lib/project-scanner.ts
 * Static analysis engine for the Import Existing Project feature.
 *
 * Philosophy: deterministic extraction from files that already encode the truth
 * (manifests, routes, git history). No AI, runs entirely on string content.
 *
 * Two runtime paths:
 *   1. Client-side local scan — page component reads files via FS API, passes content here
 *   2. Server-side GitHub scan — /api/import/scan fetches files via GitHub API, passes content here
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeatureStatus = 'planned' | 'in_progress' | 'complete'
export type FeatureType = 'frontend' | 'api' | 'auth' | 'data' | 'integration' | 'other'
export type ConfidenceLevel = 'high' | 'medium' | 'low'
export type ScanSource = 'local' | 'github'

/** A single inferred feature extracted from the repo */
export interface ScannedFeature {
  id: string
  name: string
  description: string
  phaseName: string
  status: FeatureStatus
  type: FeatureType
  confidence: ConfidenceLevel
  source: string   // e.g. "app/api/users/route.ts"
}

/** Git state extracted from .git/ files */
export interface GitState {
  branch: string | null
  lastCommitMessage: string | null
  daysSinceLastCommit: number | null
}

/** Full result returned by any scanner path */
export interface ScanResult {
  name: string
  description: string
  repoUrl: string | null
  techStack: string[]
  framework: 'nextjs' | 'express' | 'mixed' | 'unknown'
  language: 'typescript' | 'javascript' | 'unknown'
  phases: import('@/lib/phase-grouper').ScannedPhase[]
  gitState: GitState | null
  filesScanned: number
  scanSource: ScanSource
  scannedAt: string
}

/** Raw feature before phase assignment */
export interface RawFeature {
  name: string
  description: string
  type: FeatureType
  confidence: ConfidenceLevel
  source: string
  keywords: string[]   // used by phase-grouper
}

/** File map passed into the parser — path → content */
export type FileMap = Record<string, string>

// ── Tiny ID generator (no external deps) ─────────────────────────────────────

let _idCounter = 0
function makeId(): string {
  return `feat_${Date.now()}_${++_idCounter}`
}

// ── Manifest parsers ──────────────────────────────────────────────────────────

export function parsePackageJson(content: string): {
  name: string
  description: string
  deps: string[]
} {
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>
    const all = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    }
    return {
      name: typeof pkg.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : '',
      description: typeof pkg.description === 'string' ? pkg.description : '',
      deps: Object.keys(all),
    }
  } catch {
    return { name: '', description: '', deps: [] }
  }
}

export function parseReadme(content: string): string {
  // Grab first non-empty paragraph that isn't a heading/badge/code block
  const lines = content.split('\n')
  const paragraphLines: string[] = []
  let inCode = false

  for (const line of lines) {
    if (line.startsWith('```')) { inCode = !inCode; continue }
    if (inCode) continue
    if (line.startsWith('#')) continue                       // headings
    if (/^\[!\[/.test(line)) continue                        // badge images
    if (/^!\[/.test(line)) continue                          // regular images
    if (line.trim() === '') {
      if (paragraphLines.length > 0) break                  // end of first paragraph
      continue
    }
    paragraphLines.push(line.trim())
  }

  return paragraphLines.join(' ').trim().slice(0, 300)
}

export function parseEnvExample(content: string): string[] {
  /** Returns a list of integration hints like "Stripe", "Supabase", "AWS" etc. */
  const SERVICE_PATTERNS: Array<[RegExp, string]> = [
    [/stripe/i, 'Stripe'],
    [/supabase/i, 'Supabase'],
    [/aws_|s3_|cloudfront/i, 'AWS'],
    [/openai/i, 'OpenAI'],
    [/anthropic/i, 'Anthropic'],
    [/sendgrid|mailgun|resend|postmark/i, 'Email'],
    [/twilio/i, 'Twilio'],
    [/pusher|ably|soketi/i, 'Realtime'],
    [/redis/i, 'Redis'],
    [/mongo/i, 'MongoDB'],
    [/planetscale|neon|turso/i, 'Database'],
    [/clerk|auth0|okta/i, 'Auth Provider'],
    [/algolia|typesense/i, 'Search'],
    [/sentry/i, 'Sentry'],
    [/vercel/i, 'Vercel'],
    [/cloudflare/i, 'Cloudflare'],
    [/github_token|gh_token/i, 'GitHub'],
    [/slack/i, 'Slack'],
    [/discord/i, 'Discord'],
  ]

  const found = new Set<string>()
  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue
    const key = line.split('=')[0].trim().toUpperCase()
    for (const [pattern, label] of SERVICE_PATTERNS) {
      if (pattern.test(key)) { found.add(label); break }
    }
  }
  return Array.from(found)
}

// ── Tech stack detection ──────────────────────────────────────────────────────

const STACK_DEPS: Array<[string[], string]> = [
  [['next'],                         'Next.js'],
  [['react'],                        'React'],
  [['express'],                      'Express'],
  [['fastapi', 'flask', 'django'],   'Python'],
  [['nestjs', '@nestjs/core'],       'NestJS'],
  [['vue', '@vue/core'],             'Vue'],
  [['svelte', '@sveltejs/kit'],      'Svelte'],
  [['remix'],                        'Remix'],
  [['prisma', '@prisma/client'],     'Prisma'],
  [['drizzle-orm'],                  'Drizzle'],
  [['mongoose'],                     'Mongoose'],
  [['@supabase/supabase-js'],        'Supabase'],
  [['firebase'],                     'Firebase'],
  [['tailwindcss'],                  'Tailwind'],
  [['@mui/material'],                'Material UI'],
  [['shadcn'],                       'shadcn/ui'],
  [['zustand'],                      'Zustand'],
  [['@reduxjs/toolkit', 'redux'],    'Redux'],
  [['trpc', '@trpc/server'],         'tRPC'],
  [['graphql'],                      'GraphQL'],
  [['typescript'],                   'TypeScript'],
  [['vitest', 'jest'],               'Testing'],
  [['stripe'],                       'Stripe'],
  [['zod'],                          'Zod'],
]

export function detectTechStack(deps: string[], fileTree: string[]): string[] {
  const stack: string[] = []
  const depSet = new Set(deps.map(d => d.toLowerCase()))

  for (const [patterns, label] of STACK_DEPS) {
    if (patterns.some(p => depSet.has(p))) {
      stack.push(label)
    }
  }

  // Language detection from file extensions
  const hasTs = fileTree.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))
  if (hasTs && !stack.includes('TypeScript')) stack.push('TypeScript')

  return stack
}

export function detectFramework(deps: string[], fileTree: string[]): ScanResult['framework'] {
  const depSet = new Set(deps.map(d => d.toLowerCase()))
  const hasNext = depSet.has('next') || fileTree.some(f => f.endsWith('next.config.ts') || f.endsWith('next.config.js') || f.endsWith('next.config.mjs'))
  const hasExpress = depSet.has('express')

  if (hasNext && hasExpress) return 'mixed'
  if (hasNext) return 'nextjs'
  if (hasExpress) return 'express'
  return 'unknown'
}

export function detectLanguage(fileTree: string[]): ScanResult['language'] {
  const hasTs = fileTree.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))
  const hasJs = fileTree.some(f => f.endsWith('.js') || f.endsWith('.jsx'))
  if (hasTs) return 'typescript'
  if (hasJs) return 'javascript'
  return 'unknown'
}

// ── Next.js App Router parser ─────────────────────────────────────────────────

/**
 * Given the file tree, extract frontend page routes and API endpoints.
 * Works with both App Router (app/) and Pages Router (pages/).
 */
export function parseNextJsRoutes(fileTree: string[]): RawFeature[] {
  const features: RawFeature[] = []

  for (const filePath of fileTree) {
    // App Router API routes
    if (/app[/\\]api[/\\].*route\.(ts|js)$/.test(filePath)) {
      const routePath = filePath
        .replace(/^.*app[/\\]api[/\\]/, '/api/')
        .replace(/[/\\]route\.(ts|js)$/, '')
        .replace(/\\/g, '/')

      features.push({
        name: routeToFeatureName(routePath, 'api'),
        description: `API endpoint: ${routePath}`,
        type: 'api',
        confidence: 'high',
        source: filePath,
        keywords: extractRouteKeywords(routePath),
      })
      continue
    }

    // App Router pages
    if (/app[/\\].*page\.(tsx|jsx|ts|js)$/.test(filePath)) {
      // Skip root layout, loading, error, not-found
      if (/\/(layout|loading|error|not-found|template)\.(tsx|jsx|ts|js)$/.test(filePath)) continue

      const routePath = filePath
        .replace(/^.*app[/\\]/, '/')
        .replace(/[/\\]page\.(tsx|jsx|ts|js)$/, '')
        .replace(/\\/g, '/')
        || '/'

      // Skip (auth) group pages — internal layout groups
      if (routePath.startsWith('/(')) continue

      features.push({
        name: routeToFeatureName(routePath, 'page'),
        description: `Page: ${routePath || '/'}`,
        type: 'frontend',
        confidence: 'high',
        source: filePath,
        keywords: extractRouteKeywords(routePath),
      })
      continue
    }

    // Pages Router pages
    if (/pages[/\\](?!api[/\\]|_).*\.(tsx|jsx|ts|js)$/.test(filePath)) {
      const routePath = filePath
        .replace(/^.*pages[/\\]/, '/')
        .replace(/\.(tsx|jsx|ts|js)$/, '')
        .replace(/\/index$/, '/')
        .replace(/\\/g, '/')

      features.push({
        name: routeToFeatureName(routePath, 'page'),
        description: `Page: ${routePath}`,
        type: 'frontend',
        confidence: 'high',
        source: filePath,
        keywords: extractRouteKeywords(routePath),
      })
      continue
    }

    // Pages Router API routes
    if (/pages[/\\]api[/\\].*\.(ts|js)$/.test(filePath)) {
      const routePath = filePath
        .replace(/^.*pages[/\\]api[/\\]/, '/api/')
        .replace(/\.(ts|js)$/, '')
        .replace(/\/index$/, '')
        .replace(/\\/g, '/')

      features.push({
        name: routeToFeatureName(routePath, 'api'),
        description: `API route: ${routePath}`,
        type: 'api',
        confidence: 'high',
        source: filePath,
        keywords: extractRouteKeywords(routePath),
      })
    }
  }

  return deduplicateByName(features)
}

// ── Express route parser ──────────────────────────────────────────────────────

const EXPRESS_ROUTE_RE = /(?:router|app)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/g

export function parseExpressRoutes(fileTree: string[], fileContents: FileMap): RawFeature[] {
  const features: RawFeature[] = []
  const routeFiles = fileTree.filter(f =>
    /(routes?[/\\]|controllers?[/\\]).*\.(js|ts)$/.test(f) ||
    /^(server|index|app)\.(js|ts)$/.test(f.split('/').pop() ?? '')
  )

  for (const filePath of routeFiles) {
    const content = fileContents[filePath]
    if (!content) continue

    EXPRESS_ROUTE_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = EXPRESS_ROUTE_RE.exec(content)) !== null) {
      const [, method, routePath] = match
      if (!routePath || routePath === '/') continue

      features.push({
        name: routeToFeatureName(routePath, 'api'),
        description: `${method.toUpperCase()} ${routePath}`,
        type: 'api',
        confidence: 'high',
        source: filePath,
        keywords: extractRouteKeywords(routePath),
      })
    }
  }

  return deduplicateByName(features)
}

// ── DB model / schema scanner ─────────────────────────────────────────────────

export function parseDbModels(fileTree: string[]): RawFeature[] {
  const features: RawFeature[] = []

  // Prisma schema
  const prismaSchema = fileTree.find(f => /prisma[/\\]schema\.prisma$/.test(f))
  if (prismaSchema) {
    features.push({
      name: 'Database Schema (Prisma)',
      description: 'Prisma ORM schema with models and relations',
      type: 'data',
      confidence: 'high',
      source: prismaSchema,
      keywords: ['database', 'schema', 'prisma', 'models'],
    })
  }

  // Drizzle
  const drizzleSchema = fileTree.find(f => /drizzle\.config\.(ts|js)$/.test(f))
  if (drizzleSchema) {
    features.push({
      name: 'Database Schema (Drizzle)',
      description: 'Drizzle ORM schema and migrations',
      type: 'data',
      confidence: 'high',
      source: drizzleSchema,
      keywords: ['database', 'schema', 'drizzle', 'models'],
    })
  }

  // Supabase migrations
  const hasMigrations = fileTree.some(f => /supabase[/\\]migrations[/\\].*\.sql$/.test(f))
  if (hasMigrations) {
    features.push({
      name: 'Database Migrations (Supabase)',
      description: 'Supabase SQL migrations and schema',
      type: 'data',
      confidence: 'high',
      source: 'supabase/migrations/',
      keywords: ['database', 'schema', 'supabase', 'migrations', 'sql'],
    })
  }

  // SQL migration folder (generic)
  const hasGenericMigrations = !hasMigrations && fileTree.some(f => /migrations[/\\].*\.sql$/.test(f))
  if (hasGenericMigrations) {
    features.push({
      name: 'Database Migrations',
      description: 'SQL database migrations',
      type: 'data',
      confidence: 'medium',
      source: 'migrations/',
      keywords: ['database', 'schema', 'migrations', 'sql'],
    })
  }

  return features
}

// ── Auth detection ────────────────────────────────────────────────────────────

export function detectAuthFeatures(fileTree: string[], deps: string[]): RawFeature[] {
  const features: RawFeature[] = []
  const depSet = new Set(deps.map(d => d.toLowerCase()))

  const authFiles = fileTree.filter(f => /auth/.test(f.toLowerCase()))
  if (authFiles.length === 0 && !depSet.has('next-auth') && !depSet.has('@clerk/nextjs') && !depSet.has('passport')) {
    return []
  }

  // NextAuth
  if (depSet.has('next-auth') || fileTree.some(f => /auth\.(ts|js)$/.test(f))) {
    features.push({
      name: 'Authentication (NextAuth)',
      description: 'User authentication with NextAuth.js — sessions, providers, callbacks',
      type: 'auth',
      confidence: 'high',
      source: fileTree.find(f => /next-auth|auth\.ts/.test(f)) ?? 'auth',
      keywords: ['auth', 'login', 'session', 'nextauth', 'authentication'],
    })
    return features
  }

  // Clerk
  if (depSet.has('@clerk/nextjs') || depSet.has('@clerk/clerk-sdk-node')) {
    features.push({
      name: 'Authentication (Clerk)',
      description: 'User authentication and management with Clerk',
      type: 'auth',
      confidence: 'high',
      source: 'clerk config',
      keywords: ['auth', 'login', 'clerk', 'authentication'],
    })
    return features
  }

  // Auth0
  if (depSet.has('@auth0/nextjs-auth0') || depSet.has('auth0')) {
    features.push({
      name: 'Authentication (Auth0)',
      description: 'User authentication with Auth0',
      type: 'auth',
      confidence: 'high',
      source: 'auth0 config',
      keywords: ['auth', 'login', 'auth0', 'authentication'],
    })
    return features
  }

  // Generic: auth files exist
  if (authFiles.length > 0) {
    features.push({
      name: 'Authentication',
      description: 'User login, registration, and session management',
      type: 'auth',
      confidence: 'medium',
      source: authFiles[0],
      keywords: ['auth', 'login', 'session', 'authentication'],
    })
  }

  return features
}

// ── Integration hints from env ────────────────────────────────────────────────

export function buildIntegrationFeatures(integrations: string[]): RawFeature[] {
  const MAP: Record<string, RawFeature> = {
    'Stripe': {
      name: 'Payments (Stripe)',
      description: 'Stripe payment processing — checkouts, subscriptions, webhooks',
      type: 'integration',
      confidence: 'high',
      source: '.env.example',
      keywords: ['stripe', 'payment', 'checkout', 'subscription', 'billing', 'integration'],
    },
    'Email': {
      name: 'Email Notifications',
      description: 'Transactional email sending for notifications and alerts',
      type: 'integration',
      confidence: 'medium',
      source: '.env.example',
      keywords: ['email', 'sendgrid', 'mailgun', 'resend', 'notification', 'integration'],
    },
    'AWS': {
      name: 'AWS Integration',
      description: 'AWS services — S3 storage, CloudFront CDN, or other AWS infrastructure',
      type: 'integration',
      confidence: 'medium',
      source: '.env.example',
      keywords: ['aws', 's3', 'storage', 'cdn', 'integration'],
    },
    'OpenAI': {
      name: 'AI (OpenAI)',
      description: 'OpenAI API integration for AI-powered features',
      type: 'integration',
      confidence: 'high',
      source: '.env.example',
      keywords: ['openai', 'ai', 'gpt', 'llm', 'integration'],
    },
    'Redis': {
      name: 'Redis Cache',
      description: 'Redis for caching, sessions, or pub/sub',
      type: 'integration',
      confidence: 'medium',
      source: '.env.example',
      keywords: ['redis', 'cache', 'session', 'integration'],
    },
    'Sentry': {
      name: 'Error Monitoring (Sentry)',
      description: 'Sentry error tracking and performance monitoring',
      type: 'integration',
      confidence: 'high',
      source: '.env.example',
      keywords: ['sentry', 'monitoring', 'error', 'integration'],
    },
  }

  return integrations
    .filter(label => MAP[label])
    .map(label => MAP[label])
}

// ── Git state parser ──────────────────────────────────────────────────────────

export function parseGitHead(headContent: string): string | null {
  const ref = headContent.trim()
  if (ref.startsWith('ref: refs/heads/')) return ref.replace('ref: refs/heads/', '')
  if (/^[0-9a-f]{40}$/.test(ref)) return ref.slice(0, 8)  // detached HEAD
  return null
}

export function parseGitLog(logContent: string): { message: string | null, daysAgo: number | null } {
  const lines = logContent.trim().split('\n')
  const lastLine = lines[lines.length - 1]
  if (!lastLine) return { message: null, daysAgo: null }

  // reflog format: <sha> <sha> <author> <timestamp> <tz> <colon> <message>
  // e.g. "abc123 def456 Harry <h@x.com> 1714000000 +0000\tcommit: fix the thing"
  const tabIdx = lastLine.indexOf('\t')
  const message = tabIdx >= 0 ? lastLine.slice(tabIdx + 1).replace(/^commit:\s*/, '') : null

  const tsMatch = lastLine.match(/\s(\d{10})\s[+-]\d{4}/)
  const daysAgo = tsMatch ? Math.floor((Date.now() / 1000 - parseInt(tsMatch[1])) / 86400) : null

  return { message, daysAgo }
}

// ── Master scan function (accepts pre-read file contents) ─────────────────────

export interface ScanInput {
  name?: string                    // override — e.g. from GitHub repo name
  repoUrl?: string | null
  fileTree: string[]               // all file paths
  files: FileMap                   // path → content for key files
  gitState?: GitState | null
  scanSource: ScanSource
}

export function buildScanResult(input: ScanInput): Omit<ScanResult, 'phases'> & { rawFeatures: RawFeature[] } {
  const { fileTree, files, scanSource, repoUrl } = input

  // Package manifest
  const pkgContent = files['package.json'] ?? files['package.json']
  const pkg = pkgContent ? parsePackageJson(pkgContent) : { name: '', description: '', deps: [] }

  // README
  const readmeContent = files['README.md'] ?? files['readme.md'] ?? files['README.MD'] ?? ''
  const readmeDesc = readmeContent ? parseReadme(readmeContent) : ''

  // .env.example
  const envContent = files['.env.example'] ?? files['.env.sample'] ?? ''
  const integrations = envContent ? parseEnvExample(envContent) : []

  // Project name: explicit override > package.json > directory name from repoUrl > 'My Project'
  const name = (input.name ?? pkg.name ?? repoUrl?.split('/').pop() ?? 'My Project').replace(/-/g, ' ')
  const description = readmeDesc || pkg.description || ''

  // Tech stack
  const framework = detectFramework(pkg.deps, fileTree)
  const language = detectLanguage(fileTree)
  const techStack = detectTechStack(pkg.deps, fileTree)
  const integrationLabels = integrations.filter(i => !techStack.includes(i))
  const allStack = Array.from(new Set([...techStack, ...integrationLabels]))

  // Features
  const nextFeatures = (framework === 'nextjs' || framework === 'mixed') ? parseNextJsRoutes(fileTree) : []
  const expressFeatures = (framework === 'express' || framework === 'mixed') ? parseExpressRoutes(fileTree, files) : []
  const dbFeatures = parseDbModels(fileTree)
  const authFeatures = detectAuthFeatures(fileTree, pkg.deps)
  const integrationFeatures = buildIntegrationFeatures(integrations)

  const rawFeatures: RawFeature[] = [
    ...authFeatures,           // auth first — phase-grouper picks it up first
    ...dbFeatures,
    ...nextFeatures,
    ...expressFeatures,
    ...integrationFeatures,
  ]

  // Remove routes that duplicate auth (e.g. /api/auth/... routes) if a dedicated auth feature exists
  const hasAuthFeature = authFeatures.length > 0
  const dedupedFeatures = hasAuthFeature
    ? rawFeatures.filter(f => !(f.type === 'api' && /\/auth/.test(f.source)))
    : rawFeatures

  return {
    name,
    description,
    repoUrl: repoUrl ?? null,
    techStack: allStack,
    framework,
    language,
    rawFeatures: dedupedFeatures,
    gitState: input.gitState ?? null,
    filesScanned: fileTree.length,
    scanSource,
    scannedAt: new Date().toISOString(),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function routeToFeatureName(routePath: string, kind: 'api' | 'page'): string {
  // /api/users/[id] → "User detail API"
  // /dashboard/projects → "Dashboard projects"
  const segments = routePath
    .replace(/^\/api\//, '')
    .replace(/\[([^\]]+)\]/g, '$1')
    .split('/')
    .filter(Boolean)

  if (segments.length === 0) return kind === 'page' ? 'Home page' : 'Root API'

  const last = segments[segments.length - 1]
  const penultimate = segments[segments.length - 2]

  // "users / [id]" → "User detail"
  if (/^[a-z0-9_-]+$/.test(last) && penultimate && /[a-z]/.test(penultimate)) {
    if (last === 'id' || last === 'slug' || last === 'uuid') {
      return `${capitalize(singularize(penultimate))} detail${kind === 'api' ? ' API' : ' page'}`
    }
  }

  const base = capitalize(last.replace(/-/g, ' '))
  return kind === 'api' ? `${base} API` : `${base} page`
}

function extractRouteKeywords(routePath: string): string[] {
  return routePath
    .toLowerCase()
    .split(/[/\-_[\]]/)
    .filter(s => s.length > 1 && !/^(api|app|pages|src|id|slug|uuid)$/.test(s))
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function singularize(s: string): string {
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y'
  if (s.endsWith('ses')) return s.slice(0, -2)
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1)
  return s
}

function deduplicateByName(features: RawFeature[]): RawFeature[] {
  const seen = new Set<string>()
  return features.filter(f => {
    if (seen.has(f.name)) return false
    seen.add(f.name)
    return true
  })
}

// ── Export: assign IDs to raw features ───────────────────────────────────────

/** Attach IDs to raw features (done after phase assignment, just before returning to UI) */
export function finalizeFeatures(
  phases: import('@/lib/phase-grouper').ScannedPhase[]
): import('@/lib/phase-grouper').ScannedPhase[] {
  return phases.map(phase => ({
    ...phase,
    features: phase.features.map(f => ({ ...f, id: f.id || makeId() })),
  }))
}
