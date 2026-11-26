# Reminisce

OpenRouter remains the project standard for server-side AI calls. The Gemini rework in `docs/SPEC.md` is a draft proposal. Wait for approval and an update to the project instructions before starting its phases.

Map, not manual. Read `docs/HANDOFF.md` with the Read tool at session start; never @-import it.

## Rules (each with its check)
| Rule | Check |
|---|---|
| No code edits on the default branch | hook: edit_guard R-branch |
| Never edit hooks, harness config, `.harness/` state | hook: edit_guard R-guarded, bash_guard |
| Acceptance tests (`tests/acceptance/**`) are frozen after red; a wrong one → return `needs-red-reopen` + ISS | hook: edit_guard R-frozen, bash_guard R-bash-detect |
| Unit tests (`tests/unit/**`): one test, then just enough code, one slice at a time, through agreed interfaces; editable; must be green at verify | runner: `harness verify` (unit suite) + review |
| Use only the words in SPEC.md Terminology | review |
| Workers stay inside packet `allowed_tools` / `allowed_paths` | hook: scope |
| One worker at a time, only after `/brief` | hook: packet R-lock |
| Worker returns one `return.v1` JSON ≤ 2 KB | hook: packet R-return |
| Only the harness CLI marks pass; never claim "done" from your own run | runner: `harness verify` |
| No secrets in files | hook: edit_guard R-secret |
| Prove it on the real artifact; label confidence hypothesis / red-green / run-checked | review |
| Same mistake twice → propose a check, not a sentence | review (/retro) |

## Claude Responses
When reporting to me, be extremely concise, load-bearing words only. Priorities: user understanding > concision > grammar. Directive not recap → never padding. Split-second read. Do not compromise on meaning. Presenting data: use tables.
End with: *DO THIS* block → concrete next actions for user, numbered, priority-first. Spell out reply options on decisions. Omit only when no user action.

## Docs map
| Need | Read |
|---|---|
| Stack, components, allowed imports | `docs/ARCHITECTURE.md` |
| One feature: intent, REQs, acceptance, edge cases, issues, Paths | `docs/features/FEAT-NNN.md` |
| Why | `docs/DECISIONS.md` |
| Feature sets by phase | `docs/PHASES.md` |
| What changed | `docs/CHANGELOG.md` |
| Intent, stack, terminology, non-goals | `docs/SPEC.md` |

## Commands
`node .claude/harness/harness.mjs analyze | brief FEAT role | record-red FEAT | freeze FEAT | verify FEAT | reopen-red FEAT --iss ISS-N --reason ".." --confirm | restore FEAT | accept FEAT | status`

`analyze` and `status` run with Node alone. The red and verify commands require Vitest installed locally and the mapped test files. The kickoff includes the spec and harness, and leaves test setup and implementation to the approved phases.
