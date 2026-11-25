#!/usr/bin/env node
// Solo Harness v3 CLI. Only this file writes .harness/state.json, baselines/ and status.json.
// Usage: node .claude/harness/harness.mjs <cmd> [FEAT-NNN] [flags]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, loadConfig, H, readJSON, writeJSON, loadState, saveState, sha256File, sha256, git, matchAny } from '../hooks/lib.mjs';
import { listFeatures, parseFeature, featurePath, mappedIds, reviewOnly, components, idsInName } from './features.mjs';

const r = root();
const cfg = loadConfig(r);
const [cmd, fid, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf('--' + n); return i < 0 ? undefined : (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true); };
const say = (ok, msg, extra) => { console.log(JSON.stringify({ ok, cmd, feature: fid, msg, ...extra }, null, 1)); process.exit(ok ? 0 : 1); };

const PARSER_VERSION = 'junit-v1';

function feat(state, id) {
  state.features[id] ||= { state: 'draft', baseline_id: null, history: [] };
  return state.features[id];
}
function transition(state, id, to, note) {
  const f = feat(state, id);
  f.history.push({ ts: new Date().toISOString(), from: f.state, to, note });
  f.state = to;
}

// ---------- analyze ----------
function analyze() {
  const errors = [];
  const spec = path.join(r, 'docs', 'SPEC.md');
  if (!fs.existsSync(spec)) errors.push('docs/SPEC.md missing');
  else {
    const t = fs.readFileSync(spec, 'utf8');
    const sec = (t.split(/^## Terminology\s*$/m)[1] || '').split(/^## /m)[0];
    const terms = sec.split('\n').filter(l => /^\|\s*[^|\s-][^|]*\|/.test(l) && !/^\|\s*Term\s*\|/i.test(l) && !/<[^>]+>/.test(l));
    if (!terms.length) errors.push('docs/SPEC.md: Terminology section missing or empty (one row per project term)');
  }
  const comps = new Set(components(r));
  const seen = new Map();
  for (const f of listFeatures(r)) {
    const own = [...f.reqs.map(x => x.id), ...f.acceptance.map(x => x.id), ...f.edge_cases.map(x => x.id), ...f.issues.map(x => x.id)];
    for (const id of own) {
      const key = id.startsWith('REQ') ? id : `${f.id}/${id}`; // EC/ISS are feature-scoped
      if (seen.has(key)) errors.push(`${f.id}: duplicate id ${id}`); else seen.set(key, f.id);
    }
    for (const q of f.reqs) {
      if (!comps.has(q.comp)) errors.push(`${f.id}: ${q.id} maps to unknown component ${q.comp}`);
      if (!f.acceptance.some(a => a.id.startsWith(q.id + '.'))) errors.push(`${f.id}: ${q.id} has no acceptance line`);
    }
    for (const a of f.acceptance) if (!f.reqs.some(q => a.id.startsWith(q.id + '.'))) errors.push(`${f.id}: acceptance ${a.id} has no REQ`);
    for (const p of f.paths) if (!p.planned && !fs.existsSync(path.join(r, p.path))) errors.push(`${f.id}: path ${p.path} missing (mark it "(planned)" if it will be created)`);
    for (const q of f.open) {
      const hit = f.acceptance.find(a => q.includes(a.id));
      if (hit) errors.push(`${f.id}: open question touches ${hit.id}: ${q}`);
    }
    if (!f.paths.length) errors.push(`${f.id}: no Paths`);
  }
  return errors;
}

// ---------- runner ----------
// Only acceptance tests are locked. Unit tests (cfg.test.unit_globs) are written one slice at a time and stay editable.
const ACC = () => cfg.test.acceptance_globs || cfg.test.test_globs;
function testFiles(f) {
  return f.paths.map(p => p.path).filter(p => matchAny(p, ACC()) && fs.existsSync(path.join(r, p)));
}

function frozenFiles(f) {
  const set = new Set(testFiles(f));
  for (const g of cfg.test.frozen_extra || []) if (fs.existsSync(path.join(r, g))) set.add(g);
  return [...set].sort();
}

function decode(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }

function parseJunit(xml) {
  const cases = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    const body = m[3] || '';
    let outcome = 'pass', detail = '';
    const fail = body.match(/<failure\b([^>]*?)\/?>([\s\S]*?)(<\/failure>|$)/);
    const err = body.match(/<error\b([^>]*?)\/?>([\s\S]*?)(<\/error>|$)/);
    // Reason = the element's type + message attributes only (never the traceback body, which quotes source lines).
    const why = (mm) => { const at = {}; for (const a of mm[1].matchAll(/(\w+)="([^"]*)"/g)) at[a[1]] = decode(a[2]); return `type=${at.type || ''} message=${at.message || decode(mm[2]).split('\n')[0]}`.slice(0, 400); };
    if (/<skipped\b/.test(body)) outcome = 'skipped';
    else if (err) { outcome = 'error'; detail = why(err); }
    else if (fail) { outcome = 'failure'; detail = why(fail); }
    cases.push({ key: `${attrs.classname || ''}::${attrs.name || ''}`, name: attrs.name || '', outcome, detail });
  }
  return cases;
}

function runTests(f, runId, unit = false) {
  const outDir = H(r, 'out', runId);
  fs.mkdirSync(outDir, { recursive: true });
  const junit = path.join(outDir, unit ? 'junit-unit.xml' : 'junit.xml');
  try { fs.unlinkSync(junit); } catch {}
  const files = unit ? (cfg.test.unit_paths || []).filter(p => fs.existsSync(path.join(r, p))) : testFiles(f);
  const argv = (unit ? cfg.test.unit_command || cfg.test.command : cfg.test.command).flatMap(a => a === '{tests}' ? files : [a.replace('{junit}', junit)]);
  const env = {};
  for (const k of cfg.test.env_allow || []) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, cfg.test.env_set || {});
  const res = spawnSync(argv[0], argv.slice(1), { cwd: path.join(r, cfg.test.cwd || '.'), env, encoding: 'utf8', timeout: (cfg.test.timeout_s || 300) * 1000 });
  fs.writeFileSync(path.join(outDir, 'stdout.txt'), (res.stdout || '') + '\n--- stderr ---\n' + (res.stderr || ''));
  const xml = fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : '';
  const cases = parseJunit(xml);
  const meta = {
    command: argv.join(' '), cwd: cfg.test.cwd || '.', exit: res.status, ran_at: new Date().toISOString(),
    lockfile_hash: (cfg.test.lockfiles || []).map(l => sha256File(path.join(r, l)) || 'absent').join(','),
    runtime: cfg.test.runtime_probe ? spawnSync(cfg.test.runtime_probe[0], cfg.test.runtime_probe.slice(1), { encoding: 'utf8' }).stdout.trim() : process.version,
    parser: PARSER_VERSION, junit: path.relative(r, junit), files,
  };
  return { cases, meta, junitFound: Boolean(xml) };
}

function idCoverage(f, cases) {
  const byId = {};
  for (const id of mappedIds(f)) byId[id] = [];
  for (const c of cases) for (const id of idsInName(c.name)) if (byId[id]) byId[id].push(c);
  return byId;
}

// ---------- hashes ----------
function hashFiles(files) {
  const map = {};
  for (const p of files) map[p] = sha256File(path.join(r, p));
  return map;
}
const frozenHash = map => sha256(Object.entries(map).sort().map(([p, s]) => `${p}:${s}`).join('\n'));

function contentHash() {
  const tree = git(r, ['ls-tree', '-r', 'HEAD']).split('\n').filter(Boolean)
    .filter(l => !matchAny(l.split('\t')[1], cfg.closeout_paths));
  return sha256(tree.join('\n'));
}
function treeClean() {
  return git(r, ['status', '--porcelain']).split('\n').filter(Boolean).length === 0;
}
const featureRev = id => git(r, ['rev-parse', `HEAD:docs/features/${id}.md`]);

// ---------- commands ----------
const state = loadState(r);

if (cmd === 'analyze') {
  const errors = analyze();
  say(errors.length === 0, errors.length ? 'analyze failed' : 'analyze clean', { errors });
}

if (cmd === 'brief') {
  // brief FEAT-NNN <role>  — writes and validates the packet, binds it as the active run
  const role = rest[0];
  const roles = cfg.roles;
  if (!roles[role]) say(false, `unknown role ${role}`);
  const errs = analyze().filter(e => e.startsWith(fid + ':'));
  if (errs.length) say(false, 'analyze failed for feature', { errors: errs });
  if (state.active_run && fs.existsSync(H(r, 'run.lock'))) say(false, `run ${state.active_run.run_id} holds the lock`);
  const f = parseFeature(r, fid);
  const fs_ = feat(state, fid);
  const need = { 'test-writer': ['draft', 'red-running'], 'feature-dev': ['frozen'], 'debugger': ['frozen', 'verified', 'invalid'], 'verifier': ['verified', 'frozen'] }[role] || ['draft', 'frozen', 'verified'];
  if (!need.includes(fs_.state)) say(false, `role ${role} needs state ${need.join('|')}, feature is ${fs_.state}`);
  const n = (fs_.history.filter(h => h.note?.startsWith('brief')).length + 1).toString().padStart(2, '0');
  const runId = `${fid}-${role}-${n}`;
  const allowed = role === 'test-writer' ? f.paths.map(p => p.path).filter(p => matchAny(p, ACC()))
    : role === 'feature-dev' ? [...f.paths.map(p => p.path).filter(p => !matchAny(p, ACC())), ...(cfg.test.unit_globs || [])] : [];
  const packet = {
    run_id: runId, role, goal: rest.slice(1).join(' ') || `${role} for ${fid}`,
    feature: { id: fid, rev: git(r, ['hash-object', featurePath(r, fid)]) },
    reqs: f.reqs.map(q => q.id), acceptance: f.acceptance, edge_cases: f.edge_cases, issues: f.issues,
    allowed_paths: [...allowed, `.harness/out/${runId}/**`],
    allowed_tools: roles[role].tools, role_skill: `.claude/skills/role-${role}/SKILL.md`,
    evidence_required: roles[role].evidence || [], return_schema: 'return.v1', out_dir: `.harness/out/${runId}/`,
  };
  const bytes = Buffer.byteLength(JSON.stringify(packet));
  if (bytes > cfg.packet_max_bytes) say(false, `packet ${bytes} B over cap ${cfg.packet_max_bytes}`);
  if (role !== 'verifier' && role !== 'debugger' && allowed.length === 0) say(false, 'allowed_paths empty');
  if (allowed.some(p => matchAny(p, cfg.guarded))) say(false, 'allowed_paths includes a guarded path');
  writeJSON(H(r, 'briefs', runId + '.json'), packet);
  if (role === 'test-writer' && fs_.state === 'draft') transition(state, fid, 'red-running', 'brief test-writer');
  else fs_.history.push({ ts: new Date().toISOString(), note: `brief ${role}` });
  state.active_run = { run_id: runId, feature: fid, role, status: 'briefed', agent_id: null, ts: new Date().toISOString() };
  saveState(r, state);
  say(true, 'packet written', { run_id: runId, bytes, path: `.harness/briefs/${runId}.json` });
}

if (cmd === 'record-red') {
  const fs_ = feat(state, fid);
  if (fs_.state !== 'red-running') say(false, `record-red needs red-running, feature is ${fs_.state}`);
  const f = parseFeature(r, fid);
  const runId = `${fid}-red-${Date.now()}`;
  const { cases, meta, junitFound } = runTests(f, runId);
  if (!junitFound) say(false, 'runner produced no JUnit report (collection or config error)', { meta });
  const prev = fs_.baseline_id ? readJSON(H(r, 'baselines', fs_.baseline_id, 'baseline.json'), null) : null;
  const prevKeys = new Set(prev ? prev.tests.map(t => t.key) : []);
  const broken = new Set(fs_.reopen?.broken || []);
  const problems = [];
  const cov = idCoverage(f, cases);
  for (const [id, cs] of Object.entries(cov)) if (!cs.length) problems.push(`no test mapped to ${id}`);
  const tests = cases.map(c => ({ key: c.key, ids: idsInName(c.name), outcome: c.outcome, set: prevKeys.has(c.key) ? 'carried' : 'new', detail: c.detail }));
  const invalidRe = new RegExp(cfg.test.invalid_red_pattern);
  for (const t of tests) {
    if (t.outcome === 'skipped') problems.push(`${t.key} skipped`);
    if (t.outcome === 'error') problems.push(`${t.key} errored (not a valid red): ${t.detail.slice(0, 120)}`);
    if (t.set === 'new') {
      if (t.outcome === 'pass') problems.push(`new test ${t.key} passes at red`);
      if (t.outcome === 'failure' && invalidRe.test(t.detail)) problems.push(`new test ${t.key} failed on a test-authoring error, not on behavior: ${t.detail.slice(0, 120)}`);
    } else if (t.outcome !== 'pass' && !t.ids.some(i => broken.has(i))) problems.push(`carried test ${t.key} fails and is not listed as broken by the reopen`);
  }
  if (!cases.length) problems.push('no tests executed');
  if (problems.length) say(false, 'red not valid', { problems, meta });
  const files = hashFiles(frozenFiles(f));
  const baselineId = `${fid}-b${(fs_.history.filter(h => h.to === 'red-recorded').length + 1)}`;
  writeJSON(H(r, 'baselines', baselineId, 'baseline.json'), {
    baseline_id: baselineId, feature: fid, feature_rev: git(r, ['hash-object', featurePath(r, fid)]), created: meta.ran_at,
    tests, files, frozen_hash: frozenHash(files), meta, review: 'failure reason: review (v3.0)',
  });
  fs_.candidate = baselineId;
  transition(state, fid, 'red-recorded', `baseline candidate ${baselineId}`);
  saveState(r, state);
  say(true, 'red recorded', { baseline: baselineId, new: tests.filter(t => t.set === 'new').length, carried: tests.filter(t => t.set === 'carried').length });
}

if (cmd === 'freeze') {
  const fs_ = feat(state, fid);
  if (fs_.state !== 'red-recorded') say(false, `freeze needs red-recorded, feature is ${fs_.state}`);
  const b = readJSON(H(r, 'baselines', fs_.candidate, 'baseline.json'), null);
  const now = hashFiles(Object.keys(b.files));
  if (frozenHash(now) !== b.frozen_hash) say(false, 'test files changed between record-red and freeze; run record-red again');
  const snap = H(r, 'baselines', b.baseline_id, 'snapshot');
  for (const p of Object.keys(b.files)) {
    fs.mkdirSync(path.dirname(path.join(snap, p)), { recursive: true });
    fs.copyFileSync(path.join(r, p), path.join(snap, p));
    if (cfg.freeze_chmod) fs.chmodSync(path.join(r, p), 0o444);
  }
  fs_.baseline_id = b.baseline_id; delete fs_.candidate; delete fs_.reopen;
  transition(state, fid, 'frozen', `frozen ${b.baseline_id}`);
  saveState(r, state);
  say(true, 'frozen', { baseline: b.baseline_id, files: Object.keys(b.files), chmod: Boolean(cfg.freeze_chmod) });
}

if (cmd === 'verify') {
  const fs_ = feat(state, fid);
  if (!['frozen', 'verified'].includes(fs_.state)) say(false, `verify needs frozen|verified, feature is ${fs_.state}`);
  const b = readJSON(H(r, 'baselines', fs_.baseline_id, 'baseline.json'), null);
  const now = hashFiles(Object.keys(b.files));
  if (frozenHash(now) !== b.frozen_hash) {
    fs_.prev_state = fs_.state; transition(state, fid, 'invalid', 'verify found frozen hash mismatch'); saveState(r, state);
    say(false, 'frozen set changed: run is invalid, no evidence written', { changed: Object.keys(now).filter(p => now[p] !== b.files[p]) });
  }
  if (!treeClean()) say(false, 'working tree not clean: commit the candidate revision first (spec: commit ordering)');
  const f = parseFeature(r, fid);
  const runId = `${fid}-verify-${Date.now()}`;
  const { cases, meta, junitFound } = runTests(f, runId);
  const counts = { passed: cases.filter(c => c.outcome === 'pass').length, failed: cases.filter(c => c.outcome === 'failure' || c.outcome === 'error').length, skipped: cases.filter(c => c.outcome === 'skipped').length };
  const results = {};
  for (const [id, cs] of Object.entries(idCoverage(f, cases))) results[id] = !cs.length ? 'missing' : cs.every(c => c.outcome === 'pass') ? 'pass' : 'fail';
  const baselineKeys = new Set(b.tests.map(t => t.key));
  const missingTests = [...baselineKeys].filter(k => !cases.some(c => c.key === k));
  // Unit suite: editable, not frozen, but must be green for the feature to verify.
  let unit = { ran: false };
  if ((cfg.test.unit_paths || []).some(p => fs.existsSync(path.join(r, p)))) {
    const u = runTests(f, runId, true);
    unit = { ran: true, report: u.junitFound, passed: u.cases.filter(c => c.outcome === 'pass').length, failed: u.cases.filter(c => c.outcome === 'failure' || c.outcome === 'error').length, skipped: u.cases.filter(c => c.outcome === 'skipped').length, command: u.meta.command };
  }
  const unitOk = !unit.ran || (unit.report && unit.failed === 0);
  const green = unitOk && junitFound && counts.failed === 0 && counts.skipped === 0 && missingTests.length === 0 && Object.values(results).every(v => v === 'pass');
  const status = readJSON(H(r, 'status.json'), {});
  status[fid] = {
    feature_rev: featureRev(fid), baseline_id: b.baseline_id, frozen_hash: b.frozen_hash,
    source_commit: git(r, ['rev-parse', 'HEAD']), verified_content_hash: contentHash(),
    env: { lockfile_hash: meta.lockfile_hash, runtime: meta.runtime, parser: meta.parser },
    command: meta.command, ran_at: meta.ran_at, results, counts, unit, green, missing_tests: missingTests,
    review_only: reviewOnly(f), artifact: meta.junit,
  };
  writeJSON(H(r, 'status.json'), status);
  if (green) transition(state, fid, 'verified', `verified at ${status[fid].source_commit.slice(0, 7)}`);
  saveState(r, state);
  say(green, green ? 'verified' : 'not green', { results, counts, unit, missing_tests: missingTests });
}

if (cmd === 'reopen-red') {
  const fs_ = feat(state, fid);
  const amend = fs_.state === 'red-running' && fs_.reopen;
  if (!amend && !['frozen', 'verified', 'accepted'].includes(fs_.state)) say(false, `reopen needs frozen|verified|accepted (or an open reopen to amend), feature is ${fs_.state}`);
  const iss = flag('iss'), reason = flag('reason');
  if (!iss || !reason || reason === true) say(false, 'reopen needs --iss ISS-NNN --reason "<text>"');
  if (flag('confirm') !== true) say(false, 'reopen needs --confirm (human confirmation in chat)');
  if (process.env.HARNESS_ACTOR === 'worker') say(false, 'workers can request a reopen but cannot perform it');
  const broken = (flag('broken') && flag('broken') !== true) ? String(flag('broken')).split(',') : [];
  fs_.reopen = { iss, reason, broken, ts: new Date().toISOString() };
  if (amend) fs_.history.push({ ts: new Date().toISOString(), note: `reopen amended: broken=${broken.join(',')}` });
  else transition(state, fid, 'red-running', `reopen ${iss}: ${reason}`);
  saveState(r, state);
  // unlock test files for the new red (chmod mode)
  if (cfg.freeze_chmod && fs_.baseline_id) {
    const b = readJSON(H(r, 'baselines', fs_.baseline_id, 'baseline.json'), null);
    for (const p of Object.keys(b.files)) try { fs.chmodSync(path.join(r, p), 0o644); } catch {}
  }
  say(true, 'red reopened; old baseline stays active until the new one is recorded', { baseline_active: fs_.baseline_id });
}

if (cmd === 'restore') {
  const fs_ = feat(state, fid);
  if (fs_.state !== 'invalid') say(false, `restore needs invalid, feature is ${fs_.state}`);
  const b = readJSON(H(r, 'baselines', fs_.baseline_id, 'baseline.json'), null);
  const snap = H(r, 'baselines', b.baseline_id, 'snapshot');
  for (const p of Object.keys(b.files)) {
    const dst = path.join(r, p);
    try { fs.chmodSync(dst, 0o644); } catch {}
    fs.copyFileSync(path.join(snap, p), dst);
    if (cfg.freeze_chmod) fs.chmodSync(dst, 0o444);
  }
  const ok = frozenHash(hashFiles(Object.keys(b.files))) === b.frozen_hash;
  if (!ok) say(false, 'restore did not reproduce the frozen hash');
  transition(state, fid, fs_.prev_state || 'frozen', 'restored from snapshot');
  delete fs_.prev_state;
  saveState(r, state);
  say(true, 'restored', { state: fs_.state });
}

if (cmd === 'accept') {
  const fs_ = feat(state, fid);
  if (fs_.state !== 'verified') say(false, `accept needs verified, feature is ${fs_.state}`);
  const st = readJSON(H(r, 'status.json'), {})[fid];
  const fresh = freshness(fid, st);
  if (!fresh.fresh) say(false, 'verification is stale', fresh);
  const answers = {};
  for (const a of rest.filter(x => x.startsWith('--answer=')).map(x => x.slice(9))) { const [k, ...v] = a.split('='); answers[k] = v.join('='); }
  const missing = st.review_only.filter(id => !answers[id]);
  if (missing.length) say(false, 'review-only lines need an answer', { missing, usage: '--answer=REQ-001.c="text"' });
  fs_.review_answers = answers;
  transition(state, fid, 'accepted', 'accepted');
  saveState(r, state);
  say(true, 'accepted', { commit: st.source_commit });
}

function freshness(id, st) {
  if (!st) return { fresh: false, why: 'no status entry' };
  const ch = contentHash(), fr = featureRev(id);
  if (st.verified_content_hash !== ch) return { fresh: false, why: 'verified-content hash changed since verify' };
  if (st.feature_rev !== fr) return { fresh: false, why: 'feature file changed since verify' };
  if (!st.green) return { fresh: false, why: 'last verify was not green' };
  return { fresh: true };
}

if (cmd === 'status') {
  const status = readJSON(H(r, 'status.json'), {});
  const rows = Object.entries(state.features).filter(([k]) => !fid || k === fid).map(([k, v]) => ({ feature: k, state: v.state, baseline: v.baseline_id, ...freshness(k, status[k]) }));
  say(true, 'status', { rows, active_run: state.active_run, lock: fs.existsSync(H(r, 'run.lock')) });
}

say(false, `unknown command ${cmd}. Commands: analyze, brief, record-red, freeze, verify, reopen-red, restore, accept, status`);
