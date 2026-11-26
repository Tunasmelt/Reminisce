// PreToolUse (all tools) — inside a worker only: enforce the packet's allowed_tools and allowed_paths.
import { readInput, root, loadState, activePacket, rel, matchAny, deny, allow, logHit, isWorker } from './lib.mjs';

const input = readInput();
if (!isWorker(input)) allow();
const r = root(input);
const state = loadState(r);
const pk = activePacket(r, state);
const tool = input.tool_name || '';
const ti = input.tool_input || {};
const no = (rule, msg) => { logHit(r, rule, tool); deny(`[harness ${rule}] ${msg}`); };

if (!pk) no('R-no-packet', 'no active packet for this worker. The orchestrator must run /brief first.');
if (state.active_run.status !== 'running' || state.active_run.agent_id !== input.agent_id) {
  no('R-no-packet', 'the active packet belongs to a different run.');
}

const entries = pk.allowed_tools.map(t => { const m = t.match(/^(\w+)\((.*)\)$/); return m ? { name: m[1], prefix: m[2].replace(/:\*$/, '') } : { name: t }; });
const forTool = entries.filter(e => e.name === tool);
if (!forTool.length) no('R-tool', `${tool} is not in this packet's allowed_tools (${pk.allowed_tools.join(', ')}).`);
if (tool === 'Bash' && forTool.every(e => e.prefix !== undefined)) {
  const cmd = (ti.command || '').trim();
  if (/[;&|`<>\n]|\$\(/.test(cmd)) no('R-tool', 'prefix-restricted Bash may not chain, pipe, substitute or redirect. Run the allowed command on its own.');
  if (!forTool.some(e => cmd.startsWith(e.prefix))) no('R-tool', `Bash command not allowed for this packet. Allowed prefixes: ${forTool.map(e => e.prefix).join(' | ')}`);
}
if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  const p = rel(r, ti.file_path || ti.notebook_path);
  if (!matchAny(p, pk.allowed_paths)) no('R-scope', `${p} is outside this packet's allowed_paths (${pk.allowed_paths.join(', ')}).`);
}
allow();
