// Offline tests: synthetic transcripts, the hook run as a child process with fixture stdin JSON. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { asksPossibility, mergeConfig, readTranscriptTail, judgeTurn } from '../dismissal-watch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'dismissal-watch.mjs');
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dismissal-watch-test-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const STATE = tmp();
function run(input, { state = STATE, config = null, raw = false } = {}) {
  const env = { ...process.env, HEADLESS_KIT_STATE_DIR: state };
  delete env.DISMISSAL_WATCH_CONFIG;
  if (config) {
    const p = path.join(tmp(), 'cfg.json');
    fs.writeFileSync(p, typeof config === 'string' ? config : JSON.stringify(config));
    env.DISMISSAL_WATCH_CONFIG = p;
  }
  const t = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: raw ? input : JSON.stringify(input), encoding: 'utf8', env, windowsHide: true, timeout: 20000 });
  assert.equal(r.status, 0, 'always exits 0');
  return { out: r.stdout, json: r.stdout ? JSON.parse(r.stdout) : null, ms: Date.now() - t };
}

const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const used = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] } });

let n = 0;
function stop(entries, { sid = 'watch-' + (++n), extra = {}, ...opts } = {}) {
  const tp = path.join(tmp(), sid + '.jsonl');
  fs.writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { r: run({ hook_event_name: 'Stop', transcript_path: tp, session_id: sid, stop_hook_active: false, ...extra }, opts), sid, tp };
}
const ASK = 'can i run a desktop OS on an android tablet';
const NO = "Sadly that's impossible: the bootloader is locked and signed.";
const warned = (r) => /\[dismissal-watch\]/.test(r.json?.systemMessage || '');

test('warns when the reply dismisses a possibility question and no search ran', () => {
  const { r, sid } = stop([user(ASK), said(NO)]);
  assert.ok(warned(r), r.out);
  assert.ok(!('decision' in r.json), 'warn mode never blocks');
  assert.ok(!('hookSpecificOutput' in r.json), 'warn mode never continues the conversation');
  assert.ok(fs.existsSync(path.join(STATE, 'dismissal-watch', sid)), 'leaves a note for the next prompt');
  const next = run({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'ok thanks' });
  assert.match(next.json.hookSpecificOutput.additionalContext, /\[dismissal-watch\]/);
  assert.equal(next.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(!fs.existsSync(path.join(STATE, 'dismissal-watch', sid)), 'the note is delivered once');
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'next' }).out, '');
});

test('a search in the same turn silences it (WebSearch, WebFetch, browser read, gh search, research skill, web brief)', () => {
  const searches = [
    used('WebSearch', { query: 'desktop OS on android' }),
    used('WebFetch', { url: 'https://example.com' }),
    used('mcp__playwright__browser_navigate', { url: 'https://github.com/search' }),
    used('mcp__claude-in-chrome__get_page_text', {}),
    used('mcp__brave-search__brave_web_search', { query: 'x' }),
    used('Bash', { command: 'gh search repos "desktop on android"' }),
    used('Bash', { command: 'curl -s https://api.github.com/search/repositories?q=x' }),
    used('Skill', { skill: 'research' }),
    used('Agent', { prompt: 'Do a web search and search GitHub for projects that do this' }),
  ];
  for (const s of searches) {
    const { r } = stop([user(ASK), s, toolResult(), said(NO)]);
    assert.equal(r.out, '', `${s.message.content[0].name} should count as a search`);
  }
});

test('tool calls that are not searches are not credited', () => {
  const notSearches = [
    used('mcp__claude-in-chrome__tabs_context_mcp', {}),
    used('mcp__playwright__browser_take_screenshot', {}),
    used('Agent', { prompt: 'search the repo for the webhook handler in the web app' }),
    used('Bash', { command: 'grep -rn impossible src/' }),
    used('Read', { file_path: 'README.md' }),
  ];
  for (const s of notSearches) {
    const { r } = stop([user(ASK), s, toolResult(), said(NO)]);
    assert.ok(warned(r), `${s.message.content[0].name} should not count: ${r.out}`);
  }
});

test('a search in an EARLIER turn does not count', () => {
  const { r } = stop([user(ASK), used('WebSearch', { query: 'x' }), toolResult(), said('Here is what I found.'), user('and could i run it on a watch?'), said(NO)]);
  assert.ok(warned(r));
});

test('silent when the reply does not dismiss, says "not impossible", or only quotes the word', () => {
  assert.equal(stop([user(ASK), said('Yes, roughly: three projects do this. Here is the path.')]).r.out, '');
  assert.equal(stop([user(ASK), said("It's not impossible, but it is hard. Here is what exists.")]).r.out, '');
  assert.equal(stop([user(ASK), said('The tool prints `not possible` when it refuses, and the log line reads "impossible state".')]).r.out, '');
  assert.equal(stop([user(ASK), said('```\nError: impossible\n```\nThat error came from the old build; here is a fix.')]).r.out, '');
});

test('flags the wider set of dismissal phrases', () => {
  for (const phrase of ['That can’t be done on stock firmware.', 'That is unrealistic for one developer.', 'Sadly that is not doable.', "It isn’t feasible.", 'This cannot be done.']) {
    const { r } = stop([user('could we somehow do this on the phone'), said(phrase)]);
    assert.ok(warned(r), phrase);
  }
});

test('by default only fires when the prompt asked whether something can be done', () => {
  assert.equal(stop([user('rename the folder'), said('Renaming it is impossible while the hook holds the lock.')]).r.out, '');
  const { r } = stop([user('rename the folder'), said('Renaming it is impossible while the hook holds the lock.')], { config: { requirePossibilityPrompt: false } });
  assert.ok(warned(r), 'with requirePossibilityPrompt false it fires on any prompt');
});

test('possibility prompts: positives and routine requests', () => {
  const cfg = mergeConfig(null);
  for (const p of ['is it possible to boot linux off my phone', 'is there a way to get this on the tablet', 'would it be possible to mirror the screen onto my watch',
    'is this even feasible for a solo dev in a week', 'running stable diffusion on a raspberry pi, doable?', 'can it run on android', 'any way to do this offline?',
    'could we somehow boot from a usb stick', 'can i install macOS on the old laptop']) assert.ok(asksPossibility(p, cfg), p);
  for (const p of ['fix the failing test in auth.ts', 'commit and push', 'can you check the logs', 'can we commit this now', 'run the tests on the branch',
    'make it as fast as possible to the user', '<task-notification><status>completed</status></task-notification>', 'he said "is it possible"']) assert.ok(!asksPossibility(p, cfg), p);
});

test('last_assistant_message from the hook input wins over a lagging transcript', () => {
  const { r } = stop([user(ASK), said('Let me think.')], { extra: { last_assistant_message: NO } });
  assert.ok(warned(r));
  const ok = stop([user(ASK), said(NO)], { extra: { last_assistant_message: 'Here is what exists: two projects.' } });
  assert.equal(ok.r.out, '');
});

test('opt-in modes: feedback continues via additionalContext, block via decision; both respect stop_hook_active', () => {
  const fb = stop([user(ASK), said(NO)], { config: { mode: 'feedback' } });
  assert.equal(fb.r.json.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(fb.r.json.hookSpecificOutput.additionalContext, /\[dismissal-watch\]/);
  assert.ok(!('decision' in fb.r.json));
  const bl = stop([user(ASK), said(NO)], { config: { mode: 'block' } });
  assert.equal(bl.r.json.decision, 'block');
  assert.match(bl.r.json.reason, /Search/);
  const again = stop([user(ASK), said(NO)], { config: { mode: 'block' }, extra: { stop_hook_active: true } });
  assert.equal(again.r.out, '', 'never blocks twice in a row');
  const bogus = stop([user(ASK), said(NO)], { config: { mode: 'nonsense' } });
  assert.ok(warned(bogus.r) && !('decision' in bogus.r.json), 'an unknown mode falls back to warn');
});

test('config: custom phrases, search tools and message', () => {
  const config = { dismissalPatterns: ['\\bno chance\\b'], searchTools: { names: ['MyLookup'] }, message: '[dismissal-watch] custom' };
  const a = stop([user(ASK), said('No chance on that hardware.')], { config });
  assert.equal(a.r.json.systemMessage, '[dismissal-watch] custom');
  assert.equal(stop([user(ASK), said(NO)], { config }).r.out, '', 'the default phrases were replaced');
  assert.equal(stop([user(ASK), used('MyLookup', {}), toolResult(), said('No chance.')], { config }).r.out, '');
  assert.ok(warned(stop([user(ASK), said(NO)], { config: '{broken' }).r), 'a broken config falls back to defaults');
  const example = fs.readFileSync(path.join(HERE, '..', 'examples', 'config.example.json'), 'utf8');
  assert.ok(warned(stop([user(ASK), said(NO)], { config: example }).r), 'the example config works');
});

test('notes: stale notes are pruned on write; an invalid session id warns but writes nothing', () => {
  const state = tmp();
  const dir = path.join(state, 'dismissal-watch');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'old-note'); const fresh = path.join(dir, 'fresh-note');
  fs.writeFileSync(old, 'x'); fs.writeFileSync(fresh, 'x');
  const eightDays = new Date(Date.now() - 8 * 864e5);
  fs.utimesSync(old, eightDays, eightDays);
  stop([user(ASK), said(NO)], { state });
  assert.ok(!fs.existsSync(old) && fs.existsSync(fresh));
  const before = fs.readdirSync(dir).length;
  const { r } = stop([user(ASK), said(NO)], { state, sid: 'x', extra: { session_id: '../evil' } });
  assert.ok(warned(r));
  assert.equal(fs.readdirSync(dir).length, before);
  assert.ok(!fs.existsSync(path.join(state, 'evil')));
  const off = stop([user(ASK), said(NO)], { state, sid: 'nodeliver', config: { deliverOnNextPrompt: false } });
  assert.ok(warned(off.r) && !fs.existsSync(path.join(dir, 'nodeliver')));
});

test('tail read: a prompt 3 MB back is found by doubling the window; a 30 MB transcript stays fast', () => {
  const dir = tmp();
  const filler = JSON.stringify(toolResult()).replace('"ok"', JSON.stringify('x'.repeat(8000))) + '\n';
  function big(file, mb, promptBackMb) {
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, JSON.stringify(user('an ancient prompt')) + '\n');
    const total = Math.floor((mb << 20) / filler.length);
    const after = Math.floor((promptBackMb << 20) / filler.length);
    for (let i = 0; i < total - after; i++) fs.writeSync(fd, filler);
    fs.writeSync(fd, JSON.stringify(user(ASK)) + '\n');
    for (let i = 0; i < after; i++) fs.writeSync(fd, filler);
    fs.writeSync(fd, JSON.stringify(said(NO)) + '\n');
    fs.closeSync(fd);
  }
  const deep = path.join(dir, 'deep.jsonl');
  big(deep, 6, 3);
  const j = judgeTurn(readTranscriptTail(deep), mergeConfig(null));
  assert.ok(j.foundPrompt && j.prompt === ASK && j.dismissed);
  const large = path.join(dir, 'large.jsonl');
  big(large, 30, 0);
  const r = run({ hook_event_name: 'Stop', transcript_path: large, session_id: 'perf', stop_hook_active: false });
  assert.ok(warned(r));
  assert.ok(r.ms < 2000, `took ${r.ms} ms`);
});

test('fails open: malformed or unrelated input, a missing or directory transcript give no output and exit 0', () => {
  assert.equal(run('not json', { raw: true }).out, '');
  assert.equal(run('', { raw: true }).out, '');
  assert.equal(run('null', { raw: true }).out, '');
  assert.equal(run({ hook_event_name: 'Stop', transcript_path: path.join(tmp(), 'nope.jsonl'), session_id: 'z' }).out, '');
  assert.equal(run({ hook_event_name: 'Stop', transcript_path: tmp(), session_id: 'z' }).out, '');
  assert.equal(run({ hook_event_name: 'Stop', session_id: 'z' }).out, '');
  assert.equal(run({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }).out, '');
});

test('--help and --judge work as a CLI', () => {
  const h = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /warn \(default/);
  const { tp } = stop([user(ASK), said(NO)]);
  const j = spawnSync(process.execPath, [HOOK, '--judge', tp], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HEADLESS_KIT_STATE_DIR: tmp() } });
  assert.deepEqual(JSON.parse(j.stdout), { dismissed: true, searched: false, asksPossibility: true, warn: true });
});
