// Unit tests for the phrase detector, quiet hours and the backlog store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detect, humanText, presence, setPresence, inQuietHours, addEntry, readBacklog, resolveEntry, backlogCounts,
  DEFAULT_CONFIG, render, loadConfig,
} from '../presence.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'presence-unit-'));

const cases = (rows) => { for (const [prompt, want] of rows) assert.equal(detect(prompt), want, JSON.stringify(prompt)); };

test('real phrases flip', () => cases([
  ["I'm going to sleep", 'away'],
  ['Im going to bed, finish the build', 'away'],
  ['ok going to sleep now, keep at the queue', 'away'],
  ['Going to bed. Do the queue.', 'away'],
  ["I'll be away for the afternoon", 'away'],
  ['I am going to be away until Monday', 'away'],
  ['Good night', 'away'],
  ["I'm back", 'present'],
  ["ok I'm back, what did you find?", 'present'],
  ['back now', 'present'],
  ['Back.', 'present'],
  ["I'm back from dinner", 'present'],
]));

test('slash commands, bare, namespaced and wrapped', () => cases([
  ['/back', 'present'],
  ['/away', 'away'],
  ['/away  dinner then bed', 'away'],
  ['/headless-kit:away', 'away'],
  ['/headless-kit:back  ', 'present'],
  ['<command-name>/back</command-name>\n<command-message>back</command-message>', 'present'],
  ['/backup the database', null],
  ['/away-mode please', null],
  ['/humanizer  Would you like to try improving this', null],
]));

test('sentences ABOUT the phrase, and machine text, do not flip', () => cases([
  ["when I say 'I'm going to sleep' the file should flip", null],
  ['When I say "I am going to sleep" the file should flip to away.', null],
  ['The toast is heading out of view on mobile, fix it', null],
  ['good night mode toggle should dim the page', null],
  ['My laptop keeps going to sleep when the lid closes, can you fix the power plan?', null],
  ["quote:\n> I'm going to sleep", null],
  ["<foo>unclosed I'm going to sleep", null],
  ["<task-notification>agent says: I'm going to sleep</task-notification>", null],
  ['the hook keys on `I\'m going to sleep` in the prompt', null],
  ["I'm here to ask about the footer bug", null],
  ['revert it, go back now to the old layout', null],
  ["I'm back to the problem from yesterday: the build fails", null],
]));

test('both kinds in one prompt: the last wins; a future "back" does not count', () => cases([
  ["I'm going to sleep. I'm back at 8 so do the queue", 'away'],
  ["I'm going to bed, back tomorrow, I'm back in the morning", 'away'],
  ["I was going to say I'm going to sleep, but no: I'm back, carry on", 'present'],
]));

test('phrases can be switched off and extended', () => {
  const off = { ...DEFAULT_CONFIG, phrases: { enabled: false } };
  assert.equal(detect("I'm going to sleep", off), null);
  assert.equal(detect('/away', off), 'away');
  const extra = { ...DEFAULT_CONFIG, phrases: { enabled: true, extraAway: ['\\bheading home\\b', '(bad['], extraBack: [] } };
  assert.equal(detect('ok heading home now', extra), 'away');
});

test('humanText is linear on hostile input', () => {
  const code = 'if (a<b && c<d) { x = y; }\n'.repeat(8000) + "I'm going to sleep";
  let t = Date.now();
  assert.equal(detect(code), 'away');
  assert.ok(Date.now() - t < 1000, '216 KB of code classified quickly');
  t = Date.now();
  humanText(('<ax' + 'x'.repeat(20) + ' ').repeat(20000));
  assert.ok(Date.now() - t < 1000, '20k unclosed tags stripped quickly');
});

test('quiet hours: window, wrap past midnight, recent typing overrides', () => {
  const cfg = { ...DEFAULT_CONFIG, quietHours: { enabled: true, from: 23, to: 8, utcOffsetMinutes: 0, activeMinutes: 30 } };
  assert.equal(inQuietHours(cfg, Date.parse('2026-01-01T23:30:00Z')), true);
  assert.equal(inQuietHours(cfg, Date.parse('2026-01-01T07:59:00Z')), true);
  assert.equal(inQuietHours(cfg, Date.parse('2026-01-01T08:00:00Z')), false);
  assert.equal(inQuietHours({ ...cfg, quietHours: { ...cfg.quietHours, utcOffsetMinutes: 480 } }, Date.parse('2026-01-01T16:00:00Z')), true);
  assert.equal(inQuietHours(DEFAULT_CONFIG, Date.parse('2026-01-01T23:30:00Z')), false, 'off by default');
  const dir = tmp();
  const file = path.join(dir, 'presence.json');
  fs.writeFileSync(file, JSON.stringify({ state: 'present', lastPromptAt: '2026-01-01T23:10:00Z' }));
  assert.equal(presence(file, cfg, Date.parse('2026-01-01T23:30:00Z')).state, 'present', 'typed 20 min ago');
  const p = presence(file, cfg, Date.parse('2026-01-02T01:00:00Z'));
  assert.equal(p.state, 'away');
  assert.equal(p.quiet, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing or corrupt state reads as present (fails open)', () => {
  const dir = tmp();
  assert.equal(presence(path.join(dir, 'none.json')).state, 'present');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.equal(presence(path.join(dir, 'bad.json')).state, 'present');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setPresence writes whole JSON atomically, no temp file left', () => {
  const dir = tmp();
  const file = path.join(dir, 'presence.json');
  setPresence(file, 'away', 'x', 's');
  assert.equal(presence(file).state, 'away');
  assert.deepEqual(fs.readdirSync(dir), ['presence.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backlog: add, count, resolve, skip bad lines', () => {
  const dir = tmp();
  const file = path.join(dir, 'b.jsonl');
  const a = addEntry(file, { question: 'Blue or green header?', assumed: 'blue', built: 'header.css', reverse: 'git revert abc' });
  const w = addEntry(file, { question: 'Publish the release?', waiting: true });
  fs.appendFileSync(file, 'garbage line\n');
  assert.deepEqual(backlogCounts(file), { open: 1, waiting: 1 });
  assert.equal(resolveEntry(file, a.id, 'confirmed').status, 'confirmed');
  assert.equal(resolveEntry(file, 'nope', 'confirmed'), null);
  assert.deepEqual(backlogCounts(file), { open: 0, waiting: 1 });
  assert.equal(readBacklog(file).find((i) => i.id === w.id).status, 'waiting');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('render keeps unknown placeholders; config merges over defaults', () => {
  assert.equal(render('a {x} {y}', { x: 1 }), 'a 1 {y}');
  const dir = tmp();
  const cfgFile = path.join(dir, 'c.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ messages: { present: 'HERE' } }));
  const cfg = loadConfig(cfgFile);
  assert.equal(cfg.messages.present, 'HERE');
  assert.equal(cfg.messages.away, DEFAULT_CONFIG.messages.away);
  fs.writeFileSync(cfgFile, '{broken');
  assert.equal(loadConfig(cfgFile), DEFAULT_CONFIG);
  assert.throws(() => loadConfig(cfgFile, true));
  fs.rmSync(dir, { recursive: true, force: true });
});
