#!/usr/bin/env node
/**
 * focus-gate.mjs: a Claude Code UserPromptSubmit hook that makes Claude turn down off-task requests until real work
 * on the task you keep putting off exists on disk. One file, two roles:
 *
 *   UserPromptSubmit hook   on each prompt YOU type, works out whether the gate is on and, if so, adds one context
 *                           block telling Claude to decline anything off-task in a line or two and offer to start the
 *                           next step with you instead. It never blocks a prompt.
 *   CLI                     status, evidence, snapshot, hold, arm, pause, resume.
 *
 * The gate is ON when any of these holds:
 *   1. a configured item is active (past its "from", or due within dueSoonHours) and not begun;
 *   2. an open entry in the optional deadlines file is due within dueSoonHours and has no evidence;
 *   3. watch.roots are configured and no work file under them has changed for idleHours.
 * Begun = a watched path saved after the baseline with a size different from the last size seen (so opening and
 * saving an untouched starter file does not count), or evidence recorded with `focus-gate.mjs evidence`. A recurring
 * item (everyDays: N) only counts work from the last N days, so it comes back on when you stop.
 *
 * HOLD: while you are in transit, `hold` keeps the gate quiet; it arms when you say you have settled ("settled",
 * "arrived", "at my desk"...) or when the hold runs out. PAUSE: only with a reason, at most pauseMaxHours.
 *
 * State: $HEADLESS_KIT_STATE_DIR/focus-gate (default ~/.claude/headless-kit/focus-gate). Config: --config,
 * $FOCUS_GATE_CONFIG, or <state folder>/focus-gate.config.json. Clock override for tests: $HEADLESS_KIT_NOW.
 * As a hook it fails silent: any error, missing config or unexpected input exits 0 with no output. No child
 * processes, no network. Zero dependencies, Node 18+.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';
const H = 3600e3;
const DAY = 24 * H;

/* ---------------------------------------------------------------- config */

export const DEFAULT_CONFIG = {
  baseline: null, // ISO time; saves before it never count. null = any time.
  items: [], // [{ id, title, short?, next?, from?, due?, everyDays?, paths?, done? }]
  deadlinesFile: null, // optional JSON: an array, or { items | deadlines: [...] } of { id, title, due, status? }
  coveredIds: [], // deadlines-file ids that a configured item already stands for
  dueSoonHours: 48,
  idleHours: 48,
  watch: {
    roots: [], // folders whose work files feed the idle trigger; empty = no idle trigger
    extensions: ['.py', '.ipynb', '.js', '.ts', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.sql', '.r', '.m',
      '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.tex', '.txt', '.pkt'],
    skipDirs: ['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'],
    maxDepth: 6,
    maxEntries: 20000,
    budgetMs: 100, // the scan stops after this long, so a hook run stays well under 200 ms
    cacheMinutes: 10,
  },
  holdMaxHours: 3,
  pauseMaxHours: 4,
  skipUnattended: true, // headless and SDK runs are agents, not you
  settledPattern: String.raw`\b(?:settled|arrived|reached|i'?m (?:here|home|back|at my desk)|im (?:here|home|back)|at my desk|on my laptop|starting (?:work|now)|let'?s (?:start|begin|do (?:it|this))|arm (?:the )?focus gate)\b`,
  ignorePatterns: [], // extra regex sources: prompts that match are not yours (peer agents, bots)
  // peerPattern: regex source for peer-agent messages (default PEER_PATTERN); "" turns it off
  rule: '', // optional: your own words, quoted back to Claude when the gate is on
  allowed: [
    'work on any item above',
    'anything urgent (a real deadline today, safety, money, something breaking)',
    'anything quick (answerable in a sentence or two, or one small action)',
  ],
  idleShort: 'Real work', // the "<short> first" label when only the idle trigger is on
  heldAdvice: 'push the user the small manual steps that unblock background work (one per line, smallest first), so it keeps running while they focus.',
};

export function stateDir(env = process.env) {
  return path.join(env.HEADLESS_KIT_STATE_DIR || path.join(os.homedir(), '.claude', 'headless-kit'), 'focus-gate');
}

export function files(env = process.env, configFlag = null) {
  const dir = stateDir(env);
  return {
    dir,
    config: configFlag || env.FOCUS_GATE_CONFIG || path.join(dir, 'focus-gate.config.json'),
    evidence: path.join(dir, 'evidence.json'),
    pause: path.join(dir, 'pause.json'),
    hold: path.join(dir, 'hold.json'),
    snapshot: path.join(dir, 'snapshot.json'),
    seen: path.join(dir, 'seen.json'),
    cache: path.join(dir, 'scan-cache.json'),
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

/** The merged config, or null when there is no config file (the gate is then inert). strict: throw on a bad file. */
export function loadConfig(file, strict = false) {
  try {
    if (!file || !fs.existsSync(file)) {
      if (strict && file) throw new Error(`config not found: ${file}`);
      return null;
    }
    return merge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (strict) throw e;
    return null;
  }
}

/* ---------------------------------------------------------------- state helpers */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}
const quietWrite = (file, value) => { try { writeAtomic(file, value); } catch { /* read-only is fine */ } };
const ms = (v) => { const n = Date.parse(v ?? ''); return Number.isFinite(n) ? n : NaN; };
// C0/C1 controls, every format character (bidi, zero-width, the tag block), separators: never quoted into context.
const INVISIBLE = /[\x00-\x08\x0e-\x1f\x7f-\x9f]|\p{Cf}|[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
const clip = (s, n) => { const t = String(s ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const safeId = (v) => String(v ?? '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);
const iso = (t) => new Date(t).toISOString().slice(0, 16) + 'Z';

export function nowMs(env = process.env) {
  const n = ms(env.HEADLESS_KIT_NOW);
  return Number.isFinite(n) ? n : Date.now();
}

/** Headless and SDK runs: nobody is typing, so the gate has nothing to say. */
export function isUnattended(env = process.env) {
  const att = env.CLAUDE_CODE_SESSION_ATTENDED;
  if (att !== undefined && att.trim() !== '1') return true;
  return /^sdk-/i.test(env.CLAUDE_CODE_ENTRYPOINT || '');
}

/* ---------------------------------------------------------------- whose prompt is it? */

const MACHINE = [
  /^\s*\[[^\]\n]{0,80}\bSYSTEM\b/i, // "[SYSTEM NOTICE] ..." style injected turns
  /<(?:cross-session-message|agent-message|task-notification|side-sessions-event|ci-monitor-event|child-session-event|webhook-payload|system-reminder)\b/i,
];
// "LANE-A -> ORCH: ..." peer messages: an upper-case sender, an arrow, an upper-case recipient and a colon, so a
// person typing "TODO -> fix the tests" still counts as a person.
export const PEER_PATTERN = String.raw`^\s*[A-Z][A-Z0-9_-]{1,24}\s*(?:→|->)\s*[A-Z][A-Z0-9_-]{1,24}\s*:`;

/** True when the prompt was typed by a person, not injected by an agent, a peer session or the system. */
export function isUserPrompt(prompt, cfg = DEFAULT_CONFIG) {
  const p = String(prompt ?? '');
  if (!p.trim()) return false;
  if (MACHINE.some((re) => re.test(p))) return false;
  const peer = cfg.peerPattern === undefined ? PEER_PATTERN : cfg.peerPattern;
  try { if (peer && new RegExp(peer).test(p)) return false; } catch { /* a bad pattern is skipped */ }
  for (const src of cfg.ignorePatterns || []) {
    try { if (new RegExp(src, 'i').test(p)) return false; } catch { /* a bad pattern is skipped */ }
  }
  return true;
}

/**
 * "pause focus gate 2h exam revision night" / "hold focus gate 1.5 h on the bus" / "resume focus gate".
 * Anchored to the start of the prompt so a sentence about the gate does not trigger it.
 */
export function parseGatePhrase(prompt) {
  const m = /^\s*(pause|hold|resume|unpause|arm)\s+(?:the\s+)?focus[ -]gate\b[\s:,-]*(?:(?:for\s+)?(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)\b)?[\s:,-]*([\s\S]*)$/i.exec(String(prompt ?? ''));
  if (!m) return null;
  const verb = m[1].toLowerCase();
  if (verb === 'resume' || verb === 'unpause') return { verb: 'resume' };
  if (verb === 'arm') return { verb: 'arm' };
  let hours = m[2] ? Number(m[2]) : null;
  if (hours !== null && /^m/i.test(m[3])) hours /= 60;
  return { verb, hours, reason: clip(m[4], 200) };
}

/* ---------------------------------------------------------------- the disk */

// Files an application makes on its own when you merely open or download something: Office owner files (~$x.docx),
// editor backups and swap files, temporary and partial downloads, and folder metadata. Dot files are skipped too.
export const JUNK = /^~\$|~$|\.(?:tmp|temp|swp|swo|swx|bak|crdownload|part|partial|download|lock)$|^(?:thumbs\.db|desktop\.ini|\.ds_store)$/i;
export const isJunk = (name) => name.startsWith('.') || JUNK.test(name);

function walkNewest(roots, w, deadline) {
  const exts = new Set((w.extensions || []).map((e) => String(e).toLowerCase()));
  const skip = new Set(w.skipDirs || []);
  let newest = 0, budget = Number(w.maxEntries) || 20000, truncated = false;
  const walk = (d, depth) => {
    if (depth > (Number(w.maxDepth) || 6)) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (--budget <= 0 || Date.now() > deadline) { truncated = true; return; }
      if (e.isDirectory()) { if (!skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth + 1); }
      else if (!isJunk(e.name) && exts.has(path.extname(e.name).toLowerCase())) {
        try { const m = fs.statSync(path.join(d, e.name)).mtimeMs; if (m > newest) newest = m; } catch { /* gone */ }
      }
      if (truncated) return;
    }
  };
  for (const r of roots) { if (truncated) break; walk(String(r), 0); }
  return { newest, truncated };
}

/** Newest work-file change under watch.roots, cached for watch.cacheMinutes. 0 = nothing found or no roots. */
export function newestWork(cfg, f, now) {
  const w = cfg.watch || {};
  const roots = Array.isArray(w.roots) ? w.roots.filter(Boolean) : [];
  if (!roots.length) return { newest: 0, cached: false };
  const key = JSON.stringify([roots, w.extensions, w.skipDirs, w.maxDepth]);
  const c = readJson(f.cache, null);
  const ttl = (Number(w.cacheMinutes) || 0) * 60e3;
  if (c && c.key === key && now >= c.at && now - c.at < ttl) return { newest: c.newest, cached: true, truncated: c.truncated };
  const { newest, truncated } = walkNewest(roots, w, Date.now() + (Number(w.budgetMs) || 100));
  // A scan cut short by its caps has not seen every file, so its "newest" may be too old: never cache it.
  if (!truncated) quietWrite(f.cache, { at: now, key, newest, truncated: false });
  return { newest, cached: false, truncated };
}

const entryPath = (e) => (typeof e === 'string' ? e : isObj(e) ? String(e.path ?? e.p ?? '') : '');

/**
 * When did this watched path last change in a way that counts? A file with a known baseline size counts only when
 * its size moves away from the last size seen (tracked in seen.json); without a known size, any save counts.
 */
function changedAt(id, entry, snap, seen, dirty, exts) {
  const p = entryPath(entry);
  if (!p) return 0;
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (st.isDirectory()) {
    let newest = 0;
    const deadline = Date.now() + 30;
    const walk = (d, depth) => {
      if (depth > 3 || Date.now() > deadline) return;
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents.slice(0, 2000)) {
        if (isJunk(e.name) || e.name === 'node_modules') continue;
        const q = path.join(d, e.name);
        if (e.isDirectory()) walk(q, depth + 1);
        else if (exts.has(path.extname(e.name).toLowerCase())) { try { const m = fs.statSync(q).mtimeMs; if (m > newest) newest = m; } catch { /* gone */ } }
      }
    };
    walk(p, 0);
    return newest;
  }
  const cfgSize = isObj(entry) && Number.isFinite(entry.size) ? entry.size : undefined;
  const snapHas = snap && Object.prototype.hasOwnProperty.call(snap, p);
  const base = cfgSize !== undefined ? cfgSize : snapHas ? snap[p].size : undefined; // null = did not exist
  if (base === undefined) return st.mtimeMs;
  const k = `${id}|${p}`;
  let s = seen[k];
  if (!s || s.base !== base) s = { base, size: base, changedAt: 0 };
  if (st.size !== s.size) { s = { base, size: st.size, changedAt: st.mtimeMs }; seen[k] = s; dirty.v = true; }
  else if (seen[k] !== s) { seen[k] = s; dirty.v = true; }
  return s.changedAt;
}

/* ---------------------------------------------------------------- the decision */

/** Is the item in play now? Past its "from", or due within the due-soon window (past due still counts). */
export function isActive(it, now, dueSoonMs) {
  if (!isObj(it) || it.done) return false;
  const from = ms(it.from), due = ms(it.due);
  if (!Number.isFinite(from) && !Number.isFinite(due)) return true;
  if (Number.isFinite(from) && now >= from) return true;
  return Number.isFinite(due) && due - now <= dueSoonMs;
}

/** Returns { on, reasons[], open[], idle, newest, paused?, held? }. Pure apart from the seen/cache files. */
export function decide(cfg, f, now) {
  const pause = readJson(f.pause, null);
  if (pause && ms(pause.until) > now) return { on: false, paused: pause, reasons: [], open: [] };
  const hold = readJson(f.hold, null);
  if (hold && !hold.armedAt && ms(hold.until) > now) return { on: false, held: hold, reasons: [], open: [] };

  const ev = readJson(f.evidence, {}) || {};
  const snap = readJson(f.snapshot, {}) || {};
  const seen = readJson(f.seen, {}) || {};
  const dirty = { v: false };
  const baseline = Number.isFinite(ms(cfg.baseline)) ? ms(cfg.baseline) : 0;
  const dueSoon = (Number(cfg.dueSoonHours) || 48) * H;

  const since = (it) => Math.max(baseline, Number(it.everyDays) > 0 ? now - Number(it.everyDays) * DAY : 0);
  const evidenceOk = (it) => {
    const e = ev[it.id];
    if (!e) return false;
    return Number(it.everyDays) > 0 ? ms(e.at) > since(it) : true;
  };
  const begun = (it) => evidenceOk(it)
    || (Array.isArray(it.paths) ? it.paths : []).some((e) => changedAt(it.id, e, snap[it.id], seen, dirty, extsFor(it)) > since(it));
  const extsFor = (it) => new Set((Array.isArray(it.extensions) ? it.extensions : (cfg.watch && cfg.watch.extensions) || []).map((x) => String(x).toLowerCase()));

  const open = [];
  const items = Array.isArray(cfg.items) ? cfg.items : [];
  for (const it of items) {
    if (!it || !it.id || !isActive(it, now, dueSoon)) continue;
    if (!begun(it)) open.push({ id: safeId(it.id) || 'item', title: clip(it.title || it.id, 80), short: it.short, next: it.next, due: it.due });
  }
  if (dirty.v) quietWrite(f.seen, seen);

  if (cfg.deadlinesFile) {
    const known = new Set([...items.map((i) => i && i.id), ...(cfg.coveredIds || [])]);
    const dl = readJson(String(cfg.deadlinesFile), []);
    const arr = Array.isArray(dl) ? dl : (isObj(dl) ? (dl.items || dl.deadlines || []) : []);
    for (const x of Array.isArray(arr) ? arr.slice(0, 500) : []) {
      const id = isObj(x) ? safeId(x.id) : '';
      if (!id || known.has(x.id) || known.has(id) || ev[x.id] || ev[id]) continue;
      if (x.status !== undefined && x.status !== 'open') continue;
      const due = ms(x.due);
      if (!(due > now && due - now <= dueSoon)) continue; // past entries belong to whatever tracks deadlines
      open.push({ id, title: clip(x.title || id, 80), due: new Date(due).toISOString(), next: 'start it, or say it is already done so it can be checked and recorded' });
    }
  }

  const reasons = [];
  if (open.length) reasons.push(`${open.length} item${open.length === 1 ? '' : 's'} not begun`);
  const { newest, truncated } = newestWork(cfg, f, now);
  const idleMs = (Number(cfg.idleHours) || 48) * H;
  const idle = !truncated && newest > 0 && now - newest > idleMs; // a partial scan proves nothing about idleness
  if (idle) reasons.push(`no watched work file changed since ${iso(newest)} (over ${Math.round(idleMs / H)} h)`);
  return { on: reasons.length > 0, reasons, open, idle, newest: newest ? iso(newest) : null, scanTruncated: !!truncated,
    ...(truncated ? { note: 'the idle scan hit watch.maxEntries or watch.budgetMs, so the idle trigger was skipped; narrow watch.roots or raise the caps' } : {}) };
}

/* ---------------------------------------------------------------- what Claude is told */

const CLI_PATH = fileURLToPath(import.meta.url).replace(/\\/g, '/');

export function firstLabel(d, cfg) {
  const o = d.open[0];
  if (!o) return cfg.idleShort || 'Real work';
  return clip(o.short || String(o.title).split(/\s*[(:]/)[0], 40);
}

export function gateLine(d, cfg) {
  const list = d.open.slice(0, 8)
    .map((o) => `${clip(o.title, 80)} [id ${o.id}]${o.due ? ` (due ${String(o.due).slice(0, 16)})` : ''}${o.next ? `: next, ${clip(o.next, 160)}` : ''}`)
    .join('; ');
  const more = d.open.length > 8 ? ` (+${d.open.length - 8} more)` : '';
  const rule = cfg.rule ? ` The user's own rule: "${clip(cfg.rule, 300)}".` : '';
  const allowed = (cfg.allowed || []).map((a) => clip(a, 160)).join('; ');
  return `[focus-gate] FOCUS GATE ON (${d.reasons.join('; ')}). The user set this gate up to stop themselves putting off this work.${rule} `
    + `Not begun: ${list || '(idle trigger: any real work in the watched folders lifts it)'}${more}. `
    + `ALLOWED: ${allowed || 'work on the items above'}. `
    + `EVERYTHING ELSE (new discussions, ideas, research, side projects, long builds the user starts by asking): do NOT do it. `
    + `Reply in one or two warm, firm lines: "${firstLabel(d, cfg)} first", the single next step from the list above, and offer to start it with them right now. `
    + 'Do not lecture, and do not do the request anyway. Work already running in the background keeps going; it is not a new request. '
    + `Begun means real work on disk. For work done somewhere this machine cannot see (another computer, an online quiz), check it first, then record it: node "${CLI_PATH}" evidence <id> "<how you checked>". `
    + `It pauses only if the user types "pause focus gate <hours>h <reason>" (at most ${Number(cfg.pauseMaxHours) || 4} h).`;
}

export function heldLine(hold, cfg) {
  return `[focus-gate] Focus gate HELD while the user is in transit (${clip(hold.reason, 200)}; it arms at ${hold.until} at the latest, or as soon as they say they have settled or arrived). `
    + `Normal requests are fine now. A good use of this window: ${cfg.heldAdvice}`;
}

/* ---------------------------------------------------------------- the hook */

const out = (ctx, extra = {}) => ({ ...extra, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } });

function setPause(f, cfg, hours, reason, now) {
  const h = Math.min(Number(cfg.pauseMaxHours) || 4, Math.max(0.25, Number(hours) || 1));
  const p = { since: new Date(now).toISOString(), until: new Date(now + h * H).toISOString(), hours: h, reason: clip(reason, 200) };
  writeAtomic(f.pause, p);
  return p;
}
function setHold(f, cfg, hours, reason, now) {
  const h = Math.min(Number(cfg.holdMaxHours) || 3, Math.max(0.25, Number(hours) || 2));
  const p = { since: new Date(now).toISOString(), until: new Date(now + h * H).toISOString(), hours: h, reason: clip(reason, 200) };
  writeAtomic(f.hold, p);
  return p;
}
function arm(f, now, by = '') {
  const hd = readJson(f.hold, null);
  if (!hd || hd.armedAt) return false;
  hd.armedAt = new Date(now).toISOString();
  if (by) hd.armedBy = clip(by, 120);
  writeAtomic(f.hold, hd);
  return true;
}

/** Returns the hook's stdout object, or null for silence. */
export function runHook(input, env = process.env) {
  if (!isObj(input)) return null;
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'UserPromptSubmit') return null;
  const f = files(env);
  const cfg = loadConfig(f.config);
  if (!cfg) return null; // no config: inert
  if (cfg.skipUnattended !== false && isUnattended(env)) return null;
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!isUserPrompt(prompt, cfg)) return null;
  const now = nowMs(env);

  const phrase = parseGatePhrase(prompt);
  if (phrase) {
    if (phrase.verb === 'resume') {
      try { fs.rmSync(f.pause, { force: true }); } catch { /* fine */ }
    } else if (phrase.verb === 'arm') {
      arm(f, now, prompt);
    } else if (phrase.reason.length < 3) {
      return out(`[focus-gate] The user asked to ${phrase.verb} the focus gate without a reason, so nothing changed. Tell them, in one line, to type "${phrase.verb} focus gate <hours>h <reason>".`);
    } else if (phrase.verb === 'pause') {
      const p = setPause(f, cfg, phrase.hours, phrase.reason, now);
      return out(`[focus-gate] Paused until ${p.until} (${p.hours} h) for the user's reason: "${p.reason}". Normal requests are fine until then.`,
        { systemMessage: `[focus-gate] paused for ${p.hours} h` });
    } else {
      const p = setHold(f, cfg, phrase.hours, phrase.reason, now);
      return out(heldLine(p, cfg), { systemMessage: `[focus-gate] held for up to ${p.hours} h` });
    }
  }

  const hold = readJson(f.hold, null);
  let settled = false;
  try { settled = new RegExp(cfg.settledPattern, 'i').test(prompt); } catch { settled = false; }
  if (hold && !hold.armedAt && ms(hold.until) > now && settled) { try { arm(f, now, prompt); } catch { /* fine */ } }

  const d = decide(cfg, f, now);
  if (d.on) return out(gateLine(d, cfg));
  if (d.held) return out(heldLine(d.held, cfg));
  return null;
}

/* ---------------------------------------------------------------- CLI */

const HELP = `focus-gate ${VERSION}: Claude turns down off-task requests until the work you keep putting off has begun.

Hook use (reads the hook JSON on stdin; register for UserPromptSubmit):
  node focus-gate.mjs < hook-input.json

CLI:
  node focus-gate.mjs status                         is the gate on, and why
  node focus-gate.mjs evidence <id> "<how checked>"  record work this machine cannot see
  node focus-gate.mjs snapshot [<id>]                record today's size of each item's paths as the baseline
  node focus-gate.mjs hold <hours> "<reason>"        in transit: quiet until "settled" or the hold ends (max 3 h)
  node focus-gate.mjs arm                            end a hold now
  node focus-gate.mjs pause <hours> "<reason>"       pause (max 4 h); a reason is required
  node focus-gate.mjs resume                         end a pause now
  Every command takes [--config <file>].

Output: one JSON object on stdout. Exit codes: 0 ok, 1 failure (no config, a write failed), 2 usage error.
State folder: $HEADLESS_KIT_STATE_DIR/focus-gate (default ~/.claude/headless-kit/focus-gate).
Config: --config, $FOCUS_GATE_CONFIG, or <state folder>/focus-gate.config.json.`;

function print(obj, code = 0, stdout = process.stdout) { stdout.write(`${JSON.stringify(obj)}\n`); return code; }

export function runCli(argv, env = process.env, stdout = process.stdout) {
  const pos = [];
  let configFlag = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { configFlag = argv[++i] ?? ''; continue; }
    if (argv[i] === '--help' || argv[i] === '-h') { stdout.write(`${HELP}\n`); return 0; }
    pos.push(argv[i]);
  }
  const [cmd, a1, a2] = pos;
  const f = files(env, configFlag);
  const now = nowMs(env);
  let cfg;
  try { cfg = loadConfig(f.config, true); } catch (e) { return print({ ok: false, error: `config: ${e.message}`, config: f.config }, 1, stdout); }

  if (cmd === 'status') {
    return print({ ok: true, config: f.config, stateDir: f.dir, ...decide(cfg, f, now) }, 0, stdout);
  }
  if (cmd === 'evidence') {
    if (!a1 || !a2 || String(a2).trim().length < 3) return print({ ok: false, error: 'usage: evidence <id> "<how it was checked>"' }, 2, stdout);
    const ev = readJson(f.evidence, {}) || {};
    ev[a1] = { at: new Date(now).toISOString(), how: clip(a2, 200) };
    writeAtomic(f.evidence, ev);
    const known = (cfg.items || []).some((i) => i && i.id === a1);
    return print({ ok: true, id: a1, at: ev[a1].at, knownItem: known }, 0, stdout);
  }
  if (cmd === 'snapshot') {
    const snap = readJson(f.snapshot, {}) || {};
    const seen = readJson(f.seen, {}) || {};
    const done = [];
    for (const it of cfg.items || []) {
      if (!it || !it.id || (a1 && it.id !== a1)) continue;
      snap[it.id] = snap[it.id] || {};
      for (const e of Array.isArray(it.paths) ? it.paths : []) {
        const p = entryPath(e);
        if (!p) continue;
        let size = null;
        try { const st = fs.statSync(p); if (st.isDirectory()) continue; size = st.size; } catch { size = null; }
        snap[it.id][p] = { size, at: new Date(now).toISOString() };
        delete seen[`${it.id}|${p}`];
        done.push({ id: it.id, path: p, size, overriddenByConfig: isObj(e) && Number.isFinite(e.size) });
      }
    }
    if (a1 && !done.length && !(cfg.items || []).some((i) => i && i.id === a1)) return print({ ok: false, error: `no item with id ${a1}` }, 1, stdout);
    writeAtomic(f.snapshot, snap);
    writeAtomic(f.seen, seen);
    return print({ ok: true, recorded: done }, 0, stdout);
  }
  if (cmd === 'pause' || cmd === 'hold') {
    if (!a2 || String(a2).trim().length < 3) return print({ ok: false, error: `usage: ${cmd} <hours> "<the user's reason>"` }, 2, stdout);
    const p = cmd === 'pause' ? setPause(f, cfg, a1, a2, now) : setHold(f, cfg, a1, a2, now);
    return print({ ok: true, [cmd === 'pause' ? 'paused' : 'held']: p }, 0, stdout);
  }
  if (cmd === 'arm') return print({ ok: true, armed: arm(f, now, 'cli') }, 0, stdout);
  if (cmd === 'resume') { fs.rmSync(f.pause, { force: true }); return print({ ok: true, resumed: true }, 0, stdout); }
  return print({ ok: false, error: `unknown command: ${cmd ?? '(none)'}; see --help` }, 2, stdout);
}

/* ---------------------------------------------------------------- main */

const isMain = (() => { try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.length) {
    let code = 2;
    try { code = runCli(argv); } catch (e) { code = print({ ok: false, error: String(e && e.message) }, 1); }
    process.exitCode = code;
  } else {
    // Hook mode: fail silent, and stop well inside any hook timeout.
    setTimeout(() => process.exit(0), 1500).unref();
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
      try {
        const res = raw.trim() ? runHook(JSON.parse(raw)) : null;
        if (res) process.stdout.write(JSON.stringify(res), () => process.exit(0));
        else process.exit(0);
      } catch { process.exit(0); }
    });
    process.stdin.on('error', () => process.exit(0));
  }
}
