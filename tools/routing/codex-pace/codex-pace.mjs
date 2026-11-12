#!/usr/bin/env node
import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { totalmem, freemem, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONSTANTS = Object.freeze({
  primaryHardCap: 90, secondaryHardCap: 97, weeklyPaceMargin: 10,
  primarySoftCap: 75, memoryCap: 75, maxLocalRunning: 0, maxAgeMinutes: 30,
});
export const EXIT_CODES = Object.freeze({ cloud: 0, local: 10, hold: 20, stale: 3 });
const MINUTE = 60_000;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const percent = (v) => finite(v) && v >= 0 && v <= 100 ? v : null;
const timestamp = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function resetTime(window, at) {
  if (!object(window)) return null;
  const absolute = window.resets_at ?? window.reset_at;
  if (finite(absolute)) {
    const ms = absolute < 1e12 ? absolute * 1000 : absolute;
    return Number.isFinite(new Date(ms).getTime()) ? ms : null;
  }
  const iso = timestamp(absolute);
  if (iso !== null) return iso;
  const seconds = window.resets_in_seconds ?? window.reset_in_seconds ?? window.reset_after_seconds;
  const ms = finite(seconds) && seconds >= 0 && at !== null ? at + seconds * 1000 : null;
  return ms !== null && Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

export function normaliseSnapshot(raw) {
  const at = timestamp(raw?.taken_at);
  const window = (w) => {
    const reset = resetTime(w, at);
    return {
      used_percent: percent(w?.used_percent),
      window_minutes: finite(w?.window_minutes) && w.window_minutes > 0 ? w.window_minutes : null,
      resets_at: reset === null ? null : new Date(reset).toISOString(),
    };
  };
  return { taken_at: at === null ? null : new Date(at).toISOString(), primary: window(raw?.primary), secondary: window(raw?.secondary) };
}

function complete(s) {
  return s.taken_at !== null && ['primary', 'secondary'].every((key) =>
    s[key].used_percent !== null && s[key].window_minutes !== null && s[key].resets_at !== null);
}

/** Stream logs without relying on filename order or file modification times. */
export async function fromSessions(dir) {
  let newest = null;
  async function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const input = createReadStream(file, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          const at = event?.timestamp ?? event?.taken_at;
          const stack = [event];
          while (stack.length) {
            const value = stack.pop();
            if (!object(value) && !Array.isArray(value)) continue;
            if (object(value.rate_limits)) {
              const candidate = normaliseSnapshot({ ...value.rate_limits, taken_at: at });
              if (complete(candidate) && (!newest || Date.parse(candidate.taken_at) > Date.parse(newest.taken_at))) newest = candidate;
            }
            for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
          }
        }
      } finally { lines.close(); input.destroy(); }
    }
  }
  await walk(dir);
  return newest;
}

export function decide(raw, options = {}) {
  const s = normaliseSnapshot(raw);
  const now = options.now ?? Date.now();
  const primaryReset = timestamp(s.primary.resets_at);
  const weeklyReset = timestamp(s.secondary.resets_at);
  const expected = weeklyReset !== null && s.secondary.window_minutes !== null
    ? Math.max(0, Math.min(1, 1 - (weeklyReset - now) / (s.secondary.window_minutes * MINUTE))) * 100 : null;
  const result = {
    decision: 'stale', reason: '', primary_used: s.primary.used_percent, secondary_used: s.secondary.used_percent,
    expected_weekly: expected, spare_weekly: expected !== null && s.secondary.used_percent !== null ? expected - s.secondary.used_percent : null,
    hours_to_weekly_reset: weeklyReset === null ? null : Math.max(0, (weeklyReset - now) / (60 * MINUTE)),
    minutes_to_primary_reset: primaryReset === null ? null : Math.max(0, (primaryReset - now) / MINUTE),
    memory_percent: options.memoryPercent ?? (1 - freemem() / totalmem()) * 100, taken_at: s.taken_at,
  };
  const finish = (decision, reason) => ({ ...result, decision, reason });
  if (s.taken_at === null) return finish('stale', 'No usable snapshot timestamp is available.');
  if (now - Date.parse(s.taken_at) > (options.maxAgeMinutes ?? CONSTANTS.maxAgeMinutes) * MINUTE)
    return finish('stale', 'The usage snapshot is too old; refresh it before routing.');
  if (result.primary_used !== null && result.primary_used >= CONSTANTS.primaryHardCap) return finish('hold', 'The primary hard cap has been reached.');
  if (result.secondary_used !== null && result.secondary_used >= CONSTANTS.secondaryHardCap) return finish('hold', 'The weekly hard cap has been reached.');
  if (!complete(s)) return finish('stale', 'The usage snapshot is incomplete; refresh it before routing.');
  if (!options.urgent && result.secondary_used > expected + CONSTANTS.weeklyPaceMargin) return finish('hold', 'over weekly pace');
  if (!options.urgent && result.primary_used >= CONSTANTS.primarySoftCap) return finish('hold', `The short window is busy; it resets in ${result.minutes_to_primary_reset} minutes.`);
  if (!options.needsLocal) return finish('cloud', 'Use Codex Cloud; shared allowance is available and it uses no local memory.');
  if (result.memory_percent >= CONSTANTS.memoryCap) return finish('hold', 'Local memory is too high for a local Codex run.');
  if ((options.localRunning ?? 0) > CONSTANTS.maxLocalRunning) return finish('hold', 'Another local Codex run is already running.');
  return finish('local', 'Use the local Codex CLI; local access is required and memory and concurrency allow it.');
}

const HELP = `codex-pace: choose cloud, local, hold or stale from shared Codex allowance.
Usage: node codex-pace.mjs [--usage <file|-> | --from-sessions [dir]] [options]
  --usage <file|->       Read a JSON snapshot from a file or stdin
  --from-sessions [dir]  Search JSONL logs (default: ~/.codex/sessions)
  --memory-percent <n>  Committed memory, 0..100 (default: OS measurement)
  --needs-local         Require local files or devices
  --local-running <n>   Existing local runs, nonnegative integer (default: 0)
  --urgent              Bypass weekly pace and short-window soft limit
  --now <ISO>           Override the clock
  --max-age-minutes <n> Maximum snapshot age (default: 30)
  --json                Print one JSON line (default: text)
  --help                Show this help
Exit: 0 cloud, 10 local, 20 hold, 3 stale/no snapshot, 2 bad input.
`;

export function parseArgs(argv) {
  const o = {};
  const booleans = new Set(['needs-local', 'urgent', 'json', 'help']);
  const values = new Set(['usage', 'memory-percent', 'local-running', 'now', 'max-age-minutes']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--')) throw new Error('Unexpected argument.');
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (Object.hasOwn(o, camel)) throw new Error('Duplicate option.');
    if (booleans.has(key)) { o[camel] = true; continue; }
    if (key === 'from-sessions') {
      o.fromSessions = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : join(homedir(), '.codex', 'sessions');
      continue;
    }
    if (!values.has(key)) throw new Error('Unknown option; use --help.');
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('Option requires a value.');
    if (key === 'now') {
      o.now = timestamp(value);
      if (o.now === null) throw new Error('--now requires an ISO date-time.');
    } else if (key === 'usage') o.usage = value;
    else {
      const n = value.trim() === '' ? NaN : Number(value);
      if (!finite(n) || n < 0 || (key === 'memory-percent' && n > 100) || (key === 'local-running' && !Number.isInteger(n))) throw new Error('Invalid numeric option.');
      o[camel] = n;
    }
  }
  if (o.usage && o.fromSessions) throw new Error('Choose one usage source.');
  return o;
}

export async function main(argv) {
  try {
    const o = parseArgs(argv);
    if (o.help) { console.log(HELP); return 0; }
    let snapshot;
    if (o.usage) {
      let raw;
      try { raw = JSON.parse(readFileSync(o.usage === '-' ? 0 : o.usage, 'utf8')); }
      catch { throw new Error('Cannot read or parse usage input.'); }
      if (!object(raw)) throw new Error('Usage input must be a JSON object.');
      snapshot = raw;
    } else {
      try { snapshot = await fromSessions(o.fromSessions ?? join(homedir(), '.codex', 'sessions')); }
      catch { throw new Error('Cannot read session input.'); }
    }
    const result = decide(snapshot, o);
    if (o.json) console.log(JSON.stringify(result));
    else {
      const { decision, reason, ...numbers } = result;
      console.log(`${decision}\n${reason}\n${JSON.stringify({ ...numbers, local_running: o.localRunning ?? 0, max_age_minutes: o.maxAgeMinutes ?? CONSTANTS.maxAgeMinutes })}`);
    }
    return EXIT_CODES[result.decision];
  } catch (error) { console.error(error.message); return 2; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
