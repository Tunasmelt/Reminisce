// PreToolUse Edit|Write|MultiEdit|NotebookEdit — prevention for file tools.
import { readInput, root, loadConfig, loadState, rel, matchAny, frozenIndex, deny, allow, logHit, git, activePacket, isWorker } from './lib.mjs';
import { parseFeature } from '../harness/features.mjs';

const input = readInput();
const r = root(input);
const cfg = loadConfig(r);
const ti = input.tool_input || {};
const p = rel(r, ti.file_path || ti.notebook_path);
if (!p || p.startsWith('..')) allow();

const state = loadState(r);
const fix = (rule, msg) => { logHit(r, rule, p); deny(`[harness ${rule}] ${msg}`); };

// 1. Guarded paths. A worker may write only inside its own out_dir.
if (matchAny(p, cfg.guarded)) {
  const pk = isWorker(input) ? activePacket(r, state) : null;
  if (!(pk && p.startsWith(pk.out_dir))) fix('R-guarded', `${p} is a guarded path (hooks, config, harness state). Only the harness CLI or a human edits it.`);
}

// 2. Frozen tests, fixtures and runner config.
const fz = frozenIndex(r, state)[p];
if (fz) fix('R-frozen', `${p} is frozen in ${fz.feature} (${state.features[fz.feature].state}). A wrong test means: stop, return status "needs-red-reopen" and name the ISS.`);

// 3. A feature in state "invalid" accepts no work until restored.
for (const [fid, f] of Object.entries(state.features)) {
  if (f.state !== 'invalid') continue;
  try {
    if (parseFeature(r, fid).paths.some(x => x.path === p)) fix('R-invalid', `${fid} is invalid (frozen set was changed). Run: node .claude/harness/harness.mjs restore ${fid}`);
  } catch {}
}

// 4. Branch guard: no code edits on a protected branch.
const branch = git(r, ['branch', '--show-current']);
if ((cfg.protected_branches || []).includes(branch) && !matchAny(p, cfg.docs_globs || ['docs/**', '*.md'])) {
  fix('R-branch', `code edit on protected branch ${branch}. Run: git switch -c feat/<name>`);
}

// 5. Secrets in new content.
const content = [ti.content, ti.new_string, ...(ti.edits || []).map(e => e.new_string)].filter(Boolean).join('\n');
for (const [name, re] of Object.entries(cfg.secret_patterns || {})) {
  if (new RegExp(re).test(content)) fix('R-secret', `content matches secret pattern "${name}". Use an env var and add a placeholder to .env.example.`);
}
allow();
