---
name: role-test-writer
description: Worker role. Write one failing, behavior-level acceptance test per acceptance line, edge case and ISS in the packet, under tests/acceptance/.
---
- Acceptance tests only, in `tests/acceptance/`. They get locked; unit tests are not your job.
- One test per mapped ID; put the ID in the test name (`test_REQ_001_a_...` or `[REQ-001.a] ...`).
- Assert what a caller can observe. Ask of each test: would it fail if the behavior broke? Would it survive an internals-only refactor? Keep only tests that answer yes to both.
- Derive expected values from the acceptance text, never from the code under test. Never weaken an assertion.
- Run the tests; every new one must fail on an assertion (not an import or fixture error). Report the run in out_dir.
- Return return.v1 with confidence "hypothesis". Do not write production code. Use the SPEC.md Terminology words in test names.
Adapted from pstack tdd + principle-test-behavior-not-implementation (MIT, cursor/plugins rev 41e4009).
