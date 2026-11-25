# FEAT-007 — Markdown and template rework

## Intent
Bring repo docs, Project file templates and Prompt templates up to current standards.

## REQs
| ID | Requirement | COMP |
|---|---|---|
| REQ-025 | Repo docs (CLAUDE.md, README, DEPLOYMENT, CHANGELOG, `.env.example`) describe the Gemini-only system with no stale references. | COMP-09 |
| REQ-026 | CLAUDE.md contains the Claude Responses block verbatim. | COMP-09 |
| REQ-027 | The `.agents` skill is a valid `SKILL.md` with name and description frontmatter and only references files that exist. | COMP-09 |
| REQ-028 | Prompt templates and wizard-generated Project files follow one current structure and are tuned for Gemini. | COMP-09 |

## Acceptance
- REQ-025.a: No repo doc mentions a removed provider, `provider_models` or OpenAI embeddings except in CHANGELOG history.
- REQ-025.b: `.env.example` lists only variables the code reads.
- REQ-026.a: CLAUDE.md contains the exact Claude Responses block.
- REQ-027.a: Every path named in the skill exists in the repo.
- REQ-028.a: Each manifest template renders with all placeholders filled and no leftover tokens.
- REQ-028.b: Prompt template output for each prompt type keeps its required sections [review]

## Edge cases
- EC-1: CHANGELOG keeps its existing history and adds a REFACTOR entry.

## Issues

## Paths
- CLAUDE.md
- README.md
- DEPLOYMENT.md
- CHANGELOG.md
- .env.example
- .agents/skills/reminisce-context/SKILL.md (planned)
- lib/wizard-stages.ts
- tests/acceptance/feat-007.test.ts (planned)

## Open questions
- none
