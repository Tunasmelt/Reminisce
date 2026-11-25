// Solo Harness v3 — shared helpers. Zero dependencies, Node >= 20.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

export function root(input = {}) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

export function loadConfig(r) {
  return JSON.parse(fs.readFileSync(path.join(r, '.claude', 'harness.config.json'), 'utf8'));
}

export const H = (r, ...p) => path.join(r, '.harness', ...p);

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export const loadState = r => readJSON(H(r, 'state.json'), { features: {}, active_run: null });
export const saveState = (r, s) => writeJSON(H(r, 'state.json'), s);

export function rel(r, p) {
  if (!p) return '';
  const abs = path.isAbsolute(p) ? p : path.join(r, p);
  return path.relative(r, abs).split(path.sep).join('/');
}

// Minimal glob: ** (any depth), * (within a segment), exact.
export function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if ('.+?^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
export const matchAny = (p, globs = []) => globs.some(g => globToRe(g).test(p));

export function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return null; }
}
export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

export function git(r, args) {
  try { return execFileSync('git', args, { cwd: r, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

// Hook replies
export const deny = (reason) => out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
export const ask = (reason) => out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } });
export const block = (reason) => out({ decision: 'block', reason });
export const context = (event, text) => out({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
export function out(obj) { process.stdout.write(JSON.stringify(obj)); process.exit(0); }
export const allow = () => process.exit(0);

export function logHit(r, rule, detail = '') {
  try {
    fs.mkdirSync(H(r), { recursive: true });
    fs.appendFileSync(H(r, 'hits.jsonl'), JSON.stringify({ ts: new Date().toISOString(), rule, detail }) + '\n');
  } catch {}
}

// Frozen files of every feature that currently holds a frozen baseline.
export function frozenIndex(r, state) {
  const idx = {}; // relpath -> { feature, sha }
  for (const [fid, f] of Object.entries(state.features || {})) {
    if (!['frozen', 'verified', 'accepted', 'invalid'].includes(f.state) || !f.baseline_id) continue;
    const b = readJSON(H(r, 'baselines', f.baseline_id, 'baseline.json'), null);
    if (!b) continue;
    for (const [p, sha] of Object.entries(b.files)) idx[p] = { feature: fid, sha };
  }
  return idx;
}

export const isWorker = input => Boolean(input.agent_id);

export function activePacket(r, state) {
  const run = state.active_run;
  if (!run) return null;
  return readJSON(H(r, 'briefs', run.run_id + '.json'), null);
}
