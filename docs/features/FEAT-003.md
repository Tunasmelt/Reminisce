# FEAT-003 — AI route migration

## Intent
Move every AI-consuming route onto the Gemini client without changing what users see.

## REQs
| ID | Requirement | COMP |
|---|---|---|
| REQ-009 | Wizard chat, wizard generate, PAM message, PAM summarise, agent run and prompt structure routes call only the Gemini client. | COMP-04 |
| REQ-010 | Each route resolves a Model tier, runs `canUseModel`, then deducts the Wallet before the call. | COMP-04 |
| REQ-011 | The keys routes accept only Gemini BYOK keys and `/api/keys/models` lists Model tiers from `config/models.ts`. | COMP-04 |
| REQ-012 | Existing SSE event shapes, including `model_switched`, are unchanged. | COMP-04 |

## Acceptance
- REQ-009.a: No route file imports `lib/ai-client` or any provider SDK.
- REQ-010.a: A request that fails `canUseModel` returns before the Wallet is touched.
- REQ-011.a: Saving a BYOK key for any provider other than Gemini returns 400.
- REQ-011.b: The models endpoint returns exactly the three Model tiers with their Wallet currency.
- REQ-012.a: A wizard generate stream still emits the same event names as before the rework.

## Edge cases
- EC-1: A banned user is rejected before any Gemini call.
- EC-2: A `viewer` role is rejected on write routes.

## Issues

## Paths
- app/api/wizard/chat/route.ts
- app/api/wizard/generate/route.ts
- app/api/pam/message/route.ts
- app/api/pam/summarise/route.ts
- app/api/agent/run/route.ts
- app/api/prompts/structure/route.ts
- app/api/keys/save/route.ts
- app/api/keys/models/route.ts
- tests/acceptance/feat-003.test.ts (planned)

## Open questions
- none
