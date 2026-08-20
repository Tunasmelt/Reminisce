# Plan: Import Existing Projects into Reminisce

> Saved 2026-04-21. Ready to implement when needed.

## Philosophy

The previous codebase feature leaned on AI for everything — 5 AI passes just to understand a repo. This design inverts that: a deterministic engine extracts 90% of what we need from files that already encode the truth (manifests, routes, schemas, git history). AI only touches the final 10% — polishing descriptions and filling gaps the engine can't infer — and only if the user opts in.

---

## The User Flow

```
Dashboard → "Add Existing Project" → Source picker
  → [Scan runs, ~2s] → Review & edit extracted data
  → Confirm → Project created with board/graph/context wired up
```

---

## Component Breakdown

### 1. `lib/project-scanner.ts` — Static Analysis Engine

Pure TypeScript, no AI, runs entirely client-side via the File System Access API (for local) or raw GitHub API (for public repos). Outputs a typed `ScanResult`.

**What it extracts:**

| Signal | Source files |
|---|---|
| Project name | `package.json`, `pyproject.toml`, `Cargo.toml`, directory name |
| Description | README first paragraph, `package.json` description |
| Tech stack | All manifest files — framework, language, key deps |
| Framework | Detects Next.js, Express, Django, Rails, Laravel, Go, Rust, etc. by file patterns |
| Routes / endpoints | `app/`, `pages/`, `routes/`, `views/`, `controllers/` — framework-specific parsers |
| DB models / schemas | `prisma/schema.prisma`, `models/`, `migrations/`, Django `models.py` |
| Components / UI | `components/`, `src/components/` — grouped by subdirectory |
| Git state | `.git/HEAD`, `.git/logs/HEAD` — branch, last commit, author, n days since last activity |
| Env hints | `.env.example` — reveals integrations (Stripe, Supabase, AWS, etc.) |

**How features are inferred from routes (example):**

```
GET  /api/users        → Feature: "User list"        (phase: API)
POST /api/users        → Feature: "User creation"    (phase: API)
/auth/login            → Feature: "Authentication"   (phase: Auth)
/dashboard/[id]        → Feature: "Project detail"   (phase: Frontend)
```

Each extracted feature gets: `name`, `description` (template-filled), `status` (set to `in_progress`), `confidence` (high/medium/low), and a `source` label so the user can see how it was found.

---

### 2. `lib/phase-grouper.ts` — Rules-Based Phase Assignment

Extracted features are bucketed into phases using keyword matching and path analysis — no AI:

```
Routes under /api/*          → Phase: "API Layer"
Auth-related paths           → Phase: "Authentication"
DB models / migrations       → Phase: "Data Layer"
Components / pages           → Phase: "Frontend"
Env vars (Stripe, etc.)      → Phase: "Integrations"
Test files                   → Phase: "Testing"
```

Order is inferred by coupling (data layer → API → frontend) and commit recency.

---

### 3. `app/dashboard/import/page.tsx` — Import Wizard (3 steps)

Lives at `/dashboard/import` (before a project exists), not inside a project.

**Step 1 — Source**
- Local folder via File System Access API (button)
- GitHub public URL (text input)
- Both (merge)

**Step 2 — Scan & Review** (main screen)
- Project name + description (editable)
- Detected tech stack chips (can remove)
- Phases table — each phase collapsible, features listed inside with `confidence` badge
- Features: rename, re-phase, mark as `complete` / `in_progress` / `planned`, or delete
- "Detected from: package.json routes" annotation on each item
- Summary card: X phases, Y features, Z files scanned, last commit N days ago

No AI call happens here. The page is fully interactive and instant.

**Step 3 — Options**
- Workspace selector
- Toggle: "Generate context files from scan data" (writes `architecture.md`, `tech-stack.md` — no AI, template-filled)
- Toggle: "Ask PAM to enrich descriptions after import" (optional one-time AI pass — coins deducted, cheapest model, user opt-in)
- Create button

---

### 4. `app/api/import/scan/route.ts` — GitHub scanning endpoint

For local scans, everything runs client-side. For GitHub repos (CORS), this route:
- Accepts a GitHub URL
- Fetches file tree via `GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1`
- Fetches key files (package.json, README, routes) in parallel
- Returns same `ScanResult` shape as client-side scanner
- Rate-limit safe: fetching specific known files, not sampling randomly

No AI. Just GitHub API + our parsers.

---

### 5. `app/api/import/create/route.ts` — Project creation from scan result

Accepts confirmed `ScanResult` + options, creates:
- Project row (`created_via: 'import'`)
- Phase rows (in order)
- Feature rows (with `status` from scan)
- Graph nodes (auto-layout via existing graph logic)
- Context files: `architecture.md`, `tech-stack.md` — template-filled from scan data
- `project_members` head row (belt-and-suspenders)
- If PAM enrichment opted in: queues one-time PAM message — fire and forget

---

### 6. Dashboard integration

- "Add Existing" button → `/dashboard/import`
- Imported projects show `IMPORTED` badge on dashboard
- Project detail shows "Scan was done X days ago — re-scan?" nudge if stale

---

## DB changes

Migration `0000000000027_import_feature.sql`:
- Add `'import'` to `created_via` check constraint on `projects`
- Add `scan_source` column (`github | local | both`) to `projects` — nullable
- No new tables needed

---

## AI usage breakdown

| Step | AI? | Why |
|---|---|---|
| File tree scan | No | Pure FS/GitHub API |
| Tech stack detection | No | Manifest file parsing |
| Route / model extraction | No | Framework-specific pattern matching |
| Phase assignment | No | Keyword rules |
| Context file generation | No | Template-filled from scan data |
| Feature description enrichment | Optional | One PAM call, cheapest model, user opt-in |

---

## Files to create/edit

**New:**
- `lib/project-scanner.ts`
- `lib/phase-grouper.ts`
- `app/dashboard/import/page.tsx`
- `app/api/import/scan/route.ts`
- `app/api/import/create/route.ts`
- `supabase/migrations/0000000000027_import_feature.sql`

**Edit:**
- `app/dashboard/page.tsx` — "Add Existing" button
- `app/dashboard/projects/[id]/page.tsx` — imported project badge + re-scan nudge
- `CLAUDE.md` — document new routes and lib files
