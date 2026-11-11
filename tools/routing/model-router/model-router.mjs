#!/usr/bin/env node
/**
 * model-router.mjs: pick which model pool should take a piece of work, ranked by use-it-or-lose-it urgency.
 *
 *   node model-router.mjs --task <class> [--config pools.json] [--usage usage.json] [--files a,b] [--private]
 *                         [--ack-scan] [--now] [--human-waiting] [--overnight] [--minutes N] [--at ISO] [--explain]
 *
 * Pools (a subscription, API keys with monthly credit, a free pool, a local model) are declared in a JSON config.
 * Current usage comes from a small JSON file you keep updated, or from numbers in the config. The router reads
 * files only: it never calls a model, never reads a key, never spawns a process.
 *
 * stdout: one JSON object {pool, model, why, fallback, batch, warnings, urgency, chain, freshness, ...}.
 * stderr: the --explain table, and error text.
 * Exit 0 routed · 2 bad usage or bad config · 3 every pool that could take the work has a stale or missing
 * reading (refresh the usage file and route again) · 4 no pool can take the work (blocked, spent, closed, refused).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TASKS = ['judgement', 'bulk', 'read', 'vision-ui', 'code'];
export const WEEK_HOURS = 168;
const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
export const DEFAULTS = { staleMinutes: 30, tieMargin: 0.05, batchMinHours: 26, finalWindowDays: 7, freeUrgency: 0.2, utcOffset: '+00:00' };
// Behaviour by kind; every field can be overridden on the pool itself.
export const KINDS = {
  subscription: { metered: true, cost: 2, batch: false, private: false, privateOnly: false, aheadOfLine: 'last-resort' },
  api: { metered: true, cost: 1, batch: true, private: false, privateOnly: false, aheadOfLine: 'normal' },
  free: { metered: false, cost: 0, batch: false, private: false, privateOnly: false },
  local: { metered: false, cost: 3, batch: false, private: true, privateOnly: true, tier: 0 },
};

export class UsageError extends Error {}

const HELP = `model-router: rank model pools by use-it-or-lose-it urgency and pick one for a task.

usage: node model-router.mjs --task <class> [options]

  --task <class>     task class; must be a key in the config's "tasks" (default: ${DEFAULT_TASKS.join(' | ')})
  --config <file>    pools config (or env MODEL_ROUTER_CONFIG)
  --usage <file>     current usage readings (or env MODEL_ROUTER_USAGE, or "usageFile" in the config)
  --files a,b        files the work will send; scanned for secrets and private data (matches are never printed)
  --private          the work carries private data: only pools with "private": true may take it
  --ack-scan         you have checked the scan hits; route as normal instead of treating the work as private
  --now              the work must run in real time (no Batch)
  --human-waiting    a person is waiting for the answer (no Batch)
  --overnight        label the pick for an overnight queue
  --minutes <N>      expected run length; a pool with a time window must stay open that long
  --at <ISO>         evaluate at this clock instead of now (or env MODEL_ROUTER_NOW)
  --explain          print the ranking table to stderr as well
  --help             this text

exit: 0 routed · 2 bad usage/config · 3 every candidate's reading is stale or missing · 4 nothing can take it
`;

// ---------------------------------------------------------------- args
export function parseArgs(argv) {
  const o = { files: [] };
  const bool = new Set(['private', 'ack-scan', 'now', 'human-waiting', 'overnight', 'explain', 'help']);
  const vals = new Set(['task', 'config', 'usage', 'files', 'minutes', 'at']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { o.help = true; continue; }
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument ${a}`);
    const k = a.slice(2);
    const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (bool.has(k)) { o[camel] = true; continue; }
    if (!vals.has(k)) throw new UsageError(`unknown option --${k}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`--${k} needs a value`);
    if (k === 'files') o.files.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
    else if (k === 'minutes') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new UsageError(`--minutes needs a number of minutes, 0 or more (got ${v})`);
      o.minutes = n;
    } else if (k === 'at') {
      if (!Number.isFinite(Date.parse(v))) throw new UsageError(`--at needs an ISO date-time (got ${v})`);
      o.at = v;
    } else o[camel] = v;
  }
  return o;
}

// ---------------------------------------------------------------- config
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export function parseOffset(s) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(s));
  if (!m) throw new UsageError(`utcOffset must look like +08:00 or -05:00 (got ${s})`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
const parseClock = (s, what) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m || +m[1] > 24 || +m[2] > 59) throw new UsageError(`${what} must be HH:MM (got ${s})`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Validate and normalise a config object. baseDir resolves a relative usageFile. */
export function normaliseConfig(raw, baseDir = process.cwd()) {
  if (!raw || typeof raw !== 'object') throw new UsageError('config must be a JSON object');
  const cfg = { ...DEFAULTS, ...raw };
  for (const k of ['staleMinutes', 'tieMargin', 'batchMinHours', 'finalWindowDays', 'freeUrgency'])
    if (!(Number.isFinite(cfg[k]) && cfg[k] >= 0)) throw new UsageError(`config ${k} must be a number, 0 or more`);
  cfg.offsetMin = parseOffset(cfg.utcOffset);
  if (!Array.isArray(cfg.pools) || !cfg.pools.length) throw new UsageError('config needs a non-empty "pools" array');
  const names = new Set();
  const allTasks = new Set();
  cfg.pools = cfg.pools.map((p, i) => {
    if (!p || typeof p.name !== 'string' || !p.name) throw new UsageError(`pool ${i} needs a "name"`);
    if (names.has(p.name)) throw new UsageError(`pool name "${p.name}" is used twice`);
    names.add(p.name);
    if (!KINDS[p.kind]) throw new UsageError(`pool "${p.name}": kind must be one of ${Object.keys(KINDS).join(' | ')}`);
    const q = { ...KINDS[p.kind], ...p };
    if (!q.models || typeof q.models !== 'object') throw new UsageError(`pool "${p.name}" needs "models" (task class -> model, "*" for any)`);
    for (const k of Object.keys(q.models)) if (k !== '*') allTasks.add(k);
    q.offsetMin = q.utcOffset !== undefined ? parseOffset(q.utcOffset) : cfg.offsetMin;
    if (q.metered) {
      if (!(Number(q.budget) > 0)) throw new UsageError(`pool "${p.name}" (${p.kind}) needs "budget" > 0`);
      const c = q.cycle || {};
      if (c.monthlyResetDay !== undefined) {
        if (!(Number.isInteger(c.monthlyResetDay) && c.monthlyResetDay >= 1 && c.monthlyResetDay <= 31)) throw new UsageError(`pool "${p.name}": cycle.monthlyResetDay must be 1-31`);
      } else if (c.periodDays !== undefined) {
        if (!(Number(c.periodDays) > 0) || !Number.isFinite(Date.parse(c.anchor))) throw new UsageError(`pool "${p.name}": cycle.periodDays needs a number > 0 and cycle.anchor an ISO date-time of any past reset`);
      } else throw new UsageError(`pool "${p.name}" needs "cycle": {"monthlyResetDay": N} or {"periodDays": N, "anchor": ISO}`);
    }
    if (q.window) {
      q.window = { ...q.window, startMin: parseClock(q.window.start, `pool "${p.name}" window.start`), endMin: parseClock(q.window.end, `pool "${p.name}" window.end`) };
      if (q.window.noStartAfter !== undefined) q.window.noStartAfterMin = parseClock(q.window.noStartAfter, `pool "${p.name}" window.noStartAfter`);
      q.window.offsetMin = q.window.utcOffset !== undefined ? parseOffset(q.window.utcOffset) : q.offsetMin;
    }
    return q;
  });
  cfg.tasks = Array.isArray(raw.tasks) && raw.tasks.length ? raw.tasks.map(String) : allTasks.size ? [...allTasks] : DEFAULT_TASKS;
  cfg.scan = { allowEmails: [], patterns: [], maxBytes: 5 * 1024 * 1024, ...(raw.scan || {}) };
  cfg.scan.compiled = (cfg.scan.patterns || []).map((x) => {
    try { return [String(x.name || 'custom'), new RegExp(x.regex, String(x.flags || '').replace(/g/g, '') + 'g')]; } catch (e) { throw new UsageError(`scan pattern ${x.name}: ${e.message}`); }
  });
  if (raw.usageFile) cfg.usageFile = path.resolve(baseDir, raw.usageFile);
  return cfg;
}

export function loadConfig(file) {
  let raw;
  try { raw = readJson(file); } catch (e) { throw new UsageError(`cannot read config ${file}: ${e.code === 'ENOENT' ? 'not found' : e.message}`); }
  return normaliseConfig(raw, path.dirname(path.resolve(file)));
}

/** Readings: {"<pool>": {used, at, resetsAt?, blockedUntil?, blockedModels?, shortWindowPct?, shortWindowResetsAt?}}. */
export function loadUsage(file, warnings) {
  if (!file) return {};
  try { return readJson(file); } catch (e) {
    if (e.code === 'ENOENT') { warnings.push(`usage file ${path.basename(file)} not found: metered pools have no reading`); return {}; }
    throw new UsageError(`cannot parse usage file ${path.basename(file)}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- time
/** The cycle containing `now`: {start, end} in ms. */
export function cycleBounds(cycle, now, offsetMin = 0) {
  if (cycle.periodDays !== undefined) {
    const A = Date.parse(cycle.anchor), P = Number(cycle.periodDays) * DAY;
    const start = A + Math.floor((now - A) / P) * P;
    return { start, end: start + P };
  }
  const off = offsetMin * MIN;
  const t = new Date(now + off);
  const at = (y, m) => { // reset of month m (may overflow) in shifted time, clamped to the month's last day
    const d = new Date(Date.UTC(y, m, 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(cycle.monthlyResetDay, last)) - off;
  };
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  const here = at(y, m);
  return here <= now ? { start: here, end: at(y, m + 1) } : { start: at(y, m - 1), end: here };
}

/** Is a daily window open at `now`, and does it stay open for `minutes`? */
export function windowState(win, now, minutes = 0) {
  const local = (((now / MIN + win.offsetMin) % 1440) + 1440) % 1440;
  const { startMin: s, endMin: e } = win;
  const inside = s <= e ? local >= s && local < e : local >= s || local < e;
  const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  if (!inside) return { open: false, reason: `outside its window ${fmt(s)}-${fmt(e)} (now ${fmt(local)})` };
  const sinceStart = (local - s + 1440) % 1440;
  if (win.noStartAfterMin !== undefined && sinceStart > (win.noStartAfterMin - s + 1440) % 1440)
    return { open: false, reason: `window open but no new work starts after ${fmt(win.noStartAfterMin)} (now ${fmt(local)})` };
  const left = (e - local + 1440) % 1440 || 1440;
  if (minutes > left) return { open: false, reason: `a ${minutes} min run would outlast the window (closes at ${fmt(e)}, ${Math.round(left)} min left)` };
  return { open: true, reason: `inside its window ${fmt(s)}-${fmt(e)}, ${Math.round(left)} min left`, closesAt: now + left * MIN };
}

// ---------------------------------------------------------------- content scan
const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|7z|tar|mp[34]|mov|wav|exe|dll|so|dylib|woff2?|ttf|xlsx?|docx?|pptx?)$/i;
export const SCANS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{6,}/g],
  ['openai-style-key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['env-secret', /^[ \t]*(?:export[ \t]+)?(?=[A-Z])[A-Z0-9_]*?(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|DSN|DATABASE_URL)[A-Z0-9_]*[ \t]*[=:][ \t]*["']?[^\s"']+/gm],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
];
const emailAllowed = (email, allow) => {
  const e = email.toLowerCase();
  return allow.some((a) => { const x = String(a).toLowerCase(); return x === e || (x.startsWith('@') && e.endsWith(x)) || (!x.includes('@') && e.endsWith('@' + x)); });
};
/** Returns [{type, line, source}]. The matched value is never returned, logged or stored. */
export function scanText(text, source, { allowEmails = [], compiled = [] } = {}) {
  const hits = [];
  const lineAt = (i) => { let n = 1; for (let j = 0; j < i; j++) if (text.charCodeAt(j) === 10) n++; return n; };
  for (const [type, re] of [...SCANS, ...compiled]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (type === 'email' && emailAllowed(m[0], allowEmails)) continue;
      hits.push({ type, line: lineAt(m.index), source });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.type.localeCompare(b.type));
}
export function scanFiles(files, scanCfg, warnings) {
  const hits = [];
  for (const f of files) {
    const label = path.basename(f);
    if (BINARY.test(f)) { warnings.push(`content scan skipped ${label} (binary type)`); continue; }
    try {
      if (fs.statSync(f).size > scanCfg.maxBytes) { warnings.push(`content scan skipped ${label} (over ${scanCfg.maxBytes} bytes)`); continue; }
      hits.push(...scanText(fs.readFileSync(f, 'utf8'), label, scanCfg));
    } catch { warnings.push(`content scan could not read ${label}`); }
  }
  return hits;
}

// ---------------------------------------------------------------- urgency
/**
 * urgency = max(0, line - used) / max(1, hours to reset) / budget x 168.
 * line is where usage "should" be if the budget were spent evenly over the cycle. The x168 changes no ordering;
 * it puts the score on a readable scale: 1.0 = the pool must spend one whole budget per week from now to catch up.
 */
export const urgency = (line, used, hoursToReset, budget) => (Math.max(0, line - used) / Math.max(1, hoursToReset) / budget) * WEEK_HOURS;
const rnd = (n, d = 4) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

function pickModel(models, task, blocked) {
  const v = models[task] ?? models['*'];
  if (v === undefined || v === null) return { model: null, why: `no model for task "${task}"` };
  const list = Array.isArray(v) ? v : [v];
  const ok = list.find((m) => !blocked.includes(m));
  return ok ? { model: ok, why: '' } : { model: list[0], why: `every model for "${task}" is blocked (${list.join(', ')})` };
}

/** Build one pool's row: eligibility, tier, urgency, and its freshness entry. */
function assessPool(p, ctx) {
  const { task, now, cfg, usage, privateWork, minutes } = ctx;
  const row = { pool: p.name, kind: p.kind, model: null, eligible: false, urgency: 0, tier: p.tier ?? 1, resetsAt: Infinity, cost: p.cost, batchable: !!p.batch, reason: '' };
  const r = usage[p.name] && typeof usage[p.name] === 'object' ? usage[p.name] : null;
  const fr = { pool: p.name, state: 'n/a', at: null, age_min: null, resets: null, used_as: 'no usage needed' };
  const out = (reason, extra = {}) => { Object.assign(row, { reason }, extra); return { row, fr }; };

  const picked = pickModel(p.models, task, (r && Array.isArray(r.blockedModels) ? r.blockedModels : []).map(String));
  row.model = picked.model;
  if (privateWork && !p.private) return out('refused: not allowed private data');
  if (!privateWork && p.privateOnly) return out('private work only');
  if (p.window) { const w = windowState(p.window, now, minutes); if (!w.open) return out(`closed: ${w.reason}`); row.windowNote = w.reason; }
  if (picked.why) return out(picked.why);
  if (r && r.blockedUntil) {
    const until = Date.parse(r.blockedUntil);
    if (Number.isFinite(until) && until > now) return out(`blocked until ${iso(until)}`);
  }

  if (!p.metered) {
    row.urgency = p.kind === 'free' ? (Number.isFinite(p.urgency) ? p.urgency : cfg.freeUrgency) : (Number.isFinite(p.urgency) ? p.urgency : 0);
    row.eligible = true;
    return out(p.kind === 'free' ? `free pool, fixed urgency ${row.urgency}` : 'local model, fixed urgency');
  }

  // Metered: needs a current reading.
  const cb = cycleBounds(p.cycle, now, p.offsetMin);
  let { start, end } = cb;
  const len = end - start;
  let used, state;
  if (r && Number.isFinite(Number(r.used))) {
    const at = Date.parse(r.at);
    fr.at = iso(at); fr.age_min = Number.isFinite(at) ? Math.round((now - at) / MIN) : null;
    if (!Number.isFinite(at) || now - at > cfg.staleMinutes * MIN) {
      fr.state = Number.isFinite(at) ? 'stale' : 'undated'; fr.used_as = `not used: older than ${cfg.staleMinutes} min or undated; refresh it`;
      return out(`stale reading (${fr.age_min === null ? 'no "at"' : fr.age_min + ' min old'}, limit ${cfg.staleMinutes} min)`, { staleOnly: true });
    }
    const vendorReset = Date.parse(r.resetsAt);
    if (Number.isFinite(vendorReset) && vendorReset > now) { end = vendorReset; start = end - len; }
    if ((Number.isFinite(vendorReset) && vendorReset <= now) || at < start) {
      used = 0; state = 'expired';
      fr.used_as = `0 (the reading of ${r.used} belongs to a cycle that has reset)`;
    } else { used = Number(r.used); state = 'fresh'; fr.used_as = `${used} of ${p.budget}`; }
  } else if (Number.isFinite(Number(p.used))) {
    used = Number(p.used); state = 'static'; fr.used_as = `${used} of ${p.budget} (fixed number in the config)`;
  } else {
    fr.state = 'missing'; fr.used_as = 'no reading: add one to the usage file';
    return out('no usage reading', { staleOnly: true });
  }
  fr.state = state; fr.resets = iso(end);

  const hours = (end - now) / HOUR;
  const line = p.budget * Math.min(1, Math.max(0, (now - start) / len));
  Object.assign(row, { used, line, budget: p.budget, hours, resetsAt: end, urgency: urgency(line, used, hours, p.budget) });
  const left = p.budget - used;
  if (!(left > (Number(p.minLeft) || 0))) return out(`nothing left (${rnd(left, 2)} of ${p.budget})`);
  if (r && Number.isFinite(p.shortWindowCeiling) && Number.isFinite(Number(r.shortWindowPct))) {
    const sr = Date.parse(r.shortWindowResetsAt);
    const pct = Number.isFinite(sr) && sr <= now ? 0 : Number(r.shortWindowPct);
    if (pct >= p.shortWindowCeiling) return out(`short window at ${pct}% (ceiling ${p.shortWindowCeiling}%)`);
  }
  const behind = line > used;
  const finalWindow = end - now <= cfg.finalWindowDays * DAY;
  row.pace = `${rnd(used, 1)} used vs a pace line of ${rnd(line, 1)} (budget ${p.budget}, resets ${iso(end)})`;
  if (p.tier !== undefined) { row.eligible = true; return out(`tier pinned to ${p.tier} in the config`); }
  if (p.aheadOfLine === 'last-resort') {
    if (behind) { row.eligible = true; row.tier = 2; return out('behind its line: use it before it resets'); }
    return out('ahead of its line: last resort only', { lastResort: true });
  }
  row.eligible = true;
  if (behind && finalWindow) { row.tier = 2; return out(`final ${cfg.finalWindowDays} days and behind its line: before free pools`); }
  return out(behind ? `behind its line, over ${cfg.finalWindowDays} days to reset` : 'at or ahead of its line');
}

// ---------------------------------------------------------------- the decision
/** Pure decision: returns {out, table, exit}. */
export function decide(opts, cfg, usage, now) {
  const warnings = [...(opts.warnings || [])];
  const task = opts.task;
  if (!cfg.tasks.includes(task)) return { out: { error: `--task must be one of ${cfg.tasks.join(' | ')}` }, table: [], exit: 2 };

  const scan = scanFiles(opts.files || [], cfg.scan, warnings);
  for (const h of scan) warnings.push(`content scan: ${h.type}-shaped string on line ${h.line} of ${h.source} (value not shown)`);
  const privateWhy = [];
  if (opts.private) privateWhy.push('--private');
  if (scan.length && !opts.ackScan) privateWhy.push(`content scan hit (${[...new Set(scan.map((h) => h.type))].join(', ')}); check it, then pass --ack-scan if it is safe to send`);
  if (scan.length && opts.ackScan) warnings.push('content scan hits acknowledged with --ack-scan: routing as normal');
  const privateWork = privateWhy.length > 0;

  const ctx = { task, now, cfg, usage, privateWork, minutes: Number(opts.minutes) || 0 };
  const table = [], freshness = [];
  for (const p of cfg.pools) { const { row, fr } = assessPool(p, ctx); table.push(row); freshness.push(fr); }

  // Rank: highest tier first, then urgency; urgencies within tieMargin tie, broken by earliest reset, then lower cost.
  const rest = table.filter((c) => c.eligible);
  const chain = [];
  while (rest.length) {
    const tier = Math.max(...rest.map((c) => c.tier));
    const g = rest.filter((c) => c.tier === tier);
    const top = Math.max(...g.map((c) => c.urgency));
    const tied = g.filter((c) => top - c.urgency <= cfg.tieMargin + 1e-12).sort((a, b) => a.resetsAt - b.resetsAt || a.cost - b.cost || 0);
    chain.push(tied[0]); rest.splice(rest.indexOf(tied[0]), 1);
  }
  if (!chain.length) {
    const lr = table.filter((c) => c.lastResort).sort((a, b) => a.cost - b.cost);
    if (lr.length) {
      lr[0].eligible = true; lr[0].reason += '; LAST RESORT: nothing else can take it';
      chain.push(lr[0]);
      warnings.push(`last resort: ${lr[0].pool} is ahead of its pace line but nothing else can take this task`);
    }
  }
  table.forEach((c) => { c.rank = chain.includes(c) ? chain.indexOf(c) + 1 : null; });
  if (chain.length) for (const c of table) if (c.staleOnly) warnings.push(`${c.pool} left out: ${c.reason}; refresh its reading`);
  const base = { task, private: privateWork, ...(privateWork ? { private_why: privateWhy.join('; ') } : {}), ...(scan.length ? { scan: scan.map(({ type, line, source }) => ({ type, line, source })) } : {}) };

  if (!chain.length) {
    const stale = table.filter((c) => c.staleOnly).map((c) => c.pool);
    if (stale.length) return { out: { stale: true, stale_pools: stale, how: 'refresh those pools\' readings in the usage file, then route again', ...base, warnings, freshness }, table, exit: 3 };
    return { out: { pool: null, model: null, why: 'no pool can take this task now (refused, closed, blocked or spent)', fallback: null, batch: false, urgency: null, chain: [], ...base, warnings, freshness }, table, exit: 4 };
  }

  const pick = chain[0];
  let batch = false, batchWhy = '';
  if (pick.batchable) {
    if (opts.now) batchWhy = 'real-time: --now';
    else if (opts.humanWaiting) batchWhy = 'real-time: a person is waiting';
    else if (Number.isFinite(pick.hours) && pick.hours < cfg.batchMinHours) batchWhy = `real-time: the cycle resets in ${pick.hours.toFixed(1)} h (under ${cfg.batchMinHours} h, a batch might bill after the reset)`;
    else { batch = true; batchWhy = 'Batch (usually half price; results within 24 h)'; }
  }
  const why = [`${pick.pool} urgency ${pick.urgency.toFixed(3)} (tier ${pick.tier})`, pick.reason, pick.pace, pick.windowNote, batchWhy, privateWork ? `private work: ${privateWhy.join('; ')}` : '', chain[1] ? `next: ${chain[1].pool}` : ''].filter(Boolean).join('; ');
  const out = { pool: pick.pool, model: pick.model, why, fallback: chain[1] ? chain[1].pool : null, batch, urgency: rnd(pick.urgency),
    chain: chain.map((c) => c.pool), ...(opts.overnight ? { queue: 'overnight' } : {}), ...base, warnings, freshness };
  return { out, table, exit: 0 };
}

// ---------------------------------------------------------------- explain table
export function explain(out, table) {
  const f = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '-');
  const cols = ['rank', 'pool', 'kind', 'model', 'ok', 'used', 'line', 'budget', 'hrs', 'urgency', 'tier', 'reason'];
  const rows = [...table].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map((c) => [c.rank || '-', c.pool, c.kind, c.model || '-', c.eligible ? 'yes' : 'no',
    f(c.used), f(c.line), f(c.budget, 0), f(c.hours, 0), c.eligible ? f(c.urgency, 3) : '-', c.eligible ? c.tier : '-', c.reason]);
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((x, i) => (i === r.length - 1 ? String(x) : String(x).padEnd(w[i]))).join('  ').trimEnd();
  const lines = rows.length ? [fmt(cols), fmt(w.map((n) => '-'.repeat(n))), ...rows.map(fmt)] : [];
  if (out.stale) lines.push('', `STALE: ${out.stale_pools.join(', ')}; ${out.how}`);
  else lines.push('', `pick: ${out.pool || 'none'}${out.model ? ` (${out.model})` : ''}   fallback: ${out.fallback || '-'}   batch: ${out.batch}   chain: ${(out.chain || []).join(' > ') || '-'}`);
  for (const x of out.warnings || []) lines.push(`warning: ${x}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- CLI
function clockFrom(opts) {
  const s = opts.at || process.env.MODEL_ROUTER_NOW;
  if (!s) return Date.now();
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new UsageError(`MODEL_ROUTER_NOW must be an ISO date-time (got ${s})`);
  return t;
}

export function run(argv, env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help) return { help: true };
  if (!opts.task) throw new UsageError('--task is required (see --help)');
  const cfgFile = opts.config || env.MODEL_ROUTER_CONFIG;
  if (!cfgFile) throw new UsageError('no config: pass --config <file> or set MODEL_ROUTER_CONFIG');
  const cfg = loadConfig(cfgFile);
  const warnings = [];
  for (const f of opts.files) if (!fs.existsSync(f)) warnings.push(`--files: ${path.basename(f)} not found`);
  opts.files = opts.files.filter((f) => fs.existsSync(f));
  const usage = loadUsage(opts.usage || env.MODEL_ROUTER_USAGE || cfg.usageFile, warnings);
  opts.warnings = warnings;
  return { opts, ...decide(opts, cfg, usage, clockFrom(opts)) };
}

function main() {
  let r;
  try { r = run(process.argv.slice(2)); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
    process.stderr.write(`model-router: ${e.message}\n`);
    process.exit(2);
  }
  if (r.help) { process.stdout.write(HELP); process.exit(0); }
  if (r.opts.explain && r.table.length) process.stderr.write(explain(r.out, r.table) + '\n');
  if (r.exit === 2) process.stderr.write(`model-router: ${r.out.error}\n`);
  process.stdout.write(JSON.stringify(r.out) + '\n');
  process.exit(r.exit);
}

const self = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : false;
if (self) main();
