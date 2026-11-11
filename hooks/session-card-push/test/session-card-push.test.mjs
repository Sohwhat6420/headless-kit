// Spawns session-card-push.mjs with fixture hook inputs (as Claude Code would) and checks what it prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, render, matches, DEFAULT_CONFIG } from '../session-card-push.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'session-card-push.mjs');
const TOOL = 'mcp__ccd_session__start_session';
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-push-'));

function run(input, extraEnv = {}) {
  const env = { ...process.env, HEADLESS_KIT_STATE_DIR: emptyDir, ...extraEnv };
  if (!extraEnv.HEADLESS_KIT_SESSION_CARD_CONFIG) delete env.HEADLESS_KIT_SESSION_CARD_CONFIG;
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10000, env, windowsHide: true,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* silent */ }
  return { code: r.status, out: r.stdout.trim(), json, ctx: json?.hookSpecificOutput?.additionalContext || '' };
}
const base = { tool_name: TOOL, tool_use_id: 't1', session_id: 's' };

test('a user-asked start that succeeded is silent', () => {
  const r = run({ ...base, hook_event_name: 'PostToolUse', tool_input: { initiation: 'user_asked', title: 'Lane X' }, tool_response: { content: [{ type: 'text', text: 'Started session 1' }] } });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('an own-initiative card speaks, names the title, and keeps the event name', () => {
  const r = run({ ...base, hook_event_name: 'PostToolUse', tool_input: { initiation: 'own_initiative', title: 'Refactor the parser' }, tool_response: 'Proposal card shown: task_1' });
  assert.equal(r.code, 0);
  assert.match(r.ctx, /"Refactor the parser" is now a proposal card/);
  assert.match(r.ctx, /PushNotification/);
  assert.match(r.ctx, /AskUserQuestion/);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
});

test('an offer card speaks too', () => {
  const r = run({ ...base, hook_event_name: 'PostToolUse', tool_input: { initiation: 'offer', title: 'Thing' }, tool_response: 'User chose: New session' });
  assert.match(r.ctx, /"Thing" is now a proposal card/);
});

test('a refusal reported as a failure speaks, with the PostToolUseFailure event name', () => {
  const r = run({ ...base, hook_event_name: 'PostToolUseFailure', tool_input: { initiation: 'user_asked', title: 'Nightly check' }, error: "Nothing was started. Start sessions only on the user's own words to you here; this turn runs an automated event", is_interrupt: false });
  assert.match(r.ctx, /Starting "Nightly check" was refused/);
  assert.match(r.ctx, /one-word reply/);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
});

test('a refusal inside a normal result speaks, and wins over the card rule', () => {
  const r = run({ ...base, hook_event_name: 'PostToolUse', tool_input: { initiation: 'own_initiative', title: 'Y' }, tool_response: { text: 'the app refuses a start: propose instead' } });
  assert.match(r.ctx, /Starting "Y" was refused/);
});

test('no title falls back to "the session"; a long title is capped', () => {
  let r = run({ ...base, hook_event_name: 'PostToolUse', tool_input: { initiation: 'own_initiative' }, tool_response: 'ok' });
  assert.match(r.ctx, /"the session"/);
  r = run({ ...base, hook_event_name: 'PostToolUse', tool_input: { initiation: 'offer', title: 'x'.repeat(300) }, tool_response: 'ok' });
  assert.match(r.ctx, new RegExp(`"${'x'.repeat(80)}"`));
});

test('another tool, or another event, is silent', () => {
  assert.equal(run({ ...base, tool_name: 'Bash', hook_event_name: 'PostToolUse', tool_input: { initiation: 'offer' }, tool_response: 'was refused' }).out, '');
  assert.equal(run({ ...base, hook_event_name: 'PreToolUse', tool_input: { initiation: 'offer', title: 'T' } }).out, '');
});

test('fails open on malformed input', () => {
  for (const input of ['not json', '', '[]', 'null', '42']) {
    const r = run(input);
    assert.equal(r.code, 0, input);
    assert.equal(r.out, '', input);
  }
});

test('config: custom rules, tool names and wording; a broken config falls back to the defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-push-cfg-'));
  const cfgFile = path.join(dir, 'c.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    askTool: 'ask_human',
    rules: [
      { name: 'bad', tool: '(unclosed[', match: { failed: true }, message: 'never' },
      { name: 'deploy', tool: '^mcp__deploy__start$', match: { input: { env: 'prod', mode: ['blue', 'green'] } }, message: 'Deploy of {input.service|a service} to {input.env} needs a look: use {askTool}. {input.missing}' },
    ],
  }));
  const env = { HEADLESS_KIT_SESSION_CARD_CONFIG: cfgFile };
  let r = run({ ...base, tool_name: 'mcp__deploy__start', hook_event_name: 'PostToolUse', tool_input: { env: 'prod', mode: 'green', service: 'api' }, tool_response: 'queued' }, env);
  assert.equal(r.ctx, 'Deploy of api to prod needs a look: use ask_human. {input.missing}');
  r = run({ ...base, tool_name: 'mcp__deploy__start', hook_event_name: 'PostToolUse', tool_input: { env: 'staging', mode: 'green' }, tool_response: 'queued' }, env);
  assert.equal(r.out, '', 'every input field must hold');
  r = run({ ...base, hook_event_name: 'PostToolUse', tool_input: { initiation: 'offer', title: 'T' }, tool_response: 'ok' }, env);
  assert.equal(r.out, '', 'custom rules replace the defaults');
  fs.writeFileSync(cfgFile, '{broken');
  r = run({ ...base, hook_event_name: 'PostToolUse', tool_input: { initiation: 'offer', title: 'T' }, tool_response: 'ok' }, env);
  assert.match(r.ctx, /"T" is now a proposal card/);
  fs.writeFileSync(cfgFile, JSON.stringify({ enabled: false }));
  assert.equal(run({ ...base, hook_event_name: 'PostToolUse', tool_input: { initiation: 'offer', title: 'T' }, tool_response: 'ok' }, env).out, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unit: render and matches', () => {
  assert.equal(render('{input.a|none} {input.b|none} {tool}', { tool_name: 'X', tool_input: { a: ' hi \n there ' } }, DEFAULT_CONFIG), 'hi there none X');
  assert.equal(matches({ tool: 'X', match: {} }, { tool_name: 'X' }), false, 'a rule with no conditions never matches');
  assert.equal(decide({ hook_event_name: 'PostToolUse', tool_name: TOOL, tool_input: { initiation: 'offer' } }, { ...DEFAULT_CONFIG, rules: 'nope' }), null);
});

test('--help prints usage and exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PostToolUseFailure/);
});

test.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));
