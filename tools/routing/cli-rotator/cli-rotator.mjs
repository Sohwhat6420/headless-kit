#!/usr/bin/env node
// cli-rotator.mjs: run a written brief on one of several signed-in accounts of a coding-agent CLI
// (Gemini CLI, Codex, Claude Code, anything that takes a prompt), rotating least-used-first, benching an
// account that hits a quota wall until its reset, and judging the run by the FILE it was told to write.
// Node 18+, no dependencies. Run with --help for usage.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, NO_ACCOUNT: 3, MEMORY: 4 };

const HELP = `cli-rotator: run a brief on one of several accounts of a coding-agent CLI, least-used first.

usage:
  cli-rotator "<brief>" [--expect <path>] [options] [-- <args passed to the CLI>]
  cli-rotator --brief-file <path> [options]
  cli-rotator --status [--model <id>]

options:
  --config <path>      config file (default: $CLI_ROTATOR_CONFIG, else ./cli-rotator.json)
  --expect <path>      the file the run must write; it decides success (size floor + sentinel + fresh).
                       A relative path is resolved against --cwd; the agent is told the absolute path
  --sentinel <text>    override expect.sentinel ("" turns the sentinel check off)
  --model <id>         fills {model} in modelArgs (default: config defaultModel, else no model args)
  --mode <name>        append config modes[<name>] to the CLI's arguments
  --yolo, --write      shorthand for --mode yolo / --mode write
  --minutes <n>        per-attempt timeout (fractions allowed); the CLI is killed when it runs out
  --account <name>     use this account only (still checked for bench, budget and the memory gate)
  --cwd <dir>          working directory for the CLI (default: the current directory)
  --dry-run            pick the account and print the plan as JSON; run nothing, record nothing
  --quiet              no human progress on stderr
  --status             accounts, usage, benches and the memory gate, as one JSON line
  -h, --help           this text

stdout is one JSON line. Human progress goes to stderr.
exit codes: 0 ok | 1 the run failed (CLI failure, timeout, or --expect not satisfied)
            2 usage or config error | 3 no account could serve (benched, spent, or every one walled)
            4 refused by the memory gate (nothing ran)
env: CLI_ROTATOR_CONFIG (config path), CLI_ROTATOR_HOME (state dir: ledger, in-flight markers, run logs),
     CLI_ROTATOR_MEM_PCT (pretend memory reading, for tests and demos)`;

// ── config ───────────────────────────────────────────────────────────────────
const DEFAULT_WALLS = [
  'quota (?:exceeded|reached|exhausted)', 'rate.?limit(?:ed)?', '\\b429\\b', 'resource.?exhausted',
  'usage limit', 'too many requests',
];
const DEFAULT_RESET_PATTERN = '(?:resets?|try again|retry)\\s+(?:in|after)\\s+([0-9][0-9dhms\\s]*)';
const TOP_KEYS = ['command', 'args', 'modelArgs', 'defaultModel', 'modes', 'promptVia', 'promptSuffix', 'scrubEnv',
  'accounts', 'dailyBudget', 'budgetWindow', 'walls', 'wallsOnlyOnFailure', 'reset', 'wallScope', 'failurePatterns',
  'rotateOn', 'memoryGate', 'timeoutMinutes', 'expect', 'stateDir'];
const ACCOUNT_KEYS = ['name', 'env', 'envFrom', 'dailyBudget'];
const PLACEHOLDERS = {
  command: ['configDir'], args: ['prompt', 'account', 'configDir'], modelArgs: ['model', 'account', 'configDir'],
  modes: ['account', 'configDir'], promptSuffix: ['expect', 'sentinel', 'account'], env: ['account', 'configDir'],
  stateDir: ['configDir'],
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isStrMap = (v) => isObj(v) && Object.values(v).every((x) => typeof x === 'string');
const posInt = (v) => Number.isInteger(v) && v > 0;
export const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, os.homedir());
export const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

function placeholderErrors(where, strings, allowed) {
  const out = [];
  for (const s of strings) {
    for (const m of String(s).matchAll(/\{(\w+)\}/g)) {
      if (!allowed.includes(m[1])) out.push(`${where}: unknown placeholder {${m[1]}} (allowed here: ${allowed.map((a) => `{${a}}`).join(' ')})`);
    }
  }
  return out;
}

function compile(list, where, errors) {
  const out = [];
  if (!Array.isArray(list)) { errors.push(`${where} must be an array of regex strings or {pattern, flags} objects`); return out; }
  list.forEach((p, i) => {
    const pattern = typeof p === 'string' ? p : isObj(p) ? p.pattern : undefined;
    const flags = isObj(p) && typeof p.flags === 'string' ? p.flags : 'i';
    if (typeof pattern !== 'string' || !pattern) { errors.push(`${where}[${i}] has no pattern`); return; }
    try { out.push(new RegExp(pattern, flags.replace(/g/g, ''))); } catch (e) { errors.push(`${where}[${i}] is not a valid regex: ${e.message}`); }
  });
  return out;
}

/** Validate a parsed config object. Returns { config, errors }; config is usable only when errors is empty. */
export function validateConfig(raw, { configDir = process.cwd(), env = process.env } = {}) {
  const errors = [];
  if (!isObj(raw)) return { config: null, errors: ['config must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!k.startsWith('_') && !TOP_KEYS.includes(k)) errors.push(`unknown key "${k}" (keys starting with _ are ignored, for comments)`);

  const c = {};
  if (typeof raw.command !== 'string' || !raw.command.trim()) errors.push('"command" must be a non-empty string (the CLI to run, e.g. "gemini" or "node")');
  else if (/\.(cmd|bat)$/i.test(raw.command)) errors.push('"command" is a .cmd/.bat shim; cli-rotator never runs a shell. Point "command" at node (or the real .exe) and put the CLI\'s JS entry file first in "args"');
  c.command = raw.command;

  c.args = raw.args === undefined ? ['{prompt}'] : raw.args;
  c.modelArgs = raw.modelArgs === undefined ? [] : raw.modelArgs;
  c.modes = raw.modes === undefined ? {} : raw.modes;
  if (!isStrArr(c.args)) errors.push('"args" must be an array of strings');
  if (!isStrArr(c.modelArgs)) errors.push('"modelArgs" must be an array of strings');
  if (!isObj(c.modes) || !Object.values(c.modes).every(isStrArr)) errors.push('"modes" must map a mode name to an array of strings');
  c.promptVia = raw.promptVia ?? 'arg';
  if (!['arg', 'stdin'].includes(c.promptVia)) errors.push('"promptVia" must be "arg" or "stdin"');
  if (isStrArr(c.args)) {
    const has = c.args.some((a) => a.includes('{prompt}'));
    if (c.promptVia === 'arg' && !has) errors.push('"args" has no {prompt} placeholder, so the brief would never reach the CLI (or set "promptVia": "stdin")');
    if (c.promptVia === 'stdin' && has) errors.push('"promptVia" is "stdin" but "args" also contains {prompt}; pick one');
  }
  c.defaultModel = raw.defaultModel ?? null;
  if (c.defaultModel !== null && typeof c.defaultModel !== 'string') errors.push('"defaultModel" must be a string or null');
  c.promptSuffix = raw.promptSuffix ?? '';
  if (typeof c.promptSuffix !== 'string') errors.push('"promptSuffix" must be a string');
  c.scrubEnv = raw.scrubEnv ?? [];
  if (!isStrArr(c.scrubEnv)) errors.push('"scrubEnv" must be an array of environment variable names');

  if (typeof raw.command === 'string') errors.push(...placeholderErrors('command', [raw.command], PLACEHOLDERS.command));
  if (isStrArr(c.args)) errors.push(...placeholderErrors('args', c.args, PLACEHOLDERS.args));
  if (isStrArr(c.modelArgs)) errors.push(...placeholderErrors('modelArgs', c.modelArgs, PLACEHOLDERS.modelArgs));
  if (isObj(c.modes)) for (const [m, a] of Object.entries(c.modes)) if (isStrArr(a)) errors.push(...placeholderErrors(`modes.${m}`, a, PLACEHOLDERS.modes));
  if (typeof c.promptSuffix === 'string') errors.push(...placeholderErrors('promptSuffix', [c.promptSuffix], PLACEHOLDERS.promptSuffix));

  c.dailyBudget = raw.dailyBudget ?? 100;
  if (!posInt(c.dailyBudget)) errors.push('"dailyBudget" must be a positive integer (runs per account per window)');
  c.budgetWindow = raw.budgetWindow ?? 'rolling-24h';
  if (!['rolling-24h', 'utc-day'].includes(c.budgetWindow)) errors.push('"budgetWindow" must be "rolling-24h" or "utc-day"');

  c.accounts = [];
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) errors.push('"accounts" must be a non-empty array');
  else {
    const seen = new Set();
    raw.accounts.forEach((a, i) => {
      const where = `accounts[${i}]`;
      if (!isObj(a)) { errors.push(`${where} must be an object`); return; }
      for (const k of Object.keys(a)) if (!k.startsWith('_') && !ACCOUNT_KEYS.includes(k)) errors.push(`${where}: unknown key "${k}"`);
      if (typeof a.name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(a.name)) errors.push(`${where}.name must be 1-64 characters of letters, digits, . _ -`);
      else if (seen.has(a.name)) errors.push(`${where}.name "${a.name}" is a duplicate`);
      else seen.add(a.name);
      const envMap = a.env ?? {};
      const envFrom = a.envFrom ?? {};
      if (!isStrMap(envMap)) errors.push(`${where}.env must map variable names to strings`);
      else errors.push(...placeholderErrors(`${where}.env`, Object.values(envMap), PLACEHOLDERS.env));
      if (!isStrMap(envFrom)) errors.push(`${where}.envFrom must map variable names to the names of variables in your environment`);
      if (a.dailyBudget !== undefined && !posInt(a.dailyBudget)) errors.push(`${where}.dailyBudget must be a positive integer`);
      c.accounts.push({ name: a.name, env: isStrMap(envMap) ? envMap : {}, envFrom: isStrMap(envFrom) ? envFrom : {}, dailyBudget: a.dailyBudget ?? null });
    });
  }

  c.walls = compile(raw.walls ?? DEFAULT_WALLS, 'walls', errors);
  c.wallsOnlyOnFailure = raw.wallsOnlyOnFailure ?? false;
  if (typeof c.wallsOnlyOnFailure !== 'boolean') errors.push('"wallsOnlyOnFailure" must be true or false');
  c.failurePatterns = compile(raw.failurePatterns ?? [], 'failurePatterns', errors);
  const reset = raw.reset ?? {};
  if (!isObj(reset)) errors.push('"reset" must be an object');
  c.reset = { pattern: null, defaultMinutes: 60, dailyAtUtc: null };
  if (isObj(reset)) {
    for (const k of Object.keys(reset)) if (!k.startsWith('_') && !['pattern', 'defaultMinutes', 'dailyAtUtc'].includes(k)) errors.push(`reset: unknown key "${k}"`);
    const pat = reset.pattern === undefined ? DEFAULT_RESET_PATTERN : reset.pattern;
    if (pat !== null) {
      const [re] = compile([pat], 'reset.pattern', errors);
      c.reset.pattern = re || null;
    }
    if (reset.defaultMinutes !== undefined) {
      if (typeof reset.defaultMinutes !== 'number' || !(reset.defaultMinutes > 0)) errors.push('reset.defaultMinutes must be a number above 0');
      else c.reset.defaultMinutes = reset.defaultMinutes;
    }
    if (reset.dailyAtUtc !== undefined && reset.dailyAtUtc !== null) {
      if (typeof reset.dailyAtUtc !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(reset.dailyAtUtc)) errors.push('reset.dailyAtUtc must be "HH:MM" (24-hour, UTC)');
      else c.reset.dailyAtUtc = reset.dailyAtUtc;
    }
  }
  c.wallScope = raw.wallScope ?? 'account';
  if (!['account', 'account+model'].includes(c.wallScope)) errors.push('"wallScope" must be "account" or "account+model"');
  c.rotateOn = raw.rotateOn ?? 'wall';
  if (!['wall', 'any-failure'].includes(c.rotateOn)) errors.push('"rotateOn" must be "wall" or "any-failure"');

  c.memoryGate = null;
  if (raw.memoryGate !== undefined && raw.memoryGate !== null) {
    const g = raw.memoryGate;
    if (!isObj(g)) errors.push('"memoryGate" must be an object or null');
    else {
      const pct = (v) => typeof v === 'number' && v >= 0 && v <= 100;
      const gate = { hotPct: g.hotPct ?? 75, maxLanesWhenHot: g.maxLanesWhenHot ?? 2, refusePct: g.refusePct ?? 90 };
      if (!pct(gate.hotPct)) errors.push('memoryGate.hotPct must be a percentage 0-100');
      if (!pct(gate.refusePct)) errors.push('memoryGate.refusePct must be a percentage 0-100');
      if (pct(gate.hotPct) && pct(gate.refusePct) && gate.hotPct > gate.refusePct) errors.push('memoryGate.hotPct must not be above refusePct');
      if (!Number.isInteger(gate.maxLanesWhenHot) || gate.maxLanesWhenHot < 0) errors.push('memoryGate.maxLanesWhenHot must be a whole number');
      c.memoryGate = gate;
    }
  }
  c.timeoutMinutes = raw.timeoutMinutes ?? 20;
  if (typeof c.timeoutMinutes !== 'number' || !(c.timeoutMinutes > 0)) errors.push('"timeoutMinutes" must be a number above 0');
  const ex = raw.expect ?? {};
  c.expect = { minBytes: ex.minBytes ?? 200, sentinel: ex.sentinel ?? 'LANE-COMPLETE' };
  if (!isObj(ex)) errors.push('"expect" must be an object');
  if (!Number.isInteger(c.expect.minBytes) || c.expect.minBytes < 0) errors.push('expect.minBytes must be a whole number');
  if (typeof c.expect.sentinel !== 'string') errors.push('expect.sentinel must be a string ("" turns it off)');

  const sd = raw.stateDir ?? env.CLI_ROTATOR_HOME ?? '~/.cli-rotator';
  if (typeof sd !== 'string') errors.push('"stateDir" must be a string');
  else {
    errors.push(...placeholderErrors('stateDir', [sd], PLACEHOLDERS.stateDir));
    c.stateDir = path.resolve(configDir, expandHome(fill(sd, { configDir })));
  }
  if (env.CLI_ROTATOR_HOME && raw.stateDir === undefined) c.stateDir = path.resolve(expandHome(env.CLI_ROTATOR_HOME));
  c.configDir = configDir;
  return { config: c, errors };
}

export function loadConfig(file, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { config: null, errors: [`cannot read config ${file}: ${e.code || e.message}`] }; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // a byte-order mark from some Windows editors
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { config: null, errors: [`config ${file} is not valid JSON: ${e.message}`] }; }
  return validateConfig(raw, { configDir: path.dirname(path.resolve(file)), env });
}

// ── time: durations and resets ───────────────────────────────────────────────
/** "4h30m12s", "2h", "45m", "90s", "1d 2h", "120" (plain seconds) -> milliseconds, or null. */
export function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  let ms = 0; let any = false;
  for (const m of t.matchAll(/(\d+)\s*([dhms])/g)) {
    any = true;
    ms += Number(m[1]) * { d: 86400000, h: 3600000, m: 60000, s: 1000 }[m[2]];
  }
  return any && ms > 0 ? ms : null;
}

/** When does a walled account come back? From the CLI's own words if the reset pattern finds a time, else the
 *  daily reset, else the default bench. Returns { until: Date, from: 'output'|'daily'|'default', text } */
export function computeReset(text, reset, now = Date.now()) {
  if (reset.pattern) {
    const m = reset.pattern.exec(String(text || ''));
    const g = m && (m[1] ?? m[0]);
    if (g) {
      const ms = parseDuration(g);
      if (ms) return { until: new Date(now + ms), from: 'output', text: g.trim() };
      const at = Date.parse(g);
      if (!Number.isNaN(at) && at > now) return { until: new Date(at), from: 'output', text: g.trim() };
    }
  }
  if (reset.dailyAtUtc) {
    const [h, mi] = reset.dailyAtUtc.split(':').map(Number);
    const d = new Date(now);
    let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, mi);
    if (at <= now) at += 86400000;
    return { until: new Date(at), from: 'daily', text: `daily at ${reset.dailyAtUtc} UTC` };
  }
  return { until: new Date(now + reset.defaultMinutes * 60000), from: 'default', text: `default ${reset.defaultMinutes} min` };
}

// ── ledger ───────────────────────────────────────────────────────────────────
export function readLedger(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
function appendLedger(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}

/** Runs this account started in the budget window (a spawn-error never reached the provider, so it is not counted). */
export function usedInWindow(rows, account, now, window) {
  const d = new Date(now);
  const cut = window === 'utc-day' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : now - 86400000;
  return rows.filter((r) => r.account === account && r.outcome !== 'spawn-error' && Date.parse(r.at) >= cut).length;
}

/** Is this account benched? Walk its rows newest first: a success clears any wall; the newest wall decides. */
export function benchState(rows, account, model, now, scope = 'account') {
  const mine = rows.filter((r) => r.account === account && (scope === 'account' || (r.model ?? null) === (model ?? null)));
  for (let i = mine.length - 1; i >= 0; i--) {
    const r = mine[i];
    if (r.outcome === 'ok') return null;
    if (r.outcome === 'wall') {
      const u = Date.parse(r.benchedUntil);
      return u > now ? { until: new Date(u).toISOString(), text: r.wallText ?? null } : null;
    }
  }
  return null;
}

// ── in-flight markers: concurrent runs spread across accounts ────────────────
// The ledger is written when a run ENDS, so runs started together would all read the same counts and pick
// the same account. Each running attempt holds inflight/<account>.slot<k>.json, created with flag 'wx', so the
// race is decided by the filesystem: simultaneous runs each win a different slot 0 before anyone takes a slot 1.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
export function sweepInflight(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const live = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const p = path.join(dir, n);
    let m = null;
    try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* half-written: live this once */ }
    const stale = m && (Number.isInteger(m.pid) ? !pidAlive(m.pid) : Date.now() - Date.parse(m.at) > 6 * 3600000);
    if (stale) { try { fs.unlinkSync(p); } catch { /* swept by another run */ } continue; }
    live.push(n);
  }
  return live;
}
const runningOn = (live, account) => live.filter((n) => n.startsWith(`${account}.slot`)).length;

class Marker {
  constructor(dir) { this.dir = dir; this.held = null; }
  claim(account, slot) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const p = path.join(this.dir, `${account}.slot${slot}.json`);
      fs.writeFileSync(p, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      this.release();
      this.held = p;
      return true;
    } catch { return false; }
  }
  claimAny(account) { for (let k = 0; k < 64; k++) if (this.claim(account, k)) return true; return false; }
  holds(account) { return !!this.held && path.basename(this.held).startsWith(`${account}.slot`); }
  release() { if (this.held) { try { fs.unlinkSync(this.held); } catch { /* gone */ } this.held = null; } }
}

// ── memory gate ──────────────────────────────────────────────────────────────
export function readMemPct(env = process.env) {
  if (env.CLI_ROTATOR_MEM_PCT !== undefined && env.CLI_ROTATOR_MEM_PCT !== '') {
    const n = Number(env.CLI_ROTATOR_MEM_PCT);
    return Number.isFinite(n) ? n : null;
  }
  const total = os.totalmem();
  return total ? (1 - os.freemem() / total) * 100 : null;
}

/** Pure decision. pct = memory in use (null if unreadable); running = lanes this tool already has in flight. */
export function gateDecision({ pct, running, gate }) {
  if (!gate) return { allow: true, level: 'off', reason: 'no memory gate configured' };
  if (pct == null || Number.isNaN(pct)) {
    return running >= 1
      ? { allow: false, level: 'unknown-full', reason: `memory unreadable and ${running} lane(s) running (max 1 while blind)` }
      : { allow: true, level: 'unknown', reason: 'memory unreadable; allowing one lane' };
  }
  const p = `memory ${pct.toFixed(1)}% used`;
  if (pct >= gate.refusePct) return { allow: false, level: 'refuse', reason: `${p} >= ${gate.refusePct}%: no new lanes` };
  if (pct >= gate.hotPct) {
    return running >= gate.maxLanesWhenHot
      ? { allow: false, level: 'hot-full', reason: `${p} >= ${gate.hotPct}% and ${running} lane(s) running (max ${gate.maxLanesWhenHot})` }
      : { allow: true, level: 'hot', reason: `${p} >= ${gate.hotPct}%: ${running} of ${gate.maxLanesWhenHot} lane slots in use` };
  }
  return { allow: true, level: 'ok', reason: p };
}

// ── the --expect verdict ─────────────────────────────────────────────────────
function sha1(file) { return createHash('sha1').update(fs.readFileSync(file)).digest('hex'); }

/** Call BEFORE the run: what the target looked like, so a file that was already there cannot pass as this run's. */
export function snapshotExpect(file) {
  try { const st = fs.statSync(file); return { mtimeMs: st.mtimeMs, size: st.size, sha1: sha1(file) }; } catch { return null; }
}

/** Judge the file. cliClaimedSuccess = the CLI exited 0 with no failure pattern and no wall. */
export function expectVerdict({ file, before, minBytes, sentinel, cliClaimedSuccess }) {
  let st;
  try { st = fs.statSync(file); } catch {
    return cliClaimedSuccess
      ? { ok: false, verdict: 'claimed-success-but-missing', why: 'the CLI reported success but the file does not exist' }
      : { ok: false, verdict: 'missing', why: 'the file does not exist' };
  }
  if (!st.isFile()) return { ok: false, verdict: 'missing', why: 'the path exists but is not a file' };
  if (st.size < minBytes) return { ok: false, verdict: 'stub', bytes: st.size, why: `${st.size} bytes, under the ${minBytes}-byte floor` };
  if (before && st.mtimeMs === before.mtimeMs && st.size === before.size && sha1(file) === before.sha1) {
    return { ok: false, verdict: 'stale', bytes: st.size, why: 'the file was already there and this run did not change it' };
  }
  if (sentinel) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !lines[lines.length - 1].includes(sentinel)) {
      return { ok: false, verdict: 'no-sentinel', bytes: st.size, why: `the last line is not "${sentinel}": the writer stopped before the end` };
    }
  }
  return { ok: true, verdict: 'ok', bytes: st.size, why: `${st.size} bytes${sentinel ? ', sentinel on the last line' : ''}` };
}

// ── accounts: state and order ────────────────────────────────────────────────
export function accountStates(cfg, rows, live, { now = Date.now(), model = null, env = process.env } = {}) {
  return cfg.accounts.map((a, index) => {
    const budget = a.dailyBudget ?? cfg.dailyBudget;
    const used = usedInWindow(rows, a.name, now, cfg.budgetWindow);
    const bench = benchState(rows, a.name, model, now, cfg.wallScope);
    const missing = Object.values(a.envFrom).filter((v) => env[v] === undefined || env[v] === '');
    const state = missing.length ? 'unconfigured' : bench ? 'benched' : used >= budget ? 'spent' : 'available';
    return {
      name: a.name, index, used, budget, state, running: runningOn(live, a.name),
      ...(bench ? { benchedUntil: bench.until, wallText: bench.text } : {}),
      ...(missing.length ? { missingEnv: missing } : {}),
    };
  });
}

/** Least busy first, then least used, then config order: N accounts drain evenly. */
export const rotationOrder = (states) => states.filter((s) => s.state === 'available')
  .sort((x, y) => x.running - y.running || x.used - y.used || x.index - y.index);

// ── running one attempt ──────────────────────────────────────────────────────
export function buildInvocation(cfg, account, { prompt, model, mode, passthrough = [] }) {
  const vars = { prompt, model: model ?? '', account: account.name, configDir: cfg.configDir };
  const argv = [
    ...cfg.args.map((a) => fill(a, vars)),
    ...(model ? cfg.modelArgs.map((a) => fill(a, vars)) : []),
    ...(mode ? cfg.modes[mode].map((a) => fill(a, vars)) : []),
    ...passthrough,
  ];
  return { command: fill(cfg.command, vars), argv };
}

function buildEnv(cfg, account, parentEnv) {
  const env = { ...parentEnv };
  const scrub = new Set(cfg.scrubEnv.map((k) => k.toUpperCase()));
  for (const k of Object.keys(env)) if (scrub.has(k.toUpperCase()) || k.startsWith('CLI_ROTATOR_')) delete env[k];
  const vars = { account: account.name, configDir: cfg.configDir };
  for (const [k, v] of Object.entries(account.env)) env[k] = expandHome(fill(v, vars));
  for (const [k, from] of Object.entries(account.envFrom)) env[k] = parentEnv[from];
  return env;
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (r.status !== 0) { try { child.kill(); } catch { /* gone */ } }
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, 3000);
  child.once('close', () => clearTimeout(t));
}

const CAP = 8 * 1024 * 1024;
let CURRENT_CHILD = null;

export function runAttempt(cfg, account, { prompt, model, mode, passthrough, cwd, timeoutMs, parentEnv = process.env }) {
  const { command, argv } = buildInvocation(cfg, account, { prompt, model, mode, passthrough });
  const env = buildEnv(cfg, account, parentEnv);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, argv, {
        cwd, env, windowsHide: true, shell: false,
        // stdin is closed unless the prompt goes through it: some agent CLIs wait forever on an open stdin.
        stdio: [cfg.promptVia === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        // POSIX only: own process group, so a timeout kills the CLI's children too. Never on Windows (no new console).
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({ outcome: 'spawn-error', error: e.message, ms: 0, stdout: '', stderr: '' });
      return;
    }
    CURRENT_CHILD = child;
    let stdout = ''; let stderr = ''; let timedOut = false; let spawnErr = null;
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > CAP) stdout = stdout.slice(-CAP); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > CAP) stderr = stderr.slice(-CAP); });
    if (cfg.promptVia === 'stdin') { child.stdin.on('error', () => {}); child.stdin.end(prompt); }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', (e) => { spawnErr = e; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      CURRENT_CHILD = null;
      const ms = Date.now() - t0;
      if (spawnErr && code === null && !timedOut) {
        let hint = '';
        if (spawnErr.code === 'ENOENT' && process.platform === 'win32') hint = '. On Windows an npm-installed CLI is a .cmd shim, which cli-rotator will not run through a shell: set "command" to "node" and put the CLI\'s JS entry first in "args"';
        resolve({ outcome: 'spawn-error', error: `${spawnErr.code || ''} ${spawnErr.message}${hint}`.trim(), ms, stdout, stderr });
        return;
      }
      const text = `${stdout}\n${stderr}`;
      const failedByCli = code !== 0 || signal !== null || cfg.failurePatterns.some((re) => re.test(text));
      const wallRe = (!cfg.wallsOnlyOnFailure || failedByCli) ? cfg.walls.find((re) => re.test(text)) : null;
      const base = { exitCode: code, signal, ms, stdout, stderr, pid: child.pid };
      if (timedOut) { resolve({ ...base, outcome: 'timeout' }); return; }
      if (wallRe) {
        const line = text.split(/\r?\n/).find((l) => wallRe.test(l)) || '';
        const r = computeReset(text, cfg.reset);
        resolve({ ...base, outcome: 'wall', wallText: line.trim().slice(0, 300), benchedUntil: r.until.toISOString(), resetFrom: r.from });
        return;
      }
      resolve({ ...base, outcome: failedByCli ? 'fail' : 'ok' });
    });
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const o = { config: null, expect: null, sentinel: undefined, model: null, mode: null, minutes: null, account: null, cwd: null,
    dryRun: false, quiet: false, status: false, help: false, briefFile: null, words: [], passthrough: [] };
  const need = (i, f) => { if (i >= argv.length) throw new Error(`${f} needs a value`); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.passthrough = argv.slice(i + 1); break; }
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--status') o.status = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--yolo') o.mode = 'yolo';
    else if (a === '--write') o.mode = 'write';
    else if (a === '--config') o.config = need(++i, a);
    else if (a === '--expect') o.expect = need(++i, a);
    else if (a === '--sentinel') o.sentinel = need(++i, a);
    else if (a === '--model') o.model = need(++i, a);
    else if (a === '--mode') o.mode = need(++i, a);
    else if (a === '--account') o.account = need(++i, a);
    else if (a === '--cwd') o.cwd = need(++i, a);
    else if (a === '--brief-file') o.briefFile = need(++i, a);
    else if (a === '--minutes') {
      const m = Number(need(++i, a));
      if (!(m > 0)) throw new Error('--minutes must be a number above 0');
      o.minutes = m;
    } else if (a.startsWith('-')) throw new Error(`unknown argument ${a} (pass CLI arguments after --)`);
    else o.words.push(a);
  }
  return o;
}

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
const hhmm = (iso) => iso.replace('T', ' ').slice(0, 16) + ' UTC';

async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { out({ ok: false, error: 'usage', message: e.message }); return EXIT.USAGE; }
  if (o.help) { process.stdout.write(HELP + '\n'); return EXIT.OK; }
  const say = o.quiet ? () => {} : (s) => process.stderr.write(s + '\n');

  const cfgPath = o.config || process.env.CLI_ROTATOR_CONFIG || 'cli-rotator.json';
  const { config: cfg, errors } = loadConfig(cfgPath);
  if (errors.length) {
    out({ ok: false, error: 'config', config: cfgPath, errors });
    for (const e of errors) say(`config error: ${e}`);
    return EXIT.USAGE;
  }
  const ledgerFile = path.join(cfg.stateDir, 'ledger.jsonl');
  const inflightDir = path.join(cfg.stateDir, 'inflight');
  const model = o.model ?? cfg.defaultModel;
  const gate = (live) => gateDecision({ pct: readMemPct(), running: live.length, gate: cfg.memoryGate });

  if (o.status) {
    const live = sweepInflight(inflightDir);
    const states = accountStates(cfg, readLedger(ledgerFile), live, { model });
    const g = gate(live);
    say(`[cli-rotator] ${states.length} account(s), budget per ${cfg.budgetWindow}, wall scope ${cfg.wallScope}`);
    for (const s of states) {
      say((`  ${s.name.padEnd(10)} ${`${s.used}/${s.budget}`.padStart(7)}  ${s.state.padEnd(12)}${s.running ? ` ${s.running} running` : ''}`
        + `${s.benchedUntil ? ` until ${hhmm(s.benchedUntil)}` : ''}${s.missingEnv ? ` (not set: ${s.missingEnv.join(', ')})` : ''}`).trimEnd());
      if (s.wallText) say(`             wall: ${s.wallText}`);
    }
    say(`  memory gate: ${g.reason}${g.level === 'off' ? '' : ` -> ${g.allow ? 'lanes allowed' : 'LANES REFUSED'}`}`);
    out({ ok: true, status: { accounts: states, memoryGate: { ...g, config: cfg.memoryGate }, running: live.length } });
    return EXIT.OK;
  }

  if (o.mode && !(o.mode in cfg.modes)) { out({ ok: false, error: 'usage', message: `mode "${o.mode}" is not in the config's "modes"` }); return EXIT.USAGE; }
  let prompt = o.words.join(' ');
  if (o.briefFile) {
    try { prompt = fs.readFileSync(o.briefFile, 'utf8'); } catch (e) { out({ ok: false, error: 'usage', message: `cannot read --brief-file: ${e.code || e.message}` }); return EXIT.USAGE; }
  }
  if (!prompt.trim()) { out({ ok: false, error: 'usage', message: 'no brief given (a positional argument or --brief-file)' }); say(HELP); return EXIT.USAGE; }
  const cwd = path.resolve(o.cwd || process.cwd());
  // A relative --expect is resolved against the CLI's working directory, and the agent is always told the absolute path.
  if (o.expect) o.expect = path.resolve(cwd, o.expect);
  if (o.account && !cfg.accounts.some((a) => a.name === o.account)) { out({ ok: false, error: 'usage', message: `--account ${o.account} is not in the config` }); return EXIT.USAGE; }
  const sentinel = o.sentinel ?? cfg.expect.sentinel;
  if (o.expect && cfg.promptSuffix) prompt += fill(cfg.promptSuffix, { expect: o.expect, sentinel });
  const timeoutMs = Math.round((o.minutes ?? cfg.timeoutMinutes) * 60000);

  const rows = readLedger(ledgerFile);
  const live = sweepInflight(inflightDir);
  const g = gate(live);
  if (!g.allow) {
    say(`[cli-rotator] MEMORY GATE: ${g.reason}. Nothing ran.`);
    out({ ok: false, error: 'memory-gate', reason: g.reason, level: g.level, ran: false });
    return EXIT.MEMORY;
  }
  if (g.level === 'hot' || g.level === 'unknown') say(`[cli-rotator] memory gate: ${g.reason}`);

  const states = accountStates(cfg, rows, live, { model }).filter((s) => !o.account || s.name === o.account);
  const skipped = states.filter((s) => s.state !== 'available').map((s) => ({ account: s.name, state: s.state, ...(s.benchedUntil ? { benchedUntil: s.benchedUntil } : {}) }));
  const order = rotationOrder(states);
  for (const s of skipped) say(`[cli-rotator] skip ${s.account}: ${s.state}${s.benchedUntil ? ` until ${hhmm(s.benchedUntil)}` : ''}`);
  if (!order.length) {
    say('[cli-rotator] no account can serve this run. Nothing ran.');
    out({ ok: false, error: 'no-account', reason: 'every account is benched, spent or unconfigured', skipped, ran: false });
    return EXIT.NO_ACCOUNT;
  }

  if (o.dryRun) { // touches no state: no marker, no ledger row, no run log
    const acct = cfg.accounts.find((a) => a.name === order[0].name);
    const inv = buildInvocation(cfg, acct, { prompt: `<brief, ${prompt.length} chars>`, model, mode: o.mode, passthrough: o.passthrough });
    out({ ok: true, dryRun: true, account: acct.name, order: order.map((s) => s.name), skipped, command: inv.command, argv: inv.argv,
      env: [...Object.keys(acct.env), ...Object.keys(acct.envFrom)], scrubbed: cfg.scrubEnv, promptVia: cfg.promptVia, timeoutMs, model, mode: o.mode });
    return EXIT.OK;
  }

  const marker = new Marker(inflightDir);
  process.on('exit', () => marker.release());
  const onSignal = (sig) => { if (CURRENT_CHILD) killTree(CURRENT_CHILD); marker.release(); process.exit(sig === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  // Atomic first pick: walk slot 0 across the order, then slot 1, and take the first marker this process creates.
  let won = null;
  for (let k = 0; k < 64 && !won; k++) for (const s of order) if (marker.claim(s.name, k)) { won = s; break; }
  if (won) { order.splice(order.indexOf(won), 1); order.unshift(won); }

  const before = o.expect ? snapshotExpect(o.expect) : null;
  if (before) say(`[cli-rotator] --expect target already exists; this run must change it to count`);
  const runDir = path.join(cfg.stateDir, 'runs');
  fs.mkdirSync(runDir, { recursive: true });
  const attempts = [];
  let last = null; let lastAcct = null; let logFile = null;
  for (const s of order) {
    const acct = cfg.accounts.find((a) => a.name === s.name);
    if (!marker.holds(acct.name)) marker.claimAny(acct.name);
    say(`[cli-rotator] -> ${acct.name}${model ? ` (model ${model})` : ''}${o.mode ? ` [${o.mode}]` : ''}`);
    const r = await runAttempt(cfg, acct, { prompt, model, mode: o.mode, passthrough: o.passthrough, cwd, timeoutMs });
    const at = new Date().toISOString();
    logFile = path.join(runDir, `${at.replace(/[-:]/g, '').replace(/\..*/, '')}-${process.pid}-${acct.name}.log`);
    try { fs.writeFileSync(logFile, `# ${acct.name} ${r.outcome} exit=${r.exitCode ?? ''} ${r.ms}ms\n## stdout\n${r.stdout}\n## stderr\n${r.stderr}\n`); } catch { logFile = null; }
    const row = { at, account: acct.name, model: model ?? null, mode: o.mode, outcome: r.outcome, exitCode: r.exitCode ?? null, ms: r.ms,
      ...(r.outcome === 'wall' ? { wallText: r.wallText, benchedUntil: r.benchedUntil, resetFrom: r.resetFrom } : {}),
      ...(r.error ? { error: r.error } : {}) };
    try { appendLedger(ledgerFile, row); } catch (e) { say(`[cli-rotator] warning: ledger not written (${e.message})`); }
    const { at: _at, model: _m, mode: _mo, ...brief } = row;
    attempts.push({ ...brief, ...(logFile ? { log: logFile } : {}) });
    last = r; lastAcct = acct;
    if (r.outcome === 'wall') { say(`   wall: ${r.wallText}\n   benched until ${hhmm(r.benchedUntil)} (from ${r.resetFrom}); rotating`); continue; }
    if (r.outcome === 'ok') { say(`   exit ${r.exitCode} in ${(r.ms / 1000).toFixed(1)}s`); break; }
    say(`   ${r.outcome}${r.exitCode != null ? ` (exit ${r.exitCode})` : ''}${r.error ? `: ${r.error}` : ''} after ${(r.ms / 1000).toFixed(1)}s`);
    if (cfg.rotateOn === 'any-failure') { say('   rotating (rotateOn: any-failure)'); continue; }
    break;
  }
  marker.release();

  if (last.outcome === 'wall') {
    say('[cli-rotator] every account tried hit a wall. Nothing was delivered.');
    out({ ok: false, error: 'no-account', reason: 'every account tried hit a quota wall', attempts, skipped, ran: true });
    return EXIT.NO_ACCOUNT;
  }
  const result = { account: lastAcct.name, cliOutcome: last.outcome, exitCode: last.exitCode ?? null, attempts, ...(skipped.length ? { skipped } : {}) };
  if (o.expect) {
    const v = expectVerdict({ file: o.expect, before, minBytes: cfg.expect.minBytes, sentinel, cliClaimedSuccess: last.outcome === 'ok' });
    say(v.ok ? `   expect: ok (${v.why})` : `   expect: NOT satisfied, ${v.verdict}: ${v.why}`);
    if (v.ok && last.outcome !== 'ok') say(`   the file is complete although the CLI reported ${last.outcome}; the file is the verdict`);
    out({ ok: v.ok, ...result, expect: { path: o.expect, ...v } });
    return v.ok ? EXIT.OK : EXIT.FAILED;
  }
  const ok = last.outcome === 'ok';
  out({ ok, ...result, stdoutTail: last.stdout.trim().slice(-2000) });
  return ok ? EXIT.OK : EXIT.FAILED;
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
