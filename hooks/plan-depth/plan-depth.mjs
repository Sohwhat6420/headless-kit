#!/usr/bin/env node
/**
 * plan-depth.mjs: a Claude Code hook that holds plans to a written standard. One script, two events:
 *
 *   UserPromptSubmit  in plan mode, on a human prompt, injects the plan standard as context (the full list once per
 *                     session, then one short line).
 *   PreToolUse        on ExitPlanMode, checks the plan for the required sections and warns about each gap, plus an
 *                     optional "hand execution over to a fresh session" check (compactions and context size).
 *
 * The standard (section headings, regexes, thresholds) comes from a JSON config; DEFAULT_CONFIG below is used when
 * there is none. WARNS ONLY by default. It never outputs permissionDecision "allow": on ExitPlanMode that would skip
 * the user's own plan approval. The opt-in `gate.onGaps: "deny"` refuses ExitPlanMode until the gaps are fixed.
 *
 * Fails open: any error, missing file or unexpected input exits 0 with no output.
 * Zero dependencies, Node 18+.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------------------------------------------------------------- config */

export const DEFAULT_CONFIG = {
  thresholds: {
    // The standard applies to a plan with at least this many non-standard headings (## to ####) OR this many lines.
    minHeadings: 3,
    minLines: 60,
    // A "big" plan: more than bigStages stages (### headings outside the standard sections) or more than bigLines lines.
    bigStages: 10,
    bigLines: 800,
  },
  reminder: {
    enabled: true,
    fullOncePerSession: true,
    requirePromptId: false,
  },
  gate: {
    enabled: true,
    onGaps: 'warn', // "warn" | "deny" (opt-in: refuses ExitPlanMode until fixed)
    maxDenialsPerSession: 2, // with "deny": after this many refusals in one session it falls back to warning
    systemMessageMax: 600,
  },
  handover: {
    enabled: true,
    minCompactions: 3, // 0 drops this condition
    minContextTokens: 160000, // 0 drops this condition
    skipIfFirstPromptMatches: null, // regex source: a session that was itself started as a hand-over is skipped
    message: 'Consider handing execution to a fresh session after approval',
  },
  disabledSections: [],
  sections: [
    {
      id: 'how', title: 'How', kind: 'perFeature', appliesTo: 'standard',
      hint: 'numbered build steps under every feature (files, the code reused with path:line, commands, formats)',
      featureLevel: 3,
      stepPattern: String.raw`^\s*\d+\.\s|\*\*[^*\n]*How[^*\n]*\*\*|How\s*:`,
    },
    {
      id: 'verification', title: 'Verification log', heading: 'Verification log', appliesTo: 'standard',
      hint: 'every claim the plan depends on, marked confirmed, refuted or unclear, with evidence (a URL, a path:line or a probe)',
      minEntries: {
        count: 5,
        mustMatch: [String.raw`\b(confirmed|refuted|unclear)\b`, String.raw`https?://|[\w./\\-]+\.\w+:\d+|\bprobe\b`],
        describe: 'have a verdict plus evidence (URL, path:line or probe)',
      },
    },
    {
      id: 'unknowns', title: 'Unknowns -> tests', heading: String.raw`Unknowns\s*(?:→|->|to)\s*tests`, appliesTo: 'standard',
      hint: 'every unknown becomes a scheduled test with a pass threshold',
    },
    {
      id: 'questions', title: 'Questions log', heading: 'Questions log', appliesTo: 'standard',
      satisfiedBy: 'no open decisions',
      hint: 'the decision-maker\'s answers word for word, or a "no open decisions" line',
    },
    {
      id: 'review', title: 'Independent review', kind: 'line', appliesTo: 'standard',
      pattern: String.raw`^\s*\**Reviewed-by:`,
      missing: 'a "Reviewed-by:" line',
      hint: 'a fresh reviewer checks the plan before it is presented; record it in a "Reviewed-by:" line',
    },
    {
      id: 'dispatch', title: 'Dispatch plan', heading: 'Dispatch plan', appliesTo: 'standard',
      hint: 'a table: each stage, who does it, where it runs, a reason for every manual row; and a load line per phase',
      table: { minRows: 1, requiredColumns: [1, 2], reasonColumn: 'why|reason', reasonWhen: 'manual|by hand|main session' },
      mustMention: [{ name: 'load line per phase', pattern: String.raw`load (line|per phase)|per-phase load` }],
    },
    {
      id: 'prior', title: 'Prior art', heading: 'Prior art', appliesTo: 'standard',
      hint: 'what already exists (docs, packages, GitHub) and what is reused or rejected, and why',
      minSources: { count: 3, escape: String.raw`searched .{0,200}nothing relevant` },
    },
    {
      id: 'coverage', title: 'Coverage checklist', heading: 'Coverage checklist', appliesTo: 'standard',
      hint: 'safety, privacy, security, portability, failure modes, rollback, cost, host impact, observability, tests, manual steps, records, clean-up, follow-ups: each covered or N/A with a reason',
      mustMention: [
        { name: 'safety', pattern: 'safety|hard line' },
        { name: 'privacy', pattern: 'privacy|personal data|client data' },
        { name: 'security', pattern: 'security|trust' },
        { name: 'portability', pattern: 'portab' },
        { name: 'failure modes', pattern: 'failure|edge case' },
        { name: 'rollback', pattern: 'rollback|undo' },
        { name: 'cost', pattern: 'cost|budget' },
        { name: 'host impact', pattern: String.raw`host|RAM|memory|disk|CPU` },
        { name: 'observability', pattern: 'observab|logging|metrics' },
        { name: 'tests', pattern: String.raw`\btests?\b` },
        { name: 'manual steps', pattern: String.raw`manual|hands-on|by hand` },
        { name: 'records', pattern: String.raw`records|docs|documentation|changelog` },
        { name: 'clean-up', pattern: 'clean-?up' },
        { name: 'follow-ups', pattern: 'follow-?up|staged|later' },
      ],
    },
    {
      id: 'succession', title: 'Context and succession', heading: 'Context and succession', appliesTo: 'big',
      hint: 'the measured context baseline of a fresh session, a rough context cost per stage, the named hand-over points, and where each stage runs (this session, a successor session, a subagent)',
      mustMention: [
        { name: 'measured context baseline (a number + tokens or k)', pattern: String.raw`\d[\d,.]*\s*(?:k\b|tokens?\b)` },
        { name: 'named hand-over points', pattern: String.raw`\bhand[\s-]*(?:over|off)\b` },
        { name: 'where each stage runs (this session, a successor, a subagent)', pattern: String.raw`\b(?:successor|subagent|this session|lane|worker)\b` },
      ],
    },
  ],
};

export function stateDir(env = process.env) {
  return env.HEADLESS_KIT_STATE_DIR || path.join(os.homedir(), '.claude', 'headless-kit');
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Defaults, overlaid by the user's config. `sections`, when given, replaces the default list whole. */
export function mergeConfig(user) {
  const d = DEFAULT_CONFIG;
  const u = isObj(user) ? user : {};
  const pick = (k) => ({ ...d[k], ...(isObj(u[k]) ? u[k] : {}) });
  const disabled = new Set(Array.isArray(u.disabledSections) ? u.disabledSections : []);
  const sections = (Array.isArray(u.sections) ? u.sections : d.sections).filter((s) => isObj(s) && s.id && !disabled.has(s.id));
  return { thresholds: pick('thresholds'), reminder: pick('reminder'), gate: pick('gate'), handover: pick('handover'), sections };
}

/** Config path: PLAN_DEPTH_CONFIG, else <state dir>/plan-depth.json if it exists. A bad file falls back to defaults. */
export function loadConfig(env = process.env) {
  const p = env.PLAN_DEPTH_CONFIG || path.join(stateDir(env), 'plan-depth.json');
  try {
    if (fs.existsSync(p)) return mergeConfig(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch { /* unreadable config: defaults */ }
  return mergeConfig(null);
}

const re = (src, flags = 'i') => {
  try { return src ? new RegExp(src, flags) : null; } catch { return null; }
};

/* ---------------------------------------------------------------- reminder */

export function reminderText(cfg) {
  const t = cfg.thresholds;
  const std = cfg.sections.filter((s) => s.appliesTo !== 'big');
  const big = cfg.sections.filter((s) => s.appliesTo === 'big');
  const lines = [`[plan-depth] Plan mode: a plan with ${t.minHeadings}+ tasks or features needs:`];
  std.forEach((s, i) => lines.push(`${i + 1} ${s.title}: ${s.hint || ''}`.trim()));
  if (big.length) {
    lines.push(`A big plan (more than ${t.bigStages} stages or ${t.bigLines} lines) also needs:`);
    big.forEach((s, i) => lines.push(`${std.length + i + 1} ${s.title}: ${s.hint || ''}`.trim()));
  }
  return lines.join('\n');
}

export function shortReminderText(cfg) {
  const std = cfg.sections.filter((s) => s.appliesTo !== 'big').map((s) => s.title);
  const big = cfg.sections.filter((s) => s.appliesTo === 'big').map((s) => s.title);
  return `[plan-depth] The plan standard applies: ${std.join(', ')}${big.length ? ` (+ ${big.join(', ')} for a big plan)` : ''}.`;
}

// Prompts that are not a person typing: harness notifications, scheduled tasks, slash-command plumbing.
const NOT_HUMAN = /^\s*(?:<(?:task-notification|cross-session-message|scheduled-task|side-sessions-event|system-reminder|local-command|command-)|\[Request interrupted)/i;
const LIMIT_CONTINUE = /\b(?:usage|session|rate) limit\b/i;

export function humanText(prompt) {
  return String(prompt || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<([a-z][\w-]*)[^<>]*>[\s\S]*?<\/\1>/gi, ' ')
    .trim();
}

export function onPrompt(input, cfg, env = process.env) {
  if (!cfg.reminder.enabled || input.permission_mode !== 'plan') return null;
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (cfg.reminder.requirePromptId && !input.prompt_id) return null;
  if (NOT_HUMAN.test(prompt) || LIMIT_CONTINUE.test(prompt) || !humanText(prompt)) return null;
  let text = reminderText(cfg);
  const sid = safeSid(input.session_id);
  if (cfg.reminder.fullOncePerSession && sid) {
    const dir = path.join(stateDir(env), 'plan-depth');
    const mark = path.join(dir, `shown-${sid}`);
    try {
      if (fs.existsSync(mark)) text = shortReminderText(cfg);
      else { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(mark, ''); }
    } catch { /* state is a nicety: on any error, show the full list */ }
  }
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
}

/* ---------------------------------------------------------------- markdown helpers */

export function parseHeadings(lines) {
  const hs = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const m = l.match(/^(#{1,6})\s+(.*)$/);
    if (m) hs.push({ level: m[1].length, title: m[2].trim(), line: i });
  });
  hs.forEach((h, k) => {
    let end = lines.length;
    for (let j = k + 1; j < hs.length; j++) if (hs[j].level <= h.level) { end = hs[j].line; break; }
    h.end = end;
  });
  return hs;
}

export function tables(bodyLines) {
  const out = [];
  let cur = null;
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  for (const l of bodyLines) {
    if (/^\s*\|/.test(l)) (cur ||= []).push(cells(l));
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  const isSep = (r) => r.every((c) => /^:?-{2,}:?$/.test(c) || c === '');
  return out.map((rows) => (rows.length >= 2 && isSep(rows[1])
    ? { header: rows[0], rows: rows.slice(2) }
    : { header: null, rows: rows.filter((r) => !isSep(r)) }));
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s/;

/* ---------------------------------------------------------------- plan checks */

/** Returns a list of human-readable gaps (empty when the plan meets the configured standard). */
export function planGaps(plan, cfg) {
  const lines = String(plan).split(/\r?\n/);
  const hs = parseHeadings(lines);
  const bodyOf = (h) => lines.slice(h.line + 1, h.end);
  const headingRe = (src) => re(String.raw`^#{2,4}\s*(\d+(\.\d+)*\.?\s*)?(?:${src})`);
  const find = (src) => {
    const r = headingRe(src);
    return r ? hs.find((h) => h.level >= 2 && h.level <= 4 && r.test(lines[h.line])) : undefined;
  };
  const headed = cfg.sections.filter((s) => s.heading && (s.kind || 'section') === 'section');
  const found = new Map(headed.map((s) => [s.id, find(s.heading)]));

  // Ranges inside any configured section: their sub-headings are not features or stages.
  const ranges = [...found.values()].filter(Boolean).map((h) => [h.line, h.end]);
  const inSection = (h) => ranges.some(([a, b]) => h.line >= a && h.line < b);
  const anySectionTitle = re(headed.map((s) => `(?:${s.heading})`).join('|') || '(?!)');
  const mainHeads = hs.filter((h) => h.level >= 2 && h.level <= 4 && !inSection(h) && !anySectionTitle.test(h.title));

  const t = cfg.thresholds;
  const standardApplies = lines.length >= t.minLines || mainHeads.length >= t.minHeadings;
  const stageCount = hs.filter((h) => h.level === 3 && !inSection(h)).length;
  const isBig = stageCount > t.bigStages || lines.length > t.bigLines;

  const gaps = [];
  for (const s of cfg.sections) {
    const applies = s.appliesTo === 'big' ? isBig : standardApplies;
    if (!applies) continue;
    const kind = s.kind || 'section';
    if (kind === 'line') {
      const r = re(s.pattern, 'im');
      if (r && !r.test(plan)) gaps.push(`${s.title} (${s.missing || `a line matching /${s.pattern}/`})`);
      continue;
    }
    if (kind === 'perFeature') {
      const level = s.featureLevel || 3;
      const step = re(s.stepPattern) || /^\s*\d+\.\s/;
      const failing = mainHeads.filter((h) => h.level === level && !bodyOf(h).some((l) => step.test(l))).map((h) => h.title);
      if (failing.length) {
        gaps.push(`${s.title} (numbered build steps) for: ${failing.slice(0, 8).join('; ')}${failing.length > 8 ? ` (+${failing.length - 8} more)` : ''}`);
      }
      continue;
    }
    const h = found.get(s.id);
    if (!h) {
      const alt = re(s.satisfiedBy);
      if (!(alt && alt.test(plan))) gaps.push(`${s.title} section${s.satisfiedBy ? ` (or a "${s.satisfiedBy}" line)` : ''}`);
      continue;
    }
    const body = bodyOf(h);
    const text = body.join('\n');
    const tbls = tables(body);
    if (s.minEntries) {
      const musts = (s.minEntries.mustMatch || []).map((x) => re(x)).filter(Boolean);
      const entries = [...tbls.flatMap((tb) => tb.rows).map((r) => r.join(' | ')), ...body.filter((l) => LIST_ITEM.test(l))];
      const ok = entries.filter((e) => musts.every((m) => m.test(e))).length;
      const need = s.minEntries.count || 1;
      if (ok < need) gaps.push(`${s.title}: only ${ok} of ${need} entries ${s.minEntries.describe || 'match the required patterns'}`);
    }
    if (s.minSources) {
      const esc = re(s.minSources.escape);
      if (!(esc && esc.test(text))) {
        const urls = (text.match(/https?:\/\/[^\s)>\]|]+/g) || []).length;
        const rows = tbls.flatMap((tb) => tb.rows).length;
        const items = body.filter((l) => LIST_ITEM.test(l)).length;
        const n = Math.max(urls, rows, items);
        const need = s.minSources.count || 1;
        if (n < need) gaps.push(`${s.title}: ${n} sources, need >= ${need}${s.minSources.escape ? ' (or a "searched ...: nothing relevant" line)' : ''}`);
      }
    }
    if (s.table) {
      const tb = tbls[0];
      const minRows = s.table.minRows || 1;
      if (!tb || tb.rows.length < minRows) gaps.push(`${s.title}: no table with at least ${minRows} data row${minRows === 1 ? '' : 's'}`);
      else {
        const cols = s.table.requiredColumns || [];
        const bad = tb.rows.filter((r) => cols.some((c) => !(r[c] || '').trim())).map((r) => r[0] || '?');
        if (bad.length) gaps.push(`${s.title}: rows with an empty required column: ${bad.join(', ')}`);
        const when = re(s.table.reasonWhen);
        const rcol = re(s.table.reasonColumn);
        if (when && rcol) {
          const ri = tb.header ? tb.header.findIndex((c) => rcol.test(c)) : -1;
          const noWhy = tb.rows.filter((r) => r.some((c, i) => i > 0 && when.test(c)) && (ri < 0 || !(r[ri] || '').trim())).map((r) => r[0] || '?');
          if (noWhy.length) gaps.push(`${s.title}: rows needing a reason have none: ${noWhy.join(', ')}`);
        }
      }
    }
    if (Array.isArray(s.mustMention)) {
      const missing = s.mustMention.filter((m) => { const r = re(m.pattern); return r && !r.test(text); }).map((m) => m.name);
      if (missing.length) gaps.push(`${s.title} missing: ${missing.join('; ')}`);
    }
  }
  return gaps;
}

/* ---------------------------------------------------------------- hand-over check */

/** Counts compactions in a transcript without parsing it whole (chunked scan), and reads the latest context size
 *  from the last assistant entry's usage in the tail. Returns { compactions, contextTokens, firstPrompt }. */
export function transcriptStats(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const CH = 1 << 20;
    const marker = /"subtype":\s*"compact_boundary"/g;
    let compactions = 0;
    let carry = '';
    let head = '';
    const buf = Buffer.alloc(CH);
    for (let pos = 0; pos < size; pos += CH) {
      const n = fs.readSync(fd, buf, 0, Math.min(CH, size - pos), pos);
      const s = carry + buf.subarray(0, n).toString('latin1');
      if (!head) head = s.slice(0, 256 * 1024);
      // A short overlap catches a marker split across chunks; a match lying wholly inside the overlap was
      // already counted in the previous chunk.
      for (const m of s.matchAll(marker)) if (m.index + m[0].length > carry.length) compactions++;
      carry = s.slice(-64);
    }
    // last assistant usage, from the last 2 MB
    const len = Math.min(size, 2 << 20);
    const tb = Buffer.alloc(len);
    fs.readSync(fd, tb, 0, len, size - len);
    let contextTokens = null;
    const tailLines = tb.toString('utf8').split('\n');
    for (let i = tailLines.length - 1; i >= 0 && contextTokens === null; i--) {
      if (!tailLines[i].includes('"usage"')) continue;
      try {
        const o = JSON.parse(tailLines[i]);
        const u = o?.type === 'assistant' ? o.message?.usage : null;
        if (u) contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      } catch { /* a torn line */ }
    }
    let firstPrompt = '';
    for (const l of head.split('\n')) {
      if (!l.includes('"type":"user"')) continue;
      try {
        const o = JSON.parse(Buffer.from(l, 'latin1').toString('utf8'));
        const c = o.message?.content;
        firstPrompt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
        if (firstPrompt) break;
      } catch { /* skip */ }
    }
    return { compactions, contextTokens, firstPrompt };
  } finally {
    fs.closeSync(fd);
  }
}

export function handoverGap(input, cfg, env = process.env) {
  const h = cfg.handover;
  if (!h.enabled) return null;
  const tp = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  const sid = safeSid(input.session_id);
  if (!tp || !sid || !fs.existsSync(tp) || !fs.statSync(tp).isFile()) return null;
  if (!(h.minCompactions > 0) && !(h.minContextTokens > 0)) return null;
  const st = transcriptStats(tp);
  const skip = re(h.skipIfFirstPromptMatches);
  if (skip && skip.test(st.firstPrompt)) return null;
  if (h.minCompactions > 0 && st.compactions < h.minCompactions) return null;
  if (h.minContextTokens > 0 && !(st.contextTokens > h.minContextTokens)) return null;
  const dir = path.join(stateDir(env), 'plan-depth');
  const mark = path.join(dir, `handover-${sid}`);
  if (fs.existsSync(mark)) return null;
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(mark, new Date().toISOString()); } catch { /* still warn */ }
  const parts = [`${st.compactions} compaction${st.compactions === 1 ? '' : 's'}`];
  if (st.contextTokens !== null) parts.push(`${Math.round(st.contextTokens / 1000)}k tokens of context`);
  return `${h.message} (${parts.join(', ')}).`;
}

/* ---------------------------------------------------------------- gate */

export function onExitPlan(input, cfg, env = process.env) {
  if (!cfg.gate.enabled) return null;
  const ti = isObj(input.tool_input) ? input.tool_input : {};
  let plan = null;
  if (typeof ti.plan === 'string' && ti.plan.trim()) plan = ti.plan;
  else if (typeof ti.planFilePath === 'string' && fs.existsSync(ti.planFilePath)) plan = fs.readFileSync(ti.planFilePath, 'utf8');
  if (plan === null) return null;

  const gaps = planGaps(plan, cfg);
  let handover = null;
  try { handover = handoverGap(input, cfg, env); } catch { handover = null; }
  if (handover) gaps.push(handover);
  if (!gaps.length) return null;

  const max = cfg.gate.systemMessageMax || 600;
  let sm = `Plan-depth: ${gaps.length} gap${gaps.length === 1 ? '' : 's'}: ${gaps.join('; ')}`;
  if (sm.length > max) sm = sm.slice(0, max - 3) + '...';
  const list = gaps.map((g) => '- ' + g).join('\n');

  if (cfg.gate.onGaps === 'deny' && denialsLeft(input, cfg, env)) {
    const reason = `[plan-depth] The plan is missing:\n${list}\nFix these (or say in the plan why each does not apply), then call ExitPlanMode again.`;
    return { systemMessage: sm, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  }
  const ctx = `[plan-depth] The plan is missing:\n${list}\nFix these or say why each doesn't apply, then present again. (Warn only; nothing is blocked.)`;
  return { systemMessage: sm, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx } };
}

function denialsLeft(input, cfg, env) {
  const max = Number(cfg.gate.maxDenialsPerSession) || 0;
  if (max <= 0) return false; // 0: never refuse
  const sid = safeSid(input.session_id);
  if (!sid) return false; // cannot count refusals without a session id, so warn instead of risking a loop
  const dir = path.join(stateDir(env), 'plan-depth');
  const f = path.join(dir, `denials-${sid}`);
  let n = 0;
  try { n = Number(fs.readFileSync(f, 'utf8')) || 0; } catch { n = 0; }
  if (n >= max) return false;
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, String(n + 1)); } catch { /* deny anyway */ }
  return true;
}

/* ---------------------------------------------------------------- main */

export function safeSid(v) {
  return typeof v === 'string' && /^[\w-]{1,80}$/.test(v) ? v : '';
}

export function handle(input, env = process.env) {
  if (!isObj(input)) return null;
  const cfg = loadConfig(env);
  const ev = input.hook_event_name;
  if (ev === 'UserPromptSubmit') return onPrompt(input, cfg, env);
  if (ev === 'PreToolUse' && input.tool_name === 'ExitPlanMode') return onExitPlan(input, cfg, env);
  return null;
}

const HELP = `plan-depth: a Claude Code hook (UserPromptSubmit + PreToolUse on ExitPlanMode).
Reads the hook input JSON on stdin and prints a hook answer on stdout (or nothing).
  node plan-depth.mjs --help            this text
  node plan-depth.mjs --print-config    the effective config as JSON
  node plan-depth.mjs --check <plan.md> check a plan file; prints {"gaps":[...]} (exit 0)
Env: PLAN_DEPTH_CONFIG (config path), HEADLESS_KIT_STATE_DIR (state folder, default ~/.claude/headless-kit).
Always exits 0. Never outputs permissionDecision "allow".`;

function isMain() {
  try { return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase(); } catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP + '\n'); process.exit(0); }
    if (argv.includes('--print-config')) { process.stdout.write(JSON.stringify(loadConfig()) + '\n'); process.exit(0); }
    const ci = argv.indexOf('--check');
    if (ci >= 0) {
      const gaps = planGaps(fs.readFileSync(argv[ci + 1], 'utf8'), loadConfig());
      process.stdout.write(JSON.stringify({ gaps }) + '\n');
      process.exit(0);
    }
    let raw = '';
    for await (const c of process.stdin) raw += c;
    const out = raw.trim() ? handle(JSON.parse(raw)) : null;
    if (out) process.stdout.write(JSON.stringify(out));
  } catch { /* fail open: no output */ }
  process.exit(0);
}
