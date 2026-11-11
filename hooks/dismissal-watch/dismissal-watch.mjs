#!/usr/bin/env node
/**
 * dismissal-watch.mjs: a Claude Code Stop hook that catches "that's impossible" said without looking.
 *
 * Stop              When the final reply dismisses an idea ("impossible", "not feasible", "can't be done", ...) and
 *                   the turn ran no search (WebSearch, WebFetch, a browser or fetch tool, gh search, ...), it warns.
 *                   By default it only warns: a systemMessage for the user, plus a one-line note for the model that
 *                   is delivered with the next prompt. Opt-in modes make the model continue at once.
 * UserPromptSubmit  Delivers that pending note (once) as additionalContext.
 *
 * By default it only fires when the user's prompt for that turn asked whether something can be done, so a process
 * word ("renaming it is impossible while the file is locked") does not trip it.
 * The transcript is tail-read (1 MB, doubling back to a 16 MB cap until the turn's prompt is found), never whole.
 * Fails open: any error, missing file or unexpected input exits 0 with no output. Zero dependencies, Node 18+.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------------------------------------------------------------- config */

const DEVICE = '(?:android|ios|iphone|ipad|phone|watch|tablet|chromebook|raspberry|pi|esp32|arduino|tv|console|switch|linux|windows|macos|mac|vm|wsl|device|router|nas|gpu|browser)';
const VERB = '(?:run|boot|install|flash|emulate|port|jailbreak|root|sideload|get .{1,40}? (?:on|onto|working|running)|make .{1,40}? (?:act|work|run|boot))';

export const DEFAULT_CONFIG = {
  // "warn": systemMessage + a note delivered with the next prompt (default; never makes the model continue).
  // "feedback": Stop additionalContext; the conversation continues so the model can search now (opt-in).
  // "block": Stop decision "block" with a reason; the model is forced to continue (opt-in).
  mode: 'warn',
  requirePossibilityPrompt: true,
  deliverOnNextPrompt: true,
  noteMaxAgeDays: 7,
  message: '[dismissal-watch] The last reply said no without searching. Search (GitHub, the web, forums, papers) and report what exists, and the closest analogues, before saying it cannot be done.',
  dismissalPatterns: [
    String.raw`\b(?:impossible|not possible|can(?:no|['’])t be done|cannot be done|isn['’]?t (?:feasible|possible|doable)|not feasible|infeasible|unrealistic|not doable|no way to do)\b`,
  ],
  // Text that contains a dismissal word but says the opposite.
  ignoreInReply: [String.raw`\bnot (?:impossible|unrealistic|infeasible)\b`],
  possibilityPatterns: [
    String.raw`\bis (?:it|this|that) (?:even |actually |really |at all )?(?:possible|feasible|doable)\b`,
    String.raw`\b(?:would|will) it be (?:possible|feasible)\b`,
    String.raw`\bis there (?:a|any) way\b`,
    String.raw`\bany way to\b`,
    String.raw`(?<!\bas )\b(?:possible|feasible) to (?!(?:the|a|an|my|your|our|his|her|their|me|you|him|us|them|it|all|any|each|every)\b)`,
    String.raw`\b(?:doable|feasible)\s*\?`,
    String.raw`\b(?:can|could) (?:i|we|it|u|you) (?:even |actually |somehow |possibly |ever )?` + VERB + String.raw`\b`,
    String.raw`\b(?:can|could) (?:i|we|it|u|you) (?:even|actually|somehow|possibly|ever) \w+`,
    String.raw`\bcan it (?:run|work)\b`,
    String.raw`\brun(?:ning)?\s+[\w.+#-]+(?:\s+[\w.+#-]+){0,4}\s+on\s+(?:(?:a|an|my|the|our)\s+)?(?:second |spare |old |new )?` + DEVICE + String.raw`\b`,
  ],
  searchTools: {
    names: ['WebSearch', 'WebFetch'],
    // MCP tools that visit or read a page, or search the web. A screenshot or a tab list does not count.
    namePatterns: [
      String.raw`^mcp__.+__(?:browser_)?(?:navigate|get_page_text|read_page|fetch|fetch_url|web_search|search_web|scrape)$`,
      String.raw`^mcp__(?:brave[-_]search|exa|tavily|perplexity|firecrawl|kagi)__`,
    ],
    bashPatterns: [String.raw`\bgh(?:\.exe"?)?\s+(?:search|api)\b`, String.raw`api\.github\.com`, String.raw`\b(?:curl|wget)\b[^\n]*https?://`],
    skillPatterns: ['research'],
    // A subagent brief that really sends it outside: "search the repo" or "web app" do not count.
    agentBriefPatterns: [String.raw`\bweb ?search\b|search (?:the web|online|github|reddit|forums|papers)|github\.com|arxiv`],
  },
};

export function stateDir(env = process.env) {
  return env.HEADLESS_KIT_STATE_DIR || path.join(os.homedir(), '.claude', 'headless-kit');
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Defaults overlaid by the user's config. Arrays replace the default arrays; searchTools merges per key. */
export function mergeConfig(user) {
  const u = isObj(user) ? user : {};
  const d = DEFAULT_CONFIG;
  const out = { ...d, ...u, searchTools: { ...d.searchTools, ...(isObj(u.searchTools) ? u.searchTools : {}) } };
  if (!['warn', 'feedback', 'block'].includes(out.mode)) out.mode = 'warn';
  return out;
}

/** Config path: DISMISSAL_WATCH_CONFIG, else <state dir>/dismissal-watch.json if it exists. A bad file means defaults. */
export function loadConfig(env = process.env) {
  const p = env.DISMISSAL_WATCH_CONFIG || path.join(stateDir(env), 'dismissal-watch.json');
  try { if (fs.existsSync(p)) return mergeConfig(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch { /* defaults */ }
  return mergeConfig(null);
}

const compile = (list, flags = 'i') => (Array.isArray(list) ? list : []).flatMap((s) => {
  try { return [new RegExp(s, flags)]; } catch { return []; }
});

/* ---------------------------------------------------------------- judging */

/** Quoted, backticked and fenced text is ABOUT a phrase, not saying it. */
export function stripQuoted(text) {
  return String(text || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
}

/** The part of a prompt a person typed: no code, no harness tags, no quotes. */
export function humanText(prompt) {
  return stripQuoted(String(prompt || '').replace(/<([a-z][\w-]*)[^<>]*>[\s\S]*?<\/\1>/gi, ' '));
}

export function isDismissal(reply, cfg) {
  let t = stripQuoted(reply);
  for (const r of compile(cfg.ignoreInReply, 'gi')) t = t.replace(r, ' ');
  return compile(cfg.dismissalPatterns).some((r) => r.test(t));
}

export function asksPossibility(prompt, cfg) {
  const t = humanText(prompt);
  return !!t.trim() && compile(cfg.possibilityPatterns).some((r) => r.test(t));
}

export function isSearch(block, cfg) {
  const st = cfg.searchTools || {};
  const name = String(block?.name || '');
  const input = isObj(block?.input) ? block.input : {};
  if ((st.names || []).includes(name)) return true;
  if (compile(st.namePatterns, '').some((r) => r.test(name))) return true;
  if (name === 'Skill' && compile(st.skillPatterns).some((r) => r.test(String(input.skill || '')))) return true;
  if (name === 'Bash' && compile(st.bashPatterns).some((r) => r.test(String(input.command || '')))) return true;
  if ((name === 'Agent' || name === 'Task') && compile(st.agentBriefPatterns).some((r) => r.test(String(input.prompt || '')))) return true;
  return false;
}

const NOT_A_PROMPT = /^\s*(?:<(?:system-reminder|task-notification|cross-session-message|scheduled-task|side-sessions-event|local-command|command-)|Stop hook feedback|\[Request interrupted)/;

function contentOf(entry) {
  const c = entry?.message?.content;
  return typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
}

/** The text of a real user prompt, or null for tool results, meta entries and harness messages. */
export function promptText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isCompactSummary) return null;
  const blocks = contentOf(entry);
  if (!blocks.length || blocks.some((b) => b?.type === 'tool_result')) return null;
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
  return text.trim() && !NOT_A_PROMPT.test(text) ? text : null;
}

/** Judges the turn after the last real prompt: { dismissed, searched, prompt, foundPrompt, reply }. */
export function judgeTurn(entries, cfg, lastAssistantMessage = null) {
  let start = 0;
  let prompt = '';
  let foundPrompt = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = promptText(entries[i]);
    if (t !== null) { start = i + 1; prompt = t; foundPrompt = true; break; }
  }
  let searched = false;
  let reply = '';
  for (const e of entries.slice(start)) {
    if (e?.type !== 'assistant') continue;
    const blocks = contentOf(e);
    if (blocks.some((b) => b?.type === 'tool_use' && isSearch(b, cfg))) searched = true;
    const t = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
    if (t.trim()) reply = t;
  }
  // The hook input's last_assistant_message is the authoritative final reply (the transcript can lag).
  if (typeof lastAssistantMessage === 'string' && lastAssistantMessage.trim()) reply = lastAssistantMessage;
  return { dismissed: isDismissal(reply, cfg), searched, prompt, foundPrompt, reply };
}

/* ---------------------------------------------------------------- transcript */

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line is normal mid-write */ }
  }
  return out;
}

/** Reads only the end of a JSONL transcript, doubling the window back (to `cap`) until a real prompt is inside it. */
export function readTranscriptTail(file, start = 1 << 20, cap = 16 << 20) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let want = start;
    for (;;) {
      const len = Math.min(want, size);
      const from = size - len;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, from + got);
        if (!n) break;
        got += n;
      }
      let text = buf.subarray(0, got).toString('utf8');
      if (from > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1); }
      const entries = parseLines(text);
      if (from === 0 || len >= cap || entries.some((e) => promptText(e) !== null)) return entries;
      want = Math.min(want * 2, cap);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------------------------------------------------------------- notes */

export function safeSid(v) {
  return typeof v === 'string' && /^[\w-]{1,80}$/.test(v) ? v : '';
}
const notesDir = (env) => path.join(stateDir(env), 'dismissal-watch');

function writeNote(sid, text, cfg, env) {
  const dir = notesDir(env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid), text.slice(0, 600) + '\n');
  const maxAge = (Number(cfg.noteMaxAgeDays) || 7) * 864e5;
  const now = Date.now();
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (now - fs.statSync(p).mtimeMs > maxAge) fs.unlinkSync(p); } catch { /* raced: leave it */ }
  }
}

/* ---------------------------------------------------------------- events */

export function onStop(input, cfg, env = process.env) {
  // A continuation a stop hook caused: the model may have searched since, and the user saw the warning once.
  if (input.stop_hook_active === true) return null;
  const tp = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (!tp || !fs.existsSync(tp) || !fs.statSync(tp).isFile()) return null;
  const j = judgeTurn(readTranscriptTail(tp), cfg, input.last_assistant_message);
  if (!j.dismissed || j.searched) return null;
  if (cfg.requirePossibilityPrompt && !(j.foundPrompt && asksPossibility(j.prompt, cfg))) return null;
  const msg = String(cfg.message || DEFAULT_CONFIG.message);
  if (cfg.mode === 'block') return { decision: 'block', reason: msg };
  if (cfg.mode === 'feedback') return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: msg } };
  const sid = safeSid(input.session_id);
  if (cfg.deliverOnNextPrompt && sid) {
    try { writeNote(sid, msg, cfg, env); } catch { /* the warning still shows */ }
  }
  return { systemMessage: msg };
}

export function onPrompt(input, cfg, env = process.env) {
  if (!cfg.deliverOnNextPrompt) return null;
  const sid = safeSid(input.session_id);
  if (!sid) return null;
  const f = path.join(notesDir(env), sid);
  let note = '';
  try {
    if (!fs.existsSync(f)) return null;
    note = fs.readFileSync(f, 'utf8').trim().slice(0, 600);
    fs.unlinkSync(f);
  } catch { return null; }
  return note ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } } : null;
}

export function handle(input, env = process.env) {
  if (!isObj(input)) return null;
  const cfg = loadConfig(env);
  if (input.hook_event_name === 'Stop') return onStop(input, cfg, env);
  if (input.hook_event_name === 'UserPromptSubmit') return onPrompt(input, cfg, env);
  return null;
}

const HELP = `dismissal-watch: a Claude Code hook (Stop, plus UserPromptSubmit to deliver its note).
Reads the hook input JSON on stdin and prints a hook answer on stdout (or nothing).
  node dismissal-watch.mjs --help           this text
  node dismissal-watch.mjs --print-config   the effective config as JSON
  node dismissal-watch.mjs --judge <file>   judge the last turn of a JSONL transcript; prints one JSON line
Env: DISMISSAL_WATCH_CONFIG (config path), HEADLESS_KIT_STATE_DIR (state folder, default ~/.claude/headless-kit).
Modes: warn (default, never makes the model continue) | feedback | block (opt-in). Always exits 0.`;

function isMain() {
  try { return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase(); } catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP + '\n'); process.exit(0); }
    if (argv.includes('--print-config')) { process.stdout.write(JSON.stringify(loadConfig()) + '\n'); process.exit(0); }
    const ji = argv.indexOf('--judge');
    if (ji >= 0) {
      const cfg = loadConfig();
      const j = judgeTurn(readTranscriptTail(argv[ji + 1]), cfg);
      const asks = asksPossibility(j.prompt, cfg);
      const warn = j.dismissed && !j.searched && (!cfg.requirePossibilityPrompt || (j.foundPrompt && asks));
      process.stdout.write(JSON.stringify({ dismissed: j.dismissed, searched: j.searched, asksPossibility: asks, warn }) + '\n');
      process.exit(0);
    }
    let raw = '';
    for await (const c of process.stdin) raw += c;
    const out = raw.trim() ? handle(JSON.parse(raw)) : null;
    if (out) process.stdout.write(JSON.stringify(out));
  } catch { /* fail open: no output */ }
  process.exit(0);
}
