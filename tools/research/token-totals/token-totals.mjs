#!/usr/bin/env node
// token-totals: total the tokens in Claude Code session logs (~/.claude/projects/**/*.jsonl, or the roots you pass),
// deduplicated by message id + request id, as input / output / cache write / cache read, per day (or month) and per
// model. Optionally keeps a daily JSONL ledger that never lowers a recorded day, and a gzip archive of the logs.
// Read-only on every log. One JSON object on stdout (or a table with --table). Node 18+, no dependencies.
import { readdirSync, lstatSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, createReadStream, createWriteStream, statSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute, sep, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import readline from 'node:readline';

export const VERSION = '0.1.0';
export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, NO_LOGS: 3 };
export class UsageError extends Error {}

// Where Claude Code keeps its transcripts, and which fields hold what. Every source is described by a map like this.
export const CLAUDE_CODE_MAP = {
  timestamp: 'timestamp',
  id: ['message.id', 'requestId'],   // a streamed reply is logged once per content block with the same pair
  model: 'message.model',
  input: 'message.usage.input_tokens',
  output: 'message.usage.output_tokens',
  cache_write: 'message.usage.cache_creation_input_tokens',
  cache_read: 'message.usage.cache_read_input_tokens',
};
const CLAUDE_SOURCE = { name: 'claude-code', ext: '.jsonl', mustContain: '"usage"', skipModels: ['<synthetic>'], fields: CLAUDE_CODE_MAP };
const FIELDS = ['input', 'output', 'cache_write', 'cache_read'];
const CONFIG_KEYS = ['$comment', 'roots', 'claudeCode', 'sources', 'tz', 'by', 'ledger', 'archive'];

export function defaultClaudeRoot(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

// ---------- small helpers ----------
export function getPath(obj, path) {
  if (path == null) return undefined;
  let v = obj;
  for (const k of String(path).split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; }
  return v;
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const blank = () => ({ input: 0, output: 0, cache_write: 0, cache_read: 0, total: 0, replies: 0 });
const add = (a, b) => { for (const k of [...FIELDS, 'total', 'replies']) a[k] += b[k] || 0; return a; };
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export function dayOf(ts, tz = 'utc') {
  let ms;
  if (typeof ts === 'number' && Number.isFinite(ts)) ms = ts < 1e12 ? ts * 1000 : ts; // seconds or milliseconds
  else if (typeof ts === 'string' && ts) ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (tz === 'local') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return d.toISOString().slice(0, 10);
}

// Every *.jsonl under root, sorted; symlinks are not followed, unreadable entries are skipped.
export function walk(root, ext = '.jsonl') {
  const out = [];
  (function rec(d) {
    let names; try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n); let s; try { s = lstatSync(p); } catch { continue; }
      if (s.isDirectory()) rec(p); else if (s.isFile() && n.endsWith(ext)) out.push(p);
    }
  })(root);
  return out.sort();
}

const inside = (child, parent) => { const r = relative(resolve(parent), resolve(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

// ---------- one line -> a usage record, or null ----------
export function readRecord(j, src, tz) {
  const f = src.fields;
  const vals = {}; let any = false;
  for (const k of FIELDS) { const v = getPath(j, f[k]); if (typeof v === 'number') any = true; vals[k] = num(v); }
  if (!any) return null;
  const model = String(getPath(j, f.model) ?? 'unknown') || 'unknown';
  if ((src.skipModels || []).includes(model)) return null;
  const day = dayOf(getPath(j, f.timestamp), tz);
  const ids = [].concat(f.id || []).map((p) => getPath(j, p));
  const key = ids.some((x) => x != null && x !== '') ? ids.map((x) => x ?? '').join('|') : null;
  return { day, model, key, ...vals, total: FIELDS.reduce((s, k) => s + vals[k], 0) };
}

// ---------- scan one source (all of its roots share one dedup set) ----------
export async function scanSource(src, { tz = 'utc', since = null, until = null } = {}) {
  const st = { name: src.name, roots: src.roots, files: 0, lines: 0, replies: 0, duplicates_skipped: 0, without_time: 0, unparseable: 0, days: {}, fileList: [] };
  const seen = new Set();
  for (const root of src.roots) {
    const files = existsSync(root) ? walk(root, src.ext || '.jsonl') : [];
    st.files += files.length;
    for (const f of files) {
      st.fileList.push({ root, file: f });
      const rl = readline.createInterface({ input: createReadStream(f, { encoding: 'utf8', flags: 'r' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        st.lines++;
        if (src.mustContain && !line.includes(src.mustContain)) continue;
        let j; try { j = JSON.parse(line); } catch { st.unparseable++; continue; }
        const r = readRecord(j, src, tz);
        if (!r) continue;
        if (!r.day) { st.without_time++; continue; }
        if (r.key) { if (seen.has(r.key)) { st.duplicates_skipped++; continue; } seen.add(r.key); }
        if ((since && r.day < since) || (until && r.day > until)) continue;
        const d = (st.days[r.day] ??= {});
        add((d[r.model] ??= blank()), { ...r, replies: 1 });
        st.replies++;
      }
    }
  }
  return st;
}

// ---------- summarise ----------
export function summarise(scans, by = 'day') {
  const totals = blank(), periods = {}, models = {};
  const sources = scans.map((s) => {
    const t = blank(); const days = Object.keys(s.days).sort();
    for (const day of days) for (const [model, c] of Object.entries(s.days[day])) {
      add(t, c); add((models[model] ??= blank()), c);
      const key = by === 'month' ? day.slice(0, 7) : day;
      const p = (periods[key] ??= { ...blank(), models: {}, sources: {} });
      add(p, c); add((p.models[model] ??= blank()), c);
      p.sources[s.name] = (p.sources[s.name] || 0) + c.total;
    }
    add(totals, t);
    return { name: s.name, roots: s.roots, files: s.files, replies: s.replies, duplicates_skipped: s.duplicates_skipped, lines_without_time: s.without_time, unparseable_lines: s.unparseable, first_day: days[0] || null, last_day: days[days.length - 1] || null, totals: t };
  });
  const sorted = Object.fromEntries(Object.keys(periods).sort().map((k) => {
    const p = periods[k];
    if (scans.length < 2) delete p.sources;
    return [k, p];
  }));
  const byModel = Object.fromEntries(Object.entries(models).sort((a, b) => b[1].total - a[1].total));
  return { sources, totals, [by === 'month' ? 'by_month' : 'by_day']: sorted, by_model: byModel };
}

// ---------- ledger: one JSON line per (source, day); a recorded day is never lowered ----------
export function readLedger(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  for (const l of stripBom(readFileSync(file, 'utf8')).split(/\r?\n/)) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r && r.source && isDay(r.day)) map.set(`${r.source}|${r.day}`, r);
  }
  return map;
}

export function updateLedger(file, scans, { tz = 'utc', dryRun = false, now = new Date().toISOString() } = {}) {
  const ledger = readLedger(file);
  for (const r of ledger.values()) if (r.tz && r.tz !== tz) throw new UsageError(`ledger ${file} was written with --tz ${r.tz}; this run uses --tz ${tz}`);
  let added = 0, raised = 0, kept = 0;
  for (const s of scans) for (const [day, models] of Object.entries(s.days)) {
    const rec = { source: s.name, day, tz, ...blank(), models: {}, updated: now };
    for (const [m, c] of Object.entries(models)) { rec.models[m] = { ...c }; add(rec, c); }
    const k = `${s.name}|${day}`, old = ledger.get(k);
    if (!old) { ledger.set(k, rec); added++; }
    else if (rec.total > (old.total || 0)) { ledger.set(k, rec); raised++; }
    else kept++;
  }
  const lines = [...ledger.values()].sort((a, b) => a.source.localeCompare(b.source) || a.day.localeCompare(b.day));
  if (!dryRun) {
    mkdirSync(dirname(resolve(file)), { recursive: true });
    writeFileSync(file + '.tmp', lines.map((r) => JSON.stringify(r)).join('\n') + (lines.length ? '\n' : ''));
    renameSync(file + '.tmp', file);
  }
  const days = lines.map((r) => r.day).sort();
  const totals = lines.reduce((t, r) => add(t, r), blank());
  return { file, added, raised, kept, days: lines.length, first_day: days[0] || null, last_day: days[days.length - 1] || null, totals, dry_run: dryRun };
}

// ---------- archive: gzip copies of the logs read, skipping files unchanged since last time ----------
export async function archiveLogs(dir, scans, { dryRun = false, now = new Date().toISOString() } = {}) {
  const roots = [...new Set(scans.flatMap((s) => s.roots))];
  const mpath = join(dir, 'manifest.json');
  let manifest = {};
  if (existsSync(mpath)) { try { manifest = JSON.parse(readFileSync(mpath, 'utf8')); } catch { manifest = {}; } }
  const st = { dir, considered: 0, written: 0, unchanged: 0, bytes_in: 0, bytes_out: 0, dry_run: dryRun };
  for (const s of scans) for (const { root, file } of s.fileList) {
    let fst; try { fst = statSync(file); } catch { continue; }
    st.considered++;
    const prefix = roots.length > 1 ? String(roots.indexOf(root)) : '';
    const rel = join(prefix, relative(root, file)) + '.gz';
    const key = rel.split(sep).join('/');
    const dest = join(dir, rel);
    const sig = `${fst.size}|${Math.floor(fst.mtimeMs)}`;
    if (manifest[key]?.sig === sig && existsSync(dest)) { st.unchanged++; continue; }
    st.written++; st.bytes_in += fst.size;
    if (dryRun) continue;
    mkdirSync(dirname(dest), { recursive: true });
    await pipeline(createReadStream(file, { flags: 'r' }), createGzip({ level: 9 }), createWriteStream(dest + '.tmp'));
    renameSync(dest + '.tmp', dest);
    const out = statSync(dest).size; st.bytes_out += out;
    manifest[key] = { sig, bytes_in: fst.size, bytes_out: out, at: now };
  }
  if (!dryRun) { mkdirSync(dir, { recursive: true }); writeFileSync(mpath + '.tmp', JSON.stringify(manifest, null, 1)); renameSync(mpath + '.tmp', mpath); }
  return st;
}

// ---------- config and arguments ----------
export function checkSource(s, i) {
  const where = `sources[${i}]`;
  if (!s || typeof s !== 'object') throw new UsageError(`${where} must be an object`);
  for (const k of Object.keys(s)) if (!['name', 'roots', 'root', 'ext', 'mustContain', 'skipModels', 'fields'].includes(k)) throw new UsageError(`${where}: unknown key "${k}"`);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(s.name || '')) throw new UsageError(`${where}.name must be 1-64 of A-Z a-z 0-9 _ . -`);
  if (s.name === 'claude-code') throw new UsageError(`${where}.name "claude-code" is reserved`);
  const roots = [].concat(s.roots || s.root || []);
  if (!roots.length || !roots.every((r) => typeof r === 'string' && r)) throw new UsageError(`${where} needs "root" or "roots"`);
  const f = s.fields || {};
  for (const k of Object.keys(f)) if (!['timestamp', 'id', 'model', ...FIELDS].includes(k)) throw new UsageError(`${where}.fields: unknown key "${k}"`);
  if (!f.timestamp) throw new UsageError(`${where}.fields.timestamp is required`);
  if (!FIELDS.some((k) => f[k])) throw new UsageError(`${where}.fields needs at least one of ${FIELDS.join(', ')}`);
  return { name: s.name, roots, ext: s.ext || '.jsonl', mustContain: s.mustContain || null, skipModels: [].concat(s.skipModels || []), fields: f };
}

export function loadConfig(path) {
  if (!path) return {};
  let c;
  try { c = JSON.parse(stripBom(readFileSync(path, 'utf8'))); } catch (e) { throw new UsageError(`config ${path}: ${e.code === 'ENOENT' ? 'not found' : e.message}`); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new UsageError(`config ${path}: not a JSON object`);
  for (const k of Object.keys(c)) if (!CONFIG_KEYS.includes(k)) throw new UsageError(`config: unknown key "${k}"`);
  return c;
}

export function parseArgs(argv) {
  const o = { roots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const nx = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`); return v; };
    if (a === '--root') o.roots.push(nx());
    else if (a === '--config') o.config = nx();
    else if (a === '--since') o.since = nx();
    else if (a === '--until') o.until = nx();
    else if (a === '--tz') o.tz = nx();
    else if (a === '--by') o.by = nx();
    else if (a === '--ledger') o.ledger = nx();
    else if (a === '--archive') o.archive = nx();
    else if (a === '--no-claude') o.noClaude = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--table') o.table = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version') o.version = true;
    else throw new UsageError(`unknown argument ${a}`);
  }
  return o;
}

// Precedence: flags, then environment, then the config file, then the defaults.
export function settings(o, env = process.env) {
  const cfg = loadConfig(o.config || env.TOKEN_TOTALS_CONFIG || null);
  const envRoots = env.TOKEN_TOTALS_ROOT ? env.TOKEN_TOTALS_ROOT.split(delimiter).filter(Boolean) : [];
  const claudeRoots = o.roots.length ? o.roots : envRoots.length ? envRoots : cfg.roots ? [].concat(cfg.roots) : [defaultClaudeRoot(env)];
  const useClaude = !o.noClaude && cfg.claudeCode !== false;
  const sources = [...(useClaude ? [{ ...CLAUDE_SOURCE, roots: claudeRoots }] : []), ...(cfg.sources || []).map(checkSource)];
  if (!sources.length) throw new UsageError('no sources: Claude Code is off and the config names none');
  if (new Set(sources.map((s) => s.name)).size !== sources.length) throw new UsageError('source names must be unique');
  const tz = o.tz || env.TOKEN_TOTALS_TZ || cfg.tz || 'utc';
  if (!['utc', 'local'].includes(tz)) throw new UsageError('--tz must be utc or local');
  const by = o.by || cfg.by || 'day';
  if (!['day', 'month'].includes(by)) throw new UsageError('--by must be day or month');
  for (const [k, v] of [['--since', o.since], ['--until', o.until]]) if (v && !isDay(v)) throw new UsageError(`${k} must be YYYY-MM-DD`);
  if (o.since && o.until && o.since > o.until) throw new UsageError('--since is after --until');
  const ledger = o.ledger || env.TOKEN_TOTALS_LEDGER || cfg.ledger || null;
  const archive = o.archive || cfg.archive || null;
  const allRoots = sources.flatMap((s) => s.roots);
  for (const [what, p] of [['--ledger', ledger], ['--archive', archive]]) {
    if (p && allRoots.some((r) => inside(p, r))) throw new UsageError(`${what} must be outside the log folders (they are read-only, and a ledger there would be read as a log)`);
  }
  return { sources, tz, by, since: o.since || null, until: o.until || null, ledger, archive, dryRun: Boolean(o.dryRun), table: Boolean(o.table) };
}

export const HELP = `token-totals ${VERSION}: total the tokens in Claude Code session logs, deduplicated, per day and per model

usage: token-totals [--root DIR]... [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--tz utc|local] [--by day|month]
                    [--ledger FILE] [--archive DIR] [--dry-run] [--config FILE] [--no-claude] [--table]

  --root DIR      a folder of Claude Code transcripts (repeatable). Default: $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects.
                  Env TOKEN_TOTALS_ROOT (several joined by the path delimiter).
  --since/--until an inclusive day window. --tz: which calendar a timestamp's day is read in (default utc).
  --by            group the output by day (default) or month. Per-model totals are always included.
  --ledger FILE   upsert one JSON line per (source, day) into FILE; a recorded day is never lowered. Env TOKEN_TOTALS_LEDGER.
  --archive DIR   keep a gzip copy of every log read (unchanged files are skipped). Opt-in.
  --dry-run       report what the ledger and archive would do, write nothing.
  --config FILE   JSON: roots, claudeCode, sources (other JSONL logs with a field map), tz, by, ledger, archive.
                  Env TOKEN_TOTALS_CONFIG. See examples/config.example.json.
  --no-claude     skip the Claude Code logs (only the config's other sources).
  --table         a human table on stdout instead of the JSON object.

Logs are only ever read. Exit: 0 ok · 1 error · 2 usage · 3 no log files found`;

// ---------- table ----------
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
export function table(out) {
  const key = out.by_month ? 'by_month' : 'by_day';
  const rows = [[key === 'by_month' ? 'month' : 'day', 'input', 'output', 'cache write', 'cache read', 'total', 'replies']];
  for (const [k, p] of Object.entries(out[key])) rows.push([k, fmt(p.input), fmt(p.output), fmt(p.cache_write), fmt(p.cache_read), fmt(p.total), String(p.replies)]);
  const t = out.totals; rows.push(['all', fmt(t.input), fmt(t.output), fmt(t.cache_write), fmt(t.cache_read), fmt(t.total), String(t.replies)]);
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ');
  const L = [line(rows[0]), ...rows.slice(1, -1).map(line), w.map((n) => '-'.repeat(n)).join('  '), line(rows[rows.length - 1]), ''];
  const mw = Math.max(0, ...Object.keys(out.by_model).map((x) => x.length));
  for (const [m, c] of Object.entries(out.by_model)) L.push(`${m.padEnd(mw)}  ${fmt(c.total).padStart(8)}  ${c.replies} ${c.replies === 1 ? 'reply' : 'replies'}`);
  const dup = out.sources.reduce((s, x) => s + x.duplicates_skipped, 0);
  L.push('', `${out.sources.reduce((s, x) => s + x.files, 0)} files, ${dup} duplicate lines skipped`);
  if (out.ledger) L.push(`ledger ${out.ledger.dry_run ? '(dry run) ' : ''}+${out.ledger.added} new, ${out.ledger.raised} raised, ${out.ledger.kept} kept; ${out.ledger.days} days, ${fmt(out.ledger.totals.total)} recorded`);
  if (out.archive) L.push(`archive ${out.archive.dry_run ? '(dry run) ' : ''}${out.archive.written} written, ${out.archive.unchanged} unchanged`);
  return L.join('\n');
}

// ---------- main ----------
export async function main(argv = process.argv.slice(2), env = process.env) {
  let o, s;
  try {
    o = parseArgs(argv);
    if (o.help) { console.log(HELP); return EXIT.OK; }
    if (o.version) { console.log(VERSION); return EXIT.OK; }
    s = settings(o, env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.log(JSON.stringify({ ok: false, error: e.message }));
    console.error(`token-totals: ${e.message} (try --help)`);
    return EXIT.USAGE;
  }
  try {
    const scans = [];
    for (const src of s.sources) scans.push(await scanSource(src, s));
    const files = scans.reduce((n, x) => n + x.files, 0);
    if (!files) {
      console.log(JSON.stringify({ ok: false, error: 'no log files found', roots: s.sources.flatMap((x) => x.roots) }));
      return EXIT.NO_LOGS;
    }
    const out = { ok: true, generated: new Date().toISOString(), tz: s.tz, since: s.since, until: s.until, convention: 'input + output + cache_write + cache_read; deduplicated by id', ...summarise(scans, s.by) };
    if (s.ledger) out.ledger = updateLedger(s.ledger, scans, { tz: s.tz, dryRun: s.dryRun });
    if (s.archive) out.archive = await archiveLogs(s.archive, scans, { dryRun: s.dryRun });
    console.log(s.table ? table(out) : JSON.stringify(out));
    return EXIT.OK;
  } catch (e) {
    if (e instanceof UsageError) { console.log(JSON.stringify({ ok: false, error: e.message })); return EXIT.USAGE; }
    console.log(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) }));
    return EXIT.ERROR;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => { process.exitCode = c; });
