// Parse docs/features/FEAT-NNN.md and docs/ARCHITECTURE.md.
import fs from 'node:fs';
import path from 'node:path';

export function listFeatures(r) {
  const dir = path.join(r, 'docs', 'features');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^FEAT-\d{3}\.md$/.test(f)).sort().map(f => parseFeature(r, f.replace(/\.md$/, '')));
}

export function featurePath(r, id) { return path.join(r, 'docs', 'features', `${id}.md`); }

export function parseFeature(r, id) {
  const text = fs.readFileSync(featurePath(r, id), 'utf8');
  const sections = {};
  let cur = '_';
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1].toLowerCase(); sections[cur] = []; continue; }
    (sections[cur] ||= []).push(line);
  }
  const bullets = name => (sections[name] || [])
    .map(l => l.match(/^\s*-\s+([A-Z]+-\d+(?:\.[a-z])?)\s*:\s*(.+)$/)).filter(Boolean)
    .map(m => ({ id: m[1], text: m[2].trim() }));
  const reqs = (sections['reqs'] || [])
    .map(l => l.split('|').map(c => c.trim()))
    .filter(c => /^REQ-\d+$/.test(c[1] || ''))
    .map(c => ({ id: c[1], text: c[2], comp: c[3] }));
  const paths = (sections['paths'] || [])
    .map(l => l.match(/^\s*-\s+`?([^`\s]+)`?\s*(\(planned\))?/)).filter(Boolean)
    .map(m => ({ path: m[1], planned: Boolean(m[2]) }));
  const open = (sections['open questions'] || []).map(l => l.trim()).filter(l => l.startsWith('- ') && !/^-\s+none\b/i.test(l));
  const acceptance = bullets('acceptance').map(a => ({ ...a, review: /\[review\]/i.test(a.text) }));
  return {
    id, text, reqs, acceptance, edge_cases: bullets('edge cases'), issues: bullets('issues'), paths, open,
  };
}

export function mappedIds(f) {
  return [...f.acceptance.filter(a => !a.review).map(a => a.id), ...f.edge_cases.map(e => e.id), ...f.issues.map(i => i.id)];
}
export const reviewOnly = f => f.acceptance.filter(a => a.review).map(a => a.id);

export function components(r) {
  const p = path.join(r, 'docs', 'ARCHITECTURE.md');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').map(l => l.split('|').map(c => c.trim())).filter(c => /^COMP-\d+$/.test(c[1] || '')).map(c => c[1]);
}

// Test name -> mapped IDs. Accepts REQ-001.a / REQ_001_a / EC-1 / EC_1 / ISS-002 / ISS_002.
export function idsInName(name) {
  const ids = new Set();
  const re = /(REQ|EC|ISS)[_-](\d+)(?:[_.]([a-z])(?![a-z]))?/g;
  let m;
  while ((m = re.exec(name))) ids.add(m[1] === 'REQ' && m[3] ? `REQ-${m[2]}.${m[3]}` : `${m[1]}-${m[2]}`);
  return [...ids];
}
