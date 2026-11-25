# FEAT-006 — File manifest and FileAPI

## Intent
Drive the FileAPI from one File manifest taken from the Prompt library's markdown list.

## REQs
| ID | Requirement | COMP |
|---|---|---|
| REQ-021 | A File manifest lists every project markdown file with path, owner, template and prompt type, taken from the Prompt library's existing markdown list. | COMP-07 |
| REQ-022 | The FileAPI initialises, syncs, hashes and exports only Project files named in the File manifest. | COMP-08 |
| REQ-023 | Wizard generation writes Project files at manifest paths and nowhere else. | COMP-07 |
| REQ-024 | Files outside the File manifest are ignored by sync and never overwritten. | COMP-08 |

## Acceptance
- REQ-021.a: Every manifest entry has a unique path under `reminisce/`.
- REQ-021.b: The manifest contains every path previously hardcoded in `fsapi.ts`.
- REQ-022.a: Initialising an empty folder creates exactly the manifest files.
- REQ-022.b: Adding an entry to the manifest makes sync and export include it with no other code change.
- REQ-023.a: After wizard generation, every written `contexts.file_path` is in the manifest.
- REQ-024.a: A user file in the project folder is untouched by pull and push.

## Edge cases
- EC-1: A manifest file missing on disk is recreated from its template on init, not treated as a conflict.
- EC-2: Safari and Firefox, which lack the File System Access API, degrade without errors.
- EC-3: Expired folder permission prompts for re-grant instead of failing silently.

## Issues

## Paths
- lib/file-manifest.ts (planned)
- lib/fsapi.ts
- hooks/useFileSystem.ts
- app/api/export/route.ts
- tests/acceptance/feat-006.test.ts (planned)

## Open questions
- none
