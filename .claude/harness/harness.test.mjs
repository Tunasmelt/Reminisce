import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));

function fixture(t) {
  const temp = fs.realpathSync(os.tmpdir());
  const cwd = fs.mkdtempSync(path.join(temp, 'reminisce-harness-'));
  t.after(() => {
    assert.equal(path.dirname(cwd), temp);
    assert.match(path.basename(cwd), /^reminisce-harness-/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  for (const dir of ['.claude', 'docs']) fs.cpSync(path.join(repo, dir), path.join(cwd, dir), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'lib'));
  fs.writeFileSync(path.join(cwd, 'lib', 'model-permissions.ts'), '');
  fs.copyFileSync(path.join(repo, '.gitignore'), path.join(cwd, '.gitignore'));

  const run = (exe, args, input, status = 0) => {
    const result = spawnSync(exe, args, {
      cwd,
      input,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });
    assert.equal(result.status, status, result.error?.message || result.stderr || result.stdout);
    return result.stdout.trim();
  };
  return {
    cwd,
    git: (...args) => run('git', args),
    brief: (status = 0) => JSON.parse(run(process.execPath, ['.claude/harness/harness.mjs', 'brief', 'FEAT-001', 'test-writer'], undefined, status)),
    hook: (name, event, fields) => {
      const output = run(process.execPath, [`.claude/hooks/${name}.mjs`], JSON.stringify({ hook_event_name: event, ...fields }));
      return output && JSON.parse(output);
    },
  };
}

test('brief recovers an expired lock and protects the replacement run', t => {
  const { cwd, brief, hook } = fixture(t);
  const first = brief();
  assert.equal(hook('packet', 'PreToolUse'), '');
  hook('packet', 'SubagentStart', { agent_id: 'first-worker' });
  assert.match(brief(1).msg, /holds the lock/);

  const lockPath = path.join(cwd, '.harness', 'run.lock');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'harness.config.json'), 'utf8'));
  lock.ts = Date.now() - (cfg.lock_stale_min + 1) * 60e3;
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  const replacement = brief();
  assert.notEqual(replacement.run_id, first.run_id);
  assert.equal(fs.existsSync(lockPath), false);

  assert.equal(hook('packet', 'PreToolUse'), '');
  hook('packet', 'SubagentStart', { agent_id: 'second-worker' });
  assert.equal(hook('scope', 'PreToolUse', { agent_id: 'first-worker', tool_name: 'Read' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(hook('scope', 'PreToolUse', { agent_id: 'second-worker', tool_name: 'Read' }), '');
  assert.equal(hook('packet', 'SubagentStop', { agent_id: 'first-worker' }), '');
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(hook('packet', 'SubagentStop', {
    agent_id: 'second-worker',
    last_assistant_message: JSON.stringify({
      run_id: replacement.run_id,
      status: 'done',
      summary: 'Fixture work complete.',
      evidence: [],
      files_changed: [],
      confidence: 'hypothesis',
    }),
  }), '');
  assert.equal(fs.existsSync(lockPath), false);
});

test('Stop saves a local handoff and leaves the checkout clean', t => {
  const { git, hook } = fixture(t);
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Harness Test', '-c', 'user.email=harness@example.invalid', 'commit', '-qm', 'fixture');

  assert.equal(hook('session', 'Stop'), '');
  assert.equal(git('status', '--porcelain'), '');
  const next = hook('session', 'SessionStart').hookSpecificOutput.additionalContext;
  assert.match(next, /# Handoff/);
  assert.match(next, /# Previous session/);
  assert.match(next, /Active run: none/);
});
