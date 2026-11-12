#!/usr/bin/env node
// mail-reply: token-free in-thread acknowledgement for an inbox. Every message from an allowed sender gets one
// reply in the same thread, from a fixed template, within one poll interval. No model reads or writes anything.
//
//   node mail-reply.mjs --config mail-reply.json            one pass, DRY RUN: says what it would reply
//   node mail-reply.mjs --config mail-reply.json --send     one pass, really replies
//   node mail-reply.mjs --config mail-reply.json --send --every 120    a pass every 2 minutes (one JSON line each)
//
// Transports: IMAP + SMTP (any mailbox; lib/imap.mjs, lib/smtp.mjs) or Composio (a Gmail account connected
// there; lib/composio.mjs). Exit codes: 0 ok, 1 mail or file error, 2 bad usage or config, 4 another pass holds the lock.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openImap, listRecent, markSeen, quote } from './lib/imap.mjs';
import { sendMail, buildReply } from './lib/smtp.mjs';
import { composioClient, composioTransport } from './lib/composio.mjs';

export const VERSION = '0.1.0';
export const DEFAULT_TEMPLATE = {
  headline: 'Got it: your message is in the queue',
  lines: [
    { lead: 'What happens next', text: 'It is read and dealt with in order.' },
    { lead: "You'll hear back", text: 'Here in this thread.' },
    { lead: 'Your email', text: '“{subject}”, received {received}' },
  ],
  footer: 'Automatic acknowledgement, {date} {time} {zone} · no AI model read your message',
};

const HELP = `mail-reply ${VERSION}: same-thread acknowledgement from a template, token-free (no model calls).

  node mail-reply.mjs --config FILE [--send] [--every SEC] [--seed] [--state FILE]

  --config FILE   JSON config (env MAIL_REPLY_CONFIG); see examples/mail-reply.example.json
  --send          really send replies (without it: a dry run that reports what it would send)
  --every SEC     keep going: one pass every SEC seconds (minimum 30); one JSON line per pass
  --seed          record every message now due as handled, without replying (start on a busy inbox)
  --state FILE    the ledger of answered messages (env MAIL_REPLY_STATE)
  --help          this text

Environment overrides: MAIL_REPLY_ALLOW (comma list), MAIL_REPLY_PASSWORD_FILE, MAIL_REPLY_COMPOSIO_KEY_FILE.`;

export class UsageError extends Error {}

// ---------------------------------------------------------------------------------------------- pure core

/** "Name <a@b.c>" -> "a@b.c" (lowercase). */
export function addressOf(from) {
  const m = String(from || '').match(/<([^<>\s]+@[^<>\s]+)>/);
  return (m ? m[1] : String(from || '').trim().split(/\s+/).find((w) => w.includes('@')) || '').replace(/^mailto:/i, '').toLowerCase();
}

/** Allow-list entries: an exact address, or "@domain" for every address at exactly that domain. */
export function makeAllow(list) {
  const exact = new Set(); const domains = new Set();
  for (const raw of list || []) {
    const e = String(raw).trim().toLowerCase();
    if (!e) continue;
    if (e.startsWith('@')) { if (!/^@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) throw new UsageError(`bad allow entry ${raw}`); domains.add(e.slice(1)); }
    else { if (!/^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) throw new UsageError(`bad allow entry ${raw}`); exact.add(e); }
  }
  if (!exact.size && !domains.size) throw new UsageError('allow must list at least one sender');
  return (addr) => exact.has(addr) || domains.has(addr.split('@')[1] || '');
}

/**
 * Sender authentication from the TOPMOST Authentication-Results header only (your own server adds it first; a
 * sender can forge lower ones). Pass = dmarc=pass, or spf=pass and dkim=pass. With authServId, the header must be
 * that server's.
 */
export function authPassed(authResults = [], authServId = null) {
  const top = String(authResults[0] || '');
  if (!top) return false;
  if (authServId && !top.toLowerCase().startsWith(String(authServId).toLowerCase())) return false;
  return /\bdmarc=pass\b/i.test(top) || (/\bspf=pass\b/i.test(top) && /\bdkim=pass\b/i.test(top));
}

/** Should this message get the acknowledgement? Returns {reply: true, to} or {reply: false, reason}. */
export function decide(msg, { allowed, self = [], ledger, nowMs, maxAgeMin, requireAuth, authKnown, authServId }) {
  if (ledger[msg.id]) return { reply: false, reason: 'already' };
  const to = addressOf(msg.from);
  if (!to || !allowed(to)) return { reply: false, reason: 'not-allowed' };
  if (self.includes(to)) return { reply: false, reason: 'self' };
  const h = msg.headers || {};
  if (h.autoSubmitted && !/^no\b/i.test(h.autoSubmitted)) return { reply: false, reason: 'auto-submitted' };
  if (h.listId || /^(bulk|list|junk)\b/i.test(h.precedence || '')) return { reply: false, reason: 'list-mail' };
  const t = Date.parse(msg.receivedAt || '');
  if (!Number.isFinite(t)) return { reply: false, reason: 'no-date' };
  if (t > nowMs + 5 * 60_000) return { reply: false, reason: 'future' };
  if (nowMs - t > maxAgeMin * 60_000) return { reply: false, reason: 'too-old' };
  if (!msg.threadId) return { reply: false, reason: 'no-thread' };
  if (requireAuth && authKnown && !authPassed(h.authResults, authServId)) return { reply: false, reason: 'unauthenticated' };
  return { reply: true, to };
}

const oneLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const at = (ms, tzOffsetH) => new Date(ms + tzOffsetH * 3_600_000).toISOString();

/**
 * Fill {date} {time} {zone} {received} {subject} {sender} in one string. Mail fields are one line, capped; nothing
 * else is interpreted. {received} is the incoming message's local time ("" when unknown).
 */
export function render(template, { nowMs, tzOffsetH = 0, subject = '', sender = '', receivedMs = NaN }) {
  const d = at(nowMs, tzOffsetH);
  const zone = tzOffsetH ? `UTC${tzOffsetH > 0 ? '+' : ''}${tzOffsetH}` : 'UTC';
  const received = Number.isFinite(receivedMs) ? `${at(receivedMs, tzOffsetH).slice(0, 16).replace('T', ' ')} ${zone}` : '';
  const vars = { date: d.slice(0, 10), time: d.slice(11, 16), zone, received, subject: oneLine(subject, 120) || '(no subject)', sender: oneLine(sender, 120) };
  return String(template).replace(/\{(date|time|zone|received|subject|sender)\}/g, (m, k) => vars[k]).slice(0, 4000);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A template is either a string (plain text only) or {headline, lines: [{lead, text}] (at most 3), footer}: a bold
 * headline, short lines with a bold lead word, and small grey footer text. Returns {text, html|null}. The HTML uses
 * inline styles only, no tables and no images, so it reads the same on a phone; every value is escaped.
 */
export function renderReply(template, vars) {
  if (typeof template === 'string') return { text: render(template, vars), html: null };
  const r = (s) => render(s || '', vars);
  const head = r(template.headline);
  const lines = (template.lines || []).slice(0, 3).map((l) => [r(l.lead), r(l.text)]);
  const foot = r(template.footer);
  const text = [head, '', ...lines.map(([k, v]) => (k ? `${k}: ${v}` : v)), ...(foot ? ['', `-- ${foot}`] : [])].join('\n');
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const html = [
    `<div style="${font};font-size:16px;line-height:1.5;color:#1f2328;max-width:560px">`,
    `<p style="margin:0 0 14px;font-size:18px;line-height:1.35"><strong>${esc(head)}</strong></p>`,
    ...lines.map(([k, v]) => `<p style="margin:0 0 8px">${k ? `<strong>${esc(k)}:</strong> ` : ''}${esc(v)}</p>`),
    ...(foot ? [`<p style="margin:18px 0 0;font-size:12px;line-height:1.4;color:#8b949e">${esc(foot)}</p>`] : []),
    '</div>',
  ].join('\n');
  return { text, html };
}

export function checkTemplate(t) {
  if (typeof t === 'string') { if (!t.trim()) throw new UsageError('template is empty'); return t; }
  if (!t || typeof t !== 'object' || !t.headline) throw new UsageError('template needs a headline (or be a string)');
  if (!Array.isArray(t.lines || []) || (t.lines || []).length > 3) throw new UsageError('template.lines: at most 3 lines');
  for (const l of t.lines || []) if (!l || typeof l.text !== 'string') throw new UsageError('each template line needs a text');
  return t;
}

export const replySubject = (s) => { const v = oneLine(s, 200); return /^re:/i.test(v) ? v : `Re: ${v}`; };

/** The ledger keeps the newest `max` ids. */
export function trimLedger(ledger, max = 5000) {
  const e = Object.entries(ledger);
  if (e.length <= max) return ledger;
  return Object.fromEntries(e.sort((a, b) => String(a[1]).localeCompare(String(b[1]))).slice(-max));
}

// ---------------------------------------------------------------------------------------------- config

const readSecretFile = (f) => {
  if (!f || !existsSync(f)) return null;
  const v = readFileSync(f, 'utf8').replace(/\r?\n$/, '').replace(/\r?\n$/, '');
  return v && !/[\r\n]/.test(v) ? v : null;
};

/** A .json template file holds the structured form; any other file is a plain-text template. */
const readTemplateFile = (f) => (/\.json$/i.test(f) ? JSON.parse(readFileSync(f, 'utf8')) : readFileSync(f, 'utf8'));

export function settings(argv, env = process.env, cwd = process.cwd()) {
  const o = { send: false, seed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') return { help: true };
    if (a === '--send') o.send = true;
    else if (a === '--seed') o.seed = true;
    else if (['--config', '--every', '--state'].includes(a)) { if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`); o[a.slice(2)] = argv[++i]; }
    else throw new UsageError(`unknown option ${a}`);
  }
  const cfgPath = o.config || env.MAIL_REPLY_CONFIG;
  if (!cfgPath) throw new UsageError('--config is required (or MAIL_REPLY_CONFIG)');
  let c;
  try { c = JSON.parse(readFileSync(resolve(cwd, cfgPath), 'utf8')); } catch (e) { throw new UsageError(`config ${cfgPath}: ${e.code || e.message}`); }
  const base = dirname(resolve(cwd, cfgPath));
  const p = (v, b = base) => (v ? (isAbsolute(v) ? v : resolve(b, v)) : null);
  const allow = env.MAIL_REPLY_ALLOW ? env.MAIL_REPLY_ALLOW.split(',') : c.allow;
  const s = {
    send: o.send, seed: o.seed,
    every: o.every !== undefined ? Number(o.every) : undefined,
    source: c.source || 'imap',
    allowList: allow || [],
    allowed: makeAllow(allow),
    self: (c.self || []).map((a) => String(a).toLowerCase()),
    maxAgeMin: Number(c.maxAgeMin ?? 60),
    maxPerPass: Number(c.maxPerPass ?? 10),
    tzOffsetH: Number(c.tzOffsetH ?? 0),
    template: checkTemplate(c.templateFile ? readTemplateFile(p(c.templateFile)) : (c.template || DEFAULT_TEMPLATE)),
    state: o.state ? p(o.state, cwd) : env.MAIL_REPLY_STATE ? p(env.MAIL_REPLY_STATE, cwd) : p(c.state || 'mail-reply-state.json'),
    imap: c.imap ? { port: 993, tls: true, mailbox: 'INBOX', requireAuth: true, authServId: null, markRead: false, ...c.imap } : null,
    smtp: c.smtp ? { port: 465, tls: true, ...c.smtp } : null,
    composio: c.composio ? { windowDays: 2, maxResults: 25, labelId: null, markRead: false, account: null, ...c.composio } : null,
  };
  if (s.every !== undefined && (!Number.isFinite(s.every) || s.every < 30)) throw new UsageError('--every must be 30 seconds or more');
  if (!(s.maxAgeMin >= 1)) throw new UsageError('maxAgeMin must be 1 or more');
  if (!(Number.isInteger(s.maxPerPass) && s.maxPerPass >= 1)) throw new UsageError('maxPerPass must be a whole number from 1');
  if (!Number.isFinite(s.tzOffsetH) || Math.abs(s.tzOffsetH) > 14) throw new UsageError('tzOffsetH must be between -14 and 14');
  if (s.source === 'imap') {
    if (!s.imap?.host || !s.imap?.user) throw new UsageError('imap.host and imap.user are required');
    s.imap.passwordFile = env.MAIL_REPLY_PASSWORD_FILE ? p(env.MAIL_REPLY_PASSWORD_FILE, cwd) : p(s.imap.passwordFile);
    if (!s.imap.passwordFile) throw new UsageError('imap.passwordFile is required (the password is never put in the config)');
    if (!s.smtp?.host) throw new UsageError('smtp.host is required with source imap');
    s.smtp.user ??= s.imap.user;
    s.smtp.from ??= s.imap.user;
    s.smtp.passwordFile = s.smtp.passwordFile ? p(s.smtp.passwordFile) : s.imap.passwordFile;
    s.self.push(String(s.smtp.from).toLowerCase(), String(s.imap.user).toLowerCase());
  } else if (s.source === 'composio') {
    s.composio ??= { windowDays: 2, maxResults: 25, labelId: null, markRead: false, account: null };
    s.composio.keyFile = env.MAIL_REPLY_COMPOSIO_KEY_FILE ? p(env.MAIL_REPLY_COMPOSIO_KEY_FILE, cwd) : p(s.composio.keyFile);
    if (!s.composio.keyFile) throw new UsageError('composio.keyFile is required (the key is never put in the config)');
    if (s.allowList.some((a) => /[()\s]|\bOR\b/i.test(a))) throw new UsageError('allow entries cannot hold spaces or brackets');
  } else throw new UsageError('source must be imap or composio');
  return s;
}

// ---------------------------------------------------------------------------------------------- transports

/** IMAP to read, SMTP to reply. One IMAP session per pass. */
export function imapTransport(s, { open = openImap, send = sendMail } = {}) {
  let session = null;
  const password = () => { const v = readSecretFile(s.imap.passwordFile); if (!v) throw new Error('no password at imap.passwordFile'); return v; };
  return {
    name: 'imap',
    authKnown: true,
    secrets: () => [readSecretFile(s.imap.passwordFile), readSecretFile(s.smtp.passwordFile)],
    async list({ sinceMs }) {
      session = await open({ host: s.imap.host, port: s.imap.port, tls: s.imap.tls });
      await session.cmd(`LOGIN ${quote(s.imap.user)} ${quote(password())}`);
      return listRecent(session, { mailbox: s.imap.mailbox, sinceMs, readOnly: !s.imap.markRead });
    },
    async reply(msg, { to, body, html }) {
      const pw = readSecretFile(s.smtp.passwordFile);
      if (!pw) throw new Error('no password at smtp.passwordFile');
      const message = buildReply({ from: s.smtp.from, to, subject: replySubject(msg.subject), body, html, inReplyTo: msg.messageId, references: msg.references });
      return send({ host: s.smtp.host, port: s.smtp.port, tls: s.smtp.tls, user: s.smtp.user, password: pw, from: s.smtp.from, to, message });
    },
    async mark(msg) { if (s.imap.markRead && session && msg.uid) await markSeen(session, msg.uid); },
    async close() { if (session) { const x = session; session = null; await x.close(); } },
  };
}

export function makeTransport(s, deps = {}) {
  if (s.source === 'imap') return deps.imapTransport ? deps.imapTransport(s) : imapTransport(s, deps);
  const readKey = () => readSecretFile(s.composio.keyFile);
  const client = composioClient({ readKey, account: s.composio.account, fetchImpl: deps.fetchImpl || fetch, ...(deps.composioUrls || {}) });
  return { ...composioTransport({ client, allow: s.allowList, windowDays: s.composio.windowDays, maxResults: s.composio.maxResults, labelId: s.composio.labelId, markRead: s.composio.markRead }), secrets: () => [readKey()] };
}

// ---------------------------------------------------------------------------------------------- one pass

const loadLedger = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')).replied || {}; } catch { return {}; } };
function saveLedger(f, replied) {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ replied: trimLedger(replied) }, null, 1));
  renameSync(tmp, f);
}
const redact = (m, secrets) => secrets.filter((x) => x && x.length >= 4).reduce((t, x) => t.split(x).join('[secret]'), String(m));

/** One pass. The ledger is written after every reply, so a crash never sends the same acknowledgement twice. */
export async function pass(s, transport, { now = () => Date.now(), log = () => {} } = {}) {
  const nowMs = now();
  const ledger = loadLedger(s.state);
  const out = { ok: true, source: transport.name, dryRun: !s.send && !s.seed, seeded: s.seed, checked: 0, replied: [], skipped: {}, errors: [] };
  const secrets = () => (transport.secrets ? transport.secrets() : []);
  try {
    const msgs = await transport.list({ sinceMs: nowMs - s.maxAgeMin * 60_000 });
    out.checked = msgs.length;
    const ctx = { allowed: s.allowed, self: s.self, ledger, nowMs, maxAgeMin: s.maxAgeMin, requireAuth: s.imap?.requireAuth ?? false, authKnown: transport.authKnown, authServId: s.imap?.authServId };
    for (const m of msgs.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))) {
      const d = decide(m, ctx);
      if (!d.reply) { out.skipped[d.reason] = (out.skipped[d.reason] || 0) + 1; continue; }
      if (out.replied.length >= s.maxPerPass) { out.skipped['over-max-per-pass'] = (out.skipped['over-max-per-pass'] || 0) + 1; continue; }
      const row = { id: m.id, threadId: m.threadId, to: d.to };
      if (s.seed) { ledger[m.id] = new Date(nowMs).toISOString(); saveLedger(s.state, ledger); out.replied.push({ ...row, seeded: true }); continue; }
      const { text: body, html } = renderReply(s.template, { nowMs, tzOffsetH: s.tzOffsetH, subject: m.subject, sender: d.to, receivedMs: Date.parse(m.receivedAt || '') });
      if (!s.send) { out.replied.push({ ...row, wouldSend: true }); continue; }
      try { await transport.reply(m, { to: d.to, body, html }); }
      catch (e) { out.errors.push(redact(`reply ${m.id}: ${String(e.message).slice(0, 160)}`, secrets())); continue; }   // retried next pass
      ledger[m.id] = new Date(nowMs).toISOString();
      saveLedger(s.state, ledger);
      out.replied.push(row);
      log(`replied to ${m.id}`);
      try { await transport.mark?.(m); } catch (e) { out.errors.push(redact(`mark ${m.id}: ${String(e.message).slice(0, 120)}`, secrets())); }
    }
  } catch (e) {
    out.ok = false;
    out.error = redact(String(e.message).slice(0, 200), secrets());
  } finally {
    try { await transport.close?.(); } catch { /* closing anyway */ }
  }
  if (!out.errors.length) delete out.errors;
  return out;
}

// ---------------------------------------------------------------------------------------------- CLI

function lock(file) {
  const l = `${file}.lock`;
  if (existsSync(l)) {
    const pid = Number(readFileSync(l, 'utf8'));
    try { if (pid && pid !== process.pid) { process.kill(pid, 0); return null; } } catch { /* stale */ }
  }
  mkdirSync(dirname(l), { recursive: true });
  writeFileSync(l, String(process.pid));
  return () => { try { unlinkSync(l); } catch { /* gone */ } };
}

/** The CLI as a function: returns the exit code. Loops with --every until `signal` aborts. */
export async function run(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, signal, now, ...deps } = {}) {
  let s;
  try { s = settings(argv, env, cwd); } catch (e) { stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`); return 2; }
  if (s.help) { stdout.write(`${HELP}\n`); return 0; }
  const release = lock(s.state);
  if (!release) { stdout.write(`${JSON.stringify({ ok: false, error: 'another pass holds the state lock' })}\n`); return 4; }
  try {
    for (;;) {
      const r = await pass(s, makeTransport(s, deps), { now });
      stdout.write(`${JSON.stringify(r)}\n`);
      if (!s.every) return r.ok ? 0 : 1;
      if (!r.ok) stderr.write('pass failed; trying again next round\n');
      const stop = await new Promise((done) => {
        const t = setTimeout(() => done(false), s.every * 1000);
        signal?.addEventListener('abort', () => { clearTimeout(t); done(true); }, { once: true });
      });
      if (stop || signal?.aborted) return 0;
    }
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
