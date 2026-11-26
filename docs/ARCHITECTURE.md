# Architecture

Proposed architecture for the Gemini rework in `SPEC.md`.

Stack: see SPEC.md Tech stack.

| ID | Component | Allowed imports |
| --- | --- | --- |
| COMP-01 | Gemini client (lib/gemini/client.ts) | COMP-02, COMP-03, `@google/genai` |
| COMP-02 | Model config and permissions (config/models.ts, lib/model-permissions.ts) | none |
| COMP-03 | Rate guard (lib/gemini/rate-guard.ts) | COMP-02, lib/supabase |
| COMP-04 | AI routes (app/api/{wizard,pam,agent,prompts,keys}) | COMP-01, COMP-02, COMP-10, lib/supabase |
| COMP-05 | Vector memory (lib/vector-memory.ts) | COMP-01, COMP-03, lib/supabase |
| COMP-06 | Database migrations (supabase/migrations) | none |
| COMP-07 | File manifest (lib/file-manifest.ts) | none |
| COMP-08 | FileAPI (lib/fsapi.ts, hooks/useFileSystem.ts) | COMP-07 |
| COMP-09 | Docs and templates (*.md, .agents, lib/wizard-stages.ts) | COMP-07 |
| COMP-10 | Wallet (lib/wallet.ts) | COMP-02, lib/supabase |
| COMP-11 | Team (app/api/team) | lib/supabase |
| COMP-12 | Repo hygiene (package.json, lib/constants.ts, config files) | none |
