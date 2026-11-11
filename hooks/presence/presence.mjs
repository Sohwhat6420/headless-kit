#!/usr/bin/env node
/**
 * presence.mjs: a machine-wide "is the human here?" switch for Claude Code sessions. One file, three roles:
 *
 *   SessionStart hook       tells each new session which mode it is in (present, away, or unattended).
 *   UserPromptSubmit hook   flips the switch on /away, /back or a clear phrase ("I'm going to bed", "I'm back"),
 *                           and tells running sessions when the mode has changed since they last heard.
 *   CLI                     status, set, and the away backlog: ask / backlog / resolve.
 *
 * Present: ask in chat. Away: keep working on the most likely answer and log each such decision to a backlog, which
 * /back walks through with the human. Unattended (headless or SDK runs): nobody is watching, never wait.
 *
 * State lives in HEADLESS_KIT_STATE_DIR (default ~/.claude/headless-kit): presence.json, presence-backlog.jsonl,
 * presence-seen.json. Config: --config, HEADLESS_KIT_PRESENCE_CONFIG, or <state dir>/presence.config.json.
 *
 * As a hook it fails open: any error, missing file or unexpected input exits 0 with no output. It never blocks.
 * Zero dependencies, Node 18+.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ---------------------------------------------------------------- config */

export const DEFAULT_CONFIG = {
  // When the UserPromptSubmit hook injects the mode line into a running session:
  //   "flip"     only in the session whose prompt flipped the switch;
  //   "onChange" also in any session whose last-seen mode differs (it learns of a flip made elsewhere);
  //   "always"   on every prompt.
  updates: 'onChange',
  phrases: {
    enabled: true, // natural-language phrases flip the switch, not only /away and /back
    extraAway: [], // extra regex sources (case-insensitive) that mean "I am going away"
    extraBack: [], // extra regex sources that mean "I am back"
  },
  // `set present` from the CLI needs --said carrying the human's own words, so a session can never mark the
  // human present on its own inference.
  presentNeedsWords: true,
  // A prompt matching this regex never counts as the human typing (an app's auto-continue after a usage reset).
  machinePromptPattern: String.raw`\b(?:usage|session|rate) limit\b.*\b(?:reset|continue)\b`,
  quietHours: {
    enabled: false, // inside the window the human counts as away unless they typed in the last activeMinutes
    from: 23,
    to: 8,
    utcOffsetMinutes: null, // null = this machine's local time
    activeMinutes: 30,
  },
  locale: 'en-GB',
  notify: {
    command: null, // e.g. ["node", "/abs/path/notify.mjs"]; argv gets the event appended. No shell is used.
    on: ['away', 'present', 'waiting'],
    timeoutMs: 3000,
  },
  messages: {
    present:
      '[presence] The user is PRESENT. When a decision is theirs, ask in chat and wait for the answer. ' +
      '"/away" or "I\'m going to bed" switches every session to away mode.',
    away:
      '[presence] The user is AWAY{since}{quiet}. Do not stop to wait for answers: where a decision is theirs, pick ' +
      'the most likely answer, build on it, and log it with node "{cli}" ask --question "..." --context "..." ' +
      '--assumed "..." --built "..." --reverse "...". Never act on a guess for anything irreversible (spending money, ' +
      'publishing, sending messages, deleting the user\'s data, credentials): log it with --waiting and leave it. ' +
      'Backlog: {open} open, {waiting} waiting. "/back" or "I\'m back" switches back.',
    unattended:
      '[presence] Unattended session: nobody is watching this chat, so never wait for an answer. Log each question ' +
      'with node "{cli}" ask --question "..." --assumed "..." (add --waiting for anything irreversible) and carry on.',
    backlogWaiting:
      ' {open} open and {waiting} waiting question(s) in the away backlog: run /back, or node "{cli}" backlog.',
    // Shown to the human (systemMessage) on the prompt that flips the switch. Empty string = no visible notice.
    noticeAway: '[presence] Away mode is on for every session. /back or "I\'m back" to undo.',
    noticePresent: '[presence] Present mode is on. Away backlog: {open} open, {waiting} waiting.',
  },
};

const CLI_PATH = fileURLToPath(import.meta.url).replace(/\\/g, '/');

export function stateDir(env = process.env) {
  return env.HEADLESS_KIT_STATE_DIR || path.join(os.homedir(), '.claude', 'headless-kit');
}

export function files(env = process.env) {
  const dir = stateDir(env);
  return {
    dir,
    state: path.join(dir, 'presence.json'),
    backlog: path.join(dir, 'presence-backlog.jsonl'),
    seen: path.join(dir, 'presence-seen.json'),
    config: env.HEADLESS_KIT_PRESENCE_CONFIG || path.join(dir, 'presence.config.json'),
  };
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

/** Load config. strict=true throws on an unreadable named file (CLI); otherwise falls back to the defaults. */
export function loadConfig(file, strict = false) {
  try {
    if (!file || !fs.existsSync(file)) {
      if (strict && file) throw new Error(`config not found: ${file}`);
      return DEFAULT_CONFIG;
    }
    return merge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (strict) throw e;
    return DEFAULT_CONFIG;
  }
}

/* ---------------------------------------------------------------- state */

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function nowMs(env = process.env) {
  const n = Number(env.HEADLESS_KIT_NOW ? Date.parse(env.HEADLESS_KIT_NOW) : NaN);
  return Number.isFinite(n) ? n : Date.now();
}

export function inQuietHours(cfg, ms) {
  const q = cfg.quietHours || {};
  if (!q.enabled) return false;
  const from = Number(q.from), to = Number(q.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  const off = q.utcOffsetMinutes;
  const h = off === null || off === undefined ? new Date(ms).getHours() : new Date(ms + Number(off) * 60000).getUTCHours();
  return from > to ? h >= from || h < to : h >= from && h < to;
}

/** The effective mode: an explicit "away" wins; quiet hours count as away unless the human typed recently. */
export function presence(file, cfg = DEFAULT_CONFIG, ms = Date.now()) {
  const j = readJson(file, null);
  const base = { since: j?.since || null, said: j?.said || '', session: j?.session || '', lastPromptAt: j?.lastPromptAt || null };
  if (j && j.state === 'away') return { state: 'away', away: true, quiet: false, ...base };
  const last = Date.parse(base.lastPromptAt || '');
  const activeMs = Number(cfg.quietHours?.activeMinutes ?? 30) * 60000;
  if (inQuietHours(cfg, ms) && !(Number.isFinite(last) && ms - last < activeMs)) {
    return { state: 'away', away: true, quiet: true, ...base };
  }
  return { state: 'present', away: false, quiet: false, ...base };
}

export function setPresence(file, state, said = '', session = '', ms = Date.now()) {
  const at = new Date(ms).toISOString();
  const rec = {
    state: state === 'away' ? 'away' : 'present',
    since: at,
    said: String(said).slice(0, 200),
    session: String(session).slice(0, 12),
    ...(state === 'away' ? {} : { lastPromptAt: at }),
  };
  writeAtomic(file, JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

/** Stamp the human's latest prompt, so quiet hours know they are still at the keyboard. */
export function touchPrompt(file, ms = Date.now()) {
  try {
    const j = readJson(file, {}) || {};
    j.state = j.state === 'away' ? 'away' : 'present';
    j.lastPromptAt = new Date(ms).toISOString();
    writeAtomic(file, JSON.stringify(j, null, 2) + '\n');
  } catch { /* never break a prompt */ }
}

/** Headless and SDK runs: nobody is reading the chat, whatever the switch says. */
export function isUnattended(env = process.env) {
  const att = env.CLAUDE_CODE_SESSION_ATTENDED;
  if (att !== undefined && att.trim() !== '1') return true;
  return /^sdk-/i.test(env.CLAUDE_CODE_ENTRYPOINT || '');
}

/* ---------------------------------------------------------------- phrase detection */

/* Clear phrases only. Matched on the human's own text, with machine blocks, quotes, code spans and `>` lines
   stripped, so a pasted log or a sentence ABOUT the phrase cannot flip it. Each pattern is first-person or anchored
   to a sentence start / the whole message, because loose patterns misfire on ordinary sentences ("the toast is
   heading out of view", "my laptop keeps going to sleep"). */
const SENT = String.raw`(?:^|[.!?;\n]\s*)(?:(?:ok(?:ay)?|right|alright|ok so|anyway)[,.!]?\s+)?`;
const AWAY = [
  /\b(?:i'?m|i am|im)\s+(?:going|gonna|off)\s+(?:to\s+)?(?:sleep|bed)\b/gi,
  new RegExp(`${SENT}(?:going|off) to (?:sleep|bed)\\b`, 'gi'),
  /\b(?:i'?ll|i will) be away\b/gi,
  /\b(?:i'?m|i am|im) going to be away\b/gi,
];
const AWAY_WHOLE = /^\s*(?:ok(?:ay)?[,.!]?\s*)?(?:good ?night|night all)(?:\s+(?:all|everyone|claude|guys))?\s*[.!]*\s*$/i;
/* "I'm back", but not a future statement ("I'm back at 8", "back tomorrow") nor back-to-a-topic. */
const BACK = [
  /\b(?:i'?m|i am|im)\s+back\b(?!\s+(?:to|at|in|on|by|around|after|tomorrow|later|tonight|soon|when|once)\b)/gi,
];
const BACK_WHOLE = /^\s*(?:ok(?:ay)?[,.!]?\s*)?(?:(?:i'?m|i am|im)\s+)?(?:back(?:\s+now)?|here(?:\s+now)?)\s*[.!]*\s*$/i;
/* The slash commands, bare or plugin-namespaced (/away, /some-plugin:back), raw or wrapped in <command-name>. */
const SLASH = /^\s*(?:<command-name>\s*)?\/(?:[\w.-]+:)?(away|back)(?![\w:-])/i;

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'col', 'source']);
/* Linear tag stripper: a closed <tag>…</tag> is removed; an UNCLOSED non-void tag removes everything after it
   (a truncated machine block is still not the human's words). */
function stripTags(s) {
  const open = /<([a-z][\w-]*)(?:\s[^<>\n]{0,500})?>/gi;
  const lastClose = new Map();
  const lower = s.toLowerCase();
  let out = '';
  let pos = 0;
  let m;
  while ((m = open.exec(s))) {
    const name = m[1].toLowerCase();
    if (VOID_TAGS.has(name)) continue;
    const closeTag = `</${name}>`;
    if (!lastClose.has(name)) lastClose.set(name, lower.lastIndexOf(closeTag));
    out += s.slice(pos, m.index) + ' ';
    if (lastClose.get(name) < open.lastIndex) return out;
    const end = lower.indexOf(closeTag, open.lastIndex);
    pos = end + closeTag.length;
    open.lastIndex = pos;
  }
  return out + s.slice(pos);
}

/** Strip what is not the human's own words: tagged blocks, quotes, code, `>` lines, pasted hook output. */
export function humanText(prompt) {
  let t = String(prompt || '');
  t = t.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  t = stripTags(t);
  t = t.replace(/^\s*\[[^\]]*(SYSTEM|Request interrupted)[^\]]*\][^\n]*$/gim, ' ');
  t = t.split(/\r?\n/).filter((l) => !/^\s*(>|Stop hook|\[[a-z-]+\]|──)/i.test(l)).join('\n');
  t = t.replace(/"[^"\n]*"/g, ' ').replace(/“[^”\n]*”/g, ' ').replace(/‘(?:[^’\n]|’(?=[a-z]))*’/gi, ' ');
  t = t.replace(/(^|[\s(:])'(?:[^'\n]|'(?=[a-z]))+'(?=[\s.,;:!?)]|$)/gim, '$1 ');
  return t;
}

function compileExtra(list) {
  const out = [];
  for (const src of Array.isArray(list) ? list : []) { try { out.push(new RegExp(String(src), 'gi')); } catch { /* skip */ } }
  return out;
}
function lastEnd(res, t) {
  let at = -1;
  for (const re of res) { re.lastIndex = 0; for (const m of t.matchAll(re)) at = Math.max(at, m.index + m[0].length); }
  return at;
}

/** 'away' | 'present' | null. When both kinds of phrase appear, the LAST one wins. */
export function detect(prompt, cfg = DEFAULT_CONFIG) {
  const raw = String(prompt || '');
  const slash = raw.match(SLASH);
  if (slash) return slash[1].toLowerCase() === 'away' ? 'away' : 'present';
  if (cfg.phrases && cfg.phrases.enabled === false) return null;
  const t = humanText(raw);
  if (AWAY_WHOLE.test(t)) return 'away';
  if (BACK_WHOLE.test(t)) return 'present';
  const away = lastEnd([...AWAY, ...compileExtra(cfg.phrases?.extraAway)], t);
  const back = lastEnd([...BACK, ...compileExtra(cfg.phrases?.extraBack)], t);
  if (away < 0 && back < 0) return null;
  return back > away ? 'present' : 'away';
}

/* ---------------------------------------------------------------- backlog */

export function readBacklog(file) {
  let text = '';
  try { text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && j.id) out.push(j); } catch { /* skip a bad line */ }
  }
  return out;
}

export function backlogCounts(file) {
  const items = readBacklog(file);
  return { open: items.filter((i) => i.status === 'open').length, waiting: items.filter((i) => i.status === 'waiting').length };
}

const cap = (v, n = 2000) => (v === undefined || v === null ? '' : String(v).slice(0, n));

export function addEntry(file, fields, ms = Date.now()) {
  const entry = {
    id: `q${ms.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`,
    at: new Date(ms).toISOString(),
    session: cap(fields.session, 40),
    status: fields.waiting ? 'waiting' : 'open',
    question: cap(fields.question),
    context: cap(fields.context),
    assumed: cap(fields.assumed),
    built: cap(fields.built),
    reverse: cap(fields.reverse),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

export function resolveEntry(file, id, as, answer = '', ms = Date.now()) {
  const items = readBacklog(file);
  const hit = items.find((i) => i.id === id);
  if (!hit) return null;
  hit.status = as;
  hit.answer = cap(answer);
  hit.resolvedAt = new Date(ms).toISOString();
  writeAtomic(file, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  return hit;
}

/* ---------------------------------------------------------------- wording */

export function render(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function vars(p, cfg, f) {
  let since = '';
  if (p.since && !p.quiet) {
    try {
      since = ` since ${new Date(p.since).toLocaleString(cfg.locale || undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}`;
    } catch { since = ` since ${p.since}`; }
  }
  const q = cfg.quietHours || {};
  const pad = (n) => String(n).padStart(2, '0');
  const quiet = p.quiet ? ` (quiet hours ${pad(q.from)}:00 to ${pad(q.to)}:00)` : '';
  const c = backlogCounts(f.backlog);
  return { since, quiet, cli: CLI_PATH, backlogFile: f.backlog.replace(/\\/g, '/'), open: c.open, waiting: c.waiting, state: p.state };
}

export function describe(p, cfg, f, { unattended = false, justBack = false } = {}) {
  const v = vars(p, cfg, f);
  const m = cfg.messages || {};
  if (unattended) return render(m.unattended, v);
  let line = render(p.away ? m.away : m.present, v);
  if (justBack && v.open + v.waiting > 0) line += render(m.backlogWaiting, v);
  return line;
}

/* ---------------------------------------------------------------- notify */

export function notify(cfg, event, text, env = process.env) {
  const n = cfg.notify || {};
  if (!Array.isArray(n.command) || !n.command.length || !(n.on || []).includes(event)) return false;
  try {
    const r = spawnSync(String(n.command[0]), [...n.command.slice(1).map(String), event], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: Number(n.timeoutMs) || 3000,
      env: { ...env, PRESENCE_EVENT: event, PRESENCE_TEXT: String(text || '').slice(0, 500) },
    });
    return r.status === 0;
  } catch { return false; }
}

/* ---------------------------------------------------------------- seen (per session) */

function markSeen(f, session, mode, ms) {
  if (!session) return;
  try {
    const seen = readJson(f.seen, {}) || {};
    seen[session] = { mode, at: new Date(ms).toISOString() };
    const keys = Object.keys(seen);
    if (keys.length > 200) {
      keys.sort((a, b) => String(seen[a].at).localeCompare(String(seen[b].at)));
      for (const k of keys.slice(0, keys.length - 200)) delete seen[k];
    }
    writeAtomic(f.seen, JSON.stringify(seen));
  } catch { /* never break a prompt */ }
}
function lastSeen(f, session) {
  const seen = readJson(f.seen, {}) || {};
  return session && seen[session] ? seen[session].mode : null;
}

/* ---------------------------------------------------------------- hooks */

/** Returns the hook's stdout object, or null for silence. */
export function runHook(input, env = process.env) {
  if (!isObj(input)) return null;
  const f = files(env);
  const cfg = loadConfig(f.config);
  const ms = nowMs(env);
  const unattended = isUnattended(env);
  const session = typeof input.session_id === 'string' ? input.session_id : '';
  const event = input.hook_event_name;

  if (event === 'SessionStart') {
    const p = presence(f.state, cfg, ms);
    markSeen(f, session, unattended ? 'unattended' : p.state, ms);
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: describe(p, cfg, f, { unattended }) } };
  }
  if (event !== 'UserPromptSubmit' && !(event === undefined && typeof input.prompt === 'string')) return null;

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const want = detect(prompt, cfg);
  let machine = false;
  try { machine = cfg.machinePromptPattern ? new RegExp(cfg.machinePromptPattern, 'i').test(prompt) : false; } catch { machine = false; }
  if (!unattended && want !== 'away' && !machine && humanText(prompt).trim()) touchPrompt(f.state, ms);

  const now = presence(f.state, cfg, ms);
  if (want && want !== now.state) {
    setPresence(f.state, want, prompt.trim().slice(0, 200), session, ms);
    const p = presence(f.state, cfg, ms);
    notify(cfg, want, p.said, env);
    markSeen(f, session, unattended ? 'unattended' : p.state, ms);
    const line = describe(p, cfg, f, { justBack: want === 'present' });
    const notice = render(want === 'away' ? cfg.messages?.noticeAway : cfg.messages?.noticePresent, vars(p, cfg, f));
    const res = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line } };
    return notice.trim() ? { systemMessage: notice, ...res } : res;
  }

  const mode = unattended ? 'unattended' : now.state;
  const updates = cfg.updates || 'onChange';
  if (updates === 'always' || (updates === 'onChange' && lastSeen(f, session) !== mode)) {
    markSeen(f, session, mode, ms);
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: describe(now, cfg, f, { unattended }) } };
  }
  return null;
}

/* ---------------------------------------------------------------- CLI */

const HELP = `presence: is the human here? A Claude Code hook plus CLI.

Hook use (reads the hook JSON on stdin; register for SessionStart and UserPromptSubmit):
  node presence.mjs < hook-input.json

CLI:
  node presence.mjs status
  node presence.mjs set away [--said "<text>"] [--session <id>]
  node presence.mjs set present --said "<the human's own words>" [--session <id>]
  node presence.mjs ask --question "<q>" [--context "<c>"] [--assumed "<a>"] [--built "<b>"]
                        [--reverse "<how to undo>"] [--waiting] [--session <id>]
  node presence.mjs backlog [--all]
  node presence.mjs resolve <id> --as confirmed|reversed|answered [--answer "<text>"]
  Every command takes [--config <file>].

Output: one JSON object on stdout. Exit codes: 0 ok, 1 failure (for example an unknown id), 2 usage error.
State folder: $HEADLESS_KIT_STATE_DIR (default ~/.claude/headless-kit).
Config: --config, $HEADLESS_KIT_PRESENCE_CONFIG, or <state folder>/presence.config.json.`;

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  const bool = new Set(['--waiting', '--all', '--help', '-h', '--status']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (bool.has(a)) opt[a.replace(/^-+/, '')] = true;
    else if (a.startsWith('--')) { opt[a.slice(2)] = argv[i + 1] ?? ''; i++; }
    else pos.push(a);
  }
  return { pos, opt };
}

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  return code;
}

export function runCli(argv, env = process.env) {
  const { pos, opt } = parseArgs(argv);
  if (opt.help || opt.h) { process.stdout.write(HELP + '\n'); return 0; }
  const f = files(env);
  let cfg;
  try { cfg = loadConfig(opt.config || f.config, Boolean(opt.config)); } catch (e) { return out({ ok: false, error: `config: ${e.message}` }, 2); }
  const ms = nowMs(env);
  const cmd = opt.status ? 'status' : pos[0];

  if (cmd === 'status') {
    const p = presence(f.state, cfg, ms);
    return out({ ok: true, state: p.state, quiet: p.quiet, since: p.since, said: p.said, unattended: isUnattended(env), backlog: backlogCounts(f.backlog), line: describe(p, cfg, f, { unattended: isUnattended(env) }) });
  }
  if (cmd === 'set') {
    const want = pos[1];
    if (want !== 'away' && want !== 'present') return out({ ok: false, error: 'set takes away or present' }, 2);
    const said = String(opt.said || '').trim();
    if (want === 'present' && cfg.presentNeedsWords !== false && said.length < 3) {
      return out({ ok: false, error: 'set present needs --said "<the human\'s own words saying they are back>"' }, 2);
    }
    const before = presence(f.state, cfg, ms).state;
    try { setPresence(f.state, want, want === 'present' ? `on their words: ${said}` : said || '/away', opt.session || '', ms); } catch (e) { return out({ ok: false, error: e.message }, 1); }
    const p = presence(f.state, cfg, ms);
    if (before !== want) notify(cfg, want, said, env);
    return out({ ok: true, state: p.state, changed: before !== want, line: describe(p, cfg, f, { justBack: want === 'present' }) });
  }
  if (cmd === 'ask') {
    if (!String(opt.question || '').trim()) return out({ ok: false, error: 'ask needs --question' }, 2);
    let e;
    try { e = addEntry(f.backlog, { ...opt, waiting: Boolean(opt.waiting) }, ms); } catch (err) { return out({ ok: false, error: err.message }, 1); }
    if (e.status === 'waiting') notify(cfg, 'waiting', e.question, env);
    return out({ ok: true, id: e.id, status: e.status, backlog: backlogCounts(f.backlog) });
  }
  if (cmd === 'backlog') {
    const all = readBacklog(f.backlog);
    const items = opt.all ? all : all.filter((i) => i.status === 'open' || i.status === 'waiting');
    // Waiting entries first (they block work), then oldest first.
    items.sort((a, b) => (a.status === 'waiting') === (b.status === 'waiting') ? String(a.at).localeCompare(String(b.at)) : a.status === 'waiting' ? -1 : 1);
    return out({ ok: true, count: items.length, items });
  }
  if (cmd === 'resolve') {
    const id = pos[1];
    const as = opt.as;
    if (!id || !['confirmed', 'reversed', 'answered'].includes(as)) return out({ ok: false, error: 'resolve <id> --as confirmed|reversed|answered' }, 2);
    let hit;
    try { hit = resolveEntry(f.backlog, id, as, opt.answer || '', ms); } catch (e) { return out({ ok: false, error: e.message }, 1); }
    if (!hit) return out({ ok: false, error: `no backlog entry ${id}` }, 1);
    return out({ ok: true, id, status: hit.status, backlog: backlogCounts(f.backlog) });
  }
  return out({ ok: false, error: `unknown command: ${cmd ?? '(none)'}; see --help` }, 2);
}

/* ---------------------------------------------------------------- main */

const isMain = (() => { try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.length) {
    let code = 2;
    try { code = runCli(argv); } catch (e) { code = out({ ok: false, error: String(e && e.message) }, 1); }
    process.exitCode = code;
  } else {
    // Hook mode: fail open, hard stop well inside the hook timeout.
    const cfgGuess = loadConfig(files().config);
    setTimeout(() => process.exit(0), Math.max(1500, (Number(cfgGuess.notify?.timeoutMs) || 0) + 1000)).unref();
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
