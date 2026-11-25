# FEAT-005 — Forward migration 0040

## Intent
Move live databases to the Gemini-only schema safely and repeatably.

## REQs
| ID | Requirement | COMP |
|---|---|---|
| REQ-016 | Migration 0040 is idempotent and drops `provider_models`, keeping `rate_events`. | COMP-06 |
| REQ-017 | Migration 0040 deletes every `user_api_keys` row whose provider is not `gemini`. | COMP-06 |
| REQ-018 | Migration 0040 remaps stored model ids on `prompts` and `agent_runs` to Model tiers. | COMP-06 |
| REQ-019 | Migration 0040 sets all `memory_chunks.embedding` to NULL. | COMP-06 |
| REQ-020 | The admin model CRUD routes and UI are removed; the reset schema file matches the post-migration schema. | COMP-06 |

## Acceptance
- REQ-016.a: Running the migration twice succeeds and leaves the same schema.
- REQ-017.a: After migration only `gemini` rows remain in `user_api_keys`.
- REQ-018.a: No `prompts` or `agent_runs` row holds a non-tier model id.
- REQ-019.a: After migration every `memory_chunks.embedding` is NULL.
- REQ-020.a: `app/api/admin/models` no longer exists and admin pages build without it.
- REQ-020.b: A cold install from the reset file equals a migrated database in tables and columns.

## Edge cases
- EC-1: A user whose only BYOK key was removed still uses the Wallet normally.
- EC-2: Admin audit logs for past model edits are kept.

## Issues

## Paths
- supabase/migrations/0000000000040_gemini_only.sql (planned)
- supabase/migrations/00000000000099_complete_reset_schema.sql
- app/api/admin/models/route.ts
- components/admin/models.tsx
- tests/acceptance/feat-005.test.ts (planned)

## Open questions
- none
