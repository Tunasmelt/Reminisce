# FEAT-004 — Gemini embeddings

## Intent
Replace OpenAI embeddings so no non-Gemini key is needed for PAM memory.

## REQs
| ID | Requirement | COMP |
|---|---|---|
| REQ-013 | `generateEmbedding` calls a Gemini embedding model requesting 1536 dimensions. | COMP-05 |
| REQ-014 | Chunks with a NULL embedding are re-indexed lazily on next project-memory access. | COMP-05 |
| REQ-015 | With no server key and no BYOK key, `searchMemory` falls back to text search. | COMP-05 |

## Acceptance
- REQ-013.a: A returned embedding has length 1536.
- REQ-013.b: No code path calls OpenAI.
- REQ-014.a: After migration, searching a project re-embeds its NULL chunks and later searches use vectors.
- REQ-015.a: With no key available, `searchMemory` returns text matches instead of throwing.

## Edge cases
- EC-1: An embedding failure leaves the chunk NULL and does not fail the surrounding request.
- EC-2: Embedding calls go through the Rate guard.

## Issues

## Paths
- lib/vector-memory.ts
- tests/acceptance/feat-004.test.ts (planned)

## Open questions
- none
