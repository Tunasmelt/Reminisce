// PreToolUse Read|Grep|Glob — session logs only for /retro; workers read only their own out_dir under .harness/out.
import { readInput, root, loadState, activePacket, rel, deny, allow, logHit, isWorker } from './lib.mjs';

const input = readInput();
const r = root(input);
const ti = input.tool_input || {};
const p = rel(r, ti.file_path || ti.path || '');
if (!p.startsWith('.harness/')) allow();
const state = loadState(r);
const retro = state.active_run?.role === 'retro';
if (p.startsWith('.harness/sessions') && !retro) { logHit(r, 'R-read-sessions', p); deny('[harness R-read] session logs are read only by /retro.'); }
if (isWorker(input) && p.startsWith('.harness/out')) {
  const pk = activePacket(r, state);
  if (!pk || !p.startsWith(pk.out_dir.replace(/\/$/, ''))) { logHit(r, 'R-read-out', p); deny('[harness R-read] workers read only their own out_dir.'); }
}
allow();
