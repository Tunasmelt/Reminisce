# CLAUDE.md — Reminisce v2 Semantic Memory

> **Purpose of this file.** This is the single reference document for the Reminisce v2 codebase. When the user asks me to fix, change, extend, or explain anything in this project, I load context from here first and only open the actual source files I need. Treat every section as the source of truth until it's proven stale — if reality on disk disagrees, update this file, don't just fix the code silently.

**Last updated:** 2026-04-25 (import feature)
**Repo root:** `/sessions/bold-zealous-davinci/mnt/reminisce`
**Primary docs on disk:** `README.md`, `DEPLOYMENT.md`, `CHANGELOG.md`, `.env.example`
**Canonical schema file:** `supabase/migrations/00000000000099_complete_reset_schema.sql`

---

## 1. Product scope

**One-liner.** Reminisce is an AI context orchestration platform for software developers. Users define a project once — idea, architecture, features, context files — and every AI tool, editor session, and teammate works from the same shared live context.

**The problem it solves.** Devs using AI tools re-paste the same architecture docs, tech stack, and conventions into every chat. Context drifts between sessions and between teammates. Reminisce stores project context centrally, versions it like git, and injects the right slice of it into every AI call.

**Shape of the product.**
- **SaaS web app** (Next.js, deployed on Vercel).
- **Multi-tenant** via Supabase workspaces + projects + RLS.
- **Freemium** — Free plan uses free-tier LLMs with a daily coin budget; Pro plan adds premium models via a monthly gem grant and paid gem packs.
- **BYOK** — users can paste their own provider keys and bypass the economy entirely.

**Target audience.**
- **Primary:** solo indie devs and 2–8 person product teams building AI-assisted apps who already use Cursor / Windsurf / Claude Code / ChatGPT daily.
- **Secondary:** technical founders kicking off a new project who want AI to draft phases, features, prompts, and architecture in one go.
- **Tertiary:** engineering managers who want a lightweight project tracker (graph + board) that's wired to AI prompts, not yet-another-Jira.

**Not the audience.** Non-technical PMs, large enterprises needing SSO/SOC2, or teams that want a general-purpose chat client.

---

## 2. Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Framework | **Next.js 14.2.35** App Router | TypeScript 5, strict mode |
| UI | Tailwind CSS 3.4 + **shadcn/base-nova** primitives | Only 7 shadcn primitives in `components/ui/`: button, card, dialog, dropdown-menu, input, label, sonner. Everything else is custom. |
| Icons | `lucide-react` | |
| DB / Auth | **Supabase** (Postgres + RLS) | `pgvector` + `pg_trgm` extensions. Email/password auth. |
| AI SDKs | `@anthropic-ai/sdk`, `ai` (Vercel AI SDK), raw `fetch` for other providers | 10 providers abstracted in `lib/ai-client.ts`. |
| Payments | **Stripe** (`stripe` + `@stripe/stripe-js`) | Pro subscription + one-time gem packs. |
| Local FS | File System Access API + `idb-keyval` | Handle persisted per project in IndexedDB. |
| Graph viz | Custom canvas (pan/zoom/touch) + `@xyflow/react` types | Swimlane layout; `@dagrejs/dagre` for auto-layout. |
| 3D landing | `three` + `@react-three/fiber` + `@react-three/drei` | `components/Scene3D.tsx`. |
| State | **Zustand** (`store/`) | Only `auth` and `theme` are global. Everything else is API-driven. |
| Markdown | `react-markdown`, `remark`, `unified` | |
| Diff | `diff` + `diff-match-patch` | Powers `components/DiffViewer.tsx`. |
| Zip | `jszip` | Project export. |

**Path alias.** `@/*` → project root (see `tsconfig.json`). Always import internal modules with `@/` (e.g. `@/lib/supabase`), never relative `../../`.

---

## 3. Directory map (high level)

```
app/                       # Next.js App Router
├── (auth)/                # login, signup
├── admin/                 # admin console (gated in layout.tsx)
├── api/                   # all server routes (see §5)
├── dashboard/             # authed user app
│   ├── page.tsx           # project list
│   ├── templates/         # prompt template library
│   └── projects/[id]/     # per-project workspace (see §4)
├── docs/, engineering/, capabilities/, upgrade/
├── layout.tsx             # root layout (auth-provider, theme)
└── page.tsx               # landing
components/                # UI layer (see §7)
hooks/                     # useFileSystem, useKeyboardShortcuts, useMediaQuery, useTheme
lib/                       # core business logic (see §6)
store/                     # Zustand — auth.ts, theme.ts only
supabase/migrations/       # schema (see §8) — canonical reset in 00000000000099
middleware.ts              # no-op; admin gated in layout, not middleware
```

**Temp + build:** `.next/`, `tsconfig.tsbuildinfo`, `scratch/`, `build_log.txt`.

---

## 4. Per-project UI surface

Under `app/dashboard/projects/[id]/`:

| Route | Page | What it does |
|---|---|---|
| `/` | `page.tsx` | Project overview — metadata, git state, quick links. |
| `wizard/` | Blueprint generator | 4-stage AI chat (idea → features → stack → generating) then parallel blueprint generation. See §6 `wizard-stages.ts`. |
| `agent/` | PAM chat | AI project manager with full project context, action confirmations, reminders. |
| `graph/` | Visual map | Swimlane canvas of phases → features. Drag-to-reparent, annotations. |
| `board/` | Kanban | Drag-and-drop columns, swimlane grouping, priority badges, mobile move menu. |
| `context/` | Context file editor | Versioned markdown store, diff viewer, push/pull to local folder. |
| `prompts/` | Prompt library | 3 tabs: Blueprint (wizard-generated), Custom (user + PAM), Changelog (agent-runs.md + changes.md). |
| `api-lab/` | HTTP client | In-app HTTP tester with SSRF protection and AI-suggest. |
| `settings/` | Project settings | Name, description, git repo, editor, BYOK keys, team, subscription. |

**Top-level dashboard routes:** `/dashboard` (projects list), `/dashboard/templates` (prompt templates shared across projects), `/dashboard/import` (3-step import wizard for existing projects).

---

## 5. API routes (under `app/api/`)

**Universal conventions.**
- Every `route.ts` exports `export const dynamic = 'force-dynamic'` (no caching).
- Streaming routes (SSE) set `X-Accel-Buffering: no` for Vercel/Nginx.
- Long-running routes set `export const maxDuration = 60` or `300` (Vercel limit).
- Auth is always `getUser()` from Supabase (JWT); project writes go through `verifyProjectAccess` + `getProjectRole`.
- Admin routes gated by `verifyAdmin()` from `lib/admin-auth.ts`.

### 5.1 Admin — `/api/admin/*` (all require `verifyAdmin`)
| Method + Path | Purpose |
|---|---|
| GET `/admin/verify` | Return `{ is_admin: boolean }` |
| GET `/admin/stats` | Dashboard counters (users, projects, today's activity, economy) |
| GET `/admin/logs` | Last 200 `admin_logs` rows |
| GET `/admin/models` · POST · PATCH/DELETE `/admin/models/[id]` | CRUD on `provider_models` (label, enabled, tier, cost). All mutations logged to `admin_logs`. |
| GET `/admin/users` | Paginated user list with wallet + project counts. `?page=&limit=&search=` |
| PATCH `/admin/users/[id]` | Actions: `upgrade_pro`, `downgrade_free`, `add_coins`, `add_gems`, `ban`, `unban`, `set_notes`, `make_admin`, `remove_admin`. Logged. |
| DELETE `/admin/users/[id]` | Full cascade delete including `auth.admin.deleteUser`. |
| GET `/admin/users/[id]/activity` | Last 20 wallet transactions for user. |

### 5.2 Agent — `/api/agent/*`
| Method + Path | Purpose |
|---|---|
| GET `/agent/history?projectId=` | Last 20 `agent_runs` for project. |
| POST `/agent/run` | **SSE stream.** Runs an agent prompt against a feature. Loads feature + git state + architecture/tech-stack/coding-guidelines context files. Deducts coins/gems unless `userHasOwnKey`. Detects scope drift. Writes `agent_runs` row, bumps `prompts.run_count`, appends to `reminisce/workflow/agent-runs.md`. Awards `first_agent_run` coins on first completion. |

### 5.3 Context — `/api/context/*`
| Method + Path | Purpose |
|---|---|
| GET `/context/history?projectId=&filePath=` | Version history for a file. |
| POST `/context/version` | Save new version. Computes diff vs previous, upserts into `contexts` + `context_versions`, re-indexes for PAM vector search. Rejects `viewer` role. |

### 5.4 Export — `/api/export`
| Method + Path | Purpose |
|---|---|
| POST `/export` | Returns `application/zip` of `reminisce/*` files. Owner-only. |

### 5.5 Keys (BYOK) — `/api/keys/*`
| Method + Path | Purpose |
|---|---|
| GET `/keys/list` | Provider names only (not the keys). |
| POST `/keys/save` | Encrypt + upsert. **Pro-only.** |
| DELETE `/keys/delete` | Remove. **Pro-only.** |
| GET `/keys/models` | Public list of enabled models (no auth). Used by model selectors. |

### 5.6 PAM (Project Action Manager) — `/api/pam/*`
| Method + Path | Purpose |
|---|---|
| GET · POST `/pam/threads` | List / create threads. |
| GET · PATCH `/pam/thread/[id]` | Fetch messages / update title / archive flag. |
| POST `/pam/message` | **SSE.** Main chat turn. Builds tiered system prompt: summaries + smart-loaded full context + workflow files + semantic memory hits via `searchMemory()`. Detects PAM action signals `UPDATE_FEATURE_STATUS`, `CREATE_PROMPT`, `ADD_FEATURE`, `CREATE_REMINDER`. Writes `pam_messages`, bumps thread metadata. Rejects `viewer` role. |
| PATCH `/pam/message` | Confirm/reject a pending PAM action — executes DB mutation and appends `reminisce/workflow/changes.md`. |
| GET · POST `/pam/reminders` · PATCH/DELETE `/pam/reminders/[id]` | Reminder CRUD. |
| POST `/pam/summarise` | Background: summarize thread → `pam_thread_summaries` for cross-thread memory. |

### 5.7 Projects — `/api/projects/*`
| Method + Path | Purpose |
|---|---|
| GET `/projects` | Owned + accepted-member projects. Uses service role to bypass RLS join cost. |
| POST `/projects` | Create project. Enforces `canCreateProject` (plan limit). Belt-and-suspenders upsert of `project_members` (head). |
| GET `/projects/[id]` | Project + phases + features + latest context version. |
| DELETE `/projects/[id]` | Owner-only cascade delete. |
| POST `/projects/repair` | Heal orphaned `project_members` rows ("ghost project" fix — idempotent). |

### 5.8 Prompts — `/api/prompts/*`
| Method + Path | Purpose |
|---|---|
| GET `/prompts/list?projectId=&tab=` | `blueprint` (MASTER + PHASE_OVERVIEW + FEATURE_BUILD), `custom` (user + PAM-generated, excl. MASTER), `changelog` (reads `agent-runs.md` + `changes.md`). |
| POST `/prompts/structure` | AI prompt enhancer. Detects type (FEATURE_BUILD / BUG_FIX / REFACTOR / API_TEST / ARCHITECTURE), rewrites via Codeck persona, saves to `prompts`. |

### 5.9 Proxy — `/api/proxy`
| Method + Path | Purpose |
|---|---|
| POST `/proxy` | SSRF-hardened HTTP proxy powering API Lab. **Two-layer defense** (`lib/ssrf-guard.ts`): hostname blocklist **+** DNS-rebinding guard that resolves the host, rejects any private-resolving IP, and pins the connection to a validated IP via an undici dispatcher. `redirect:'error'`, 5 MB response cap, safe response-header allowlist. Supports Bearer + `x-api-key` auth. Returns `{ status, headers, body, timing:{total,ttfb}, size }`. |

### 5.10 Rewards — `/api/rewards/daily-login`
POST → `awardCoins(..., 'daily_login')`.

### 5.11 Stripe — `/api/stripe/*`
| Method + Path | Purpose |
|---|---|
| POST `/stripe/checkout` | Create Checkout Session (subscription `subscription` mode OR one-time `payment` mode for gem packs: `gems_50` $5 / `gems_150` $12 / `gems_400` $25). |
| POST `/stripe/cancel` | `cancel_at_period_end` — user keeps Pro until cycle end. Supports manual downgrade too. |
| POST `/stripe/webhook` | Signature-verified. Events: `checkout.session.completed` (subscription or gems), `customer.subscription.deleted`, `invoice.paid`. |

### 5.12 Team — `/api/team/*`
| Method + Path | Purpose |
|---|---|
| POST `/team/invite` | Invite by email. Creates accepted row if user exists, pending otherwise. Head-only. Enforces 8-member cap. |
| GET `/team/members?projectId=` | Members (accepted + pending) with emails from auth users. |
| DELETE `/team/members?projectId=&userId=` | Remove member. Head-only. |
| POST `/team/respond` | Accept/decline invite by email lookup. |

### 5.13 Templates — `/api/templates/*`
| Method + Path | Purpose |
|---|---|
| GET `/templates/list?tag=&category=&search=` | Sort by `use_count DESC`. |
| POST `/templates/save` | Upsert. Ban-check. |
| POST `/templates/use` | Use template in a project. Increments `use_count`. |
| DELETE `/templates/delete` | Owner-only. |

### 5.14 Import — `/api/import/*`
| Method + Path | Purpose |
|---|---|
| POST `/import/scan` | Scans a GitHub repo (public or private with PAT). Fetches file tree + key files via GitHub API, runs static parsers, returns `ScanResult`. No AI. Accepts `{ url, pat? }`. |
| POST `/import/create` | Creates a project from a confirmed `ScanResult`. Inserts project (`created_via: 'import'`), phases, features, and optional context files (`architecture.md`, `tech-stack.md`). Enforces plan limits. |

### 5.15 Wizard — `/api/wizard/*`
| Method + Path | Purpose |
|---|---|
| POST `/wizard/chat` | **SSE, maxDuration 60.** Chat turn for the 4-stage wizard. Extracts idea data / features / stack options on stage transitions. Saves to `wizard_sessions.messages` + `stage` + `completed_stages`. |
| POST `/wizard/generate` | **SSE, maxDuration 300.** 5-step blueprint generation in 3 waves: Wave 1 parallel (Architecture, Phases), Wave 2 parallel (Feature Prompts, Phase Prompts), Wave 3 serial (Master Prompt). Saves phases / features / prompts / contexts / graph_nodes / workflow files. Head-only + coin preflight. Awards `wizard_complete` coins. |
| PATCH `/wizard/session` | Single authoritative write point for confirmed features / stack / stage (head-only). |

---

## 6. `lib/` — core business logic

Each module is self-contained with typed exports. Prefer composing these in routes rather than reimplementing.

| File | Responsibility | Key exports |
|---|---|---|
| `ai-client.ts` | Unified client for all 10 AI providers. Per-model rate limiting (via `rate_events`). BYOK key resolution. | `AIProvider`, `callAI()`, `userHasOwnKey()`, `invalidateModelCache()` |
| `wallet.ts` | Dual-currency economy + per-model cost/tier lookup. | `getModelCostInfo()`, `getUserPlan()`, `canCreateProject()`, `getWallet()`, `ensureWallet()`, `applyDailyReset()`, `deductCost()`, `refundCost()`, `awardCoins()`, `getTimeUntilUTCReset()` |
| `model-registry.ts` | Single cached reader of `provider_models` — the one source of truth in code for model metadata. | `ModelDef`, `getModels()`, `getModel()`, `getModelByIdLoose()`, `invalidate()` |
| `model-permissions.ts` | Pure resolver: may this user run this model? (enabled + tier + BYOK). No I/O. | `canUseModel()`, `ModelPermissionContext`, `ModelPermissionResult` |
| `ssrf-guard.ts` | Two-layer SSRF defense for `/api/proxy` (hostname blocklist + resolve-then-pin). | `isBlockedHost()`, `resolveAndValidateHost()`, `createPinnedAgent()`, `HostValidation` |
| `admin-audit.ts` | Single canonical `admin_logs` writer — non-throwing, delete-safe. | `writeAuditLog()` |
| `api-auth.ts` | Bearer-token auth helper (partial adoption — 3 routes: `agent/history`, `context/history`, `export`). | `authenticateRequest()` |
| `constants.ts` | Shared constants. | `ALLOWED_PROVIDERS` (the 10 provider slugs) |
| `wizard-stages.ts` (46.6 KB) | Wizard state machine + generation config. | `WizardStageKey`, `WizardSessionState`, `TechStackOption`, `ConfirmedFeature`, `STAGE_META`, `GENERATION_STEPS` |
| `fsapi.ts` (13.3 KB) | File System Access API + git reading. Handles persisted in IndexedDB. | `openProjectFolder()`, `getStoredHandle()`, `readFile()`, `writeFile()`, `initProjectStructure()`, `readGitState()`, `readAllContextFiles()`, `computeFileHash()`, `REMINISCE_OWNED_PATHS` |
| `vector-memory.ts` (6 KB) | Embeddings + semantic search. | `chunkText()`, `generateEmbedding()`, `upsertMemoryChunks()`, `searchMemory()`, `indexProjectContext()` |
| `github.ts` (10.7 KB) | Public repo metadata fetcher. | `parseRepoUrl()`, `fetchRepoMetadata()`, `detectStackFromRepo()` |
| `admin-auth.ts` (1.1 KB) | `verifyAdmin()` — JWT check + `user_plans.is_admin` flag. |
| `encryption.ts` (1.5 KB) | AES-256-GCM for BYOK. | `encrypt()`, `decrypt()` — keyed by `ENCRYPTION_SECRET` |
| `supabase.ts` (2.4 KB) | Client + authz helpers. | `supabase`, `getServiceSupabase()`, `verifyProjectAccess()`, `getProjectRole()`, `isUserBanned()` |
| `stream-parser.ts` (2.9 KB) | Unified SSE parser. | `StreamChunk`, `readSSEStream()`, `stripPamAction()`, `estimateTokens()` |
| `exportBrief.ts` (5.4 KB) | Project brief export. | `BriefData`, `generateMarkdown()`, `generatePlainText()`, `generateJSON()`, `downloadFile()`, `copyToClipboard()` |
| `project-scanner.ts` | Static analysis engine for import feature. Parses manifests, Next.js routes, Express routes, DB schemas, .env.example. No AI. | `ScanResult`, `RawFeature`, `FileMap`, `buildScanResult()`, `parsePackageJson()`, `parseNextJsRoutes()`, `parseExpressRoutes()`, `parseDbModels()`, `detectAuthFeatures()`, `buildIntegrationFeatures()`, `detectTechStack()`, `parseGitHead()`, `parseGitLog()` |
| `phase-grouper.ts` | Rules-based phase assignment for imported projects. Buckets `RawFeature[]` into ordered `ScannedPhase[]`. | `ScannedPhase`, `ScannedFeature`, `groupIntoPhases()` |
| `utils.ts` | Shared UI helpers. | `cn()` (clsx + twMerge), `hexToRgba()` |

### 6.1 Supported AI providers
Groq, Cerebras, SambaNova, Gemini, Mistral, Anthropic, OpenAI, Kimi (Moonshot), MiniMax, OpenRouter. Context-window limits range SambaNova 5.5K → Gemini 800K. Per-model RPM/RPD limits enforced in `checkUserRateLimit()` (in `ai-client.ts`) via the dedicated `rate_events` table (decoupled from the billing ledger).

### 6.2 Economy rules
| Plan | Coins/day | Gems | Projects cap |
|---|---|---|---|
| Free | 50 | 0 | 2 |
| Pro | 200 | 100/month + purchasable | unlimited |
| BYOK | bypasses economy | — | — |

---

## 7. UI layer (`components/`, `hooks/`, `store/`)

### Components
- **Root:** `auth-provider.tsx`, `protected-route.tsx`, `OnboardingGate.tsx`, `theme-initializer.tsx`, `theme-wrapper.tsx`, `theme-toggle.tsx`, `theme-switcher.tsx`, `landing-nav.tsx`.
- **Visual:** `ReminisceLogo.tsx`, `Scene3D.tsx` (R3F landing), `BentoScene.tsx`, `reveal.tsx`, `DiffViewer.tsx` (unified/split/summary modes), `ExportBriefModal.tsx`, `CustomSelect.tsx`.
- **`components/ui/`:** shadcn/base-nova primitives (7 files). Do **not** pull in the full shadcn set — keep additions minimal and themed.
- **`components/admin/`:** `overview.tsx`, `users.tsx`, `models.tsx`, `logs.tsx`, `activity.tsx`, `modals.tsx`, plus `types.ts` and `shared.tsx` (helpers: `hexToRgba`, `timeAgo`, `pill`, shared table styles).

### Hooks
- `useFileSystem(projectId)` — FS handle, git state, sync/pull/push + conflict detection.
- `useKeyboardShortcuts(config)` — Cmd/Ctrl+K (search), +H (dashboard), +G (generate), +P (PAM), +B (board), +S (save), Esc (close), Enter (send).
- `useMediaQuery(query)` + `useIsMobile/Tablet/Desktop`.
- `useTheme()` — 5 themes: `solar-flare`, `elite-purple`, `midnight-cyan`, `emerald-circuit`, `monochrome`. Cross-tab sync via `storage` event.

### Stores (Zustand)
- `store/auth.ts` — `{ user, session, initialized }`.
- `store/theme.ts` — `{ theme, hasChosen }`, persists to localStorage + `data-theme` attr.

> **Rule of thumb:** if new state is project-scoped, put it in an API call + local `useState`/URL params, not a global store.

---

## 8. Database schema (Supabase)

**28 tables. RLS enabled on all except `provider_models` (public read).** Extensions: `vector`, `pg_trgm`. Canonical reset: `supabase/migrations/00000000000099_complete_reset_schema.sql` — a **complete cold install** (migrations `0035`–`0038` are folded in; run this one file alone for a fresh DB). Optional post-reset: `0000000000039_models_rehaul.sql` refreshes the model catalogue to the verified-live set.

### 8.1 Relationship tree
```
workspaces (owner_id → auth.users)
 └── projects
      ├── project_members         (roles: head | collaborator | viewer; invite_status: pending|accepted|declined; cap 8)
      ├── phases                  (ordered; unique per project by name)
      │    └── features           (unique per phase by name)
      │         └── tasks
      │              └── prompts  (optional)
      ├── prompts                 (direct, project-level)
      ├── agent_runs              (execution log — workspace-owner RLS only)
      ├── contexts (file_path)
      │    └── context_versions
      ├── wizard_sessions
      ├── pam_threads
      │    └── pam_messages
      ├── notifications
      ├── graph_nodes + graph_edges
      └── memory_chunks           (pgvector embeddings; HNSW cosine index)

auth.users
 ├── user_plans      (1:1; auto-created via handle_new_user trigger)
 ├── user_wallets    (1:1; auto-created; 50 coins starting)
 ├── wallet_transactions
 ├── gem_purchases
 ├── user_api_keys   (UNIQUE(user_id, provider); encrypted_key)
 ├── project_reminders
 ├── prompt_templates
 └── admin_logs      (if admin)

provider_models    (global, seeded)
```

### 8.2 Tables by domain

**Workspace / team.** `workspaces`, `projects`, `project_members`.
- `projects.created_via` ∈ `'wizard' | 'blank' | 'import'`. `scan_source` ∈ `'local' | 'github'` (nullable, set only for imported projects).
- `project_members` uniqueness enforced at app level (upsert with duplicate-swallow).

**Project structure.** `phases`, `features`, `tasks`.
- Post-reset migration 21 added uniqueness: `(project_id, name)` on phases, `(project_id, phase_id, name)` on features, `(project_id, file_path)` on contexts.

**Context / code.** `contexts`, `context_versions`.
- `contexts.owned_by` ∈ `'reminisce' | 'developer' | 'shared'` — drives sync behavior.
- `contexts.file_hash` used with local FS hashes for conflict detection.

**Prompts / AI runs.** `prompts`, `agent_runs`.
- `prompts.is_master_prompt` boolean flags the wizard's master prompt.
- `agent_runs` RLS allows **owner OR accepted project members** — all team members can read run history.

**Blueprint ingestion.** `wizard_sessions`.

**Messaging.** `pam_threads`, `pam_messages`, `notifications`, `project_reminders`.
- `pam_messages.role` ∈ `'user' | 'assistant' | 'system'`.
- `pam_messages.action_type / action_payload / action_confirmed` drive confirm-to-execute actions.

**Graph.** `graph_nodes`, `graph_edges` — workspace-owner RLS only.

**Vector memory.** `memory_chunks(embedding vector(1536))` + HNSW index. RPC `match_memory_chunks(query_embedding, match_threshold, match_count, p_project_id, p_source_types)` for semantic search.

**Identity / economy.** `user_plans`, `user_wallets`, `wallet_transactions`, `gem_purchases`, `user_api_keys`.

**Admin + catalog.** `admin_logs`, `provider_models`, `rate_events` (per-user AI rate-limit ledger). The verified catalogue is **32 live-checked models across 9 active providers** (Groq, Cerebras, SambaNova, OpenRouter, Gemini, Anthropic, Mistral, Kimi, MiniMax); **OpenAI is seeded but disabled** (invalid platform key). _Model management is `provider_models`-backed today; this whole flow is slated for replacement by `config/models.ts` in the **M2 model-config rehaul** — treat the specifics here as provisional, and re-pass this section once M2 lands._

**Personal.** `prompt_templates` (per-user, category + tags + `use_count`).

### 8.3 Triggers & functions
- `handle_new_user()` — on `auth.users` insert, create `user_plans` (free / 2 projects) + `user_wallets` (50 coins). SECURITY DEFINER.
- `assign_project_head()` — on project insert, upsert workspace owner as head in `project_members`.
- `enforce_member_limit()` — rejects insert when a project already has 8 non-declined members.
- `pam_auto_title()` — on first user message, sets `pam_threads.title = LEFT(content, 60)` + bumps `message_count` + `last_message_at`.
- `match_memory_chunks()` — RPC wrapping cosine search with optional source-type filter.

---

## 9. Security model

- **JWT on every route** via `getUser()` / `getSession()`.
- **Project writes** always pass `verifyProjectAccess(userId, projectId)` and usually `getProjectRole(userId, projectId)`; `viewer` is explicitly rejected on write routes (PAM message, context version, wizard generate/session).
- **Admin routes** gated by `verifyAdmin()` (JWT + `user_plans.is_admin` flag). Admin gate also re-checked in `app/admin/layout.tsx` (no edge middleware — Supabase cookie names vary by project ref).
- **Banned users** blocked from AI-consuming routes via `isUserBanned()`.
- **BYOK keys** AES-256-GCM encrypted (`ENCRYPTION_SECRET` hashed to 256-bit key).
- **Stripe webhook** signature-verified via `constructEvent`.
- **SSRF protection** in `/api/proxy` — two layers via `lib/ssrf-guard.ts`: (1) hostname blocklist (private ranges, `.local`/`.internal`, cloud metadata, alternative IP encodings, IPv6 ULA/link-local); (2) a **DNS-rebinding guard** that resolves the host, rejects if any resolved IP is private, and **pins the connection to a validated IP** (undici dispatcher) so the TCP target can't rebind. Any future route that fetches a user-supplied URL must go through `resolveAndValidateHost()` + `createPinnedAgent()`.
- **RLS** enabled on all 28 tables; `provider_models` additionally carries a public-read policy.

---

## 10. Feature set already shipped

1. **Project Wizard** — 4-stage AI chat → parallel blueprint generation (architecture + phases + feature prompts + phase prompts + master prompt).
2. **PAM (Project Action Manager)** — streaming chat with tiered context (smart-loaded + semantic + workflow), action confirmation (`UPDATE_FEATURE_STATUS`, `CREATE_PROMPT`, `ADD_FEATURE`, `CREATE_REMINDER`), reminders, thread summaries.
3. **Graph** — custom canvas swimlanes, drag-to-reparent, node annotations.
4. **Board** — Kanban with drag-and-drop, swimlane grouping, priority badges, mobile move menu.
5. **Context Engine** — versioned markdown files, diff viewer (unified/split/summary), push/pull to local folder via File System Access API, git state reading (branch / last commit / remote) with no API keys.
6. **AI Agent runs** — streaming SSE against feature prompts with full project context.
7. **Prompt Library** — blueprint prompts, custom prompts, changelog view backed by `agent-runs.md` + `changes.md`.
8. **API Lab** — in-app HTTP client with SSRF protection and AI-suggest.
9. **Prompt Templates** — cross-project reusable templates with categories, tags, `use_count` ranking.
10. **Dual-currency Economy** — coins + gems, daily reset, BYOK bypass, per-model costs.
11. **Admin Panel** — user management (upgrade/downgrade/ban/grant/admin), model catalog CRUD, audit log, platform stats.
12. **Subscription** — Stripe Pro subscriptions, one-time gem packs ($5/$12/$25), self-service cancel with `cancel_at_period_end`.
13. **Team collaboration** — invite by email, roles (head / collaborator / viewer), 8-member cap.
14. **Project export** — ZIP of `reminisce/*` files.
15. **Semantic memory** — pgvector embeddings with HNSW index, 1536-dim (OpenAI text-embedding-3-small), fallback to `ilike` when `OPENAI_API_KEY` missing.
16. **Theming** — 5 themes with cross-tab sync.
17. **Daily-login rewards** + first-agent-run coin bonus + wizard-completion bonus.

---

## 11. Environment variables

**Required for local dev:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `ENCRYPTION_SECRET` (32 chars), `GROQ_API_KEY`.

**AI providers (optional, add as needed):** `CEREBRAS_API_KEY`, `SAMBANOVA_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `KIMI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`.

**Stripe (for payments):** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`.

Full reference in `.env.example` (3.3 KB). Never commit `.env.local`.

---

## 12. Conventions & gotchas

### Coding conventions
- **Path alias `@/`** — always use it, never deep relative imports.
- **Server components by default** in App Router; mark `'use client'` only when needed.
- **Every `app/api/**/route.ts` exports `export const dynamic = 'force-dynamic'`.** If you add a route and forget this, cached responses will leak user data — don't forget.
- **Streaming routes** need `X-Accel-Buffering: no` response header (Vercel/Nginx buffering breaks SSE without it).
- **Long-running routes** set `export const maxDuration` (60 for wizard/chat, 300 for wizard generate).
- **TypeScript is strict.** Watch for `MapIterator` spread errors — use `Array.from()`.
- **Inline CSS-in-JS is acceptable** alongside Tailwind — the codebase mixes both intentionally.
- **Zustand stays minimal.** Only auth + theme. Everything else is API + local state.

### Authorization conventions
- Call `verifyProjectAccess` **before** `getProjectRole` — the former is a membership check, the latter returns the role string.
- `viewer` role is **never** allowed to write. If you're adding a write endpoint, the pattern is `if (role === 'viewer') return 403`.
- `wizard_sessions`, `graph_nodes`, `graph_edges` have **workspace-owner-only RLS**. When listing these for a collaborator, you must use the service role, and app code must re-check membership. `agent_runs` is owner-or-member (fixed in migration 0027).

### Economy / AI conventions
- **Deduct before call, refund on error.** Use `deductCoins()` / `refundCoins()` — pattern: `try { deduct → call → persist } catch { refund }`.
- **Wallet deduction is atomic** (E-1, fixed): `deductCost()` uses optimistic locking — it reads the balance for a snapshot, then `UPDATE ... WHERE <currency> = snapshot`. If a concurrent call already deducted, the guarded WHERE matches 0 rows and it retries once with a fresh read. Two concurrent calls can no longer both pass the check and drive the balance negative. The daily reset (`applyDailyReset`) is likewise atomic via a conditional `coins_last_reset` filter (E-2) plus a process-local memo fast path (E-22). Do not "simplify" these back to read-then-write.
- **BYOK bypasses the economy entirely.** Check `userHasOwnKey(userId, provider)` before wallet logic.
- **Model cascades** (wizard generate): on rate-limit or timeout → next model. On parse failure → retry same model with stricter instruction. On context overrun → skip this model.
- **Emit `model_switched` SSE** so the UI can toast-notify without crashing.
- **Free-tier token caps are tight** — decomposition 3500, comprehension 2000, context files 3000, gap analysis 1200. Don't bump these without testing against Groq 30K TPM.

### Database conventions
- **All FKs are `ON DELETE CASCADE`** — deleting a project cleans up everything.
- **`wallet_transactions` are immutable** (no UPDATE/DELETE grants under RLS). To "undo" charges, emit a matching `refund` row.
- **`project_members.user_id` is nullable** for pending invites — always filter `WHERE user_id IS NOT NULL` when joining to auth users.
- **pgvector embeddings are populated asynchronously.** `memory_chunks.embedding` may be NULL immediately after insert; `searchMemory()` falls back to text `ilike` if no `OPENAI_API_KEY` is set.
- **Uniqueness was added late** (migration 21). Be defensive — use `upsert` (ON CONFLICT DO UPDATE) for phases/features/contexts inserts.

### Streaming / SSE gotchas
- **SSE parser must use a persistent buffer.** `chunk.split('\n\n')` breaks on fragmented TCP delivery. Use `sseBufferRef` that only processes complete `\n\n`-terminated messages.
- **Render objects safely.** `{gap?.missingFeatures.map(m => ...)}` has bitten us with `[object Object]` — always pick specific fields (`m.name`, `m.description`).
- **PAM action signals** are embedded in streamed text like `[PAM_ACTION]...[/PAM_ACTION]`. Use `stripPamAction()` from `stream-parser.ts` before rendering to the user.

### Local FS gotchas
- **FS Access API is Chromium-only.** Safari/Firefox users can't push/pull — fall back gracefully.
- **Handle permissions expire.** Always `queryPermission` on restore and `requestPermission` if needed.
- **`REMINISCE_OWNED_PATHS`** (`reminisce/*`, `.reminisce-meta`) are auto-ignored during sync — don't blow this up or we'll trigger a sync loop.
- **Git state is read by parsing `.git/HEAD`, `.git/refs/heads/`, `.git/config` as plain text** — no API, works offline for any git provider.

### Admin gotchas
- **Admin route gating is in `app/admin/layout.tsx`, not middleware.** Supabase JS v2 cookie names vary by project ref, so we can't check at the edge. `middleware.ts` is intentionally a no-op.
- **Every admin mutation must write to `admin_logs`** (admin_id, action, target_id, target_type, payload).

### Stripe gotchas
- **Webhook must read the raw body** before signature verification. Next.js App Router: use `await req.text()` then `constructEvent(body, sig, secret)` — don't parse JSON first.
- **`cancel_at_period_end`** keeps the user on Pro until cycle end; the actual downgrade happens on `customer.subscription.deleted`.
- **Gem packs are one-time (`payment` mode)**, subscription is recurring (`subscription` mode) — same checkout route handles both via a `mode` param.

### Migration hygiene
- **Canonical schema is `00000000000099_complete_reset_schema.sql`** — a complete cold install (migrations `0035`–`0038` are folded in; `0099` alone provisions a fresh DB). When adding new migrations, number them after the reset (current tail: `0000000000039`).
- **If a cold install and an existing install diverge,** prefer idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in migrations.

### AI-model access — the `canUseModel` gate
Every AI-consuming route resolves the model + user context, then calls the single resolver **`canUseModel({ plan, isBYOK }, modelDef)`** from `lib/model-permissions.ts` **before any `deductCost`**: an unknown/disabled model → 400; a Pro-tier model on a free plan (non-BYOK) → 403; BYOK bypasses tier gating only. The `modelDef` comes from `getModel(provider, modelId)` in `lib/model-registry.ts` (the single `provider_models` reader). This is now the **established pattern — any new AI-consuming route must add this gate before charging.** Live in all four AI routes: `agent/run`, `pam/message`, `prompts/structure`, and `wizard/generate` (which gates **per generation step**, since steps can use different models — the check runs inside `runStep`, routed through the existing `step_error`/fatal machinery).

### Known quirks
- **Pro-gate on BYOK save/delete** is enforced in the route, not in the UI — UI may let a free user click "save" and get a 403.
- **`components/ui/`** is deliberately sparse (7 primitives). Don't auto-install shadcn components on a whim.
- **`.agents/skills/`** folder exists but is empty — legacy scaffolding, safe to ignore.
- **`CHANGELOG.md` mentions an `.auto-memory/` directory** from a prior memory pass (2026-04-16). It is **not** present on disk — this `CLAUDE.md` replaces it.

### Open issues (known, unresolved)
- **`app/api/team/respond/route.ts` is written but held uncommitted.** The invitee accept/decline UI doesn't exist, and there is **no automatic pending→accepted conversion** on signup (no DB trigger, no signup-flow claim). A `pending` invite (issued to a not-yet-registered email) currently has **no working resolution path** except the head manually re-inviting after the person signs up — which leaves a stale pending row.
- **`wizard/generate` discards `deductCost`'s result.** The per-step `try { await deductCost(...) } catch {}` throws the return value away, so its **balance** check is unenforced (a free user with insufficient coins on a free model still generates). The **tier** dimension is now covered by the `canUseModel` gate (fixed); the balance-discard remains open.

---

## 13. How to use this memory

When the user asks me to do something, I should:

1. **Locate the feature** in §4 (UI), §5 (API), §6 (lib), or §8 (DB).
2. **Check §12 for gotchas** that touch the area — especially auth, economy, streaming, migrations.
3. **Open only the files I actually need to change** — don't re-scan the whole repo.
4. **If reality disagrees with this file,** update the relevant section before finishing the task. A stale memory is worse than none.
5. **When a significant change ships,** append a one-line entry to `CHANGELOG.md` in the repo (the project already uses `## [DATE] — [TYPE]: [desc]` format; types are `FIX | FEAT | REFACTOR | PERF | CHORE | REBUILD`).
