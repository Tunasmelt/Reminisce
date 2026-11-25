// PostToolUse (main session) — large Bash or MCP output is saved to disk and replaced by a handle + preview.
// Uses updatedToolOutput (docs: replaces what Claude sees, all tools; built-in shapes must match the schema).
import fs from 'node:fs';
import { readInput, root, loadConfig, H, out, allow, logHit, isWorker } from './lib.mjs';

const input = readInput();
if (isWorker(input)) allow();
const r = root(input);
const cfg = loadConfig(r);
const tool = input.tool_name || '';
const resp = input.tool_response;
const max = cfg.spill_max_bytes || 4096;

function spill(text) {
  const id = (input.tool_use_id || String(Date.now())).replace(/[^\w-]/g, '');
  const file = H(r, 'out', 'spill', `${id}.txt`);
  fs.mkdirSync(H(r, 'out', 'spill'), { recursive: true });
  fs.writeFileSync(file, text);
  const lines = text.split('\n');
  const preview = lines.slice(0, 10).concat(lines.length > 20 ? ['…'] : [], lines.slice(-10)).join('\n');
  logHit(r, 'R-spill', `${tool} ${text.length}B`);
  return `[harness spill] ${text.length} bytes saved to .harness/out/spill/${id}.txt (${lines.length} lines). Delegate reading it to a worker. Preview (first and last 10 lines, raw content omitted):\n${preview.slice(0, 1500)}`;
}

if (tool === 'Bash' && resp && typeof resp === 'object') {
  const text = `${resp.stdout || ''}${resp.stderr ? '\n[stderr]\n' + resp.stderr : ''}`;
  if (Buffer.byteLength(text) > max) out({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: spill(text), stderr: '', interrupted: Boolean(resp.interrupted), isImage: false } } });
}
if (tool.startsWith('mcp__')) {
  const text = typeof resp === 'string' ? resp : JSON.stringify(resp);
  if (Buffer.byteLength(text) > max) {
    const s = spill(text);
    out({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: Array.isArray(resp) ? [{ type: 'text', text: s }] : s } });
  }
}
allow();
