// Offline tests: injected readings only (no CIM, no /proc, no sysctl). Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verdictFor, linuxReading, darwinReading, injectedReading, evaluate, settings, parseArgs, readMachine, UsageError, EXIT } from '../memory-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'memory-gate.mjs');
const CLEAN_ENV = { MEMORY_GATE_HOT: '', MEMORY_GATE_STOP: '', MEMORY_GATE_BASIS: '', MEMORY_GATE_CONFIG: '', MEMORY_GATE_READING: '' };

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...CLEAN_ENV, ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* left null */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

const GiB = 1024 ** 3;
const MEMINFO = [
  'MemTotal:       16000000 kB',
  'MemFree:         1000000 kB',
  'MemAvailable:    4000000 kB',
  'SwapTotal:       4000000 kB',
  'SwapFree:        3000000 kB',
  'CommitLimit:    12000000 kB',
  'Committed_AS:   30000000 kB',
].join('\n');

test('verdict boundaries: below hot ok, at hot no-parallelism, at stop stop', () => {
  const t = { hot: 75, stop: 85 };
  assert.equal(verdictFor(74.99, t), 'ok');
  assert.equal(verdictFor(75, t), 'no-parallelism');
  assert.equal(verdictFor(84.9, t), 'no-parallelism');
  assert.equal(verdictFor(85, t), 'stop');
  assert.equal(verdictFor(130, t), 'stop');
  assert.equal(verdictFor(null, t), 'unknown');
  assert.equal(verdictFor(NaN, t), 'unknown');
});

test('each verdict has its own exit code, and the CLI uses it', () => {
  assert.deepEqual(new Set(Object.values(EXIT)).size, 4);
  const cases = [[10, 'ok', 0], [80, 'no-parallelism', 3], [90, 'stop', 4]];
  for (const [pct, verdict, code] of cases) {
    const r = cli(['--reading', JSON.stringify({ pct })]);
    assert.equal(r.code, code, r.err);
    assert.equal(r.json.verdict, verdict);
  }
  const u = cli(['--reading', '{"unsupported":true}']);
  assert.equal(u.code, 5);
  assert.equal(u.json.verdict, 'unknown');
  assert.equal(u.json.unsupported, true);
});

test('used/limit bytes become GB and a percentage', () => {
  const { out, exit } = evaluate(injectedReading({ usedBytes: 24 * GiB, limitBytes: 32 * GiB }), { hot: 75, stop: 85 }, 'win32');
  assert.equal(out.pct, 75);
  assert.equal(out.usedGB, 24);
  assert.equal(out.limitGB, 32);
  assert.equal(out.verdict, 'no-parallelism');
  assert.equal(exit, 3);
  assert.deepEqual(out.thresholds, { hot: 75, stop: 85 });
});

test('Linux strict overcommit uses Committed_AS / CommitLimit', () => {
  const r = linuxReading(MEMINFO, 2, 'auto');
  assert.equal(r.basis, 'commit');
  assert.equal(r.usedBytes, 30000000 * 1024);
  assert.equal(r.limitBytes, 12000000 * 1024);
  assert.equal(Math.round((r.usedBytes / r.limitBytes) * 100), 250); // over 100 is possible and reported honestly
});

test('Linux heuristic overcommit uses RAM + swap in use, unless --basis commit forces it', () => {
  const r = linuxReading(MEMINFO, 0, 'auto');
  assert.equal(r.basis, 'available');
  // used = 16e6 - 4e6 + (4e6 - 3e6) = 13e6 kB; limit = 16e6 + 4e6 = 20e6 kB -> 65%
  assert.equal(r.usedBytes, 13000000 * 1024);
  assert.equal(r.limitBytes, 20000000 * 1024);
  assert.equal(r.detail.commitLimit, 12000000 * 1024);
  assert.equal(linuxReading(MEMINFO, 0, 'commit').basis, 'commit');
  assert.equal(linuxReading(MEMINFO, 2, 'available').basis, 'available');
  assert.equal(linuxReading('garbage', 0, 'auto'), null);
  const c = cli(['--reading', JSON.stringify({ meminfo: MEMINFO, overcommit: 0 })]);
  assert.equal(c.code, 0);
  assert.equal(c.json.pct, 65);
  assert.equal(c.json.basis, 'available');
});

test('macOS best effort: 100 - percent free, marked approximate', () => {
  const r = darwinReading('30\n', String(16 * GiB));
  assert.equal(r.approximate, true);
  assert.equal(r.basis, 'memorystatus');
  assert.equal(Math.round((r.usedBytes / r.limitBytes) * 100), 70);
  assert.equal(darwinReading('', '123'), null);
  assert.equal(darwinReading('150', '123'), null);
});

test('an unknown platform reports unsupported, never a guess', () => {
  const r = readMachine('auto', 'aix');
  assert.equal(r.unsupported, true);
  const { out, exit } = evaluate(r, { hot: 75, stop: 85 }, 'aix');
  assert.equal(out.verdict, 'unknown');
  assert.equal(exit, 5);
  assert.equal(out.pct, null);
});

test('thresholds: flags beat env beat config beat defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-gate-'));
  const cfg = path.join(dir, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ hot: 60, stop: 70 }));
  assert.deepEqual(settings({}, {}), { hot: 75, stop: 85, basis: 'auto' });
  assert.deepEqual(settings({ config: cfg }, {}), { hot: 60, stop: 70, basis: 'auto' });
  assert.deepEqual(settings({ config: cfg }, { MEMORY_GATE_HOT: '65' }), { hot: 65, stop: 70, basis: 'auto' });
  assert.deepEqual(settings({ config: cfg, hot: '50' }, { MEMORY_GATE_HOT: '65' }), { hot: 50, stop: 70, basis: 'auto' });
  const r = cli(['--config', cfg, '--reading', '{"pct":65}']);
  assert.equal(r.json.verdict, 'no-parallelism');
  assert.equal(r.code, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bad usage exits 2 with a JSON error', () => {
  assert.throws(() => parseArgs(['--hot']), UsageError);
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => settings({ hot: '90', stop: '80' }, {}), /must not be above/);
  assert.throws(() => settings({ basis: 'vibes' }, {}), /basis/);
  for (const args of [['--hot', 'x'], ['--hot', '90', '--stop', '80'], ['--reading', '{nope'], ['--reading', '{"limitBytes":0,"usedBytes":1}'], ['--frobnicate']]) {
    const r = cli(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.json && r.json.error, args.join(' '));
  }
});

test('--explain writes the summary to stderr and keeps stdout one JSON line', () => {
  const r = cli(['--reading', JSON.stringify({ usedBytes: 9 * GiB, limitBytes: 10 * GiB }), '--explain']);
  assert.equal(r.code, 4);
  assert.equal(r.out.trim().split('\n').length, 1);
  assert.match(r.err, /STOP: 9 of 10 GB, 90%/);
});

test('--help exits 0', () => {
  const r = cli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /no-parallelism/);
});
