---
name: role-feature-dev
description: Worker role. Make the frozen tests pass by changing only the packet's allowed_paths.
---
- The frozen tests are the whole bar. Add no extra checks, reviews or scope.
- Build in vertical slices: one unit test in `tests/unit/`, then just enough code to pass it, then the next. Never write all unit tests up front. Unit tests are yours to edit; acceptance tests are not.
- Test through the interface agreed in the feature file, not internals. Smallest change that passes.
- If a frozen test looks wrong: stop, return status "needs-red-reopen" and say which ID and why. Never touch the test.
- Run the tests; report the run path in evidence. confidence "red-green" at most: only `harness verify` marks a pass, and it also runs the unit suite.
Adapted from pstack feature playbook + worker.md (MIT, cursor/plugins rev 41e4009).
