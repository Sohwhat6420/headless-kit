#!/usr/bin/env node
/**
 * memory-gate.mjs: a pre-flight memory check an agent runs before heavy work (a build, parallel subagents, a VM).
 *
 *   node memory-gate.mjs [--hot 75] [--stop 85] [--basis auto|commit|available] [--config file.json]
 *                        [--reading file-or-json] [--explain]
 *
 * It reads how much of the machine's memory commit limit is in use and answers with one verdict:
 *   ok              below --hot: go ahead
 *   no-parallelism  from --hot up to --stop: one heavy job at a time, add nothing in parallel
 *   stop            at or above --stop: start nothing heavy, free memory first
 *   unknown         the reading failed or this platform has no reading
 *
 * Readings:
 *   Windows  Win32_OperatingSystem through CIM (TotalVirtualMemorySize = the commit limit, FreeVirtualMemory), in a
 *            hidden PowerShell (windowsHide).
 *   Linux    /proc/meminfo. Strict overcommit (vm.overcommit_memory = 2): Committed_AS / CommitLimit. Otherwise the
 *            kernel does not enforce CommitLimit, so the reading is (RAM + swap in use) / (RAM + swap).
 *   macOS    best effort: 100 - kern.memorystatus_level (the kernel's "percent free" gauge), against hw.memsize.
 *
 * stdout: one JSON object. stderr: a one-line summary with --explain, and error text.
 * Exit 0 ok · 3 no-parallelism · 4 stop · 5 unknown (unreadable or unsupported) · 2 bad usage or bad config.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = { hot: 75, stop: 85, basis: 'auto' };
export const EXIT = { ok: 0, 'no-parallelism': 3, stop: 4, unknown: 5 };
const BASES = ['auto', 'commit', 'available'];
const GB = 1024 ** 3;

export class UsageError extends Error {}

const HELP = `memory-gate: is there memory headroom for heavy work right now?

usage: node memory-gate.mjs [options]

  --hot <pct>        from here on: no-parallelism (default 75; env MEMORY_GATE_HOT)
  --stop <pct>       from here on: stop (default 85; env MEMORY_GATE_STOP)
  --basis <b>        Linux only: auto (default), commit (Committed_AS / CommitLimit) or available (RAM + swap in use)
  --config <file>    JSON {"hot", "stop", "basis"} (env MEMORY_GATE_CONFIG)
  --reading <x>      use this reading instead of the machine's: a JSON file or inline JSON, one of
                     {"usedBytes", "limitBytes"} · {"pct"} · {"meminfo": "<text>", "overcommit": 0} · {"unsupported": true}
                     (env MEMORY_GATE_READING; for tests and "what if")
  --explain          also print a one-line summary on stderr
  --help             this text

stdout: one JSON line {verdict, pct, usedBytes, limitBytes, usedGB, limitGB, thresholds, source, basis, ...}
exit:   0 ok · 3 no-parallelism · 4 stop · 5 unknown (unreadable or unsupported) · 2 bad usage or config`;

export function parseArgs(argv) {
  const o = { explain: false, help: false };
  const need = (i, f) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${f} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--explain') o.explain = true;
    else if (a === '--hot' || a === '--stop' || a === '--basis' || a === '--config' || a === '--reading') { o[a.slice(2)] = need(i, a); i++; }
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return o;
}

function readJsonArg(x, what) {
  const t = String(x).trim();
  try { return JSON.parse(t.startsWith('{') ? t : readFileSync(t, 'utf8')); }
  catch (e) { throw new UsageError(`${what}: ${e.code === 'ENOENT' ? 'file not found' : 'not valid JSON'} (${t.startsWith('{') ? 'inline' : t})`); }
}

/** Merge flags > env > config file > defaults, and validate. */
export function settings(opts, env = process.env) {
  const cfgPath = opts.config ?? (env.MEMORY_GATE_CONFIG || undefined);
  const cfg = cfgPath ? readJsonArg(cfgPath, '--config') : {};
  const pick = (k, envKey) => opts[k] ?? (env[envKey] || undefined) ?? cfg[k] ?? DEFAULTS[k];
  const hot = Number(pick('hot', 'MEMORY_GATE_HOT'));
  const stop = Number(pick('stop', 'MEMORY_GATE_STOP'));
  const basis = String(pick('basis', 'MEMORY_GATE_BASIS'));
  if (!Number.isFinite(hot) || !Number.isFinite(stop) || hot <= 0 || stop <= 0) throw new UsageError('--hot and --stop must be positive numbers');
  if (hot > stop) throw new UsageError(`--hot (${hot}) must not be above --stop (${stop})`);
  if (!BASES.includes(basis)) throw new UsageError(`--basis must be one of ${BASES.join(', ')}`);
  return { hot, stop, basis };
}

/** Parse /proc/meminfo text into bytes. */
export function parseMeminfo(text) {
  const kb = {};
  for (const line of String(text).split('\n')) {
    const m = /^(\w+):\s+(\d+)(?:\s*kB)?/.exec(line.trim());
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  return kb;
}

/**
 * Linux reading. `overcommit` is vm.overcommit_memory (0 heuristic, 1 always, 2 strict).
 * Only strict mode enforces CommitLimit; in the others Committed_AS routinely exceeds it on a healthy desktop,
 * so `auto` uses RAM + swap in use instead (the same shape as the Windows commit charge: RAM + page file).
 */
export function linuxReading(meminfo, overcommit, basis = 'auto') {
  const m = parseMeminfo(meminfo);
  const commit = m.CommitLimit && m.Committed_AS != null ? { usedBytes: m.Committed_AS, limitBytes: m.CommitLimit } : null;
  const avail = m.MemTotal && m.MemAvailable != null
    ? { usedBytes: m.MemTotal - m.MemAvailable + Math.max(0, (m.SwapTotal || 0) - (m.SwapFree || 0)), limitBytes: m.MemTotal + (m.SwapTotal || 0) }
    : null;
  const use = basis === 'commit' ? 'commit' : basis === 'available' ? 'available' : (Number(overcommit) === 2 ? 'commit' : 'available');
  const r = use === 'commit' ? commit : avail;
  if (!r) return null;
  return { ...r, basis: use, detail: commit ? { committedAS: commit.usedBytes, commitLimit: commit.limitBytes, overcommit: overcommit ?? null } : undefined };
}

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function readWindows() {
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$os=Get-CimInstance Win32_OperatingSystem; "$($os.TotalVirtualMemorySize) $($os.FreeVirtualMemory)"']);
  const m = /(\d+)\s+(\d+)/.exec(r.stdout || '');
  if (!m || !Number(m[1])) return { error: `CIM read failed${r.error ? ': ' + r.error.code : ''}` };
  const total = Number(m[1]) * 1024, free = Number(m[2]) * 1024; // CIM reports KB
  return { usedBytes: total - free, limitBytes: total, basis: 'commit', source: 'win32-cim' };
}

export function readLinux(basis) {
  let mi, oc;
  try { mi = readFileSync('/proc/meminfo', 'utf8'); } catch (e) { return { error: `/proc/meminfo unreadable (${e.code})` }; }
  try { oc = Number(readFileSync('/proc/sys/vm/overcommit_memory', 'utf8').trim()); } catch { oc = null; }
  const r = linuxReading(mi, oc, basis);
  return r ? { ...r, source: 'linux-proc-meminfo' } : { error: '/proc/meminfo lacks the fields needed' };
}

/** macOS has no commit limit. kern.memorystatus_level is the kernel's percent-free gauge (0-100). */
export function darwinReading(levelText, memsizeText) {
  const lt = String(levelText).trim(), mt = String(memsizeText).trim();
  if (!/^\d+$/.test(lt) || !/^\d+$/.test(mt)) return null;
  const level = Number(lt), mem = Number(mt);
  if (level > 100 || !mem) return null;
  return { usedBytes: Math.round(mem * (100 - level) / 100), limitBytes: mem, basis: 'memorystatus', approximate: true };
}

export function readDarwin() {
  const lv = run('sysctl', ['-n', 'kern.memorystatus_level']);
  const ms = run('sysctl', ['-n', 'hw.memsize']);
  const r = lv.status === 0 && ms.status === 0 ? darwinReading(lv.stdout, ms.stdout) : null;
  return r ? { ...r, source: 'darwin-sysctl' } : { unsupported: true, error: 'kern.memorystatus_level is not available on this macOS' };
}

/** Turn an injected reading (tests, "what if") into the common shape. */
export function injectedReading(j, basis) {
  if (!j || typeof j !== 'object') throw new UsageError('--reading must be a JSON object');
  if (j.unsupported) return { unsupported: true, error: 'injected: unsupported', source: 'injected' };
  if (j.error) return { error: String(j.error), source: 'injected' };
  if (j.meminfo != null) {
    const r = linuxReading(j.meminfo, j.overcommit, basis);
    return r ? { ...r, source: 'injected' } : { error: 'injected meminfo lacks the fields needed', source: 'injected' };
  }
  if (j.usedBytes != null && j.limitBytes != null) {
    const u = Number(j.usedBytes), l = Number(j.limitBytes);
    if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0 || u < 0) throw new UsageError('--reading: usedBytes and limitBytes must be numbers, limitBytes > 0');
    return { usedBytes: u, limitBytes: l, basis: j.basis || 'commit', source: 'injected' };
  }
  if (j.pct != null) {
    const p = Number(j.pct);
    if (!Number.isFinite(p) || p < 0) throw new UsageError('--reading: pct must be a number >= 0');
    return { pct: p, basis: j.basis || 'commit', source: 'injected' };
  }
  throw new UsageError('--reading needs usedBytes + limitBytes, pct, meminfo or unsupported');
}

export function readMachine(basis, platform = process.platform) {
  if (platform === 'win32') return readWindows();
  if (platform === 'linux') return readLinux(basis);
  if (platform === 'darwin') return readDarwin();
  return { unsupported: true, error: `no reading for platform ${platform}` };
}

/** Pure decision. */
export function verdictFor(pct, { hot, stop }) {
  if (pct == null || !Number.isFinite(pct)) return 'unknown';
  if (pct >= stop) return 'stop';
  if (pct >= hot) return 'no-parallelism';
  return 'ok';
}

const ADVICE = {
  ok: 'headroom: heavy work may start',
  'no-parallelism': 'one heavy job at a time: add no parallel work, no big builds alongside',
  stop: 'start nothing heavy: free memory first (close idle apps and finished jobs)',
  unknown: 'no reading: treat as no-parallelism (one job at a time) unless you can check another way',
};

export function evaluate(reading, s, platform = process.platform) {
  const pct = reading.pct != null ? reading.pct
    : reading.usedBytes != null && reading.limitBytes ? (reading.usedBytes / reading.limitBytes) * 100 : null;
  const verdict = verdictFor(pct, s);
  const round = (n, d) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
  const out = {
    verdict,
    pct: round(pct, 1),
    usedBytes: reading.usedBytes ?? null,
    limitBytes: reading.limitBytes ?? null,
    usedGB: reading.usedBytes != null ? round(reading.usedBytes / GB, 2) : null,
    limitGB: reading.limitBytes != null ? round(reading.limitBytes / GB, 2) : null,
    thresholds: { hot: s.hot, stop: s.stop },
    source: reading.source ?? null,
    basis: reading.basis ?? null,
    platform,
    advice: ADVICE[verdict],
  };
  if (reading.approximate) out.approximate = true;
  if (reading.unsupported) out.unsupported = true;
  if (reading.error) out.error = reading.error;
  if (reading.detail) out.detail = reading.detail;
  return { out, exit: EXIT[verdict] };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let o, s, reading;
  try {
    o = parseArgs(argv);
    if (o.help) { process.stdout.write(HELP + '\n'); return 0; }
    s = settings(o, env);
    const inj = o.reading ?? (env.MEMORY_GATE_READING || undefined);
    reading = inj ? injectedReading(readJsonArg(inj, '--reading'), s.basis) : readMachine(s.basis);
  } catch (e) {
    if (e instanceof UsageError) { process.stdout.write(JSON.stringify({ error: e.message }) + '\n'); process.stderr.write(`memory-gate: ${e.message}\n`); return 2; }
    throw e;
  }
  const { out, exit } = evaluate(reading, s);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (o.explain) {
    const used = out.usedGB != null ? `${out.usedGB} of ${out.limitGB} GB, ` : '';
    process.stderr.write(`memory-gate: ${out.verdict.toUpperCase()}: ${used}${out.pct ?? '?'}% (${out.basis ?? 'no'} basis; hot ${s.hot}, stop ${s.stop}). ${out.advice}${out.error ? ` [${out.error}]` : ''}\n`);
  }
  return exit;
}

const self = process.argv[1] ? resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : false;
if (self) process.exitCode = main();
