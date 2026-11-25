# FEAT-002 — Rate guard

## Intent
Keep the shared Gemini key and each user inside quota, and degrade gracefully on 429.

## REQs
| ID | Requirement | COMP |
|---|---|---|
| REQ-005 | The Rate guard enforces per-user RPM and RPD by Plan and Model tier, counted in `rate_events`. | COMP-03 |
| REQ-006 | The Rate guard limits the shared server key by RPM, TPM and RPD using values from `config/models.ts`, each overridable by environment variable. | COMP-03 |
| REQ-007 | On a Gemini 429 the Rate guard waits for `Retry-After` (else jittered exponential backoff), retries up to a cap, then falls to the next lower Model tier. | COMP-03 |
| REQ-008 | When every attempt is exhausted the caller receives a typed rate-limit error with a retry-after value, and the Wallet is refunded. | COMP-03 |

## Acceptance
- REQ-005.a: A user exceeding their RPM gets a rate-limit error before any Gemini call is made.
- REQ-005.b: A `pro` Plan user has higher limits than a `free` Plan user for the same Model tier.
- REQ-006.a: When the shared key limiter is full, further calls wait or are rejected without calling Gemini.
- REQ-006.b: Setting an environment override changes the enforced limit.
- REQ-007.a: A 429 with `Retry-After` delays the retry by at least that value.
- REQ-007.b: After the retry cap on standard, the call is attempted on lite and the SSE stream emits `model_switched`.
- REQ-008.a: When all tiers fail with 429, the error includes retry-after and the Wallet balance is unchanged.

## Edge cases
- EC-1: Daily counters reset at midnight Pacific to match Gemini's quota reset.
- EC-2: Two concurrent calls cannot both pass a limit with one slot left.
- EC-3: A BYOK call is exempt from the shared key limiter but still obeys per-user limits.

## Issues

## Paths
- lib/gemini/rate-guard.ts (planned)
- config/models.ts (planned)
- supabase/migrations/0000000000040_gemini_only.sql (planned)
- tests/acceptance/feat-002.test.ts (planned)

## Open questions
- none
