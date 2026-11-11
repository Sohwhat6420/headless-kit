#!/usr/bin/env node
/**
 * lane-model-check.mjs: does a background agent run actually use the model it was asked for?
 *
 *   node lane-model-check.mjs (--transcript <file.jsonl> | --session <id>)
 *                             (--expect <model> | --plan <plan.json> --lane <id>)
 *                             [--all] [--exact] [--config <file.json>] [--explain]
 *
 * An agent started on the wrong model (the large one where the small one was planned, or the reverse) quietly
 * spends the wrong budget for its whole run. Agent CLIs write a JSONL transcript in which each model turn
 * records the model that served it. This reads that transcript and compares.
 *
 * The defaults read Claude Code transcripts (~/.claude/projects/<project>/<session id>.jsonl, turns with
 * "type": "assistant" and the model in message.model). Another agent's JSONL format is a config change:
 * which field marks a model turn, where the model id sits, and where --session looks.
 *
 * Match: equal, or the expected id followed by a separator (so "model-a" matches "model-a-20261001" and
 * "model-a[1m]", but not "model-ab"); case-insensitive. --exact turns the prefix rule off.
 * Default: the first model turn decides (the file is streamed and closed at the first hit). --all reads every
 * turn and fails if any of them used another model.
 *
 * stdout: one JSON object. Exit 0 match · 1 mismatch · 2 bad usage or config · 3 not yet (no transcript or no
 * model turn yet: poll again).
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = {
  transcriptDirs: ['~/.claude/projects/*'],
  transcriptExt: '.jsonl',
  turn: { field: 'type', equals: 'assistant' },
  modelField: 'message.model',
  ignoreModels: ['<synthetic>'],
  plan: { lanesPath: 'lanes', idField: 'id', modelField: 'model' },
};

const HELP = `lane-model-check: does an agent's transcript show the model it was asked to run?

usage: node lane-model-check.mjs (--transcript <file> | --session <id>) (--expect <model> | --plan <file> --lane <id>) [options]

  --transcript <file>  the JSONL transcript to read
  --session <id>       find <id>.jsonl in the config's transcriptDirs (default: ~/.claude/projects/*)
  --expect <model>     the model id it should be running
  --plan <file>        a JSON plan holding lanes and their models (shape set by the config's "plan")
  --lane <id>          the lane to look up in --plan (case-insensitive)
  --all                check every model turn, not just the first
  --exact              no prefix matching: the ids must be equal (case-insensitive)
  --config <file>      JSON overriding the transcript format and plan shape (env LANE_MODEL_CHECK_CONFIG)
  --explain            also print a one-line verdict on stderr
  --help               this text

stdout: one JSON line {ok, verdict, expected, actual, transcript, ...}
exit:   0 match · 1 mismatch · 2 bad usage or config · 3 not yet (no transcript or no model turn yet)`;

export class UsageError extends Error {}

const expand = (p) => (p === '~' ? homedir() : /^~[\\/]/.test(p) ? join(homedir(), p.slice(2)) : p);

export function getPath(obj, dotted) {
  let v = obj;
  for (const k of String(dotted).split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; }
  return v;
}

export function parseArgs(argv) {
  const o = { all: false, exact: false, explain: false, help: false };
  const vals = ['--transcript', '--session', '--expect', '--plan', '--lane', '--config'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--all') o.all = true;
    else if (a === '--exact') o.exact = true;
    else if (a === '--explain') o.explain = true;
    else if (vals.includes(a)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else throw new UsageError(`unknown argument: ${a}`);
  }
  return o;
}

export function loadConfig(path) {
  if (!path) return structuredClone(DEFAULTS);
  let j;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new UsageError(`--config: ${e.code === 'ENOENT' ? 'file not found' : 'not valid JSON'}: ${path}`); }
  const c = { ...structuredClone(DEFAULTS), ...j, turn: { ...DEFAULTS.turn, ...(j.turn || {}) }, plan: { ...DEFAULTS.plan, ...(j.plan || {}) } };
  if (!Array.isArray(c.transcriptDirs) || !c.transcriptDirs.every((d) => typeof d === 'string')) throw new UsageError('config "transcriptDirs" must be an array of strings');
  if (!Array.isArray(c.ignoreModels)) throw new UsageError('config "ignoreModels" must be an array');
  if (typeof c.modelField !== 'string' || !c.modelField) throw new UsageError('config "modelField" must be a dotted path such as "message.model"');
  return c;
}

/** Model ids match when equal, or (unless exact) when actual is expected plus a separator and a suffix. */
export function modelMatches(expected, actual, exact = false) {
  const e = String(expected).toLowerCase(), a = String(actual).toLowerCase();
  if (a === e) return true;
  if (exact || !a.startsWith(e)) return false;
  return /^[-@[:_./ ]/.test(a.slice(e.length));
}

/** Find <id><ext> in the configured folders; a folder ending in "/*" means "any direct subfolder". */
export function findTranscript(id, cfg) {
  if (!/^[\w.-]{1,128}$/.test(id) || id.includes('..')) throw new UsageError(`bad session id "${id}"`);
  const name = id + cfg.transcriptExt;
  for (const pattern of cfg.transcriptDirs) {
    const p = expand(pattern);
    if (/[\\/]\*$/.test(p)) {
      const base = p.slice(0, -2);
      let subs = [];
      try { subs = readdirSync(base); } catch { continue; }
      for (const d of subs.sort()) {
        const f = join(base, d, name);
        if (existsSync(f)) return f;
      }
    } else if (existsSync(join(p, name))) return join(p, name);
  }
  return null;
}

/** Read the expected model of a lane from a plan file. lanesPath may hold an array of lanes or an object keyed by id. */
export function expectedFromPlan(planPath, lane, cfg) {
  let j;
  try { j = JSON.parse(readFileSync(planPath, 'utf8')); } catch (e) { throw new UsageError(`--plan: ${e.code === 'ENOENT' ? 'file not found' : 'not valid JSON'}: ${planPath}`); }
  const lanes = cfg.plan.lanesPath ? getPath(j, cfg.plan.lanesPath) : j;
  const want = String(lane).toLowerCase();
  let entry;
  if (Array.isArray(lanes)) entry = lanes.find((x) => String(getPath(x, cfg.plan.idField)).toLowerCase() === want);
  else if (lanes && typeof lanes === 'object') {
    const k = Object.keys(lanes).find((x) => x.toLowerCase() === want);
    entry = k === undefined ? undefined : lanes[k];
  }
  const model = entry === undefined ? undefined : typeof entry === 'string' ? entry : getPath(entry, cfg.plan.modelField);
  if (typeof model !== 'string' || !model) throw new UsageError(`lane "${lane}" has no model in ${planPath}`);
  return model;
}

/** Stream the transcript; return the model turns seen (first only, unless all). */
export async function readModels(file, cfg, all = false) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const seen = [];
  const pre = typeof cfg.turn.equals === 'string' ? JSON.stringify(cfg.turn.equals) : null; // cheap pre-filter before parsing
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      if (pre && !line.includes(pre)) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; } // a torn last line, still being written
      if (cfg.turn.field && cfg.turn.equals != null && getPath(o, cfg.turn.field) !== cfg.turn.equals) continue;
      const m = getPath(o, cfg.modelField);
      if (typeof m !== 'string' || !m || cfg.ignoreModels.includes(m)) continue;
      seen.push({ model: m, line: lineNo });
      if (!all) break;
    }
  } finally { rl.close(); }
  return seen;
}

export async function check(o, env = process.env) {
  const cfg = loadConfig(o.config ?? (env.LANE_MODEL_CHECK_CONFIG || undefined));
  if (!o.transcript && !o.session) throw new UsageError('give --transcript <file> or --session <id>');
  if (o.transcript && o.session) throw new UsageError('give --transcript or --session, not both');
  if (!o.expect && !(o.plan && o.lane)) throw new UsageError('give --expect <model>, or --plan <file> with --lane <id>');
  if (o.expect && (o.plan || o.lane)) throw new UsageError('give --expect or --plan/--lane, not both');
  const expected = o.expect || expectedFromPlan(o.plan, o.lane, cfg);
  const transcript = o.transcript ? resolve(o.transcript) : findTranscript(o.session, cfg);
  const base = { expected, transcript, lane: o.lane ?? null, session: o.session ?? null };
  if (!transcript) return { out: { ok: false, verdict: 'pending', ...base, actual: null, why: `no transcript yet for session ${o.session}` }, code: 3 };
  if (!existsSync(transcript) || !statSync(transcript).isFile()) return { out: { ok: false, verdict: 'pending', ...base, actual: null, why: 'transcript missing' }, code: 3 };
  const seen = await readModels(transcript, cfg, o.all);
  if (!seen.length) return { out: { ok: false, verdict: 'pending', ...base, actual: null, why: 'no model turn yet' }, code: 3 };
  const actual = seen[0].model;
  if (!o.all) {
    const ok = modelMatches(expected, actual, o.exact);
    return { out: { ok, verdict: ok ? 'match' : 'mismatch', ...base, actual, line: seen[0].line }, code: ok ? 0 : 1 };
  }
  const counts = new Map();
  for (const s of seen) counts.set(s.model, (counts.get(s.model) || 0) + 1);
  const models = [...counts].map(([model, turns]) => ({ model, turns, matches: modelMatches(expected, model, o.exact) }));
  const bad = seen.find((s) => !modelMatches(expected, s.model, o.exact));
  const ok = !bad;
  const out = { ok, verdict: ok ? 'match' : 'mismatch', ...base, actual, turns: seen.length, models };
  if (bad) Object.assign(out, { firstMismatch: bad.model, firstMismatchLine: bad.line });
  return { out, code: ok ? 0 : 1 };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let o, r;
  try {
    o = parseArgs(argv);
    if (o.help) { process.stdout.write(HELP + '\n'); return 0; }
    r = await check(o, env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stdout.write(JSON.stringify({ ok: false, verdict: 'error', error: e.message }) + '\n');
    process.stderr.write(`lane-model-check: ${e.message}\n`);
    return 2;
  }
  process.stdout.write(JSON.stringify(r.out) + '\n');
  if (o.explain) {
    const v = r.out.verdict;
    const tail = v === 'pending' ? r.out.why : v === 'match' ? `${r.out.actual}` : `expected ${r.out.expected}, got ${r.out.firstMismatch || r.out.actual}`;
    process.stderr.write(`lane-model-check: ${v.toUpperCase()} ${tail}\n`);
  }
  return r.code;
}

const self = process.argv[1] ? resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : false;
if (self) process.exitCode = await main();
