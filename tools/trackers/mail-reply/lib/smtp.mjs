// Minimal SMTP submission client, standard library only: implicit TLS (port 465) by default, EHLO, AUTH PLAIN,
// MAIL FROM, RCPT TO (exactly one recipient), DATA, QUIT. Plain TCP only to a loopback host (for tests).
// Builds the reply itself so threading headers are right and no header can be injected.
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const oneLine = (s) => String(s ?? '').replace(/[\r\n\u0000]+/g, ' ').trim();
const ADDR = /^[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+$/;

/** RFC 2047 B-encode a header value if it is not plain ASCII. */
export const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

const b64 = (s) => Buffer.from(String(s).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');

/** The full RFC 5322 message for an in-thread reply: plain text, or multipart/alternative (text + HTML) with `html`. */
export function buildReply({ from, to, subject, body, html = null, inReplyTo, references, date = new Date(), messageId }) {
  for (const a of [from, to]) if (!ADDR.test(String(a))) throw new Error('SMTP: from and to must be bare addresses');
  const domain = String(from).split('@')[1];
  // Only whole message ids (<...@...>, at most 250 characters each) are copied. In-Reply-To is one id; References
  // keeps the newest 20 and at most 900 characters, so the header stays inside one 998-character line.
  const ids = (s) => oneLine(s).split(/\s+/).filter((t) => t.length <= 250 && /^<[^<>\s]+@[^<>\s]+>$/.test(t));
  const ref = ids(inReplyTo)[0] || '';
  const kept = [...ids(references).filter((t) => t !== ref), ...(ref ? [ref] : [])].slice(-20);
  while (kept.join(' ').length > 900) kept.shift();
  const refs = kept.join(' ');
  const headers = [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodeHeader(oneLine(subject))}`, `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId || `<${randomBytes(12).toString('hex')}@${domain}>`}`,
    ...(ref ? [`In-Reply-To: ${ref}`] : []), ...(refs ? [`References: ${refs}`] : []),
    'Auto-Submitted: auto-replied', 'X-Auto-Response-Suppress: All', 'MIME-Version: 1.0',
  ];
  if (!html) return `${[...headers, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64'].join('\r\n')}\r\n\r\n${b64(body)}\r\n`;
  const boundary = `=_hk_${randomBytes(12).toString('hex')}`;
  const part = (type, s) => `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(s)}\r\n`;
  return `${[...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`].join('\r\n')}\r\n\r\n${part('text/plain', body)}${part('text/html', html)}--${boundary}--\r\n`;
}

function connect({ host, port, tls: useTls = true, timeoutMs = 30_000, rejectUnauthorized = true }) {
  if (!useTls && !LOOPBACK.has(host)) throw new Error('SMTP: plain TCP is allowed only to a loopback host');
  return new Promise((ok, fail) => {
    const sock = useTls ? tls.connect({ host, port, servername: host, rejectUnauthorized }) : net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error('SMTP: timed out')));
    sock.once(useTls ? 'secureConnect' : 'connect', () => ok(sock));
    sock.once('error', fail);
  });
}

/** Send one message. Throws on any non-2xx/3xx reply; the error never contains the password. */
export async function sendMail({ host, port = 465, tls: useTls = true, user, password, from, to, message, helo = 'localhost', rejectUnauthorized = true, timeoutMs }) {
  if (!ADDR.test(String(to))) throw new Error('SMTP: bad recipient');
  const sock = await connect({ host, port, tls: useTls, rejectUnauthorized, timeoutMs });
  let buf = '';
  let waiter = null;
  const replies = [];
  const pump = () => {
    for (;;) {
      const i = buf.indexOf('\r\n');
      if (i < 0) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) { replies.push(line); }
    }
  };
  sock.on('data', (d) => { buf += d.toString('latin1'); pump(); if (waiter && replies.length) { const w = waiter; waiter = null; w.ok(replies.shift()); } });
  // A socket that errors, times out or is closed by the server ends the wait: no step can hang.
  let dead = null;
  const end = (e) => { dead ??= e; if (waiter) { const w = waiter; waiter = null; w.fail(dead); } };
  sock.on('error', end);
  sock.on('close', () => end(new Error('connection closed')));
  const next = () => new Promise((ok, fail) => { if (replies.length) return ok(replies.shift()); if (dead) return fail(dead); waiter = { ok, fail }; });
  const expect = async (verb, re) => {
    let r;
    try { r = await next(); } catch (e) { throw new Error(`SMTP ${verb}: ${String(e.message).replace(/^SMTP: /, '').slice(0, 120)}`); }
    if (!re.test(r)) throw new Error(`SMTP ${verb}: ${r.slice(0, 120)}`);
    return r;
  };
  const say = (line) => sock.write(`${line}\r\n`);
  try {
    await expect('greeting', /^220/);
    say(`EHLO ${helo}`); await expect('EHLO', /^250/);
    if (user) {
      say(`AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64')}`);
      await expect('AUTH', /^235/);
    }
    say(`MAIL FROM:<${from}>`); await expect('MAIL FROM', /^250/);
    say(`RCPT TO:<${to}>`); await expect('RCPT TO', /^25[01]/);
    say('DATA'); await expect('DATA', /^354/);
    sock.write(`${message.replace(/\r\n\./g, '\r\n..')}.\r\n`);
    const done = await expect('message', /^250/);
    say('QUIT');
    return done;
  } finally { setTimeout(() => sock.destroy(), 50).unref?.(); }
}
