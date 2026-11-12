// Minimal IMAP4rev1 client, standard library only: LOGIN, EXAMINE/SELECT, UID SEARCH SINCE, UID FETCH of a few
// header fields (BODY.PEEK, so nothing is marked read), optional UID STORE \Seen, LOGOUT. TLS (port 993) by default;
// plain TCP only to a loopback host (for tests). The password is sent once inside LOGIN and never logged.
import net from 'node:net';
import tls from 'node:tls';

export const HEADER_FIELDS = ['FROM', 'SUBJECT', 'MESSAGE-ID', 'REFERENCES', 'IN-REPLY-TO', 'AUTO-SUBMITTED', 'AUTHENTICATION-RESULTS', 'LIST-ID', 'PRECEDENCE', 'X-AUTO-RESPONSE-SUPPRESS', 'RETURN-PATH'];
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Splits a byte stream into IMAP responses: {text, literals[]}, with each {n} literal replaced by \0index\0. */
export class ResponseReader {
  constructor() { this.buf = Buffer.alloc(0); this.cur = null; this.need = null; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.need !== null) {
        if (this.buf.length < this.need) break;
        this.cur.literals.push(this.buf.subarray(0, this.need));
        this.cur.parts.push(`\u0000${this.cur.literals.length - 1}\u0000`);
        this.buf = this.buf.subarray(this.need);
        this.need = null;
        continue;
      }
      const i = this.buf.indexOf('\r\n');
      if (i < 0) break;
      const line = this.buf.subarray(0, i).toString('latin1');
      this.buf = this.buf.subarray(i + 2);
      this.cur ??= { parts: [], literals: [] };
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (m) { this.cur.parts.push(line.slice(0, m.index)); this.need = Number(m[1]); continue; }
      this.cur.parts.push(line);
      out.push({ text: this.cur.parts.join(''), literals: this.cur.literals });
      this.cur = null;
    }
    return out;
  }
}

export const quote = (s) => {
  const v = String(s);
  if (/[\r\n\u0000]/.test(v) || /[^\x20-\x7e]/.test(v)) throw new Error('IMAP: user and password must be printable ASCII');
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

export const imapDate = (ms) => { const d = new Date(ms); return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };

function connect({ host, port, tls: useTls = true, timeoutMs = 30_000, rejectUnauthorized = true }) {
  if (!useTls && !LOOPBACK.has(host)) throw new Error('IMAP: plain TCP is allowed only to a loopback host');
  return new Promise((ok, fail) => {
    const sock = useTls ? tls.connect({ host, port, servername: host, rejectUnauthorized }) : net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error('IMAP: timed out')));
    sock.once(useTls ? 'secureConnect' : 'connect', () => ok(sock));
    sock.once('error', fail);
  });
}

/** Open a session. Returns {cmd(text) -> responses[], close()}. */
export async function openImap(opts) {
  const sock = await connect(opts);
  const reader = new ResponseReader();
  let waiting = null;   // {tag, got[], ok, fail}
  let greeting = null;
  let dead = null;
  const onError = (e) => { dead = e; if (waiting) waiting.fail(e); };
  sock.on('error', onError);
  sock.on('close', () => onError(dead || new Error('IMAP: connection closed')));
  const greeted = new Promise((ok, fail) => { greeting = { ok, fail }; });
  sock.on('data', (chunk) => {
    for (const r of reader.push(chunk)) {
      if (greeting) { const g = greeting; greeting = null; if (/^\* (OK|PREAUTH)/i.test(r.text)) g.ok(); else g.fail(new Error('IMAP: bad greeting')); continue; }
      if (!waiting) continue;
      if (r.text.startsWith(`${waiting.tag} `)) {
        const w = waiting; waiting = null;
        const status = r.text.slice(w.tag.length + 1);
        if (/^OK/i.test(status)) w.ok(w.got); else w.fail(new Error(`IMAP ${w.verb}: ${status.slice(0, 120)}`));
      } else waiting.got.push(r);
    }
  });
  sock.once('error', (e) => greeting?.fail(e));
  await greeted;
  let n = 0;
  const cmd = (text) => new Promise((ok, fail) => {
    if (dead) return fail(dead);
    const tag = `h${++n}`;
    waiting = { tag, got: [], ok, fail, verb: text.split(' ').slice(0, text.startsWith('UID') ? 2 : 1).join(' ') };
    sock.write(`${tag} ${text}\r\n`);
  });
  // LOGOUT gets closeTimeoutMs to be answered; a server that has gone quiet cannot hold the pass open.
  const close = async () => {
    let timer;
    const late = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('IMAP: LOGOUT timed out')), opts.closeTimeoutMs ?? 5000); });
    try { await Promise.race([cmd('LOGOUT'), late]); } catch { /* closing anyway */ } finally { clearTimeout(timer); sock.destroy(); }
  };
  return { cmd, close };
}

/** Unfold a raw header block into {lowercase-name: [values]} (top to bottom). */
export function parseHeaders(raw) {
  const out = {};
  const text = String(raw).replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    (out[k] ||= []).push(line.slice(i + 1).trim());
  }
  return out;
}

/** RFC 2047 encoded words (=?utf-8?B?...?= and ?Q?) to text. Unknown charsets fall back to UTF-8. */
export function decodeWords(s) {
  return String(s ?? '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (all, cs, enc, data) => {
    try {
      const bytes = /b/i.test(enc) ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      try { return new TextDecoder(cs.toLowerCase()).decode(bytes); } catch { return bytes.toString('utf8'); }
    } catch { return all; }
  });
}

/** One FETCH response to a message record. */
export function parseFetch(r) {
  const uid = /\bUID (\d+)/i.exec(r.text)?.[1];
  const date = /INTERNALDATE "([^"]+)"/i.exec(r.text)?.[1];
  const lit = /\u0000(\d+)\u0000/.exec(r.text);
  if (!uid || !lit) return null;
  const h = parseHeaders(r.literals[Number(lit[1])].toString('utf8'));
  const first = (k) => (h[k] ? h[k][0] : '');
  const receivedAt = date ? new Date(date.replace(/^(\d{1,2})-(\w{3})-(\d{4})/, '$2 $1 $3')).toISOString() : null;
  return {
    id: first('message-id') || `uid:${uid}`, uid: Number(uid), threadId: first('message-id') || null, receivedAt,
    // `from` stays undecoded: an RFC 2047 encoded word in the display name must never become an address.
    from: (h.from || []).length === 1 ? h.from[0] : '', subject: decodeWords(first('subject')),
    messageId: first('message-id'), references: first('references'),
    headers: { autoSubmitted: first('auto-submitted'), precedence: first('precedence'), listId: first('list-id'), autoResponseSuppress: first('x-auto-response-suppress'), returnPath: first('return-path'), authResults: h['authentication-results'] || [] },
  };
}

/**
 * Messages received since `sinceMs`. IMAP SINCE compares only the date part of INTERNALDATE, in the server's own
 * time zone, so the search asks for one day earlier than the UTC date of the cut-off: that covers every zone. The
 * caller applies the exact cut-off, by the minute. Newest `limit` only.
 */
export async function listRecent(session, { mailbox = 'INBOX', sinceMs, limit = 100, readOnly = true }) {
  await session.cmd(`${readOnly ? 'EXAMINE' : 'SELECT'} ${quote(mailbox)}`);
  const found = await session.cmd(`UID SEARCH SINCE ${imapDate(sinceMs - 86_400_000)}`);
  const uids = found.flatMap((r) => (/^\* SEARCH\b/i.test(r.text) ? r.text.slice(8).trim().split(/\s+/).filter(Boolean).map(Number) : [])).sort((a, b) => a - b).slice(-limit);
  if (!uids.length) return [];
  const got = await session.cmd(`UID FETCH ${uids.join(',')} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS.join(' ')})])`);
  return got.filter((r) => /^\* \d+ FETCH/i.test(r.text)).map(parseFetch).filter(Boolean);
}

export const markSeen = (session, uid) => session.cmd(`UID STORE ${Number(uid)} +FLAGS.SILENT (\\Seen)`);
