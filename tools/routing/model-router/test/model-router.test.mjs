// Offline tests: fixtures only, a fixed clock, no network, no keys. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, normaliseConfig, decide, cycleBounds, windowState, scanText, urgency, UsageError } from '../model-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'model-router.mjs');
const EXAMPLES = path.join(HERE, '..', 'examples');
const NOW = Date.parse('2026-11-19T08:00:00Z');
const at = (minAgo = 5) => new Date(NOW - minAgo * 60e3).toISOString();

const api = (name, over = {}) => ({ name, kind: 'api', models: { '*': 'medium-model' }, budget: 100, cycle: { monthlyResetDay: 24 }, ...over });
const route = (pools, usage, opts = {}, extra = {}) => decide({ task: 'bulk', files: [], ...opts }, normaliseConfig({ pools, ...extra }), usage, opts.clock ?? NOW);

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MODEL_ROUTER_CONFIG: '', MODEL_ROUTER_USAGE: '', MODEL_ROUTER_NOW: '', ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* left null */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-')); }

test('urgency: the pool nearer its reset ranks first when both are equally behind', () => {
  // Both cycles are 30 days long and both pools are behind by the same share; "soon" resets in about 2 days, "later" in about 20.
  const pools = [
    api('later', { cycle: { periodDays: 30, anchor: '2026-11-09T08:00:00Z' } }), // started 10 days ago
    api('soon', { cycle: { periodDays: 30, anchor: '2026-10-22T08:00:00Z' } }),  // started 28 days ago
  ];
  const usage = { later: { used: 33.33 * 0.5, at: at() }, soon: { used: 93.33 * 0.5, at: at() } };
  const { out, table, exit } = route(pools, usage, {}, { finalWindowDays: 0 });
  assert.equal(exit, 0);
  assert.deepEqual(out.chain, ['soon', 'later']);
  const u = Object.fromEntries(table.map((r) => [r.pool, r.urgency]));
  assert.ok(u.soon > u.later * 5, `soon ${u.soon} should be far above later ${u.later}`);
  // The formula itself: 10 behind, 10 h left, budget 100 -> 10/10/100*168 = 1.68; under 1 h counts as 1 h.
  assert.equal(urgency(50, 40, 10, 100), 1.68);
  assert.equal(urgency(50, 40, 0.2, 100), urgency(50, 40, 1, 100));
  assert.equal(urgency(40, 50, 10, 100), 0);
});

test('final window lifts a behind API pool above a free pool; outside it the free pool wins', () => {
  const free = { name: 'free', kind: 'free', models: { '*': 'small-model' } };
  const usage = { 'api-a': { used: 40, at: at() } };
  // 19 Nov, resets on the 24th: final 7 days, behind its line -> tier 2.
  assert.deepEqual(route([api('api-a'), free], usage).out.chain, ['api-a', 'free']);
  // Resets on the 13th: 24 days away, only slightly behind -> tier 1, urgency below the free pool's 0.2.
  const r = route([api('api-a', { cycle: { monthlyResetDay: 13 } }), free], { 'api-a': { used: 18, at: at() } });
  assert.deepEqual(r.out.chain, ['free', 'api-a']);
});

test('ties within the margin go to the earliest reset, then the cheaper pool', () => {
  const pools = [api('x', { cost: 5, cycle: { monthlyResetDay: 13 } }), api('y', { cost: 1, cycle: { monthlyResetDay: 13 } }), api('z', { cost: 9 })];
  const usage = { x: { used: 10, at: at() }, y: { used: 10, at: at() }, z: { used: 84, at: at() } };
  const { out } = route(pools, usage, {}, { finalWindowDays: 0, tieMargin: 1 });
  assert.deepEqual(out.chain, ['z', 'y', 'x']); // z resets first; x and y share a reset, y is cheaper
});

test('private work is refused by pools without "private": true', () => {
  const pools = [api('api-a'), { name: 'trusted', kind: 'subscription', private: true, models: { '*': 'large-model' }, budget: 100, cycle: { periodDays: 7, anchor: '2026-11-13T02:00:00Z' } }, { name: 'local', kind: 'local', models: { '*': 'local-8b' } }];
  const usage = { 'api-a': { used: 40, at: at() }, trusted: { used: 10, at: at() } };
  const { out, table, exit } = route(pools, usage, { private: true });
  assert.equal(exit, 0);
  assert.equal(out.private, true);
  assert.deepEqual(out.chain, ['trusted', 'local']);
  assert.match(table.find((r) => r.pool === 'api-a').reason, /not allowed private data/);
  // Not private: the local pool is kept for private work only.
  assert.ok(!route(pools, usage).out.chain.includes('local'));
  // No private pool at all: nothing can take it (exit 4), and the API pool is still not used.
  const none = route([api('api-a')], usage, { private: true });
  assert.equal(none.exit, 4);
  assert.equal(none.out.pool, null);
});

test('stale or missing readings: exit 3 when nothing else can take the work', () => {
  const pools = [api('api-a'), api('api-b')];
  const r = route(pools, { 'api-a': { used: 10, at: at(45) } });
  assert.equal(r.exit, 3);
  assert.equal(r.out.stale, true);
  assert.deepEqual(r.out.stale_pools, ['api-a', 'api-b']);
  assert.equal(r.out.freshness.find((f) => f.pool === 'api-a').state, 'stale');
  assert.equal(r.out.freshness.find((f) => f.pool === 'api-b').state, 'missing');
  // A free pool can still take it: exit 0, with a warning that the stale pools were left out.
  const ok = route([...pools, { name: 'free', kind: 'free', models: { '*': 'small-model' } }], { 'api-a': { used: 10, at: at(45) } });
  assert.equal(ok.exit, 0);
  assert.equal(ok.out.pool, 'free');
  assert.ok(ok.out.warnings.some((w) => /api-a left out: stale/.test(w)));
  // A static number in the config never goes stale.
  assert.equal(route([api('api-a', { used: 10 })], {}).out.pool, 'api-a');
});

test('a reading from a cycle that has since reset counts as 0 used', () => {
  // Read on 23 Nov 23:50, the cycle reset at 24 Nov 00:00, now 24 Nov 00:10: within staleMinutes, but expired.
  const clock = Date.parse('2026-11-24T00:10:00Z');
  const r = route([api('api-a')], { 'api-a': { used: 99, at: '2026-11-23T23:50:00Z' } }, { clock });
  assert.equal(r.exit, 0);
  assert.equal(r.table[0].used, 0);
  assert.equal(r.out.freshness[0].state, 'expired');
});

test('batch: on for a batch-capable pick; off for --now, --human-waiting and a reset under batchMinHours', () => {
  const usage = { 'api-a': { used: 40, at: at() } };
  assert.equal(route([api('api-a')], usage).out.batch, true);
  const now = route([api('api-a')], usage, { now: true }).out;
  assert.equal(now.batch, false);
  assert.match(now.why, /real-time: --now/);
  assert.equal(route([api('api-a')], usage, { humanWaiting: true }).out.batch, false);
  const late = route([api('api-a')], { 'api-a': { used: 40, at: '2026-11-23T07:55:00Z' } }, { clock: Date.parse('2026-11-23T08:00:00Z') }).out; // 16 h to the reset
  assert.equal(late.batch, false);
  assert.match(late.why, /under 26 h/);
  assert.equal(route([api('api-a', { batch: false })], usage).out.batch, false);
});

test('a subscription ahead of its line is a last resort; behind it, it burns first', () => {
  const sub = { name: 'sub', kind: 'subscription', models: { '*': 'large-model' }, budget: 100, cycle: { periodDays: 7, anchor: '2026-11-13T02:00:00Z' } };
  const ahead = route([sub], { sub: { used: 95, at: at() } });
  assert.equal(ahead.out.pool, 'sub');
  assert.ok(ahead.out.warnings.some((w) => /last resort/.test(w)));
  const free = { name: 'free', kind: 'free', models: { '*': 'small-model' } };
  assert.deepEqual(route([sub, free], { sub: { used: 95, at: at() } }).out.chain, ['free']);
  assert.deepEqual(route([sub, free], { sub: { used: 20, at: at() } }).out.chain, ['sub', 'free']);
  // The short-window ceiling takes it out until that window resets.
  const s2 = { ...sub, shortWindowCeiling: 90 };
  assert.deepEqual(route([s2, free], { sub: { used: 20, at: at(), shortWindowPct: 95, shortWindowResetsAt: '2026-11-19T09:00:00Z' } }).out.chain, ['free']);
  assert.deepEqual(route([s2, free], { sub: { used: 20, at: at(), shortWindowPct: 95, shortWindowResetsAt: '2026-11-19T07:00:00Z' } }).out.chain, ['sub', 'free']);
});

test('blocks: blockedUntil takes a pool out until then; blockedModels falls through to the next model', () => {
  const free = { name: 'free', kind: 'free', models: { bulk: ['fast', 'slow'] } };
  assert.equal(route([free], { free: { blockedModels: ['fast'] } }).out.model, 'slow');
  assert.equal(route([free], { free: { blockedModels: ['fast', 'slow'] } }).exit, 4);
  assert.equal(route([free], { free: { blockedUntil: '2026-11-19T09:00:00Z' } }).exit, 4);
  assert.equal(route([free], { free: { blockedUntil: '2026-11-19T07:00:00Z' } }).exit, 0);
  assert.equal(route([free], {}, { task: 'judgement' }, { tasks: ['bulk', 'judgement'] }).exit, 4); // no model for the task
});

test('time windows: wrap past midnight, --minutes must fit, no new starts after a cut-off', () => {
  const win = (start, end, more = {}) => ({ startMin: +start.slice(0, 2) * 60 + +start.slice(3), endMin: +end.slice(0, 2) * 60 + +end.slice(3), offsetMin: 0, ...more });
  const t = (hhmm) => Date.parse(`2026-11-19T${hhmm}:00Z`);
  assert.equal(windowState(win('22:00', '06:00'), t('23:30')).open, true);
  assert.equal(windowState(win('22:00', '06:00'), t('03:00')).open, true);
  assert.equal(windowState(win('22:00', '06:00'), t('12:00')).open, false);
  assert.equal(windowState(win('01:00', '06:00'), t('05:00'), 90).open, false);
  assert.equal(windowState(win('01:00', '06:00'), t('05:00'), 30).open, true);
  assert.equal(windowState(win('01:00', '06:00', { noStartAfterMin: 300 }), t('05:10')).open, false);
  // +08:00: 01:00-06:00 local is 17:00-22:00 UTC.
  assert.equal(windowState(win('01:00', '06:00', { offsetMin: 480 }), t('18:00')).open, true);
  // Through the router: a closed window is a refusal, not a stale reading.
  const r = route([{ name: 'night', kind: 'free', models: { '*': 'm' }, window: { start: '01:00', end: '06:00' } }], {});
  assert.equal(r.exit, 4);
  assert.match(r.table[0].reason, /outside its window/);
});

test('cycleBounds: monthly resets clamp to short months and honour the offset; periodic cycles roll from the anchor', () => {
  const feb = cycleBounds({ monthlyResetDay: 31 }, Date.parse('2027-02-15T00:00:00Z'));
  assert.equal(new Date(feb.start).toISOString(), '2027-01-31T00:00:00.000Z');
  assert.equal(new Date(feb.end).toISOString(), '2027-02-28T00:00:00.000Z');
  const plus8 = cycleBounds({ monthlyResetDay: 24 }, Date.parse('2026-11-23T17:00:00Z'), 480); // 24 Nov 01:00 at +08:00
  assert.equal(new Date(plus8.start).toISOString(), '2026-11-23T16:00:00.000Z');
  const wk = cycleBounds({ periodDays: 7, anchor: '2026-01-01T00:00:00Z' }, NOW);
  assert.equal(wk.end - wk.start, 7 * 864e5);
  assert.ok(wk.start <= NOW && NOW < wk.end);
});

test('content scan reports type and line, never the value; allow-listed e-mails and custom patterns', () => {
  const fake = ['sk', 'ant', 'api03', 'FAKE0000000000000000test'].join('-'); // built at runtime: no key-shaped literal in the repo
  const text = `notes\nANTHROPIC_API_KEY=${fake}\nmail someone@example.com or boss@corp.test\nref CUST-123456\n`;
  const hits = scanText(text, 'notes.txt', { allowEmails: ['example.com'], compiled: [['customer-id', /\bCUST-[0-9]{6}\b/g]] });
  assert.deepEqual(hits.map((h) => [h.type, h.line]), [['anthropic-key', 2], ['env-secret', 2], ['email', 3], ['customer-id', 4]]);
  assert.ok(!JSON.stringify(hits).includes(fake));
  assert.ok(!JSON.stringify(hits).includes('boss@'));
});

test('CLI: a scanned file with a fake key routes as private and never echoes the key', () => {
  const dir = tmpDir();
  const fake = ['sk', 'ant', 'api03', 'FAKEKEYFORTESTS000000000000'].join('-');
  const file = path.join(dir, 'brief.md');
  fs.writeFileSync(file, `Summarise this.\nkey: ${fake}\n`);
  const base = ['--task', 'bulk', '--config', path.join(EXAMPLES, 'config.example.json'), '--at', '2026-11-19T08:00:00Z', '--files', file, '--explain'];
  const r = cli(base);
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes(fake) && !r.err.includes(fake), 'the key value must not appear in any output');
  assert.equal(r.json.private, true);
  assert.deepEqual(r.json.scan, [{ type: 'anthropic-key', line: 2, source: 'brief.md' }]);
  assert.ok(!r.json.chain.includes('api-main'));
  // After checking it, --ack-scan routes as normal (to the final-week API pool, Batch).
  const ack = cli([...base, '--ack-scan']);
  assert.equal(ack.json.pool, 'api-main');
  assert.equal(ack.json.batch, true);
  assert.ok(!ack.out.includes(fake) && !ack.err.includes(fake));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: the example config routes bulk to api-main with a ranked chain', () => {
  const r = cli(['--task', 'bulk', '--at', '2026-11-19T08:00:00Z', '--explain'], { MODEL_ROUTER_CONFIG: path.join(EXAMPLES, 'config.example.json') });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.chain, ['api-main', 'free-tier', 'api-team']);
  assert.equal(r.json.fallback, 'free-tier');
  assert.match(r.err, /rank\s+pool/);
  assert.equal(r.out.trim().split('\n').length, 1, 'stdout is exactly one JSON line');
});

test('CLI: stale usage file -> exit 3', () => {
  const dir = tmpDir();
  const cfg = path.join(dir, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ usageFile: './u.json', pools: [api('api-a')] }));
  fs.writeFileSync(path.join(dir, 'u.json'), JSON.stringify({ 'api-a': { used: 1, at: '2026-11-19T06:00:00Z' } }));
  const r = cli(['--task', 'bulk', '--config', cfg, '--at', '2026-11-19T08:00:00Z']);
  assert.equal(r.code, 3);
  assert.equal(r.json.stale, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bad usage -> exit 2 with a JSON error', () => {
  const cfg = path.join(EXAMPLES, 'config.example.json');
  for (const args of [[], ['--task', 'bulk'], ['--task', 'nope', '--config', cfg], ['--task', 'bulk', '--config', cfg, '--bogus'],
    ['--task', 'bulk', '--config', cfg, '--minutes', 'abc'], ['--task', 'bulk', '--config', path.join(EXAMPLES, 'missing.json')], ['--task']]) {
    const r = cli(args);
    assert.equal(r.code, 2, `args ${args.join(' ')}: ${r.out}`);
    assert.ok(r.json && typeof r.json.error === 'string', `args ${args.join(' ')}`);
  }
  assert.throws(() => normaliseConfig({ pools: [{ name: 'a', kind: 'api', models: { '*': 'm' } }] }), /budget/);
  assert.throws(() => normaliseConfig({ pools: [{ name: 'a', kind: 'robot', models: {} }] }), /kind/);
  assert.throws(() => normaliseConfig({ pools: [api('a'), api('a')] }), /twice/);
  assert.throws(() => parseArgs(['--at', 'yesterday']), UsageError);
  const help = cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /usage: node model-router.mjs/);
});
