// PreToolUse + PostToolUse Bash.
// Pre: hard stops -> ask; pipe-to-shell and commands naming frozen/guarded paths -> deny (best effort); snapshot guarded files.
// Post: detect changes to frozen or guarded files -> feature "invalid" + block (detection, not prevention).
import fs from 'node:fs';
import path from 'node:path';
import { readInput, root, loadConfig, loadState, saveState, H, frozenIndex, sha256File, deny, ask, block, allow, logHit, isWorker, writeJSON, readJSON } from './lib.mjs';

const input = readInput();
const r = root(input);
const cfg = loadConfig(r);
const cmd = (input.tool_input || {}).command || '';
const event = input.hook_event_name;
const worker = isWorker(input);
const harnessCli = /\.claude\/harness\/harness\.mjs/.test(cmd);

function guardedFiles() {
  const files = [];
  const walk = d => { try { for (const e of fs.readdirSync(path.join(r, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; e.isDirectory() ? walk(p) : files.push(p); } } catch {} };
  walk('.claude');
  for (const p of ['.harness/state.json', '.harness/status.json']) files.push(p);
  return files;
}
const snapFile = H(r, 'tmp', `bash-${input.tool_use_id || 'last'}.json`);

if (event === 'PreToolUse') {
  for (const [name, re] of Object.entries(cfg.hard_stops || {})) if (new RegExp(re).test(cmd)) { logHit(r, 'R-hardstop', name); ask(`[harness R-hardstop] "${name}" needs your approval.`); }
  if (/(curl|wget)[^|]*\|\s*(ba|z)?sh\b/.test(cmd)) { logHit(r, 'R-pipe-sh'); deny('[harness R-pipe-sh] piping a download into a shell is blocked. Download, read, then run.'); }
  const state = loadState(r);
  if (worker && harnessCli && !/\sstatus\b|\sanalyze\b/.test(cmd)) { logHit(r, 'R-worker-cli'); deny('[harness R-worker-cli] workers cannot change harness state. Return status "needs-red-reopen" or "blocked" instead.'); }
  if (!harnessCli) {
    const writes = /(sed\s+(-\w*\s+)*-\w*i|perl\s+-\w*i|\btee\b|(^|[^0-9&])>{1,2}\s*[^&\s]|\bmv\b|\bcp\b|\brm\b|\bchmod\b|\btruncate\b|python3?\s+-c|node\s+-e)/.test(cmd);
    const named = writes && Object.keys(frozenIndex(r, state)).find(p => cmd.includes(p) || cmd.includes(path.basename(p)));
    if (named) { logHit(r, 'R-frozen-bash', named); deny(`[harness R-frozen] command writes frozen file ${named}. Frozen tests cannot change during green.`); }
    if (writes && /\.harness\/(state|status)\.json|\.harness\/baselines|\.claude\/(hooks|settings|harness)/.test(cmd)) {
      logHit(r, 'R-guarded-bash'); deny('[harness R-guarded] command writes a guarded harness path.');
    }
  }
  const snap = {}; for (const p of guardedFiles()) snap[p] = sha256File(path.join(r, p));
  writeJSON(snapFile, snap);
  allow();
}

if (event === 'PostToolUse') {
  const state = loadState(r);
  const problems = [];
  // Frozen files: compare with baseline hashes directly.
  for (const [p, { feature, sha }] of Object.entries(frozenIndex(r, state))) {
    if (sha256File(path.join(r, p)) !== sha) {
      const f = state.features[feature];
      if (f.state !== 'invalid') { f.prev_state = f.state; f.history.push({ ts: new Date().toISOString(), from: f.state, to: 'invalid', note: `bash changed ${p}` }); f.state = 'invalid'; }
      problems.push(`frozen file ${p} (${feature}) changed`);
    }
  }
  if (problems.length) saveState(r, state);
  // Guarded files: compare with the pre-command snapshot. The harness CLI may change .harness state.
  const snap = readJSON(snapFile, {});
  for (const [p, sha] of Object.entries(snap)) {
    if (harnessCli && p.startsWith('.harness/')) continue;
    if (p === '.harness/state.json' && problems.length) continue; // we just wrote it
    if (sha256File(path.join(r, p)) !== sha) problems.push(`guarded file ${p} changed`);
  }
  try { fs.unlinkSync(snapFile); } catch {}
  if (problems.length) {
    logHit(r, 'R-bash-detect', problems.join('; '));
    const feats = [...new Set(Object.values(frozenIndex(r, loadState(r))).map(v => v.feature))];
    block(`[harness R-bash-detect] ${problems.join('; ')}. The run is now invalid: no green work or verify until restore. Orchestrator: node .claude/harness/harness.mjs restore ${feats[0] || '<FEAT>'}`);
  }
  allow();
}
allow();
