# FEAT-001 — Gemini client and model config

## Intent
One Gemini client and a static model config replace the ten-provider layer.

## REQs
| ID | Requirement | COMP |
|---|---|---|
| REQ-001 | `config/models.ts` defines exactly three Model tiers: lite (gemini-3.5-flash-lite), standard (gemini-3.8-flash), flagship (gemini-4-argon), each with cost currency, token caps and limits. | COMP-02 |
| REQ-002 | The Gemini client is the only module that imports `@google/genai` for generation and supports streaming and non-streaming calls. | COMP-01 |
| REQ-003 | The Gemini client resolves the key as the user's BYOK key first, else the server key; a BYOK call skips the Wallet. | COMP-01 |
| REQ-004 | `canUseModel` allows flagship only on the `pro` Plan or with a BYOK key, and rejects unknown tiers. | COMP-02 |

## Acceptance
- REQ-001.a: Importing the config yields three tiers keyed lite, standard, flagship and no other entry.
- REQ-002.a: A repo-wide search finds no import of any other AI SDK and no direct Gemini import outside the Gemini client.
- REQ-002.b: A streaming call yields text chunks in order and a final usage record.
- REQ-003.a: With a BYOK key saved, the call uses that key and no Wallet deduction occurs.
- REQ-003.b: Without a BYOK key, the server key is used and the Wallet is deducted before the call.
- REQ-004.a: A `free` Plan user requesting flagship without BYOK gets a 403.
- REQ-004.b: A request for an unknown tier gets a 400.

## Edge cases
- EC-1: Server key missing and no BYOK key returns a clear configuration error, not a crash.
- EC-2: A Gemini error after Wallet deduction triggers a refund.

## Issues

## Paths
- config/models.ts (planned)
- lib/gemini/client.ts (planned)
- lib/model-permissions.ts
- tests/acceptance/feat-001.test.ts (planned)

## Open questions
- none
