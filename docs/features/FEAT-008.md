# FEAT-008 — Cleanup and known bugs

## Intent
Remove dead code and fix known bugs left over from the old layer.

## REQs
| ID | Requirement | COMP |
|---|---|---|
| REQ-029 | Dead dependencies, provider env vars, `ALLOWED_PROVIDERS` and the migrations archive folder are removed, and `@google/genai` is added. | COMP-12 |
| REQ-030 | Wizard generate enforces the result of the Wallet deduction before each step. | COMP-10 |
| REQ-031 | The BYOK Pro gate is also enforced in the UI. | COMP-04 |
| REQ-032 | A pending team invite becomes accepted when the invited email signs up, and an invitee can accept or decline. | COMP-11 |
| REQ-033 | The sweep leaves lint, type-check and build passing with no unused files. | COMP-12 |

## Acceptance
- REQ-029.a: `package.json` has no `@anthropic-ai/sdk` and has `@google/genai`.
- REQ-029.b: No source file reads a provider env var other than the Gemini key.
- REQ-030.a: A `free` Plan user with an insufficient Wallet balance cannot start generation.
- REQ-031.a: A `free` Plan user sees the BYOK save control disabled with an upgrade hint.
- REQ-032.a: Inviting an unregistered email then signing up yields an accepted membership.
- REQ-032.b: An invitee can decline, and the member row reflects it.
- REQ-033.a: Lint, type-check and build all exit 0.

## Edge cases
- EC-1: The 8-member cap still blocks a pending-to-accepted conversion that would exceed it.
- EC-2: Re-inviting an existing member does not create a duplicate row.

## Issues

## Paths
- package.json
- lib/constants.ts
- lib/wallet.ts
- app/api/wizard/generate/route.ts
- app/api/team/respond/route.ts (planned)
- app/dashboard/projects/[id]/settings/page.tsx
- tests/acceptance/feat-008.test.ts (planned)

## Open questions
- none
