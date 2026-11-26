// Worker lifecycle.
// PreToolUse Agent|Task (main): take run.lock or deny. (SubagentStart cannot refuse a start, so the lock lives here.)
// SubagentStart: bind agent_id, inject the packet as additionalContext.
// SubagentStop: validate return.v1 (size, schema, content); block with reason, release lock on a valid return.
import fs from 'node:fs';
import { readInput, root, loadConfig, loadState, saveState, H, readJSON, writeJSON, deny, block, context, allow, logHit } from './lib.mjs';

const input = readInput();
const r = root(input);
const cfg = loadConfig(r);
const ev = input.hook_event_name;
const lockFile = H(r, 'run.lock');
const state = loadState(r);
const run = state.active_run;
if (ev === 'PreToolUse') {
  if (!run || run.status !== 'briefed') { logHit(r, 'R-no-brief'); deny('[harness R-no-brief] run /brief first: no briefed packet is waiting.'); }
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ run_id: run.run_id, feature: run.feature, ts: Date.now(), attempts: 0 }), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    logHit(r, 'R-lock');
    deny('[harness R-lock] a worker holds the lock. Run /brief again if the previous run expired.');
  }
  run.status = 'running'; saveState(r, state);
  allow();
}

if (ev === 'SubagentStart') {
  const lock = readJSON(lockFile, null);
  if (!run || run.status !== 'running' || run.agent_id || lock?.run_id !== run.run_id) allow();
  run.agent_id = input.agent_id; saveState(r, state);
  const pk = fs.readFileSync(H(r, 'briefs', run.run_id + '.json'), 'utf8');
  context('SubagentStart', `Your packet (the whole bar for this run; add no checks or reviews beyond it). Return exactly one JSON object matching return.v1, max ${cfg.return_max_bytes} bytes, details in out_dir:\n${pk}`);
}

if (ev === 'SubagentStop') {
  const lock = readJSON(lockFile, null);
  if (!run || lock?.run_id !== run.run_id || !run.agent_id || run.agent_id !== input.agent_id) allow();
  const msg = input.last_assistant_message || '';
  const problems = [];
  if (Buffer.byteLength(msg) > cfg.return_max_bytes) problems.push(`return is ${Buffer.byteLength(msg)} B, cap ${cfg.return_max_bytes}`);
  let ret = null;
  const m = msg.match(/\{[\s\S]*\}/);
  try { ret = m ? JSON.parse(m[0]) : null; } catch {}
  if (!ret) problems.push('no parseable return.v1 JSON');
  else {
    for (const k of ['run_id', 'status', 'summary', 'evidence', 'files_changed', 'confidence']) if (!(k in ret)) problems.push(`missing field ${k}`);
    if (ret.run_id && ret.run_id !== lock.run_id) problems.push(`run_id ${ret.run_id} != ${lock.run_id}`);
    if (ret.status && !['done', 'blocked', 'needs-red-reopen'].includes(ret.status)) problems.push(`bad status ${ret.status}`);
    if (ret.confidence && !['hypothesis', 'red-green', 'run-checked'].includes(ret.confidence)) problems.push(`bad confidence ${ret.confidence}`);
    if (typeof ret.summary === 'string' && ret.summary.split(/[.!?](\s|$)/).filter(s => s && s.trim()).length > 3) problems.push('summary over 3 sentences');
  }
  for (const f of cfg.return_forbidden || []) if (new RegExp(f).test(msg)) problems.push(`forbidden content /${f}/`);
  lock.attempts = (lock.attempts || 0) + 1;
  if (problems.length && lock.attempts < 3) {
    writeJSON(lockFile, lock);
    logHit(r, 'R-return', problems.join('; '));
    block(`[harness R-return] ${problems.join('; ')}. Write details to ${run?.run_id ? `.harness/out/${run.run_id}/` : 'out_dir'} and reply with one return.v1 JSON object only.`);
  }
  writeJSON(H(r, 'out', lock.run_id, 'return.json'), { valid: problems.length === 0, problems, attempts: lock.attempts, raw_bytes: Buffer.byteLength(msg), ret });
  run.status = problems.length ? 'failed-return' : 'returned';
  saveState(r, state);
  fs.unlinkSync(lockFile);
  allow();
}
allow();
