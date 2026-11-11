#!/usr/bin/env node
// anthropic-pool.mjs: spend Anthropic API credit from several keys ("pools") with a per-run cap, a JSONL ledger
// and Message Batches at half price by default. Zero dependencies, Node 18+.
//
//   anthropic-pool status [--human]
//   anthropic-pool api "<prompt>" [--model sonnet] [--max-tokens 2000] [--system-file f] [--prompt-file f] [--out f]
//                      [--now] [--wait-min 60] [--poll-sec 20] [--budget USD] [--pool NAME] [--tag T] [--note "why"] [--dry-run]
//   anthropic-pool api --jsonl prompts.jsonl --out results.jsonl [...]     (many prompts, ONE batch)
//   anthropic-pool agent "<prompt>" [--model sonnet] [--budget USD] [--cwd DIR] [--tools "Read,Grep"] [--mcp-config f.json]
//                        [--timeout-min 60] [--permission-mode acceptEdits] [--print-args] [--dry-run]
//   anthropic-pool collect [batch_id]
//
// Output: one JSON object per run on stdout (`status --human` prints a table instead); notes go to stderr.
// Exit codes: 0 ok (a dry run, a pending batch recorded for `collect`), 1 the API call or the agent run failed,
// 2 usage or configuration error (a rejected --mcp-config included), 3 refused for money: no pool has credit,
// the worst case is over the cap, or a pool already has its maximum number of runs in flight.
//
// Keys come from an environment variable or a key file named in the config. A key is sent only in the x-api-key
// header to the configured base URL, or put in the environment of the `claude` child process. It is never
// printed, logged or written, and this process never sets a global ANTHROPIC_API_KEY.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const MIN_RUN_USD = 0.05;
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const usd = (n) => 'USD' + (Math.round(n * 100) / 100).toFixed(2);

export class Refusal extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}
const refuse = (message, code = 2) => { throw new Refusal(message, code); };

// ---------- output (every line written passes through the key scrubber) ----------
const KNOWN_KEYS = new Set();
export function scrub(s) {
  let t = String(s);
  for (const k of KNOWN_KEYS) if (k) t = t.split(k).join('[key]');
  return t;
}
const emit = (obj) => process.stdout.write(scrub(JSON.stringify(obj)) + '\n');
const note = (msg) => process.stderr.write(scrub(msg) + '\n');

// ---------- arguments ----------
const BOOL_FLAGS = new Set(['status', 'dry-run', 'now', 'print-args', 'human', 'help']);
const VALUE_FLAGS = new Set(['config', 'pool', 'model', 'budget', 'max-tokens', 'system-file', 'prompt-file', 'out', 'tag', 'note',
  'wait-min', 'poll-sec', 'jsonl', 'cwd', 'tools', 'timeout-min', 'mcp-config', 'permission-mode']);
export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { o.help = true; continue; }
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (BOOL_FLAGS.has(k)) o[k] = true;
    else if (VALUE_FLAGS.has(k)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) refuse(`--${k} needs a value`);
      o[k] = v; i++;
    } else refuse(`unknown argument --${k} (see --help)`);
  }
  if (o.status && !o._.length) o._.push('status');
  return o;
}

// ---------- configuration ----------
const expandHome = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
const resolveFrom = (base, p) => path.resolve(base, expandHome(p));

export function loadConfig(file, env = process.env) {
  const abs = path.resolve(file);
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch { refuse(`no config file at ${abs} (pass --config or set ANTHROPIC_POOL_CONFIG; see examples/config.example.json)`); }
  let c;
  try { c = JSON.parse(raw); } catch { refuse(`config ${abs} is not valid JSON`); }
  return normaliseConfig(c, path.dirname(abs), env);
}

export function normaliseConfig(c, baseDir, env = process.env) {
  if (!c || typeof c !== 'object') refuse('config must be a JSON object');
  if (!Array.isArray(c.pools) || !c.pools.length) refuse('config needs a non-empty "pools" array');
  const names = new Set();
  const pools = c.pools.map((p, i) => {
    const at = `pools[${i}]`;
    if (!p || typeof p.name !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(p.name)) refuse(`${at}.name must be a short name (letters, digits, _ . -)`);
    if (names.has(p.name)) refuse(`two pools are named ${p.name}`);
    names.add(p.name);
    if (!p.key_env === !p.key_file) refuse(`${at} needs exactly one of "key_env" (an environment variable name) or "key_file" (a path)`);
    if (p.key_env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.key_env)) refuse(`${at}.key_env must be an environment variable NAME, not a key`);
    const num = (k, d, min) => {
      const v = p[k] === undefined ? d : p[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min) refuse(`${at}.${k} must be a number >= ${min}`);
      return v;
    };
    if (!Number.isInteger(p.reset_day) || p.reset_day < 1 || p.reset_day > 31) refuse(`${at}.reset_day must be a day of the month, 1 to 31`);
    const maxConc = p.max_concurrent === undefined ? 3 : p.max_concurrent;
    if (!Number.isInteger(maxConc) || maxConc < 1) refuse(`${at}.max_concurrent must be a whole number >= 1`);
    return {
      name: p.name,
      key_env: p.key_env || null,
      key_file: p.key_file ? resolveFrom(baseDir, p.key_file) : null,
      monthly_budget_usd: num('monthly_budget_usd', undefined, 0),
      reset_day: p.reset_day,
      per_run_cap_usd: num('per_run_cap_usd', 5, 0.01),
      max_concurrent: maxConc,
      floor_usd: num('floor_usd', 0, 0),
    };
  });
  const tz = c.timezone_offset_hours === undefined ? 0 : c.timezone_offset_hours;
  if (typeof tz !== 'number' || tz < -14 || tz > 14) refuse('timezone_offset_hours must be a number from -14 to 14');
  const base = String(env.ANTHROPIC_BASE_URL || c.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let u;
  try { u = new URL(base); } catch { refuse(`base URL ${base} is not a URL`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) refuse(`base URL ${u.origin} must be https (plain http is allowed only on localhost), because the key travels in a header`);
  const models = { ...DEFAULT_MODELS, ...(c.models || {}) };
  const prices = {};
  for (const [id, p] of Object.entries(c.price_per_mtok_usd || {})) if (!id.startsWith('$')) prices[id] = p;
  let cmd = c.claude_command === undefined ? ['claude'] : c.claude_command;
  if (typeof cmd === 'string') cmd = [cmd];
  if (!Array.isArray(cmd) || !cmd.length || cmd.some((x) => typeof x !== 'string' || !x)) refuse('claude_command must be a string or an array of strings');
  const ledgerDir = env.ANTHROPIC_POOL_DIR ? path.resolve(env.ANTHROPIC_POOL_DIR)
    : resolveFrom(baseDir, c.ledger_dir || '.anthropic-pool');
  return {
    pools, models, prices,
    default_model: c.default_model || 'sonnet',
    timezone_offset_hours: tz,
    base_url: base,
    base_is_default: base === DEFAULT_BASE_URL,
    batch_min_hours: typeof c.batch_min_hours === 'number' ? c.batch_min_hours : 26,
    claude_command: cmd.map((x, i) => (i === 0 && /[\\/]/.test(x) ? resolveFrom(baseDir, x) : x)),
    deny_cwd: (c.deny_cwd || []).map((p) => resolveFrom(baseDir, p)),
    ledger_dir: ledgerDir,
  };
}

export const dirsOf = (cfg) => ({
  ledger: path.join(cfg.ledger_dir, 'ledger.jsonl'),
  runs: path.join(cfg.ledger_dir, 'runs'),
  inflight: path.join(cfg.ledger_dir, 'runs', 'inflight'),
  batches: path.join(cfg.ledger_dir, 'runs', 'batches.jsonl'),
  lock: path.join(cfg.ledger_dir, 'runs', 'collect.lock'),
});

// ---------- keys ----------
// Returns {ok, key} or {ok:false, why}. `why` never contains the value.
export function readKey(pool, env = process.env) {
  let k, where;
  if (pool.key_env) {
    where = `environment variable ${pool.key_env}`;
    k = env[pool.key_env];
    if (!k) return { ok: false, why: `${where} is not set` };
  } else {
    where = `key file ${pool.key_file}`;
    try { k = fs.readFileSync(pool.key_file, 'utf8'); } catch { return { ok: false, why: `no ${where}` }; }
  }
  k = String(k).trim();
  if (!k.startsWith('sk-ant-')) return { ok: false, why: `${where} does not hold an Anthropic API key (wrong prefix; value not shown)` };
  if (k.startsWith('sk-ant-admin')) return { ok: false, why: `${where} holds an Admin key; a pool needs a normal API key` };
  KNOWN_KEYS.add(k);
  return { ok: true, key: k };
}

// ---------- the monthly cycle ----------
// A pool's cycle starts at local midnight on reset_day (clamped to the month's last day) and ends at the next one.
export function cycle(now, resetDay, tzHours = 0) {
  const off = tzHours * HOUR;
  const local = new Date(now + off);
  const y = local.getUTCFullYear(), m = local.getUTCMonth();
  const resetAt = (yy, mm) => {
    const first = new Date(Date.UTC(yy, mm, 1));
    const Y = first.getUTCFullYear(), M = first.getUTCMonth();
    const dim = new Date(Date.UTC(Y, M + 1, 0)).getUTCDate();
    return Date.UTC(Y, M, Math.min(resetDay, dim)) - off;
  };
  let sm = m;
  let start = resetAt(y, m);
  if (now < start) { sm = m - 1; start = resetAt(y, sm); }
  return { start, end: resetAt(y, sm + 1) };
}

// ---------- the ledger, in-flight claims and pending batches ----------
const readJsonl = (f) => {
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { return []; }
  return txt.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const appendJsonl = (f, row) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(row) + '\n'); };

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

export function inflight(ctx, poolName) {
  const dir = ctx.dirs.inflight;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const live = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Date.now() - Date.parse(j.ts) < 3 * HOUR && pidAlive(j.pid)) live.push(j); else fs.rmSync(p, { force: true });
    } catch { fs.rmSync(p, { force: true }); }
  }
  return poolName ? live.filter((j) => j.pool === poolName) : live;
}

function claim(ctx, runId, reserveUsd, pool) {
  fs.mkdirSync(ctx.dirs.inflight, { recursive: true });
  const f = path.join(ctx.dirs.inflight, runId + '.json');
  fs.writeFileSync(f, JSON.stringify({ run_id: runId, pid: process.pid, reserve_usd: reserveUsd, pool, ts: new Date().toISOString() }));
  return () => fs.rmSync(f, { force: true });
}

// Pending records carry a pool; a collected batch gets a {batch_id, collected_at} line appended (never rewritten).
export function uncollected(ctx) {
  const rows = readJsonl(ctx.dirs.batches);
  const done = new Set(rows.filter((r) => r.collected_at).map((r) => r.batch_id));
  return rows.filter((r) => r.batch_id && r.pool && !r.collected_at && !done.has(r.batch_id));
}

export function poolState(ctx, pool) {
  const now = ctx.now();
  const { start, end } = cycle(now, pool.reset_day, ctx.cfg.timezone_offset_hours);
  const spent = readJsonl(ctx.dirs.ledger).filter((r) => r.pool === pool.name && Date.parse(r.ts) >= start && Date.parse(r.ts) < end)
    .reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  const live = inflight(ctx, pool.name);
  // A batch whose wait ran out still owes its cost: its worst case stays reserved until it is collected (or for 30 h,
  // past the API's 24 h expiry, so a forgotten one stops blocking).
  const pending = uncollected(ctx).filter((b) => b.pool === pool.name && Date.now() - Date.parse(b.ts) < 30 * HOUR);
  const reserved = live.reduce((s, j) => s + (Number(j.reserve_usd) || 0), 0) + pending.reduce((s, b) => s + (Number(b.worst_usd) || 0), 0);
  const available = Math.max(0, pool.monthly_budget_usd - spent - pool.floor_usd - reserved);
  const frac = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const line = pool.monthly_budget_usd * frac;
  return {
    name: pool.name, start, end,
    cycle_start: new Date(start).toISOString(), cycle_end: new Date(end).toISOString(),
    hours_left: r4((end - now) / HOUR),
    budget_usd: pool.monthly_budget_usd, spent_usd: r4(spent), reserved_usd: r4(reserved), floor_usd: pool.floor_usd,
    available_usd: r4(available), per_run_cap_usd: pool.per_run_cap_usd,
    inflight: live.length, max_concurrent: pool.max_concurrent,
    pace: { line_usd: r4(line), behind_usd: r4(line - spent), days_left: Math.max(0, Math.ceil((end - now) / DAY)) },
  };
}

// ---------- choosing a pool ----------
// Without --pool: the ready pool whose cycle ends soonest (its credit expires first); ties keep config order.
// Ready = key present (unless ignoreKeys), at least USD0.05 available, and a free run slot.
export function rankPools(ctx, { ignoreKeys = false } = {}) {
  const ready = [], notReady = [];
  for (const p of ctx.cfg.pools) {
    const s = poolState(ctx, p);
    const k = readKey(p, ctx.env);
    if (!k.ok && !ignoreKeys) notReady.push({ pool: p.name, why: k.why });
    else if (s.available_usd < MIN_RUN_USD) notReady.push({ pool: p.name, why: `only ${usd(s.available_usd)} available (budget ${usd(s.budget_usd)}, spent ${usd(s.spent_usd)}, reserved ${usd(s.reserved_usd)}, floor ${usd(s.floor_usd)})` });
    else if (s.inflight >= p.max_concurrent) notReady.push({ pool: p.name, why: `${s.inflight} runs already in flight (max ${p.max_concurrent})` });
    else ready.push({ pool: p, state: s, key: k.ok });
  }
  ready.sort((a, b) => a.state.end - b.state.end);
  return { ready, notReady };
}

export function choosePool(ctx, wanted, opts = {}) {
  if (wanted) {
    const p = ctx.cfg.pools.find((x) => x.name === wanted);
    if (!p) refuse(`--pool must be one of ${ctx.cfg.pools.map((x) => x.name).join(' | ')}`);
    return p;
  }
  const { ready, notReady } = rankPools(ctx, opts);
  if (!ready.length) refuse(`no pool is ready: ${notReady.map((x) => `${x.pool}: ${x.why}`).join('; ')}`, 3);
  return ready[0].pool;
}

export function budgetFor(ctx, pool, asked) {
  const s = poolState(ctx, pool);
  if (s.inflight >= pool.max_concurrent) refuse(`${s.inflight} runs already in flight on pool ${pool.name} (max ${pool.max_concurrent}); wait for one to finish`, 3);
  const want = asked === undefined ? pool.per_run_cap_usd : Number(asked);
  if (!(want > 0)) refuse('--budget must be a positive number of USD');
  const budget = Math.min(want, pool.per_run_cap_usd, s.available_usd);
  if (budget < MIN_RUN_USD) refuse(`only ${usd(s.available_usd)} is available on pool ${pool.name} (budget ${usd(s.budget_usd)}, spent ${usd(s.spent_usd)}, reserved ${usd(s.reserved_usd)}, floor ${usd(s.floor_usd)})`, 3);
  return { budget: r4(budget), state: s };
}

export function modelId(cfg, m) {
  const want = m || cfg.default_model;
  const id = cfg.models[want] || Object.values(cfg.models).find((v) => v === want);
  if (!id) refuse(`model ${want} is not in the config's "models" (${Object.entries(cfg.models).map(([a, v]) => `${a}=${v}`).join(', ')})`);
  return id;
}

// ---------- cost ----------
// usage.cache_creation_input_tokens is the TOTAL of cache writes; usage.cache_creation, when present, splits it into
// 5-minute (price.cache_write) and 1-hour (price.cache_write_1h, else twice the input price) writes.
export function costOf(u, price, mult = 1) {
  const total = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation;
  let w5 = total, w1 = 0;
  if (cc && typeof cc === 'object') {
    w1 = cc.ephemeral_1h_input_tokens || 0;
    w5 = (cc.ephemeral_5m_input_tokens || 0) + Math.max(0, total - w1 - (cc.ephemeral_5m_input_tokens || 0));
  }
  const p1h = price.cache_write_1h != null ? price.cache_write_1h : price.input * 2;
  return mult * ((u.input_tokens || 0) * price.input + w5 * price.cache_write + w1 * p1h
    + (u.cache_read_input_tokens || 0) * price.cache_read + (u.output_tokens || 0) * price.output) / 1e6;
}
// A rough worst case before the call: about 3 characters per input token, plus every allowed output token.
export const worstOf = (price, prompt, system, maxTokens) => (((prompt || '').length + (system || '').length) / 3) * price.input / 1e6 + maxTokens * price.output / 1e6;

function priceFor(cfg, id) {
  const p = cfg.prices[id];
  const ok = p && ['input', 'output', 'cache_write', 'cache_read'].every((k) => typeof p[k] === 'number' && p[k] >= 0);
  if (!ok) refuse(`no complete price for ${id} in the config's "price_per_mtok_usd" (input, output, cache_write, cache_read per million tokens), so the run cannot be costed`);
  return p;
}

// ---------- --mcp-config check: no credential may appear in an MCP config handed to an agent ----------
const CRED_KEY_RE = /api[_-]?key|token|secret|password|authorization|bearer/i;
const CRED_FLAG_RE = /^--?[\w-]*(api[_-]?key|token|secret|password|authorization|bearer)/i;
export function valueLooksLikeKey(s) {
  if (typeof s !== 'string') return false;
  if (/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/.test(s)) return true;
  if (/\bBearer\s+\S+/i.test(s)) return true;
  if (/\b[0-9a-fA-F]{32,}\b/.test(s)) return true;
  // a long base64-like run: mixed case and a digit, and not a path
  return s.split(/[^A-Za-z0-9+/_=-]+/).some((t) => t.length >= 32 && !t.startsWith('/') && (t.match(/\//g) || []).length < 3 && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t));
}
// Returns the key path of the first credential-looking key or value, or null. Never returns a value.
export function findCredential(node, at = '') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) { const r = findCredential(node[i], `${at}[${i}]`); if (r) return r; }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [key, val] of Object.entries(node)) {
      const here = at ? `${at}.${key}` : key;
      if (CRED_KEY_RE.test(key)) return here;
      const r = findCredential(val, here);
      if (r) return r;
    }
    return null;
  }
  if (typeof node === 'string' && (valueLooksLikeKey(node) || CRED_FLAG_RE.test(node))) return at || '(root)';
  return null;
}
export function checkMcpConfig(p) {
  if (typeof p !== 'string' || !p.trim()) refuse('--mcp-config needs a path to a .json file');
  const abs = path.resolve(p);
  if (path.extname(abs).toLowerCase() !== '.json') refuse(`--mcp-config ${abs} is not a .json file`);
  let st;
  try { st = fs.statSync(abs); } catch { refuse(`--mcp-config file does not exist: ${abs}`); }
  if (!st.isFile()) refuse(`--mcp-config ${abs} is not a file`);
  let j;
  try { j = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { refuse(`--mcp-config ${abs} is not valid JSON (parser detail withheld: it can quote the file)`); }
  const servers = j && j.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) refuse(`--mcp-config ${abs} has no "mcpServers" object`);
  const cred = findCredential(j);
  if (cred) refuse(`--mcp-config ${abs} carries something that looks like a credential at "${cred}" (value not shown); keep keys out of MCP configs`);
  return abs;
}

// ---------- agent mode ----------
// The child sees ONLY these variables (an allow-list), plus ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL when one is configured).
export const AGENT_ENV_ALLOW = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA',
  'LOCALAPPDATA', 'COMSPEC', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'NODE_OPTIONS'];
export function agentEnv(src, key, baseUrl) {
  const env = {};
  for (const [name, val] of Object.entries(src)) if (val !== undefined && AGENT_ENV_ALLOW.includes(name.toUpperCase())) env[name] = val;
  env.ANTHROPIC_API_KEY = key;
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  return env;
}
export function buildAgentArgs(o, id, budget, mcpAbs) {
  const args = ['--bare', '-p', '--model', id, '--max-budget-usd', budget.toFixed(2), '--output-format', 'json',
    '--permission-mode', o['permission-mode'] || 'acceptEdits'];
  if (o.tools) args.push('--allowedTools', o.tools);
  // --mcp-config is variadic in the claude CLI, so it goes last; --strict-mcp-config uses only the servers in that file.
  if (mcpAbs) args.push('--strict-mcp-config', '--mcp-config', mcpAbs);
  return args;
}

const newRunId = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');

function promptOf(o) {
  let p;
  if (o['prompt-file']) {
    try { p = fs.readFileSync(o['prompt-file'], 'utf8'); } catch { refuse(`cannot read --prompt-file ${o['prompt-file']}`); }
  } else p = o._[1];
  if (!p || !p.trim()) refuse('no prompt (pass it as the argument after the mode, or --prompt-file)');
  return p;
}

async function agent(ctx, o) {
  const { cfg } = ctx;
  const id = modelId(cfg, o.model);
  const mcpAbs = o['mcp-config'] !== undefined ? checkMcpConfig(o['mcp-config']) : null; // before any pool or key
  const prompt = promptOf(o);
  if (o['print-args']) { // no pool, key, ledger or spawn; the budget shown is the requested cap, not a reservation
    const p = o.pool ? choosePool(ctx, o.pool) : cfg.pools[0];
    const shown = Math.min(Number(o.budget) > 0 ? Number(o.budget) : p.per_run_cap_usd, p.per_run_cap_usd);
    return { exit: 0, out: { ok: true, mode: 'print-args', command: cfg.claude_command, args: buildAgentArgs(o, id, shown, mcpAbs) } };
  }
  const pool = choosePool(ctx, o.pool, { ignoreKeys: !!o['dry-run'] });
  const { budget } = budgetFor(ctx, pool, o.budget);
  const runId = newRunId();
  const cwd = path.resolve(o.cwd || path.join(ctx.dirs.runs, 'work', runId));
  const inside = (root) => { const rel = path.relative(root, cwd); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  if (cfg.deny_cwd.some(inside)) refuse(`--cwd ${cwd} is inside a folder listed in deny_cwd; an agent never runs there`);
  const k = readKey(pool, ctx.env);
  const args = buildAgentArgs(o, id, budget, mcpAbs);
  if (o['dry-run']) return { exit: 0, out: { ok: true, dry_run: true, mode: 'agent', pool: pool.name, model: id, cap_usd: budget, cwd, command: cfg.claude_command, args, key: k.ok ? 'present' : 'missing', network: false } };
  if (!k.ok) refuse(k.why);
  fs.mkdirSync(cwd, { recursive: true });
  const release = claim(ctx, runId, budget, pool.name);
  const started = Date.now();
  let code, outTxt = '', errTxt = '';
  try {
    const [exe, ...pre] = cfg.claude_command;
    const child = spawn(exe, [...pre, ...args], { cwd, env: agentEnv(ctx.env, k.key, cfg.base_is_default ? null : cfg.base_url), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (d) => (outTxt += d));
    child.stderr.on('data', (d) => (errTxt += d));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const timer = setTimeout(() => child.kill(), Number(o['timeout-min'] || 60) * 60e3);
    code = await new Promise((r) => { child.on('error', (e) => { errTxt += String(e.message); r(127); }); child.on('close', r); });
    clearTimeout(timer);
  } finally { release(); }
  let j = null;
  try { j = JSON.parse(outTxt); } catch {}
  const known = !!(j && typeof j.total_cost_usd === 'number');
  const cost = known ? j.total_cost_usd : budget; // an unknown cost is booked at the cap
  const resultFile = path.join(ctx.dirs.runs, runId + '.json');
  fs.writeFileSync(resultFile, scrub(JSON.stringify({ run_id: runId, model: id, cwd, exit: code, budget_usd: budget, output: j || outTxt.slice(0, 20000), stderr: errTxt.slice(0, 4000) }, null, 2)));
  appendJsonl(ctx.dirs.ledger, { ts: new Date(ctx.now()).toISOString(), run_id: runId, pool: pool.name, mode: 'agent', model: id, tag: o.tag || null, note: o.note || null,
    budget_usd: budget, cost_usd: r4(cost), cost_known: known, exit: code, secs: Math.round((Date.now() - started) / 1000) });
  const ok = code === 0 && !!j && !j.is_error;
  if (!ok && errTxt) note(errTxt.slice(0, 2000));
  return { exit: ok ? 0 : 1, out: { ok, mode: 'agent', run_id: runId, pool: pool.name, model: id, exit: code, cost_usd: r4(cost), cost_known: known, cap_usd: budget, result_file: resultFile, result: j && typeof j.result === 'string' ? j.result : null } };
}

// ---------- HTTP (the key goes only to the configured base URL's origin) ----------
async function call(ctx, method, url, key, body) {
  if (new URL(url).origin !== new URL(ctx.cfg.base_url).origin) throw new Error(`refusing to send the key to ${new URL(url).origin}: it is not the configured base URL`);
  const res = await fetch(url, { method, headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, text, json };
}
const apiError = (r) => `HTTP ${r.status}: ${(r.json && r.json.error && (r.json.error.message || r.json.error.type)) || r.text.slice(0, 300)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) => ((m && m.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

async function waitForBatch(ctx, id, key, waitMs, pollMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await call(ctx, 'GET', `${ctx.cfg.base_url}/v1/messages/batches/${encodeURIComponent(id)}`, key);
    if (r.ok && r.json && r.json.processing_status === 'ended') return r.json;
    if (!r.ok && r.status < 500 && r.status !== 429) throw new Error(apiError(r));
    if (!r.ok) note(`poll failed (${apiError(r)}); retrying`);
    if (Date.now() + pollMs > deadline) return null;
    await sleep(pollMs);
  }
}
async function fetchResults(ctx, batch, key) {
  if (!batch.results_url) throw new Error('the batch has ended but carries no results_url');
  const r = await call(ctx, 'GET', batch.results_url, key);
  if (!r.ok) throw new Error(apiError(r));
  return r.text.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Turn a batch's result lines into the output file and ONE ledger row at half price.
function settleBatch(ctx, b, lines) {
  const price = priceFor(ctx.cfg, b.model);
  let cost = 0, known = true, tin = 0, tout = 0;
  const rows = [];
  for (const l of lines) {
    const r = l.result || {};
    if (r.type === 'succeeded') {
      const u = (r.message && r.message.usage) || {};
      if (!r.message || !r.message.usage) known = false;
      cost += costOf(u, price, 0.5); tin += u.input_tokens || 0; tout += u.output_tokens || 0;
      rows.push({ custom_id: l.custom_id, text: textOf(r.message) });
    } else {
      const why = r.type === 'errored' ? JSON.stringify((r.error && (r.error.error || r.error)) || r).slice(0, 500) : String(r.type || 'unknown');
      rows.push({ custom_id: l.custom_id, text: '', error: why });
    }
  }
  const failed = rows.filter((x) => x.error).length;
  appendJsonl(ctx.dirs.ledger, { ts: new Date(ctx.now()).toISOString(), run_id: b.run_id, pool: b.pool, mode: 'batch', batch_id: b.batch_id, model: b.model, tag: b.tag || null, note: b.note || null,
    budget_usd: b.budget_usd, cost_usd: r4(cost), cost_known: known, requests: b.requests || rows.length, failed, input_tokens: tin, output_tokens: tout });
  if (b.jsonl) fs.writeFileSync(b.out, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  else if (b.out) fs.writeFileSync(b.out, rows[0] ? rows[0].text : '');
  const res = { batch_id: b.batch_id, pool: b.pool, model: b.model, requests: rows.length, succeeded: rows.length - failed, failed,
    cost_usd: r4(cost), cost_known: known, price: 'batch (half)', input_tokens: tin, output_tokens: tout, out: b.out || null };
  if (!b.jsonl && !b.out && rows[0] && !rows[0].error) res.text = rows[0].text;
  if (failed) res.errors = rows.filter((x) => x.error).slice(0, 20).map((x) => ({ custom_id: x.custom_id, error: x.error }));
  return res;
}

function readRequests(o, maxTokens, system) {
  if (!o.jsonl) return [{ custom_id: 'single', prompt: promptOf(o), system, max_tokens: maxTokens }];
  if (!o.out) refuse('--jsonl needs --out (the results go there, one JSON line per request)');
  let txt;
  try { txt = fs.readFileSync(o.jsonl, 'utf8'); } catch { refuse(`cannot read --jsonl ${o.jsonl}`); }
  const reqs = txt.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    let r;
    try { r = JSON.parse(l); } catch { refuse(`${o.jsonl} line ${i + 1} is not valid JSON`); }
    if (!r || !r.custom_id || typeof r.prompt !== 'string' || !r.prompt.trim()) refuse(`${o.jsonl} line ${i + 1} needs "custom_id" and "prompt"`);
    return { custom_id: String(r.custom_id), prompt: r.prompt, system: r.system || system, max_tokens: Number(r.max_tokens || maxTokens) };
  });
  if (!reqs.length) refuse(`${o.jsonl} holds no requests`);
  if (new Set(reqs.map((r) => r.custom_id)).size !== reqs.length) refuse(`${o.jsonl} has duplicate custom_id values`);
  if (reqs.length > 100000) refuse('a batch holds at most 100000 requests');
  return reqs;
}

async function api(ctx, o) {
  const { cfg } = ctx;
  const id = modelId(cfg, o.model);
  const price = priceFor(cfg, id);
  const maxTokens = Number(o['max-tokens'] || 2000);
  if (!(maxTokens >= 1)) refuse('--max-tokens must be a positive number');
  let system;
  if (o['system-file']) { try { system = fs.readFileSync(o['system-file'], 'utf8'); } catch { refuse(`cannot read --system-file ${o['system-file']}`); } }
  const reqs = readRequests(o, maxTokens, system);
  const pool = choosePool(ctx, o.pool, { ignoreKeys: !!o['dry-run'] });
  const { budget, state } = budgetFor(ctx, pool, o.budget);
  const worstFull = reqs.reduce((s, r) => s + worstOf(price, r.prompt, r.system, r.max_tokens), 0);
  let realtime = false, why = 'default: Message Batches API at half price';
  if (o.now) { realtime = true; why = '--now given'; }
  else if (state.hours_left < cfg.batch_min_hours) { realtime = true; why = `pool ${pool.name}'s cycle ends in ${state.hours_left.toFixed(1)} h (under ${cfg.batch_min_hours} h), so a batch could outlive the credit`; }
  if (realtime && o.jsonl) refuse(`--jsonl needs the Batch API, but real-time was chosen (${why}); run it after the reset or send single calls`);
  const worst = r4(realtime ? worstFull : worstFull * 0.5);
  if (worst > budget) refuse(`worst-case cost ${usd(worst)}${realtime ? '' : ' (half price, batch)'} is over the ${usd(budget)} cap; lower --max-tokens or shorten the prompt`, 3);
  const k = readKey(pool, ctx.env);
  if (o['dry-run']) {
    return { exit: 0, out: { ok: true, dry_run: true, mode: 'api', would: realtime ? 'realtime' : 'batch', why, requests: reqs.length, pool: pool.name, model: id,
      worst_usd: worst, cap_usd: budget, key: k.ok ? 'present' : 'missing', network: false } };
  }
  if (!k.ok) refuse(k.why);
  const runId = newRunId();
  if (realtime) return apiNow(ctx, o, { id, price, req: reqs[0], pool, budget, worst, runId, key: k.key, why });
  const release = claim(ctx, runId, worst, pool.name); // held until the batch settles or the wait gives up (then the pending record reserves it)
  try {
    const created = await call(ctx, 'POST', `${cfg.base_url}/v1/messages/batches`, k.key, { requests: reqs.map((r) => ({ custom_id: r.custom_id,
      params: { model: id, max_tokens: r.max_tokens, ...(r.system ? { system: r.system } : {}), messages: [{ role: 'user', content: r.prompt }] } })) });
    if (!created.ok || !created.json || !created.json.id) return { exit: 1, out: { ok: false, mode: 'batch', pool: pool.name, error: `batch create failed: ${apiError(created)}` } };
    const batchId = created.json.id;
    const waitMin = Number(o['wait-min'] || 60);
    const pollSec = Number(o['poll-sec'] || 20);
    note(`batch ${batchId} submitted on pool ${pool.name} (${id}), ${reqs.length} request(s), worst case ${usd(worst)} at half price; waiting up to ${waitMin} min`);
    const rec = { ts: new Date().toISOString(), batch_id: batchId, pool: pool.name, model: id, tag: o.tag || null, note: o.note || null, out: o.out ? path.resolve(o.out) : null,
      budget_usd: budget, worst_usd: worst, run_id: runId, requests: reqs.length, jsonl: !!o.jsonl };
    let ended = null, waitErr = null;
    try { ended = await waitForBatch(ctx, batchId, k.key, waitMin * 60e3, pollSec * 1e3); } catch (e) { waitErr = e; }
    if (!ended) {
      appendJsonl(ctx.dirs.batches, rec);
      if (waitErr) note(`polling failed (${waitErr.message}); the batch was submitted, so it is recorded as pending`);
      return { exit: 0, out: { ok: true, mode: 'batch', pending: true, batch_id: batchId, pool: pool.name, model: id, run_id: runId, worst_usd: worst,
        collect: `anthropic-pool collect ${batchId}` } };
    }
    const res = settleBatch(ctx, rec, await fetchResults(ctx, ended, k.key));
    return { exit: res.failed && !o.jsonl ? 1 : 0, out: { ok: !(res.failed && !o.jsonl), mode: 'batch', run_id: runId, ...res } };
  } finally { release(); }
}

async function apiNow(ctx, o, { id, price, req, pool, budget, worst, runId, key, why }) {
  const release = claim(ctx, runId, worst, pool.name);
  let r;
  try {
    r = await call(ctx, 'POST', `${ctx.cfg.base_url}/v1/messages`, key, { model: id, max_tokens: req.max_tokens, ...(req.system ? { system: req.system } : {}), messages: [{ role: 'user', content: req.prompt }] });
  } finally { release(); }
  const j = r.json || {};
  const u = j.usage || {};
  const cost = costOf(u, price);
  appendJsonl(ctx.dirs.ledger, { ts: new Date(ctx.now()).toISOString(), run_id: runId, pool: pool.name, mode: 'api', model: id, tag: o.tag || null, note: o.note || null,
    budget_usd: budget, cost_usd: r4(cost), cost_known: !!j.usage, http: r.status, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 });
  if (!r.ok) return { exit: 1, out: { ok: false, mode: 'api', run_id: runId, pool: pool.name, model: id, http: r.status, cost_usd: r4(cost), error: apiError(r) } };
  const text = textOf(j);
  if (o.out) fs.writeFileSync(o.out, text);
  const out = { ok: true, mode: 'api', why, run_id: runId, pool: pool.name, model: id, http: r.status, cost_usd: r4(cost), price: 'real-time (full)',
    input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, stop_reason: j.stop_reason || null, out: o.out || null };
  if (!o.out) out.text = text;
  return { exit: 0, out };
}

// ---------- collect (a lock, so two collectors never double-book the ledger) ----------
export function takeLock(file, staleMs = 10 * 60e3) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() })); } finally { fs.closeSync(fd); }
      const release = () => fs.rmSync(file, { force: true });
      process.once('exit', release);
      return () => { process.removeListener('exit', release); release(); };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let age;
    try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
    if (age < staleMs) return null;
    const moved = file + '.stale-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
    try { fs.renameSync(file, moved); } catch { continue; }
    let movedAge = Infinity;
    try { movedAge = Date.now() - fs.statSync(moved).mtimeMs; } catch {}
    fs.rmSync(moved, { force: true });
    if (movedAge < staleMs) return null;
  }
  return null;
}

async function collect(ctx, o) {
  const release = takeLock(ctx.dirs.lock);
  if (!release) return { exit: 0, out: { ok: true, mode: 'collect', busy: true, collected: [], note: 'another collect holds the lock; it will book the batches' } };
  try {
    const want = o._[1];
    const list = uncollected(ctx);
    const todo = want ? list.filter((b) => b.batch_id === want) : list;
    if (want && !todo.length) refuse(`batch ${want} is not among the uncollected pending batches`);
    const collected = [], processing = [], errors = [];
    for (const b of todo) {
      const pool = ctx.cfg.pools.find((p) => p.name === b.pool);
      const k = pool ? readKey(pool, ctx.env) : { ok: false, why: `pool ${b.pool} is no longer in the config` };
      if (!k.ok) { errors.push({ batch_id: b.batch_id, error: k.why }); continue; }
      try {
        const r = await call(ctx, 'GET', `${ctx.cfg.base_url}/v1/messages/batches/${encodeURIComponent(b.batch_id)}`, k.key);
        if (!r.ok) throw new Error(apiError(r));
        if (r.json.processing_status !== 'ended') { processing.push({ batch_id: b.batch_id, status: r.json.processing_status }); continue; }
        const res = settleBatch(ctx, b, await fetchResults(ctx, r.json, k.key));
        appendJsonl(ctx.dirs.batches, { batch_id: b.batch_id, collected_at: new Date().toISOString() });
        collected.push(res);
      } catch (e) { errors.push({ batch_id: b.batch_id, error: e.message }); }
    }
    return { exit: errors.length ? 1 : 0, out: { ok: !errors.length, mode: 'collect', collected, still_processing: processing, errors } };
  } finally { release(); }
}

// ---------- status ----------
function status(ctx) {
  const pools = ctx.cfg.pools.map((p) => {
    const s = poolState(ctx, p);
    const k = readKey(p, ctx.env);
    delete s.start; delete s.end;
    return { ...s, key: k.ok ? 'present' : 'missing', key_source: p.key_env ? `env ${p.key_env}` : 'file' };
  });
  const { ready, notReady } = rankPools(ctx);
  return { exit: 0, out: { ok: true, mode: 'status', now: new Date(ctx.now()).toISOString(), base_url: ctx.cfg.base_url, pools,
    would_choose: ready.length ? ready[0].pool.name : null, not_ready: notReady,
    uncollected: uncollected(ctx).map((b) => ({ batch_id: b.batch_id, pool: b.pool, model: b.model, since: b.ts, worst_usd: b.worst_usd })),
    models: ctx.cfg.models } };
}
function statusHuman(s) {
  const L = [];
  const pad = (v, n) => String(v).padEnd(n);
  L.push(pad('pool', 10) + pad('resets in', 12) + pad('spent', 10) + pad('budget', 10) + pad('available', 11) + pad('vs even burn', 18) + pad('runs', 6) + 'key');
  for (const p of s.pools) {
    const gap = p.pace.behind_usd >= 0 ? `${usd(p.pace.behind_usd)} under` : `${usd(-p.pace.behind_usd)} over`;
    L.push(pad(p.name, 10) + pad(`${p.pace.days_left} days`, 12) + pad(usd(p.spent_usd), 10) + pad(usd(p.budget_usd), 10) + pad(usd(p.available_usd), 11)
      + pad(gap, 18) + pad(`${p.inflight}/${p.max_concurrent}`, 6) + `${p.key} (${p.key_source})`);
  }
  L.push(`next run spends: ${s.would_choose || 'nothing (no pool is ready)'}${s.would_choose ? ' (ready, and its credit expires soonest)' : ''}`);
  for (const n of s.not_ready) L.push(`  not ready: ${n.pool}: ${n.why}`);
  L.push(`uncollected batches: ${s.uncollected.length || 'none'}`);
  for (const b of s.uncollected) L.push(`  ${b.batch_id}  (${b.pool}, ${b.model}, up to ${usd(b.worst_usd)}): anthropic-pool collect ${b.batch_id}`);
  return L.join('\n');
}

export const HELP = `anthropic-pool: spend Anthropic API credit from several keys, soonest-expiring first, with caps and a ledger.

Usage:
  anthropic-pool status [--human]
  anthropic-pool api "<prompt>" [--model haiku|sonnet|opus|<id>] [--max-tokens N] [--system-file f] [--prompt-file f]
                     [--out f] [--now] [--wait-min 60] [--poll-sec 20] [--budget USD] [--pool NAME] [--tag T] [--note TEXT] [--dry-run]
  anthropic-pool api --jsonl prompts.jsonl --out results.jsonl [...]   lines {custom_id, prompt, system?, max_tokens?}; ONE batch
  anthropic-pool agent "<prompt>" [--model ..] [--budget USD] [--cwd DIR] [--tools "Read,Grep"] [--mcp-config f.json]
                       [--timeout-min 60] [--permission-mode acceptEdits] [--print-args] [--dry-run]
  anthropic-pool collect [batch_id]

  api      a Messages call, by the Message Batches API (half price) unless --now, or the pool's cycle ends within
           batch_min_hours (default 26). Waits --wait-min minutes, then records the batch as pending for collect.
  agent    a headless "claude --bare -p" run; the key goes only into the child's environment, --max-budget-usd caps it.
  collect  fetch finished pending batches, cost them at half price, book the ledger.
  --dry-run runs every check and makes no network call or spawn. --print-args prints the agent's argv and exits.

Config: --config <file> or ANTHROPIC_POOL_CONFIG (default ./anthropic-pool.config.json); see examples/config.example.json.
Env: ANTHROPIC_POOL_DIR (ledger folder), ANTHROPIC_BASE_URL (API base, https or localhost), ANTHROPIC_POOL_NOW (ISO time, for tests).
Output: one JSON line on stdout. Exit: 0 ok, 1 API or agent failure, 2 usage/config error, 3 refused (credit, cap, concurrency).`;

// ---------- main ----------
export async function main(argv, env = process.env) {
  let o;
  try {
    o = parseArgs(argv);
    if (o.help || (!o._.length)) { process.stdout.write(HELP + '\n'); return o.help ? 0 : 2; }
    const cfg = loadConfig(o.config || env.ANTHROPIC_POOL_CONFIG || 'anthropic-pool.config.json', env);
    const fixed = env.ANTHROPIC_POOL_NOW ? Date.parse(env.ANTHROPIC_POOL_NOW) : NaN;
    if (env.ANTHROPIC_POOL_NOW && Number.isNaN(fixed)) refuse('ANTHROPIC_POOL_NOW is not a date');
    const ctx = { cfg, env, dirs: dirsOf(cfg), now: () => (Number.isNaN(fixed) ? Date.now() : fixed) };
    // Register every configured key with the scrubber up front, so no message can carry one.
    for (const p of cfg.pools) readKey(p, env);
    const mode = o._[0];
    let r;
    if (mode === 'status') {
      r = status(ctx);
      if (o.human) { process.stdout.write(scrub(statusHuman(r.out)) + '\n'); return 0; }
    } else if (mode === 'api') r = await api(ctx, o);
    else if (mode === 'agent') r = await agent(ctx, o);
    else if (mode === 'collect') r = await collect(ctx, o);
    else refuse(`unknown mode ${mode} (status | api | agent | collect)`);
    emit(r.out);
    return r.exit;
  } catch (e) {
    const code = e instanceof Refusal ? e.code : 1;
    emit({ ok: false, error: e.message, exit: code });
    note(`anthropic-pool: ${code === 3 ? 'REFUSED' : 'error'}: ${e.message}`);
    return code;
  }
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
