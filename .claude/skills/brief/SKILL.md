---
name: brief
description: Build and validate a worker packet for one feature and role, then spawn exactly one worker with it.
---
1. Run `node .claude/harness/harness.mjs brief <FEAT> <role> "<goal>"`. A failure is final: fix the feature file, never the packet.
2. Spawn one Agent with prompt: "Read the packet in your context. Load the role skill it names. Return return.v1 only."
3. Read only the worker's return.json and the files it lists as evidence. Never paste raw output into chat.
Adapted in part from pstack worker.md (MIT, cursor/plugins rev 41e4009).
