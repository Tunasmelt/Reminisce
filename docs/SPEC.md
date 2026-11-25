# Reminisce Gemini rework — SPEC

## Intent
Rework Reminisce so every AI call goes through one Gemini client with a Rate guard, models come from a static config, the FileAPI is driven by a single File manifest taken from the Prompt library's markdown list, and all repo markdown and templates follow current standards. Dead provider code and known bugs are cleaned up in the same pass.

## Tech stack (fixed)
Next.js 14.2 App Router · TypeScript strict · Supabase (Postgres, RLS, pgvector, pg_trgm) · Stripe · Zustand · Tailwind 3 · `@google/genai` (new). Removed: `@anthropic-ai/sdk`, all non-Gemini provider code, OpenRouter fallback.

## Terminology
| Term | Meaning | Not to be confused with |
|---|---|---|
| Prompt library | The project's `/prompts` page and the `prompts` table | prompt list |
| Prompt template | A cross-project reusable `prompt_templates` row | template (alone) |
| File manifest | The single typed list of project markdown files (path, owner, template, prompt type) that drives the FileAPI | owned paths, file list |
| Project file | One File manifest entry, stored in `contexts` and mirrored to disk | context file, doc |
| Model tier | `lite`, `standard` or `flagship`; each maps to one Gemini model in `config/models.ts` | plan tier |
| Plan | User plan: `free` or `pro` | Model tier |
| Gemini client | The one server module that calls Gemini | AI client, provider layer |
| Rate guard | Per-user limits, shared-key limiter and 429 backoff inside the Gemini client | throttle |
| Wallet | Coins and gems balance, deducted before a Gemini call and refunded on error | credits |
| BYOK key | A user's own Gemini key; bypasses the Wallet | provider key |
| FileAPI | `lib/fsapi.ts` and `hooks/useFileSystem.ts`: browser File System Access read/write/sync of Project files | file API (generic) |

## Features
- FEAT-001 Gemini client and model config (see docs/features/FEAT-001.md)
- FEAT-002 Rate guard (see docs/features/FEAT-002.md)
- FEAT-003 AI route migration (see docs/features/FEAT-003.md)
- FEAT-004 Gemini embeddings (see docs/features/FEAT-004.md)
- FEAT-005 Forward migration 0040 (see docs/features/FEAT-005.md)
- FEAT-006 File manifest and FileAPI (see docs/features/FEAT-006.md)
- FEAT-007 Markdown and template rework (see docs/features/FEAT-007.md)
- FEAT-008 Cleanup and known bugs (see docs/features/FEAT-008.md)

## Non-goals
- No Next.js or React upgrade.
- No other providers and no OpenRouter fallback.
- No Stripe pricing change.
- No UI redesign.
- No change to the SSE protocol.
