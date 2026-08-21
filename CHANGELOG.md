# Reminisce v2 — Changelog

All changes, fixes, and additions are logged here. Most recent entries at the top.

Format:
```
## [DATE] — [TYPE]: [Short description]
- What changed and why
- Files modified
```

Types: `FIX` | `FEAT` | `REFACTOR` | `PERF` | `CHORE` | `REBUILD`

---

## [2026-04-25] — FEAT: Import Existing Project feature
- `lib/project-scanner.ts` (NEW): deterministic static analysis engine. Parses package.json, README, .env.example, Next.js App Router pages + API routes, Express routes, Prisma/Drizzle/Supabase migrations, auth providers. Detects tech stack from deps + file tree. Outputs typed `ScanResult` + `RawFeature[]`. No AI.
- `lib/phase-grouper.ts` (NEW): rules-based phase assignment. Buckets raw features into Authentication, Data Layer, API Layer, Frontend, Integrations, Testing phases using keyword + type scoring. Returns ordered `ScannedPhase[]`.
- `app/api/import/scan/route.ts` (NEW): `POST /api/import/scan` — server-side GitHub scanner. Fetches file tree via `GET /repos/.../git/trees/HEAD?recursive=1`, fetches key files in parallel batches of 8, runs same parsers as client-side scanner. Accepts optional PAT for private repos. Returns `ScanResult`.
- `app/api/import/create/route.ts` (NEW): `POST /api/import/create` — creates project + phases + features + optional context files (architecture.md, tech-stack.md) from a confirmed `ScanResult`. Enforces plan limits. Belt-and-suspenders `project_members` upsert.
- `app/dashboard/import/page.tsx` (NEW): 3-step import wizard. Step 1: source picker (local folder via FS API or GitHub URL + optional PAT). Step 2: full review/edit UI — rename project, edit/delete/add features, confidence badges, type chips. Step 3: workspace selector, context file toggle, create button.
- `supabase/migrations/0000000000028_import_feature.sql` (NEW): adds `'import'` to `created_via` CHECK; adds nullable `scan_source` column (`local | github`) to `projects`.
- `00000000000099_complete_reset_schema.sql`: updated `created_via` to include `'import'`; added `scan_source` column to projects.
- `app/dashboard/page.tsx`: added `IMPORTED` badge on project cards; added "Import existing" dashed card in project grid → `/dashboard/import`.
- `app/dashboard/projects/[id]/page.tsx`: added `IMPORTED` indigo badge next to project name header.

## [2026-04-25] — FIX: Schema review — codebase remnants, agent_runs RLS, missing indexes + constraints
- `00000000000099_complete_reset_schema.sql`: removed `codebase_sessions` table, `is_codebase`/`codebase_source`/`codebase_imported_at` columns from `projects`, `codebase_session_id`/`blueprint_source` columns from `wizard_sessions`, associated index and RLS policy; removed `'codebase'` from `created_via` CHECK and `memory_chunks.source_type` CHECK; fixed `agent_runs_all` RLS to allow accepted project members (was owner-only); added `UNIQUE(project_id, name)` on `phases`, `UNIQUE(project_id, phase_id, name)` on `features`, `UNIQUE(project_id, file_path)` on `contexts` (from migration 0021); added `idx_pam_threads_archived`, `idx_prompts_master`, `idx_project_members_invite_email` performance indexes; added partial unique index `idx_project_members_pending_email_unique` on `(project_id, invite_email) WHERE invite_status='pending'`
- `0000000000027_schema_fixes.sql` (NEW): additive migration for existing deployments — applies all of the above that can be done idempotently on a live DB (unique index, performance indexes, source_type check fix, agent_runs RLS fix, uniqueness constraints via DO $$ block)
- Updated `CLAUDE.md`: table count 25→24, migration tail 0025→0027, corrected agent_runs RLS note, added wallet TOCTOU race condition gotcha

## [2026-04-21] — FIX: Code review — team API correctness + settings hardening
- `members/route.ts`: replaced `sb: any` with `ServiceClient = ReturnType<typeof getServiceSupabase>` in resolveIsHead; switched `.single()` → `.maybeSingle()` (no more throw on 0 rows); PATCH now returns 404 when member not found instead of silent ok:true
- `invite/route.ts`: block re-invite of declined users (was silently overwriting); block duplicate pending invites to same email (was causing respond route crash); switched unguarded .single() calls to .maybeSingle(); fixed misleading "7 members + head" error message
- `respond/route.ts`: null-guard on email before use; replaced .single() with array query — multiple pending rows no longer crash with 500; update payload no longer sets user_id = null on decline
- `settings/page.tsx`: init() wrapped in try/catch with setLoading(false) in finally — page no longer hangs forever on any network failure; .ok checks on all fetch calls; plan value validated before cast (no unsafe as); per-provider saving state (savingProvider) locks all key inputs during a save/delete; handleUpdateProject has loading/disabled state; supabase.from('user_plans').single() → .maybeSingle()

## [2026-04-21] — FEAT: Team management UI + API fixes
- Added Team tab to settings page: member list with avatar initials, role badges, pending/accepted status, joined date; invite form with role selector; remove button (handles both accepted and pending); role-change dropdown for non-head members; 8-member cap indicator; empty state; loading states
- Fixed `GET /api/team/members` email lookup — was limited to first 100 Supabase users; now uses paginated scan (same pattern as invite route)
- Fixed `DELETE /api/team/members` — now accepts `memberId` param for pending invites (which have `user_id = null`); previously impossible to cancel a pending invite
- Added `PATCH /api/team/members` — new endpoint to change an accepted member's role (head-only, cannot change own role)
- Extracted `resolveIsHead()` shared helper in members route to eliminate code duplication
- Settings page project fetch and head-check now use service-role API endpoints instead of direct Supabase client calls (eliminates RLS edge cases)
- Settings page delete project now calls `DELETE /api/projects/:id` instead of direct Supabase client delete
- Settings page `authHeader` derived once from session and threaded through all API calls

## [2026-04-21] — REFACTOR: Remove codebase ingestion feature entirely
- Deleted `app/api/codebase/ingest/route.ts`, `app/api/codebase/session/route.ts`, `app/dashboard/projects/[id]/codebase/page.tsx`, `lib/codebase-sampler.ts`, `lib/codebase-prompts.ts`
- Removed Codebase nav tab from `app/dashboard/projects/[id]/layout.tsx`
- Stripped all codebase UI, state, and handlers from `app/dashboard/page.tsx`
- Removed `hasCodebaseAnalysis` context from `app/api/pam/message/route.ts`
- Updated landing page, capabilities page, and docs page to remove all codebase copy and sections
- Added migration `0000000000026_remove_codebase.sql` to drop `codebase_sessions` table and codebase columns from `projects` + `wizard_sessions`
- Updated `CLAUDE.md` to reflect removed routes, lib files, and DB tables
- Fixed ghost-project visibility: projects now fetched via service-role API (`GET /api/projects`), `POST /api/projects/repair` heals orphaned `project_members` rows on every dashboard load
- Added `GET /api/projects/[id]` service-role endpoint to fix "query failure" on project detail page

## [2026-04-16] — CHORE: Semantic memory + changelog system created
- Created `.auto-memory/` directory with full semantic memory of the codebase
- Memory files: vision, architecture map, current state, AI client reference, API routes reference, code conventions, user profile
- Created `MEMORY.md` index loaded automatically each session
- Created this CHANGELOG.md for tracking all future changes
- Files created: `.auto-memory/MEMORY.md`, `.auto-memory/project_reminisce_vision.md`, `.auto-memory/project_architecture_map.md`, `.auto-memory/project_state.md`, `.auto-memory/reference_ai_client.md`, `.auto-memory/reference_api_routes.md`, `.auto-memory/feedback_conventions.md`, `.auto-memory/user_profile.md`

---

## [2026-04-16] — REBUILD: Codebase feature — rate-limit-proof, full UI overhaul

### lib/codebase-sampler.ts
- Raised token budget from 8K → 12K, max file size 50K → 60K, max files 80 → 90
- Replaced `fetchWithBackoff` (1 retry, fixed 2s) with full retry logic that reads `Retry-After` / `x-ratelimit-reset` headers and caps wait at 30s
- Parallelised GitHub file content fetching with `fetchConcurrent()` (6 concurrent), was serial — 3-4x speed improvement on large repos
- Fixed `mergeSourceResults` — replaced O(n) character-by-character similarity with sampled fast-similarity
- Fixed all `MapIterator` spread errors (`Array.from()`) for strict TS target
- Added 6 new languages to `detectPrimaryLanguage()` (Swift, Kotlin, Dart)
- Expanded `detectStackFromContent()` to 25+ libraries (tRPC, Zustand, Drizzle, Socket.IO, etc.)
- Added more `SKIP_DIRS` (.svn, bower_components, etc.) and `SKIP_EXTENSIONS` (.pyc, .otf, etc.)
- PAT-based ingestion unified into `ingestFromGitHub` via optional `pat` parameter

### lib/codebase-prompts.ts
- **Decomposition maxTokens: 5000 → 3500** — was causing 413 errors on Groq/Cerebras free tier
- **Context files maxTokens: 4000 → 3000** — same fix
- Rewrote all 4 system prompts to be more directive (explicit JSON-only instruction, token caps stated)
- Comprehension maxTokens: 2500 → 2000 (safe for all providers)
- Gap analysis maxTokens: 1500 → 1200
- Decomposition prompt now includes feature counts from comprehension to guide output size
- Context files prompt includes actual built/planned feature lists for specificity
- Added `sourceType: 'both'` to `CodebaseContext` type

### app/api/codebase/ingest/route.ts
- Replaced 3-model free cascade with 4-model cascade (groq → cerebras → openrouter → sambanova)
- Added Pro cascade: claude-sonnet → claude-haiku → gemini-2.0-flash
- Extracted `callAIWithWallet()` outside POST handler — cleaner, testable, now includes 90s timeout per AI call
- Extracted `runPassWithCascade()` — unified cascade logic: rate limit/timeout = next model, parse fail = retry same model with stricter instruction, context overrun = skip this model
- Added `estimatePromptTokens()` per-model guard — skips models where prompt > 90% of their context limit
- Fixed `handleAICall` to refund on ALL errors, not just parse errors
- `parseJSONResponse()` extracted as pure function with 2-stage lenient fallback (trailing commas, control chars)
- Added `model_switched` SSE event so UI can notify user without crashing
- Added `progress` SSE event type for future use
- Added `X-Accel-Buffering: no` response header to prevent Nginx buffering on Vercel
- Added `classifyError()` to emit machine-readable `code` field with error events
- `saveBlueprint()` properly handles empty phases array without crashing
- PAM indexing moved to background `indexForPAM()` — fully fire-and-forget

### app/dashboard/projects/[id]/codebase/page.tsx
- **Fixed SSE parser** — was `chunk.split('\n\n')` which broke on chunked TCP delivery. Now uses persistent buffer (`sseBufferRef`) that only processes complete `\n\n`-terminated messages
- **Fixed `gap?.missingFeatures` rendering** — was `{m}` on objects → `[object Object]`. Now renders `m.name`, `m.description`, `m.priority` correctly with `<PriorityDot>` component
- Added `<ProgressBar>` showing 0-100% based on completed passes count
- Added `analysisError` banner with retry button that takes user back to source picker
- Added URL validation with real-time error message (`isValidGitHubUrl()`)
- Unlocked Private Repo (PAT) card for all users — Pro-gate can be added separately if needed
- Added `model_switched` handling — shows inline notice + `toast.info`
- Added `conflict_detected` handling — shows inline warning during analysis
- Added `largeRepo` indicator in analyzing view subtitle
- Added `<StatusBadge>` and `<PriorityDot>` sub-components — clean, reusable
- Added `<SourceCard>` sub-component — removes repeated inline style blocks
- Results view: added detected stack tags, feature description text, re-analyze header with repo URL
- Results view: navigation buttons for Kanban board and Wizard
- Results view: context files list shows green checkmarks
- Added TypeScript types for all SSE event payloads
- `pollForCompletion()` has a 120-attempt (6 min) ceiling to prevent infinite polling

## [2026-04-16] — FIX: Ghost project limit + delete projects + Resume Analysis UI

### Root cause
Projects created via service role had `auth.uid() = NULL` in the `on_project_created` DB trigger, producing orphaned `project_members` rows. RLS `SELECT` on `projects` requires a member row — so these projects were invisible to the client but still counted against the free-tier limit, locking users out.

### app/api/projects/route.ts
- After inserting a project, explicitly `upsert` `{ project_id, user_id, role: 'head' }` into `project_members` using `ignoreDuplicates: true` as belt-and-suspenders (trigger may still fire for non-service-role paths)
- Non-fatal warning logged if the upsert fails (trigger may have handled it)

### app/api/projects/[id]/route.ts (NEW FILE)
- `DELETE /api/projects/:id` endpoint — verifies auth, confirms workspace ownership via inner join, then deletes project (DB cascade handles all child records: phases, features, agent_runs, project_members, codebase_sessions, kanban_columns, kanban_cards)

### app/dashboard/page.tsx
- Added `confirmDeleteProject` / `isDeletingProject` state
- Added `handleConfirmDeleteProject()` — calls `DELETE /api/projects/:id`, shows toast, refreshes
- Each project card now has a `×` delete button (top-right corner, absolute-positioned, red on hover)
- Added **Resume Analysis** button (indigo) on codebase cards with 0 phases — routes to `/dashboard/projects/:id/codebase` for retry without needing to recreate the project

### app/dashboard/projects/[id]/page.tsx
- Fixed pre-existing file truncation — `onClose` prop of `<ExportBriefModal>` was cut off mid-line

### 0 TypeScript errors confirmed after all changes

## [2026-04-16] — FIX: Projects still invisible — bypass RLS via API + auto-repair

### Root cause (deeper)
Even with the `project_members` upsert fix in POST /api/projects, **existing** orphaned
projects (created before the fix) still had no valid `project_members` row. The
client-side Supabase query (`supabase.from('projects')`) uses the anon key + user JWT,
so the `proj_select` RLS policy blocks rows with no matching accepted head row.
The workspace-owner check in `proj_select` works in theory, but conflicting older
policies from migration 20 (team_integration) which require `project_members` may
shadow it depending on the DB version.

### app/api/projects/route.ts — GET handler (NEW)
- Added `GET /api/projects` — uses service role, filters by `workspaces.owner_id = user.id`,
  also merges accepted `project_members` entries (shared projects). Returns `{ projects: [...] }`.
  RLS-proof: completely server-side, no client JWT required for the query.

### app/api/projects/repair/route.ts (NEW FILE)
- `POST /api/projects/repair` — finds all projects in user-owned workspaces that are
  missing an accepted `project_members` head row, upserts them. Idempotent.
  Fixes ALL existing orphaned projects in one call.

### app/dashboard/page.tsx — fetchData()
- Now calls `GET /api/projects` (with Authorization header) instead of direct `supabase.from('projects')`.
- If result is empty but workspaces exist: auto-calls `POST /api/projects/repair`, then
  re-fetches — transparently heals orphaned projects on first load with no user action needed.

### 0 TypeScript errors

## [2026-04-17] — FIX: "Query failure" on project detail page

### Root cause
The dashboard now uses GET /api/projects (service role) to list projects,
so they appear even when project_members rows are absent. But the project
detail page (`/dashboard/projects/[id]`) was still doing direct client-side
Supabase queries subject to RLS — causing "Query failure" and redirect back.

### app/api/projects/[id]/route.ts — GET handler (NEW)
- Added `GET /api/projects/:id` alongside the existing DELETE handler.
- Fetches project + phases + features + context_versions + hasBlueprint in
  one parallel Promise.all using service role.
- Verifies access via workspace owner_id OR accepted project_members row.
- Returns `{ project, phases, features, contextDoc, hasBlueprint }`.

### app/dashboard/projects/[id]/page.tsx — loadData()
- Now calls `GET /api/projects/:id` (Authorization header) instead of four
  separate client-side supabase queries. Zero RLS exposure.
- `project.workspaces` is returned in the payload — used for workspace-owner
  role fallback when no project_members row exists yet.

### app/dashboard/page.tsx — fetchData()
- Repair now fires unconditionally (fire-and-forget, no await), not just when
  projects list is empty. Ensures project_members rows are always in sync for
  the full client-side RLS queries on child pages.

### 0 TypeScript errors

<!-- New entries go above this line -->
