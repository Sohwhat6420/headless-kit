#!/usr/bin/env node
/**
 * session-card-push.mjs: a PostToolUse / PostToolUseFailure hook that reminds the model to reach the user where they
 * can actually see it, after a tool produced something that only shows up in one client.
 *
 * The motivating case: in the Claude desktop app, a session-start tool can leave a proposal "card" for the user to
 * click, or be refused and wait for the user. Neither the card nor the refusal shows on every client (a phone
 * driving the session through remote control sees neither), so the user never learns that something waits on them.
 * This hook spots those results and injects one line: send a notification, and ask in chat with a question tool.
 *
 * Which tools, which results and what the line says all come from config rules (DEFAULT_CONFIG below is used
 * without one). The first rule that matches wins.
 *
 * Fails open: any error, missing file or unexpected input exits 0 with no output. It never blocks.
 * Zero dependencies, Node 18+.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = {
  enabled: true,
  // Filled into {notifyTool} and {askTool} in the messages. Set them to the tools your sessions have.
  notifyTool: 'PushNotification',
  askTool: 'AskUserQuestion',
  maxChars: 2000,
  rules: [
    {
      name: 'refused',
      tool: '^mcp__ccd_session__start_session$',
      // Any one of these: the call failed, or its result text matches.
      match: {
        failed: true,
        outputPattern: "Start sessions only on the user's own words|the app refuses|was refused|nothing from it was started",
      },
      message:
        '[session-card] Starting "{input.title|the session}" was refused, so it now waits on the user. Refusal notices ' +
        'do not show on every client (a phone using remote control, for one), so reach the user where they can see it: ' +
        '(1) send a notification naming it ({notifyTool}, if this session has it); (2) ask in chat with {askTool}. ' +
        'A refused start usually needs a turn the user began: if a background task or another session began this ' +
        'turn, ask the user for a one-word reply rather than answering inside this turn.',
    },
    {
      name: 'card',
      tool: '^mcp__ccd_session__start_session$',
      match: { input: { initiation: ['offer', 'own_initiative'] } },
      message:
        '[session-card] "{input.title|the session}" is now a proposal card waiting for the user\'s click. Cards do not ' +
        'show on every client (a phone using remote control, for one), so: (1) send a notification naming it ' +
        '({notifyTool}, if this session has it); (2) ask in chat with {askTool} whether to start it.',
    },
  ],
};

export function configPath(env = process.env) {
  if (env.HEADLESS_KIT_SESSION_CARD_CONFIG) return env.HEADLESS_KIT_SESSION_CARD_CONFIG;
  const dir = env.HEADLESS_KIT_STATE_DIR || path.join(os.homedir(), '.claude', 'headless-kit');
  return path.join(dir, 'session-card-push.config.json');
}

/** Top-level keys override the defaults; a `rules` array replaces the default rules entirely. */
export function loadConfig(file) {
  try {
    if (!file || !fs.existsSync(file)) return DEFAULT_CONFIG;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...j, rules: Array.isArray(j.rules) ? j.rules : DEFAULT_CONFIG.rules };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function regex(src) {
  try { return src ? new RegExp(String(src), 'i') : null; } catch { return null; }
}

function resultText(input) {
  if (input.hook_event_name === 'PostToolUseFailure') return String(input.error ?? '');
  const r = input.tool_response;
  return typeof r === 'string' ? r : JSON.stringify(r ?? '');
}

/** Does the rule match? Conditions inside `match` are alternatives (any one is enough); fields inside
    `match.input` must all hold (each value equals one of the listed values). */
export function matches(rule, input) {
  if (!rule || typeof rule !== 'object') return false;
  const toolRe = regex(rule.tool);
  if (!toolRe || !toolRe.test(String(input.tool_name || ''))) return false;
  const m = rule.match || {};
  const failed = input.hook_event_name === 'PostToolUseFailure';
  if (m.failed === true && failed) return true;
  const outRe = regex(m.outputPattern);
  if (outRe && outRe.test(resultText(input))) return true;
  if (m.input && typeof m.input === 'object') {
    const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    const entries = Object.entries(m.input);
    if (entries.length && entries.every(([k, want]) => (Array.isArray(want) ? want : [want]).map(String).includes(String(ti[k])))) return true;
  }
  return false;
}

/** {name}, {input.field} and {input.field|fallback}. Values from the tool call are trimmed and capped. */
export function render(template, input, cfg) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  return String(template || '').replace(/\{([\w.]+)(?:\|([^}]*))?\}/g, (whole, key, fallback) => {
    let v;
    if (key.startsWith('input.')) v = ti[key.slice(6)];
    else if (key === 'tool') v = input.tool_name;
    else if (key === 'notifyTool' || key === 'askTool') v = cfg[key];
    if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return fallback !== undefined ? fallback : whole;
  });
}

/** Returns the hook's stdout object, or null for silence. */
export function decide(input, cfg = DEFAULT_CONFIG) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || cfg.enabled === false) return null;
  const event = input.hook_event_name;
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return null;
  for (const rule of Array.isArray(cfg.rules) ? cfg.rules : []) {
    if (!matches(rule, input)) continue;
    const line = render(rule.message, input, cfg).slice(0, Number(cfg.maxChars) || 2000);
    if (!line.trim()) return null;
    return { hookSpecificOutput: { hookEventName: event, additionalContext: line } };
  }
  return null;
}

const HELP = `session-card-push: a Claude Code PostToolUse / PostToolUseFailure hook.

  node session-card-push.mjs < hook-input.json

Register it on the tools named in your rules (default: mcp__ccd_session__start_session).
When a rule matches, it prints {"hookSpecificOutput": {"hookEventName": ..., "additionalContext": "<reminder>"}};
otherwise nothing. Always exits 0.
Config: $HEADLESS_KIT_SESSION_CARD_CONFIG, or $HEADLESS_KIT_STATE_DIR/session-card-push.config.json
(default state folder ~/.claude/headless-kit).`;

const isMain = (() => { try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

if (isMain) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(HELP + '\n');
  } else {
    setTimeout(() => process.exit(0), 1000).unref();
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
      try {
        const res = raw.trim() ? decide(JSON.parse(raw), loadConfig(configPath())) : null;
        if (res) process.stdout.write(JSON.stringify(res), () => process.exit(0));
        else process.exit(0);
      } catch { process.exit(0); }
    });
    process.stdin.on('error', () => process.exit(0));
  }
}
