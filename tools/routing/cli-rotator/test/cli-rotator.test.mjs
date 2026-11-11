// Offline tests: every run goes to test/fixtures/fake-cli.mjs, never to a real agent CLI. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateConfig, parseDuration, computeReset, benchState, usedInWindow, rotationOrder, accountStates,
  gateDecision, expectVerdict, snapshotExpect, parseArgs,
} from '../cli-rotator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli-rotator.mjs');
const FAKE = path.join(HERE, 'fixtures', 'fake-cli.mjs');

const TEMP = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TEMP.push(d); return d; };
test.after(() => { for (const d of TEMP) fs.rmSync(d, { recursive: true, force: true }); });

/** A temp dir with one fake account home per name, its behaviour, and a config pointing at the fake CLI. */
function world(behaviours, over = {}) {
  const dir = tmp('cli-rotator-test-');
  const names = Object.keys(behaviours);
  for (const n of names) {
    fs.mkdirSync(path.join(dir, 'homes', n), { recursive: true });
    fs.writeFileSync(path.join(dir, 'homes', n, 'behaviour.json'), JSON.stringify(behaviours[n]));
  }
  const cfg = {
    command: process.execPath,
    args: [FAKE, '-p', '{prompt}'],
    modelArgs: ['--model', '{model}'],
    modes: { yolo: ['--yolo'] },
    promptSuffix: '\nOUTPUT-PATH: {expect}\nSENTINEL: {sentinel}\n',
    scrubEnv: ['FAKE_PARENT_SECRET'],
    accounts: names.map((n) => ({ name: n, env: { FAKE_CLI_HOME: path.join(dir, 'homes', n) } })),
    dailyBudget: 50,
    memoryGate: { hotPct: 75, maxLanesWhenHot: 2, refusePct: 90 },
    stateDir: path.join(dir, 'state'),
    ...over,
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return {
    dir, configPath, cfg,
    out: (name = 'out.md') => path.join(dir, name),
    calls: (n) => { try { return fs.readFileSync(path.join(dir, 'homes', n, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } },
    ledger: () => { try { return fs.readFileSync(path.join(dir, 'state', 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } },
    seed: (rows) => { fs.mkdirSync(path.join(dir, 'state'), { recursive: true }); fs.writeFileSync(path.join(dir, 'state', 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); },
    setBehaviour: (n, b) => fs.writeFileSync(path.join(dir, 'homes', n, 'behaviour.json'), JSON.stringify(b)),
  };
}

function cli(w, args, env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [CLI, '--config', w.configPath, ...args], {
      windowsHide: true, env: { ...process.env, CLI_ROTATOR_MEM_PCT: '10', ...env },
    });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const last = out.trim().split('\n').pop();
      let json = null; try { json = JSON.parse(last); } catch { /* left null */ }
      resolve({ code, out, err, json, ms: Date.now() - t0 });
    });
  });
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ahead = (ms) => new Date(Date.now() + ms).toISOString();

// ── config validation ────────────────────────────────────────────────────────
test('config validation: a good config passes; each mistake is named', () => {
  const good = { command: 'gemini', args: ['-p', '{prompt}'], accounts: [{ name: 'a', env: { GEMINI_CLI_HOME: '~/h/a' } }] };
  assert.deepEqual(validateConfig(good).errors, []);
  const errs = (raw) => validateConfig(raw).errors.join('\n');
  assert.match(errs({ args: ['{prompt}'], accounts: [{ name: 'a' }] }), /"command" must be a non-empty string/);
  assert.match(errs({ ...good, command: 'gemini.cmd' }), /\.cmd\/\.bat shim/);
  assert.match(errs({ ...good, accounts: [] }), /"accounts" must be a non-empty array/);
  assert.match(errs({ ...good, accounts: [{ name: 'a' }, { name: 'a' }] }), /duplicate/);
  assert.match(errs({ ...good, accounts: [{ name: 'has space' }] }), /\.name must be/);
  assert.match(errs({ ...good, walls: ['(unclosed'] }), /walls\[0\] is not a valid regex/);
  assert.match(errs({ ...good, rotatOn: 'wall' }), /unknown key "rotatOn"/);
  assert.match(errs({ ...good, args: ['-p', '{promt}'] }), /unknown placeholder \{promt\}/);
  assert.match(errs({ ...good, args: ['-p'] }), /no \{prompt\} placeholder/);
  assert.match(errs({ ...good, dailyBudget: 0 }), /"dailyBudget" must be a positive integer/);
  assert.match(errs({ ...good, memoryGate: { hotPct: 95, refusePct: 80 } }), /hotPct must not be above refusePct/);
  assert.match(errs({ ...good, reset: { dailyAtUtc: '25:00' } }), /dailyAtUtc must be "HH:MM"/);
  assert.match(errs({ ...good, accounts: [{ name: 'a', key: 'x' }] }), /accounts\[0\]: unknown key "key"/);
  assert.deepEqual(validateConfig({ ...good, _comment: 'ignored' }).errors, []);
});

test('CLI: a broken config exits 2 with every error in one JSON line', async () => {
  const w = world({ a: { mode: 'write' } });
  fs.writeFileSync(w.configPath, JSON.stringify({ command: 'x.bat', accounts: [], timeoutMinutes: -1 }));
  const r = await cli(w, ['brief']);
  assert.equal(r.code, 2);
  assert.equal(r.json.error, 'config');
  assert.ok(r.json.errors.length >= 3, r.out);
  fs.writeFileSync(w.configPath, '{ not json');
  const r2 = await cli(w, ['brief']);
  assert.equal(r2.code, 2);
  assert.match(r2.json.errors[0], /not valid JSON/);
  const r3 = await cli(w, ['--bogus']);
  assert.equal(r3.code, 2);
  assert.match(r3.json.message, /unknown argument --bogus/);
});

// ── pure logic ───────────────────────────────────────────────────────────────
test('durations and reset rules', () => {
  assert.equal(parseDuration('4h30m12s'), (4 * 3600 + 30 * 60 + 12) * 1000);
  assert.equal(parseDuration('1d 2h'), 26 * 3600000);
  assert.equal(parseDuration('120'), 120000);
  assert.equal(parseDuration('soon'), null);
  const now = Date.UTC(2026, 0, 1, 10, 0);
  const { config } = validateConfig({ command: 'x', accounts: [{ name: 'a' }] });
  const r1 = computeReset('Quota reached. Resets in 2h15m.', config.reset, now);
  assert.equal(r1.from, 'output');
  assert.equal(r1.until.getTime(), now + 2.25 * 3600000);
  const r2 = computeReset('Quota reached.', { ...config.reset, dailyAtUtc: '08:00' }, now);
  assert.equal(r2.from, 'daily');
  assert.equal(r2.until.toISOString(), '2026-01-02T08:00:00.000Z');
  const r3 = computeReset('Quota reached.', config.reset, now);
  assert.equal(r3.from, 'default');
  assert.equal(r3.until.getTime(), now + 60 * 60000);
});

test('bench state: newest wall decides, a later success clears it, an expired bench is no bench', () => {
  const now = Date.now();
  const rows = [
    { at: ago(5000), account: 'a', outcome: 'wall', benchedUntil: ahead(3600000), wallText: 'quota' },
    { at: ago(4000), account: 'b', outcome: 'wall', benchedUntil: ahead(3600000) },
    { at: ago(3000), account: 'b', outcome: 'ok' },
    { at: ago(2000), account: 'c', outcome: 'wall', benchedUntil: ago(1000) },
    { at: ago(1000), account: 'a', outcome: 'fail' },
  ];
  assert.ok(benchState(rows, 'a', null, now));
  assert.equal(benchState(rows, 'b', null, now), null);
  assert.equal(benchState(rows, 'c', null, now), null);
  // per-model walls: a wall on model x leaves model y free
  const m = [{ at: ago(1000), account: 'a', model: 'x', outcome: 'wall', benchedUntil: ahead(60000) }];
  assert.ok(benchState(m, 'a', 'x', now, 'account+model'));
  assert.equal(benchState(m, 'a', 'y', now, 'account+model'), null);
  assert.ok(benchState(m, 'a', 'y', now, 'account'));
});

test('budget window and rotation order: least busy, then least used, then config order', () => {
  const now = Date.now();
  const rows = [
    { at: ago(1000), account: 'a', outcome: 'ok' }, { at: ago(2000), account: 'a', outcome: 'ok' },
    { at: ago(3000), account: 'c', outcome: 'ok' }, { at: ago(25 * 3600000), account: 'b', outcome: 'ok' },
    { at: ago(500), account: 'b', outcome: 'spawn-error' },
  ];
  assert.equal(usedInWindow(rows, 'a', now, 'rolling-24h'), 2);
  assert.equal(usedInWindow(rows, 'b', now, 'rolling-24h'), 0);
  const { config } = validateConfig({ command: 'x', accounts: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
  assert.deepEqual(rotationOrder(accountStates(config, rows, [])).map((s) => s.name), ['b', 'c', 'a']);
  assert.deepEqual(rotationOrder(accountStates(config, rows, ['b.slot0.json'])).map((s) => s.name), ['c', 'a', 'b']);
});

test('memory gate decisions', () => {
  const gate = { hotPct: 75, maxLanesWhenHot: 2, refusePct: 90 };
  assert.equal(gateDecision({ pct: 50, running: 9, gate }).allow, true);
  assert.equal(gateDecision({ pct: 80, running: 1, gate }).allow, true);
  assert.equal(gateDecision({ pct: 80, running: 2, gate }).level, 'hot-full');
  assert.equal(gateDecision({ pct: 92, running: 0, gate }).level, 'refuse');
  assert.equal(gateDecision({ pct: null, running: 0, gate }).allow, true);
  assert.equal(gateDecision({ pct: null, running: 1, gate }).allow, false);
  assert.equal(gateDecision({ pct: 99, running: 9, gate: null }).allow, true);
});

test('expect verdict: ok, missing, claimed-success-but-missing, stub, stale, no-sentinel', () => {
  const dir = tmp('cli-rotator-v-');
  const f = path.join(dir, 'r.md');
  const v = (o = {}) => expectVerdict({ file: f, before: null, minBytes: 50, sentinel: 'LANE-COMPLETE', cliClaimedSuccess: true, ...o });
  assert.equal(v().verdict, 'claimed-success-but-missing');
  assert.equal(v({ cliClaimedSuccess: false }).verdict, 'missing');
  fs.writeFileSync(f, 'short\nLANE-COMPLETE\n');
  assert.equal(v().verdict, 'stub');
  fs.writeFileSync(f, `${'x'.repeat(80)}\nLANE-COMPLETE\nand then more text\n`);
  assert.equal(v().verdict, 'no-sentinel');
  fs.writeFileSync(f, `${'x'.repeat(80)}\nLANE-COMPLETE\n\n`);
  assert.equal(v().verdict, 'ok');
  const before = snapshotExpect(f);
  assert.equal(v({ before }).verdict, 'stale');
  assert.equal(v({ sentinel: '' }).ok, true);
});

test('parseArgs: flags, passthrough after --, and errors', () => {
  const o = parseArgs(['do', 'it', '--yolo', '--minutes', '0.5', '--expect', '/x', '--', '--sandbox', 'off']);
  assert.equal(o.words.join(' '), 'do it');
  assert.equal(o.mode, 'yolo');
  assert.equal(o.minutes, 0.5);
  assert.deepEqual(o.passthrough, ['--sandbox', 'off']);
  assert.throws(() => parseArgs(['--minutes', '0']), /above 0/);
  assert.throws(() => parseArgs(['--expect']), /needs a value/);
});

// ── the real CLI against the fake one ────────────────────────────────────────
test('rotation: three runs on three fresh accounts land on a, b, c in turn', async () => {
  const w = world({ a: { mode: 'write' }, b: { mode: 'write' }, c: { mode: 'write' } });
  const got = [];
  for (let i = 0; i < 3; i++) {
    const r = await cli(w, ['write a report', '--expect', w.out(`r${i}.md`)]);
    assert.equal(r.code, 0, r.out + r.err);
    got.push(r.json.account);
  }
  assert.deepEqual(got, ['a', 'b', 'c']);
  const r4 = await cli(w, ['again', '--expect', w.out('r4.md')]);
  assert.equal(r4.json.account, 'a');
  assert.equal(w.ledger().length, 4);
});

test('rotation: the least-used account in the ledger goes first', async () => {
  const w = world({ a: { mode: 'write' }, b: { mode: 'write' }, c: { mode: 'write' } });
  w.seed([
    { at: ago(1000), account: 'a', outcome: 'ok' }, { at: ago(2000), account: 'a', outcome: 'ok' },
    { at: ago(3000), account: 'b', outcome: 'ok' },
  ]);
  const r = await cli(w, ['x', '--expect', w.out()]);
  assert.equal(r.json.account, 'c');
});

test('wall: the account is benched until the reset it printed and the run moves to the next account', async () => {
  const w = world({ a: { mode: 'wall', resetIn: '2h0m0s' }, b: { mode: 'write' } });
  const r = await cli(w, ['write it', '--expect', w.out()]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.account, 'b');
  assert.deepEqual(r.json.attempts.map((x) => [x.account, x.outcome]), [['a', 'wall'], ['b', 'ok']]);
  const until = Date.parse(r.json.attempts[0].benchedUntil);
  assert.ok(Math.abs(until - (Date.now() + 2 * 3600000)) < 60000, 'bench ends about 2 h from now');
  assert.equal(r.json.attempts[0].resetFrom, 'output');
  // the next run does not even try a
  w.setBehaviour('a', { mode: 'write' });
  const r2 = await cli(w, ['again', '--expect', w.out('2.md')]);
  assert.equal(r2.json.account, 'b');
  assert.deepEqual(r2.json.skipped, [{ account: 'a', state: 'benched', benchedUntil: r.json.attempts[0].benchedUntil }]);
  assert.equal(w.calls('a').length, 1);
  const st = await cli(w, ['--status']);
  assert.equal(st.json.status.accounts.find((s) => s.name === 'a').state, 'benched');
});

test('bench expiry: a wall whose reset has passed rejoins the rotation', async () => {
  const w = world({ a: { mode: 'write' }, b: { mode: 'write' } });
  w.seed([
    { at: ago(3 * 3600000), account: 'a', outcome: 'wall', benchedUntil: ago(60000) },
    { at: ago(3 * 3600000), account: 'b', outcome: 'ok' }, { at: ago(2 * 3600000), account: 'b', outcome: 'ok' },
  ]);
  const r = await cli(w, ['x', '--expect', w.out()]);
  assert.equal(r.json.account, 'a');
  assert.equal(r.code, 0);
});

test('every account walled: exit 3, and a second run starts nothing', async () => {
  const w = world({ a: { mode: 'wall' }, b: { mode: 'wall', resetIn: '10m' } });
  const r = await cli(w, ['x', '--expect', w.out()]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, 'every account tried hit a quota wall');
  const r2 = await cli(w, ['x', '--expect', w.out()]);
  assert.equal(r2.code, 3);
  assert.equal(r2.json.ran, false);
  assert.equal(w.calls('a').length + w.calls('b').length, 2);
});

test('daily budget: a spent account is skipped; all spent is exit 3', async () => {
  const w = world({ a: { mode: 'write' }, b: { mode: 'write' } }, { dailyBudget: 1 });
  w.seed([{ at: ago(1000), account: 'a', outcome: 'ok' }]);
  const r = await cli(w, ['x', '--expect', w.out()]);
  assert.equal(r.json.account, 'b');
  const r2 = await cli(w, ['x', '--expect', w.out('2.md')]);
  assert.equal(r2.code, 3);
  assert.deepEqual(r2.json.skipped.map((s) => s.state), ['spent', 'spent']);
});

test('expect verdicts through the CLI: the file, not the exit code, decides', async () => {
  const cases = [['nowrite', 'claimed-success-but-missing'], ['stub', 'stub'], ['nosentinel', 'no-sentinel']];
  for (const [mode, verdict] of cases) {
    const w = world({ a: { mode } });
    const r = await cli(w, ['x', '--expect', w.out()]);
    assert.equal(r.code, 1, mode);
    assert.equal(r.json.cliOutcome, 'ok', `${mode}: the CLI itself said success`);
    assert.equal(r.json.expect.verdict, verdict);
  }
  // stale: the target already existed and nothing touched it
  const w = world({ a: { mode: 'nowrite' } });
  fs.writeFileSync(w.out(), `${'old line\n'.repeat(40)}LANE-COMPLETE\n`);
  const r = await cli(w, ['x', '--expect', w.out()]);
  assert.equal(r.json.expect.verdict, 'stale');
  // a failed CLI exit with a complete, fresh file still counts: the file is the verdict
  const w2 = world({ a: { mode: 'write', exitCode: 3 } });
  const r2 = await cli(w2, ['x', '--expect', w2.out()]);
  assert.equal(r2.code, 0);
  assert.equal(r2.json.cliOutcome, 'fail');
  // a relative --expect is resolved against --cwd, and that absolute path is what the agent is told
  const r3 = await cli(w2, ['x', '--cwd', w2.dir, '--expect', 'relative.md']);
  assert.equal(r3.code, 0, r3.out + r3.err);
  assert.equal(r3.json.expect.path, path.join(w2.dir, 'relative.md'));
  assert.ok(fs.existsSync(path.join(w2.dir, 'relative.md')));
});

test('a non-quota failure does not rotate by default (no second paid run); rotateOn any-failure does', async () => {
  const w = world({ a: { mode: 'fail' }, b: { mode: 'write' } });
  const r = await cli(w, ['x', '--expect', w.out()]);
  assert.equal(r.code, 1);
  assert.equal(r.json.expect.verdict, 'missing');
  assert.equal(w.calls('b').length, 0);
  const w2 = world({ a: { mode: 'fail' }, b: { mode: 'write' } }, { rotateOn: 'any-failure' });
  const r2 = await cli(w2, ['x', '--expect', w2.out()]);
  assert.equal(r2.code, 0);
  assert.equal(r2.json.account, 'b');
});

test('timeout: a hung CLI is killed when its minutes run out, and is not retried elsewhere', async () => {
  const w = world({ a: { mode: 'hang' }, b: { mode: 'write' } });
  const r = await cli(w, ['x', '--minutes', '0.02', '--expect', w.out()]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.json.cliOutcome, 'timeout');
  assert.ok(r.ms < 15000, `took ${r.ms} ms`);
  const pid = w.calls('a')[0].pid;
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the fake CLI process is gone');
  assert.equal(w.calls('b').length, 0);
  assert.equal(w.ledger()[0].outcome, 'timeout');
});

test('memory gate: at 95% the run is refused with exit 4 and the CLI never starts', async () => {
  const w = world({ a: { mode: 'write' } });
  const r = await cli(w, ['x', '--expect', w.out()], { CLI_ROTATOR_MEM_PCT: '95' });
  assert.equal(r.code, 4);
  assert.equal(r.json.error, 'memory-gate');
  assert.equal(r.json.ran, false);
  assert.equal(w.calls('a').length, 0);
  assert.equal(w.ledger().length, 0);
  const st = await cli(w, ['--status'], { CLI_ROTATOR_MEM_PCT: '95' });
  assert.equal(st.json.status.memoryGate.allow, false);
});

test('concurrent runs spread across accounts (in-flight markers), not all onto the least-used one', async () => {
  const w = world({ a: { mode: 'write', delayMs: 1500 }, b: { mode: 'write', delayMs: 1500 }, c: { mode: 'write', delayMs: 1500 } });
  const rs = await Promise.all([0, 1, 2].map((i) => cli(w, ['x', '--expect', w.out(`c${i}.md`)])));
  assert.deepEqual(rs.map((r) => r.json.account).sort(), ['a', 'b', 'c']);
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'state', 'inflight')), [], 'markers are released');
});

test('environment: scrubbed variables never reach the CLI, envFrom copies a value by name, dry-run prints names only', async () => {
  const w = world({ a: { mode: 'write' } });
  const cfg = JSON.parse(fs.readFileSync(w.configPath, 'utf8'));
  cfg.accounts[0].envFrom = { FAKE_TOKEN: 'MY_TOKEN_FOR_A' };
  fs.writeFileSync(w.configPath, JSON.stringify(cfg));
  const env = { FAKE_PARENT_SECRET: 'parent-secret-value', MY_TOKEN_FOR_A: 'token-value-123' };
  const d = await cli(w, ['x', '--dry-run', '--model', 'm1', '--yolo'], env);
  assert.equal(d.code, 0);
  assert.ok(!d.out.includes('token-value-123') && !d.err.includes('token-value-123'), 'the value is never printed');
  assert.deepEqual(d.json.env, ['FAKE_CLI_HOME', 'FAKE_TOKEN']);
  assert.ok(d.json.argv.includes('--yolo') && d.json.argv.includes('m1'));
  assert.equal(w.calls('a').length, 0, 'dry-run ran nothing');
  assert.equal(fs.existsSync(path.join(w.dir, 'state')), false, 'dry-run wrote no state');
  const r = await cli(w, ['x', '--expect', w.out()], env);
  assert.equal(r.code, 0, r.out + r.err);
  const call = w.calls('a')[0];
  assert.equal(call.leakedSecret, null);
  assert.equal(call.token, 'token-value-123');
  assert.deepEqual(call.sawRotatorVars, []);
  // an envFrom variable that is not set leaves the account unconfigured, not half-signed-in
  const r2 = await cli(w, ['x', '--expect', w.out('2.md')], { MY_TOKEN_FOR_A: '' });
  assert.equal(r2.code, 3);
  assert.equal(r2.json.skipped[0].state, 'unconfigured');
});

test('--help and --status succeed', async () => {
  const w = world({ a: { mode: 'write' }, b: { mode: 'write' } });
  const h = await cli(w, ['--help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /exit codes/);
  const s = await cli(w, ['--status']);
  assert.equal(s.code, 0);
  assert.deepEqual(s.json.status.accounts.map((a) => [a.name, a.state, a.used]), [['a', 'available', 0], ['b', 'available', 0]]);
});
