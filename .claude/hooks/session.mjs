// SessionStart / PreCompact / Stop / SessionEnd.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readInput, root, loadState, H, git, context, allow } from './lib.mjs';

const input = readInput();
const r = root(input);
const ev = input.hook_event_name;
const handoff = path.join(r, 'docs', 'HANDOFF.md');
const resume = H(r, 'resume.md');

if (ev === 'SessionStart') {
  if (input.source === 'compact' && fs.existsSync(resume)) {
    const t = fs.readFileSync(resume, 'utf8').split('\n').slice(0, 30).join('\n');
    fs.unlinkSync(resume);
    context('SessionStart', `Resume note (written before compaction):\n${t}`);
  }
  const parts = [];
  if (fs.existsSync(handoff)) parts.push(fs.readFileSync(handoff, 'utf8').split('\n').slice(0, 40).join('\n'));
  const init = path.join(r, 'init.sh');
  if (fs.existsSync(init)) {
    const s = spawnSync('bash', [init], { cwd: r, encoding: 'utf8', timeout: 60e3 });
    parts.push(`Smoke (init.sh): ${s.status === 0 ? 'PASS' : `FAIL exit ${s.status} — fix before feature work: ${(s.stdout + s.stderr).trim().split('\n').slice(-3).join(' | ')}`}`);
  }
  if (parts.length) context('SessionStart', parts.join('\n\n'));
  allow();
}

function summary() {
  const st = loadState(r);
  const feats = Object.entries(st.features).map(([k, v]) => `- ${k}: ${v.state}${v.baseline_id ? ` (baseline ${v.baseline_id})` : ''}`);
  return { st, feats };
}

if (ev === 'PreCompact') {
  const { st, feats } = summary();
  fs.mkdirSync(H(r), { recursive: true });
  fs.writeFileSync(resume, [
    `# Resume note ${new Date().toISOString()}`,
    `Branch: ${git(r, ['branch', '--show-current'])}`,
    `Active run: ${st.active_run ? `${st.active_run.run_id} (${st.active_run.status})` : 'none'}`,
    'Features:', ...feats,
    'Verified state lives in .harness/status.json; re-check freshness with: node .claude/harness/harness.mjs status',
  ].join('\n'));
  allow();
}

if (ev === 'Stop') {
  if (input.stop_hook_active) allow();
  const { st, feats } = summary();
  const block = [
    '<!-- auto:start -->',
    `Updated: ${new Date().toISOString()}`,
    `Branch: ${git(r, ['branch', '--show-current'])} · HEAD ${git(r, ['rev-parse', '--short', 'HEAD'])}`,
    'Last commits:', ...git(r, ['log', '--oneline', '-3']).split('\n').map(l => `- ${l}`),
    'Features:', ...feats,
    `Active run: ${st.active_run ? `${st.active_run.run_id} (${st.active_run.status})` : 'none'}`,
    '<!-- auto:end -->',
  ].join('\n');
  let t = fs.existsSync(handoff) ? fs.readFileSync(handoff, 'utf8') : '# Handoff\n\n';
  t = /<!-- auto:start -->[\s\S]*<!-- auto:end -->/.test(t) ? t.replace(/<!-- auto:start -->[\s\S]*<!-- auto:end -->/, block) : `${t.trimEnd()}\n\n${block}\n`;
  fs.mkdirSync(path.dirname(handoff), { recursive: true });
  fs.writeFileSync(handoff, t);
  allow();
}

if (ev === 'SessionEnd') {
  fs.mkdirSync(H(r, 'sessions'), { recursive: true });
  const d = new Date().toISOString();
  fs.appendFileSync(H(r, 'sessions', `${d.slice(0, 10)}.tsv`), `${d}\tsession-end\t${input.reason || ''}\t${input.session_id || ''}\n`);
  allow();
}
allow();
