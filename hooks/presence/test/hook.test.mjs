// Spawns presence.mjs as Claude Code would (hook JSON on stdin) and as a CLI, against a temporary state folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'presence.mjs');
const FAKE_NOTIFY = path.join(here, '..', 'examples', 'notify-example.mjs');

function sandbox(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-hook-'));
  if (config) fs.writeFileSync(path.join(dir, 'presence.config.json'), JSON.stringify(config));
  return dir;
}
function envFor(dir, extra = {}) {
  const e = { ...process.env, HEADLESS_KIT_STATE_DIR: dir, CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ...extra };
  delete e.HEADLESS_KIT_PRESENCE_CONFIG;
  for (const k of Object.keys(e)) if (e[k] === null) delete e[k];
  return e;
}
function hook(dir, input, extra) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input), env: envFor(dir, extra), encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  return { code: r.status, out: r.stdout.trim(), json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}
function cli(dir, args, extra) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: envFor(dir, extra), encoding: 'utf8', timeout: 10000, windowsHide: true });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* help text */ }
  return { code: r.status, out: r.stdout, json };
}
const ups = (prompt, session = 's1') => ({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt });
const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'presence.json'), 'utf8'));

test('SessionStart says PRESENT by default, AWAY after a flip, and unattended for headless runs', () => {
  const dir = sandbox();
  let r = hook(dir, { session_id: 'a', hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(r.code, 0);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx(r), /PRESENT/);
  cli(dir, ['set', 'away', '--said', 'lunch']);
  r = hook(dir, { session_id: 'b', hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(ctx(r), /AWAY since/);
  assert.match(ctx(r), /presence\.mjs" ask --question/);
  r = hook(dir, { session_id: 'c', hook_event_name: 'SessionStart' }, { CLAUDE_CODE_SESSION_ATTENDED: '0' });
  assert.match(ctx(r), /Unattended session/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('/away flips with a visible systemMessage; /back flips back and mentions the backlog', () => {
  const dir = sandbox();
  hook(dir, { session_id: 's1', hook_event_name: 'SessionStart' });
  let r = hook(dir, ups('/away  dinner'));
  assert.equal(state(dir).state, 'away');
  assert.match(r.json.systemMessage, /Away mode is on/);
  assert.match(ctx(r), /AWAY/);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  cli(dir, ['ask', '--question', 'Which colour?', '--assumed', 'blue']);
  r = hook(dir, ups("ok I'm back"));
  assert.equal(state(dir).state, 'present');
  assert.match(ctx(r), /PRESENT/);
  assert.match(ctx(r), /1 open and 0 waiting/);
  assert.match(r.json.systemMessage, /Away backlog: 1 open, 0 waiting/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a casual prompt while away does not flip back, and stays silent once the session has seen the mode', () => {
  const dir = sandbox();
  hook(dir, ups('/away'));
  const r = hook(dir, ups('just checking, carry on'));
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(state(dir).state, 'away');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('onChange: another session hears about a flip at its next prompt, once', () => {
  const dir = sandbox();
  hook(dir, { session_id: 'other', hook_event_name: 'SessionStart' });
  hook(dir, ups('/away', 'flipper'));
  let r = hook(dir, ups('next step please', 'other'));
  assert.match(ctx(r), /AWAY/);
  assert.equal(r.json.systemMessage, undefined, 'only the flipping prompt gets a visible message');
  r = hook(dir, ups('and the next', 'other'));
  assert.equal(r.out, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty notice suppresses the visible systemMessage but keeps the context line', () => {
  const dir = sandbox({ messages: { noticeAway: '' } });
  const r = hook(dir, ups('/away'));
  assert.equal(r.json.systemMessage, undefined);
  assert.match(ctx(r), /AWAY/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('updates "flip" keeps other sessions silent; "always" speaks every prompt', () => {
  let dir = sandbox({ updates: 'flip' });
  hook(dir, { session_id: 'other', hook_event_name: 'SessionStart' });
  hook(dir, ups('/away', 'flipper'));
  assert.equal(hook(dir, ups('go on', 'other')).out, '');
  fs.rmSync(dir, { recursive: true, force: true });
  dir = sandbox({ updates: 'always' });
  hook(dir, ups('hello'));
  assert.match(ctx(hook(dir, ups('hello again'))), /PRESENT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only the human stamps lastPromptAt: not machine tags, auto-continues or headless runs', () => {
  const dir = sandbox();
  const OLD = '2026-01-01T00:00:00.000Z';
  const stamped = (prompt, extra) => {
    fs.writeFileSync(path.join(dir, 'presence.json'), JSON.stringify({ state: 'present', lastPromptAt: OLD }));
    hook(dir, ups(prompt), extra);
    return state(dir).lastPromptAt !== OLD;
  };
  assert.equal(stamped('ok fix the header please'), true);
  assert.equal(stamped('<cross-session-message from="x">continue your work</cross-session-message>'), false);
  assert.equal(stamped('<task-notification>\n<status>completed</status>\n</task-notification>'), false);
  assert.equal(stamped('My usage limit just reset, please continue where you left off'), false);
  assert.equal(stamped('look at this <cross-session-message from="x">hi</cross-session-message> and reply'), true);
  assert.equal(stamped('Reply with only ok.', { CLAUDE_CODE_SESSION_ATTENDED: '0' }), false);
  assert.equal(stamped('Reply with only ok.', { CLAUDE_CODE_SESSION_ATTENDED: null, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }), false);
  assert.equal(stamped('ok fix it', { CLAUDE_CODE_SESSION_ATTENDED: null, CLAUDE_CODE_ENTRYPOINT: null }), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quiet hours make it away unless the human typed recently', () => {
  const dir = sandbox({ quietHours: { enabled: true, from: 23, to: 8, utcOffsetMinutes: 0, activeMinutes: 30 } });
  let r = cli(dir, ['status'], { HEADLESS_KIT_NOW: '2026-03-01T02:00:00Z' });
  assert.equal(r.json.state, 'away');
  assert.equal(r.json.quiet, true);
  assert.match(r.json.line, /quiet hours 23:00 to 08:00/);
  hook(dir, ups('still here, fix the test'), { HEADLESS_KIT_NOW: '2026-03-01T02:00:00Z' });
  r = cli(dir, ['status'], { HEADLESS_KIT_NOW: '2026-03-01T02:10:00Z' });
  assert.equal(r.json.state, 'present');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: set present needs the human\'s words; usage errors exit 2', () => {
  const dir = sandbox();
  cli(dir, ['set', 'away']);
  let r = cli(dir, ['set', 'present']);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.equal(state(dir).state, 'away');
  r = cli(dir, ['set', 'present', '--said', "yes, I'm back"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'present');
  assert.equal(cli(dir, ['set', 'sideways']).code, 2);
  assert.equal(cli(dir, ['frobnicate']).code, 2);
  assert.equal(cli(dir, ['ask']).code, 2);
  assert.equal(cli(dir, ['status', '--config', path.join(dir, 'missing.json')]).code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI backlog: ask, list (waiting first), resolve, unknown id exits 1', () => {
  const dir = sandbox();
  const a = cli(dir, ['ask', '--question', 'Tabs or spaces?', '--assumed', 'spaces', '--built', 'fmt.json', '--reverse', 'set tabs']);
  assert.equal(a.code, 0);
  assert.equal(a.json.status, 'open');
  const w = cli(dir, ['ask', '--question', 'Send the release e-mail?', '--waiting']);
  assert.equal(w.json.status, 'waiting');
  let l = cli(dir, ['backlog']);
  assert.equal(l.json.count, 2);
  assert.equal(l.json.items[0].id, w.json.id, 'waiting first');
  assert.equal(cli(dir, ['resolve', a.json.id, '--as', 'confirmed']).code, 0);
  l = cli(dir, ['backlog']);
  assert.equal(l.json.count, 1);
  assert.equal(cli(dir, ['backlog', '--all']).json.count, 2);
  assert.equal(cli(dir, ['resolve', 'q-nope', '--as', 'confirmed']).code, 1);
  assert.equal(cli(dir, ['resolve', a.json.id, '--as', 'maybe']).code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('notify command runs on a flip and on a waiting entry, with the event appended', () => {
  const log = path.join(os.tmpdir(), `presence-notify-${process.pid}-${Date.now()}.log`);
  const dir = sandbox({ notify: { command: [process.execPath, FAKE_NOTIFY], on: ['away', 'waiting'], timeoutMs: 5000 } });
  hook(dir, ups('/away'), { NOTIFY_LOG: log });
  cli(dir, ['ask', '--question', 'Pay the invoice?', '--waiting'], { NOTIFY_LOG: log });
  cli(dir, ['ask', '--question', 'Rename the file?'], { NOTIFY_LOG: log });
  cli(dir, ['set', 'present', '--said', 'back now'], { NOTIFY_LOG: log });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => c.event), ['away', 'waiting']);
  assert.deepEqual(calls[1].argv, ['waiting']);
  assert.equal(calls[1].text, 'Pay the invoice?');
  fs.rmSync(log, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fails open: malformed stdin, empty stdin, other events and a broken config', () => {
  const dir = sandbox();
  for (const input of ['not json', '', '[]', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })]) {
    const r = hook(dir, input);
    assert.equal(r.code, 0, `input ${input}`);
    assert.equal(r.out, '', `input ${input}`);
  }
  fs.writeFileSync(path.join(dir, 'presence.config.json'), '{broken');
  const r = hook(dir, { session_id: 'z', hook_event_name: 'SessionStart' });
  assert.equal(r.code, 0);
  assert.match(ctx(r), /PRESENT/, 'a broken config falls back to the defaults');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--help prints usage and exits 0', () => {
  const dir = sandbox();
  const r = cli(dir, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /presence\.mjs set away/);
  fs.rmSync(dir, { recursive: true, force: true });
});
