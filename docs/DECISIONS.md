# Decisions

Append-only. Supersede, never edit.

The ADRs below belong to the draft Gemini proposal in `SPEC.md` and are pending approval.

## ADR-001 — Gemini only
- Context: ten providers, per-model cascades and an OpenRouter fallback make the AI layer large and fragile.
- Decision: all generation and embeddings use Gemini. BYOK keys are Gemini-only.
- Alternatives: keep a second provider as fallback; keep OpenRouter.
- Consequences: one vendor dependency; one client, one limiter, no provider cascade.

## ADR-002 — Static model config replaces provider_models
- Context: Gemini publishes no fixed per-model limits, applies them per project and resets at midnight Pacific.
- Decision: three Model tiers live in `config/models.ts` with env-overridable limits.
- Alternatives: keep the `provider_models` table with admin CRUD; config plus DB overrides.
- Consequences: limits change by env, not admin UI; admin model CRUD is removed.

## ADR-003 — 1536-dimension Gemini embeddings
- Context: memory uses `vector(1536)` with an HNSW index built for OpenAI embeddings.
- Decision: request 1536 dimensions from Gemini so the column and index stay.
- Alternatives: native dimensions with a column migration; drop vector memory.
- Consequences: old vectors are incompatible, so migration 0040 nulls them and chunks re-index lazily.

## ADR-004 — One File manifest
- Context: Project file paths are hardcoded in `fsapi.ts`, wizard generation and export.
- Decision: a single typed manifest drives init, sync, hashing, export and wizard writes.
- Alternatives: keep per-module path lists; mirror every prompt as its own file.
- Consequences: adding a Project file is a one-line change.
