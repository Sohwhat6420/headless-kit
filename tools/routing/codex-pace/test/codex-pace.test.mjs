import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSTANTS, decide, fromSessions, normaliseSnapshot } from '../codex-pace.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'codex-pace.mjs');
const NOW = '2026-11-13T12:00:00Z';
const options = { now: Date.parse(NOW), memoryPercent: 20 };
function snapshot(primary = 20, secondary = 40) {
  return { taken_at: NOW, extra: 'ignored', primary: { used_percent: primary, window_minutes: 300, resets_at: '2026-11-13T13:00:00Z' }, secondary: { used_percent: secondary, window_minutes: 10080, resets_at: '2026-11-17T00:00:00Z' } };
}
function run(args = [], input = snapshot()) {
  const r = spawnSync(process.execPath, [script, '--now', NOW, '--memory-percent', '20', ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', windowsHide: true,
  });
  assert.ifError(r.error);
  return r;
}
function json(args = [], input = snapshot()) {
  const r = run(['--usage', '-', '--json', ...args], input);
  return { ...r, data: JSON.parse(r.stdout) };
}

test('rule 1: stale strictly after max age, before hard caps; urgent cannot bypass', () => {
  const s = snapshot(90, 97);
  s.taken_at = '2026-11-13T11:29:59Z';
  assert.equal(json(['--urgent'], s).status, 3);
  s.taken_at = '2026-11-13T11:30:00Z';
  assert.equal(json([], s).data.decision, 'hold');
  assert.equal(json(['--max-age-minutes', '29'], s).data.decision, 'stale');
});

test('rule 2: both hard cap boundaries, even urgent; just below is allowed urgent', () => {
  for (const s of [snapshot(90, 40), snapshot(20, 97), snapshot(100, 100)]) {
    const r = json(['--urgent'], s);
    assert.equal(r.status, 20);
    assert.match(r.data.reason, /hard cap/);
  }
  assert.equal(json(['--urgent'], snapshot(89.999, 96.999)).status, 0);
});

test('rule 3: weekly pace strict boundary, spare and reset hours, urgent bypass', () => {
  const boundary = snapshot(20, 60); // half the week gone => expected 50 + 10
  const r = json([], boundary);
  assert.equal(r.status, 0);
  assert.equal(r.data.expected_weekly, 50);
  assert.equal(r.data.spare_weekly, -10);
  assert.equal(r.data.hours_to_weekly_reset, 84);
  const over = snapshot(75, 60.001);
  assert.equal(json([], over).data.reason, 'over weekly pace');
  assert.equal(json(['--urgent'], over).status, 0);
  assert.equal(json().data.spare_weekly, 10);
});

test('rule 3: elapsed clamps to zero and one; expired reset time is zero', () => {
  const s = snapshot(20, 0);
  s.secondary.resets_at = '2026-12-01T00:00:00Z';
  assert.equal(json([], s).data.expected_weekly, 0);
  s.secondary.resets_at = '2026-11-12T00:00:00Z';
  const r = json([], s);
  assert.equal(r.data.expected_weekly, 100);
  assert.equal(r.data.hours_to_weekly_reset, 0);
});

test('rule 4: exactly 75 holds, below allows, urgent bypasses, reset minutes reported', () => {
  const r = json([], snapshot(75));
  assert.equal(r.status, 20);
  assert.equal(r.data.minutes_to_primary_reset, 60);
  assert.match(r.data.reason, /60 minutes/);
  assert.equal(json([], snapshot(74.999)).status, 0);
  assert.equal(json(['--urgent'], snapshot(75)).status, 0);
});

test('rule 5: cloud ignores local resources; local requires memory below 75 and no other run', () => {
  assert.equal(decide(snapshot(), { ...options, memoryPercent: 100, localRunning: 5 }).decision, 'cloud');
  assert.equal(json(['--needs-local']).status, 10);
  for (const memoryPercent of [75, 100]) {
    const d = decide(snapshot(), { ...options, needsLocal: true, memoryPercent });
    assert.equal(d.decision, 'hold');
    assert.match(d.reason, /memory/);
  }
  assert.equal(decide(snapshot(), { ...options, needsLocal: true, memoryPercent: 74.999 }).decision, 'local');
  const r = json(['--needs-local', '--local-running', '1', '--urgent']);
  assert.equal(r.status, 20);
  assert.match(r.data.reason, /Another local/);
  assert.equal(decide(snapshot(), { ...options, needsLocal: true, urgent: true, memoryPercent: 75 }).decision, 'hold');
});

test('rule 6: every decision has a single-line reason and the specified JSON numbers', () => {
  const cases = [json(), json(['--needs-local']), json([], snapshot(90)), json([], {})];
  const keys = ['decision', 'reason', 'primary_used', 'secondary_used', 'expected_weekly', 'spare_weekly', 'hours_to_weekly_reset', 'minutes_to_primary_reset', 'memory_percent', 'taken_at'];
  for (const r of cases) {
    assert.deepEqual(Object.keys(r.data), keys);
    assert.ok(r.data.reason.length > 0 && !r.data.reason.includes('\n'));
    assert.equal(r.stdout.trim().split('\n').length, 1);
  }
  const text = run(['--usage', '-']);
  const lines = text.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'cloud');
  assert.equal(JSON.parse(lines[2]).primary_used, 20);
});

test('missing or invalid fields are tolerated without guessing usage', () => {
  for (const s of [{}, { taken_at: NOW }, { ...snapshot(), secondary: null }, { ...snapshot(), taken_at: 'invalid' }]) {
    assert.equal(json([], s).status, 3);
  }
  const s = snapshot();
  s.primary.used_percent = '20';
  assert.equal(json([], s).data.primary_used, null);
  assert.equal(json([], s).status, 3);
});

test('session walk picks newest usable event in older-named nested file and skips broken lines', async () => {
  const dir = join(here, 'fixtures', 'sessions');
  const s = await fromSessions(dir);
  assert.equal(s.primary.used_percent, 21);
  assert.equal(s.taken_at, '2026-11-13T11:59:00.000Z');
  assert.equal(s.primary.resets_at, '2026-11-13T12:59:00.000Z');
  const r = run(['--from-sessions', dir, '--json']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).minutes_to_primary_reset, 59);
});

test('session folder with no limits exits 3', () => {
  const r = run(['--from-sessions', join(here, 'fixtures', 'no-limits'), '--json']);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).decision, 'stale');
});

test('absolute ISO, epoch seconds/milliseconds and relative reset aliases normalise', () => {
  const s = snapshot();
  const expected = normaliseSnapshot(s);
  for (const key of ['resets_in_seconds', 'reset_in_seconds', 'reset_after_seconds']) {
    const copy = snapshot();
    for (const [name, seconds] of [['primary', 3600], ['secondary', 302400]]) {
      delete copy[name].resets_at;
      copy[name][key] = seconds;
    }
    assert.deepEqual(normaliseSnapshot(copy), expected);
  }
  s.primary.resets_at = Date.parse(s.primary.resets_at) / 1000;
  s.secondary.resets_at = Date.parse(s.secondary.resets_at);
  assert.deepEqual(normaliseSnapshot(s), expected);
});

test('usage file, session absolute reset event and default session source work', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const usage = join(dir, 'usage.json');
  writeFileSync(usage, JSON.stringify(snapshot()));
  assert.equal(run(['--usage', usage]).status, 0);
  const sessions = join(dir, '.codex', 'sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'events.jsonl'), JSON.stringify({ timestamp: NOW, payload: { rate_limits: snapshot() } }));
  assert.equal((await fromSessions(sessions)).primary.resets_at, '2026-11-13T13:00:00.000Z');
  for (const args of [[], ['--from-sessions']]) {
    const r = spawnSync(process.execPath, [script, '--now', NOW, '--json', ...args], {
      env: { ...process.env, HOME: dir, USERPROFILE: dir }, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    const memory = JSON.parse(r.stdout).memory_percent;
    assert.ok(memory >= 0 && memory <= 100);
  }
});

test('bad arguments, unreadable input and invalid JSON exit 2', () => {
  for (const args of [
    ['--bogus'], ['--usage'], ['--now', 'tomorrow'], ['--memory-percent', '101'], ['--memory-percent', '-1'],
    ['--local-running', '0.5'], ['--local-running', '-1'], ['--max-age-minutes', 'NaN'],
    ['--usage', '-', '--from-sessions'], ['--usage', '-', '--usage', '-'], ['positional'],
    ['--usage', join(here, 'not-present.json')], ['--from-sessions', join(here, 'not-present')],
  ]) assert.equal(run(args).status, 2, args.join(' '));
  for (const input of ['broken JSON', '[]', 'null', '12']) assert.equal(run(['--usage', '-'], input).status, 2);
});

test('help exits zero and thresholds are exported together', () => {
  assert.equal(run(['--help']).status, 0);
  assert.equal(CONSTANTS.primaryHardCap, 90);
  assert.equal(CONSTANTS.secondaryHardCap, 97);
});
