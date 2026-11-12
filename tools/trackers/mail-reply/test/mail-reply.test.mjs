// Offline: a mock IMAP server and a mock SMTP server on 127.0.0.1, and a fake Composio through an injected fetch.
// No network beyond loopback, no child processes, every file in a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, settings, decide, makeAllow, addressOf, authPassed, render, renderReply, checkTemplate, DEFAULT_TEMPLATE, replySubject, trimLedger } from '../mail-reply.mjs';
import { ResponseReader, decodeWords, imapDate, openImap } from '../lib/imap.mjs';
import { buildReply, encodeHeader, sendMail } from '../lib/smtp.mjs';
import { gmailQuery, gmailHeaders } from '../lib/composio.mjs';

const PASSWORD = 'example-app-password-7c4a8d09';
const KEY = 'ck_example_key_5f4dcc3b5aa765d6';
const OWNER = 'owner@example.com';
const BOT = 'bot@example.net';
const MIN = 60_000;

// ------------------------------------------------------------------------------------------- mock servers

const internalDate = (ms) => {
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${imapDate(ms).split('-')[1]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};

function mockImap(messages, { password = PASSWORD, zoneOffsetH = null, ignoreLogout = false } = {}) {
  const log = { logins: 0, stores: [], commands: [] };
  const server = net.createServer((sock) => {
    sock.write('* OK mock IMAP ready\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        log.commands.push(cmd.startsWith('LOGIN') ? 'LOGIN [hidden]' : cmd);
        if (/^LOGIN /i.test(cmd)) {
          log.logins++;
          const ok = cmd === `LOGIN "${BOT}" "${password}"`;
          sock.write(ok ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else if (/^(EXAMINE|SELECT) /i.test(cmd)) sock.write(`* ${messages.length} EXISTS\r\n${tag} OK [READ-WRITE] done\r\n`);
        else if (/^UID SEARCH /i.test(cmd)) {
          // With zoneOffsetH the mock honours SINCE as a real server does: by the date part of its own local INTERNALDATE.
          let hit = messages;
          const since = /SINCE (\d{1,2})-(\w{3})-(\d{4})/i.exec(cmd);
          if (zoneOffsetH !== null && since) {
            const day = Date.parse(`${since[2]} ${since[1]} ${since[3]} 00:00:00 UTC`);
            hit = messages.filter((m) => Math.floor((m.at + zoneOffsetH * 3_600_000) / 86_400_000) * 86_400_000 >= day);
          }
          sock.write(`* SEARCH ${hit.map((m) => m.uid).join(' ')}\r\n${tag} OK search done\r\n`);
        }
        else if (/^UID FETCH /i.test(cmd)) {
          const want = cmd.split(' ')[2].split(',').map(Number);
          for (const [n, m] of messages.entries()) {
            if (!want.includes(m.uid)) continue;
            const hdr = Buffer.from(`${m.headers.join('\r\n')}\r\n\r\n`, 'utf8');
            sock.write(`* ${n + 1} FETCH (UID ${m.uid} INTERNALDATE "${internalDate(m.at)}" BODY[HEADER.FIELDS (FROM SUBJECT)] {${hdr.length}}\r\n`);
            sock.write(hdr);
            sock.write(')\r\n');
          }
          sock.write(`${tag} OK fetch done\r\n`);
        } else if (/^UID STORE /i.test(cmd)) { log.stores.push(cmd); sock.write(`${tag} OK store done\r\n`); }
        else if (/^LOGOUT/i.test(cmd)) { if (!ignoreLogout) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); } }
        else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ port: server.address().port, log, close: () => new Promise((r) => server.close(r)) })));
}

function mockSmtp({ failRcpt = false, dropAtMailFrom = false } = {}) {
  const sent = [];
  const server = net.createServer((sock) => {
    sock.write('220 mock SMTP\r\n');
    let buf = ''; let data = null; let env = {};
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          sent.push({ ...env, data: Buffer.from(buf.slice(0, end + 2), 'latin1').toString('utf8') });
          buf = buf.slice(end + 5); data = null; env = {};
          sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write('250-mock\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /i.test(line)) { env.auth = Buffer.from(line.slice(11), 'base64').toString('utf8'); sock.write('235 ok\r\n'); }
        else if (/^MAIL FROM:/i.test(line) && dropAtMailFrom) { sock.end(); return; }
        else if (/^MAIL FROM:/i.test(line)) { env.from = line.slice(10); sock.write('250 ok\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { env.to = line.slice(8); sock.write(failRcpt ? '550 no such user\r\n' : '250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { data = ''; sock.write('354 go ahead\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('500 what\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ port: server.address().port, sent, close: () => new Promise((r) => server.close(r)) })));
}

const AUTH_PASS = 'Authentication-Results: mx.example.net; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com';
const AUTH_FAIL = 'Authentication-Results: mx.example.net; dkim=none; spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com';

function inbox(nowMs) {
  return [
    { uid: 1, at: nowMs - 5 * MIN, headers: [`From: Owner <${OWNER}>`, 'Subject: =?UTF-8?B?Q2Fmw6kgcGxhbnM=?=', 'Message-ID: <m1@example.com>', 'References: <m0@example.com>', AUTH_PASS] },
    { uid: 2, at: nowMs - 4 * MIN, headers: ['From: Stranger <someone@example.org>', 'Subject: hi', 'Message-ID: <m2@example.org>', AUTH_PASS] },
    { uid: 3, at: nowMs - 3 * MIN, headers: [`From: ${OWNER}`, 'Subject: out of office', 'Message-ID: <m3@example.com>', 'Auto-Submitted: auto-replied', AUTH_PASS] },
    { uid: 4, at: nowMs - 2 * MIN, headers: [`From: ${OWNER}`, 'Subject: spoofed', 'Message-ID: <m4@example.com>', AUTH_FAIL, AUTH_PASS] },
    { uid: 5, at: nowMs - 180 * MIN, headers: [`From: ${OWNER}`, 'Subject: old one', 'Message-ID: <m5@example.com>', AUTH_PASS] },
    { uid: 6, at: nowMs - 1 * MIN, headers: [`From: ${OWNER}`, 'Subject: digest', 'Message-ID: <m6@example.com>', 'List-Id: <news.example.com>', AUTH_PASS] },
  ];
}

function sink() { const lines = []; return { lines, write: (s) => { lines.push(s); return true; }, json: () => JSON.parse(lines.at(-1)) }; }

function setup(extra = {}) {
  const d = mkdtempSync(join(tmpdir(), 'mr-'));
  writeFileSync(join(d, 'pw.txt'), `${PASSWORD}\n`);
  writeFileSync(join(d, 'key.txt'), `${KEY}\n`);
  const write = (cfg) => { writeFileSync(join(d, 'cfg.json'), JSON.stringify(cfg)); return join(d, 'cfg.json'); };
  return { d, write, ...extra };
}

// ------------------------------------------------------------------------------------------- IMAP + SMTP

test('IMAP + SMTP: dry run by default; --send replies once, in-thread, only to the allowed and authenticated sender', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const imap = await mockImap(inbox(nowMs));
  const smtp = await mockSmtp();
  try {
    const { d, write } = setup();
    const cfg = write({
      source: 'imap', allow: [OWNER], maxAgeMin: 60, tzOffsetH: 8, state: 'state.json',
      template: 'Seen {date} {time} {zone}: "{subject}"',
      imap: { host: '127.0.0.1', port: imap.port, tls: false, user: BOT, passwordFile: 'pw.txt', markRead: true },
      smtp: { host: '127.0.0.1', port: smtp.port, tls: false, from: BOT },
    });
    // 1. dry run
    let out = sink();
    assert.equal(await run(['--config', cfg], { stdout: out, env: {}, now: () => nowMs }), 0);
    let r = out.json();
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.replied, [{ id: '<m1@example.com>', threadId: '<m1@example.com>', to: OWNER, wouldSend: true }]);
    assert.deepEqual(r.skipped, { 'not-allowed': 1, 'auto-submitted': 1, unauthenticated: 1, 'too-old': 1, 'list-mail': 1 });
    assert.equal(smtp.sent.length, 0, 'a dry run sends nothing');
    assert.equal(existsSync(join(d, 'state.json')), false, 'and writes no ledger');
    // 2. real pass
    out = sink();
    assert.equal(await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs }), 0);
    r = out.json();
    assert.equal(r.replied.length, 1);
    assert.equal(smtp.sent.length, 1);
    const m = smtp.sent[0];
    assert.equal(m.to, `<${OWNER}>`);
    assert.equal(m.auth, `\u0000${BOT}\u0000${PASSWORD}`, 'AUTH PLAIN carries the password, and only there');
    assert.match(m.data, /^Subject: =\?UTF-8\?B\?/m, 'a non-ASCII subject is encoded');
    assert.match(m.data, /^In-Reply-To: <m1@example\.com>$/m);
    assert.match(m.data, /^References: <m0@example\.com> <m1@example\.com>$/m);
    assert.match(m.data, /^Auto-Submitted: auto-replied$/m);
    const body = Buffer.from(m.data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.equal(body, 'Seen 2026-11-12 18:00 UTC+8: "Café plans"');
    assert.deepEqual(imap.log.stores, ['UID STORE 1 +FLAGS.SILENT (\\Seen)'], 'markRead flags only the answered message');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).replied), ['<m1@example.com>']);
    // 3. the ledger stops a repeat
    out = sink();
    await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs });
    assert.equal(out.json().replied.length, 0);
    assert.equal(out.json().skipped.already, 1);
    assert.equal(smtp.sent.length, 1);
    for (const line of out.lines) assert.ok(!line.includes(PASSWORD), 'the password never reaches stdout');
    assert.ok(imap.log.commands.every((c) => !c.includes(PASSWORD)));
  } finally { await imap.close(); await smtp.close(); }
});

test('IMAP: a refused reply is not recorded (retried next pass); a wrong password is ok:false without the password', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const imap = await mockImap(inbox(nowMs).slice(0, 1));
  const smtp = await mockSmtp({ failRcpt: true });
  try {
    const { d, write } = setup();
    const base = { source: 'imap', allow: [OWNER], state: 'state.json', imap: { host: '127.0.0.1', port: imap.port, tls: false, user: BOT, passwordFile: 'pw.txt' }, smtp: { host: '127.0.0.1', port: smtp.port, tls: false } };
    let out = sink();
    assert.equal(await run(['--config', write(base), '--send'], { stdout: out, env: {}, now: () => nowMs }), 0);
    assert.equal(out.json().replied.length, 0);
    assert.match(out.json().errors[0], /RCPT TO: 550/);
    assert.equal(existsSync(join(d, 'state.json')), false);
    writeFileSync(join(d, 'pw.txt'), 'wrong-password-123');
    out = sink();
    assert.equal(await run(['--config', write(base), '--send'], { stdout: out, env: {}, now: () => nowMs }), 1);
    assert.equal(out.json().ok, false);
    assert.match(out.json().error, /Invalid credentials/);
    assert.ok(!out.lines.join('').includes('wrong-password-123'));
  } finally { await imap.close(); await smtp.close(); }
});

test('--seed records what is due without replying; maxPerPass caps a burst', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const many = [1, 2, 3].map((n) => ({ uid: n, at: nowMs - n * MIN, headers: [`From: ${OWNER}`, `Subject: s${n}`, `Message-ID: <b${n}@example.com>`, AUTH_PASS] }));
  const imap = await mockImap(many);
  const smtp = await mockSmtp();
  try {
    const { write } = setup();
    const cfg = { source: 'imap', allow: ['@example.com'], state: 'state.json', maxPerPass: 2, imap: { host: '127.0.0.1', port: imap.port, tls: false, user: BOT, passwordFile: 'pw.txt' }, smtp: { host: '127.0.0.1', port: smtp.port, tls: false } };
    let out = sink();
    await run(['--config', write(cfg), '--send'], { stdout: out, env: {}, now: () => nowMs });
    assert.equal(out.json().replied.length, 2);
    assert.equal(out.json().skipped['over-max-per-pass'], 1);
    assert.deepEqual(out.json().replied.map((x) => x.id), ['<b3@example.com>', '<b2@example.com>'], 'oldest first');
    const m = smtp.sent[0].data;
    const boundary = /boundary="([^"]+)"/.exec(m)?.[1];
    assert.ok(boundary, 'the default template goes out as multipart/alternative');
    const parts = m.split(`--${boundary}`).slice(1, -1).map((p) => ({ type: /Content-Type: ([^;]+)/.exec(p)[1], body: Buffer.from(p.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8') }));
    assert.deepEqual(parts.map((p) => p.type), ['text/plain', 'text/html']);
    assert.match(parts[0].body, /^Got it: your message is in the queue\r\n\r\nWhat happens next: /);
    assert.match(parts[1].body, /<strong>You'll hear back:<\/strong> Here in this thread\./);
    assert.match(parts[1].body, /color:#8b949e">Automatic acknowledgement, [^<]*no AI model read your message<\/p>/);
    out = sink();
    await run(['--config', write(cfg), '--seed'], { stdout: out, env: {}, now: () => nowMs });
    assert.deepEqual(out.json().replied, [{ id: '<b1@example.com>', threadId: '<b1@example.com>', to: OWNER, seeded: true }]);
    assert.equal(smtp.sent.length, 2, 'seeding sends nothing');
  } finally { await imap.close(); await smtp.close(); }
});

test('plain TCP is refused to anything but a loopback host', async () => {
  await assert.rejects(() => openImap({ host: 'imap.example.com', port: 143, tls: false }), /loopback/);
});

// ------------------------------------------------------------------------------------------- Composio

function fakeComposio(messages, { failReply = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const body = JSON.parse(opts.body || '{}');
    const u = new URL(url);
    if (u.host === 'connect.composio.dev') {
      const tool = body.params?.arguments?.tools?.[0];
      calls.push({ kind: 'connect', method: body.method, headers: opts.headers, tool: tool?.tool_slug, args: tool?.arguments });
      const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' } });
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
      if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: {} });
      if (tool.tool_slug === 'GMAIL_REPLY_TO_THREAD' && failReply) {
        return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ successful: false, error: `bad key ${opts.headers['x-consumer-api-key']}` }) }] } });
      }
      const data = tool.tool_slug === 'GMAIL_FETCH_EMAILS' ? { messages } : { ok: true };
      return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ successful: true, data: { results: [{ response: { successful: true, data } }] } }) }] } });
    }
    calls.push({ kind: 'rest', path: u.pathname, headers: opts.headers, body });
    return new Response(JSON.stringify({ successful: true, data: { messages } }), { status: 200 });
  };
  return { fetchImpl, calls };
}

const GMAIL_AUTH = 'mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=owner@example.com; dmarc=pass (p=NONE) header.from=example.com';
/** A message as GMAIL_FETCH_EMAILS returns it with include_payload: the header list is payload.headers. */
const gmailMsg = (o, headers = {}) => ({
  labelIds: ['INBOX', 'UNREAD'], ...o,
  payload: { headers: Object.entries({ From: o.sender, 'Authentication-Results': GMAIL_AUTH, ...headers }).map(([name, value]) => ({ name, value })) },
});

test('Composio Connect (ck_ key): lists mail from the allow-list, replies in the thread to the sender, labels it', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const msgs = [
    gmailMsg({ messageId: 'a1b2c3', threadId: 't1', messageTimestamp: new Date(nowMs - 2 * MIN).toISOString(), sender: `Owner <${OWNER}>`, subject: 'note this' }),
    gmailMsg({ messageId: 'd4e5f6', threadId: 't2', messageTimestamp: new Date(nowMs - 2 * MIN).toISOString(), sender: 'x@evil-example.com', subject: 'not allowed' }),
  ];
  const net1 = fakeComposio(msgs);
  const { write } = setup();
  const cfg = write({ source: 'composio', allow: [OWNER], state: 'state.json', composio: { keyFile: 'key.txt', labelId: 'Label_1', markRead: true } });
  const out = sink();
  assert.equal(await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs, fetchImpl: net1.fetchImpl }), 0);
  assert.deepEqual(out.json().replied, [{ id: 'a1b2c3', threadId: 't1', to: OWNER }]);
  assert.equal(out.json().skipped['not-allowed'], 1);
  const tools = net1.calls.filter((c) => c.tool);
  assert.deepEqual(tools.map((c) => c.tool), ['GMAIL_FETCH_EMAILS', 'GMAIL_REPLY_TO_THREAD', 'GMAIL_ADD_LABEL_TO_EMAIL']);
  assert.equal(tools[0].args.query, `from:(${OWNER}) newer_than:2d -in:sent -in:draft -from:me`);
  assert.equal(tools[0].args.include_payload, true, 'the headers are asked for');
  assert.equal(tools[1].args.thread_id, 't1');
  assert.equal(tools[1].args.recipient_email, OWNER);
  assert.equal(tools[1].args.is_html, true, 'the default template is sent as HTML');
  assert.match(tools[1].args.message_body, /<strong>Got it: your message is in the queue<\/strong>/);
  assert.match(tools[1].args.message_body, /“note this”, received 2026-11-12 09:58 UTC/);
  assert.deepEqual(tools[2].args, { message_id: 'a1b2c3', add_label_ids: ['Label_1'], remove_label_ids: ['UNREAD'] });
  assert.ok(net1.calls.every((c) => c.headers['x-consumer-api-key'] === KEY));
  assert.ok(!out.lines.join('').includes(KEY));
});

test('Composio: an error that echoes the key is redacted; a project key goes to the REST API', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const msgs = [gmailMsg({ messageId: 'a1b2c3', threadId: 't1', messageTimestamp: new Date(nowMs - MIN).toISOString(), sender: OWNER, subject: 's' })];
  const bad = fakeComposio(msgs, { failReply: true });
  const { d, write } = setup();
  const cfg = write({ source: 'composio', allow: [OWNER], state: 'state.json', composio: { keyFile: 'key.txt' } });
  let out = sink();
  await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs, fetchImpl: bad.fetchImpl });
  assert.match(out.json().errors[0], /bad key \[key\]/);
  assert.ok(!out.lines.join('').includes(KEY));

  writeFileSync(join(d, 'key.txt'), 'ak_example_project_key_0001');
  const rest = fakeComposio(msgs);
  out = sink();
  await run(['--config', write({ source: 'composio', allow: [OWNER], state: 'state2.json', composio: { keyFile: 'key.txt', account: 'ca_example' } }), '--send'], { stdout: out, env: {}, now: () => nowMs, fetchImpl: rest.fetchImpl });
  assert.equal(rest.calls[0].path, '/api/v3.1/tools/execute/GMAIL_FETCH_EMAILS');
  assert.equal(rest.calls[0].headers['x-api-key'], 'ak_example_project_key_0001');
  assert.equal(rest.calls[0].body.connected_account_id, 'ca_example');
});

// ------------------------------------------------------------------------------------------- the pure core

test('allow-list: exact addresses and exact domains only; display names are not addresses', () => {
  const allowed = makeAllow([OWNER, '@example.org']);
  assert.equal(allowed(addressOf(`"Owner" <${OWNER.toUpperCase()}>`)), true);
  assert.equal(allowed(addressOf('a@example.org')), true);
  assert.equal(allowed(addressOf('a@sub.example.org')), false, 'no subdomains');
  assert.equal(allowed(addressOf('a@evil-example.org')), false, 'no suffix match');
  assert.equal(allowed(addressOf(`"${OWNER}" <attacker@example.net>`)), false, 'the address in brackets wins');
  assert.throws(() => makeAllow([]), /at least one/);
  assert.throws(() => makeAllow(['not an address']), /bad allow entry/);
});

test('authentication: only the topmost Authentication-Results counts', () => {
  const D = 'example.com';
  assert.equal(authPassed([AUTH_PASS.slice(24)], null, D), true);
  assert.equal(authPassed([AUTH_FAIL.slice(24), AUTH_PASS.slice(24)], null, D), false, 'a forged lower header is ignored');
  assert.equal(authPassed(['mx.example.net; spf=pass; dkim=fail'], null, D), false);
  assert.equal(authPassed([AUTH_PASS.slice(24)], 'mx.other.net', D), false, 'authServId pins the server');
  assert.equal(authPassed([AUTH_PASS.slice(24)], 'MX.example.net', D), true);
  assert.equal(authPassed([AUTH_PASS.slice(24)], 'mx.example', D), false, 'the authserv-id is matched whole, not as a prefix');
  assert.equal(authPassed([], null, D), false);
});

test('decide: future, undated and threadless mail is skipped; self is never answered', () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const ctx = { allowed: makeAllow([OWNER, BOT]), self: [BOT], ledger: {}, nowMs, maxAgeMin: 60, requireAuth: false, authKnown: false };
  const base = { id: 'x', threadId: 't', from: OWNER, receivedAt: new Date(nowMs - MIN).toISOString() };
  assert.deepEqual(decide(base, ctx), { reply: true, to: OWNER });
  assert.equal(decide({ ...base, receivedAt: new Date(nowMs + 60 * MIN).toISOString() }, ctx).reason, 'future');
  assert.equal(decide({ ...base, receivedAt: null }, ctx).reason, 'no-date');
  assert.equal(decide({ ...base, threadId: null }, ctx).reason, 'no-thread');
  assert.equal(decide({ ...base, from: BOT }, ctx).reason, 'self');
  assert.equal(decide({ ...base, headers: { precedence: 'bulk' } }, ctx).reason, 'list-mail');
  assert.equal(decide({ ...base, headers: { autoSubmitted: 'no' } }, ctx).reply, true);
});

test('template and headers: mail text cannot add lines or headers', () => {
  const body = render('Got "{subject}" from {sender} at {time} {zone} {unknown}', { nowMs: Date.parse('2026-11-12T10:00:00Z'), subject: 'hi\r\nBcc: x@example.org', sender: OWNER });
  assert.equal(body, `Got "hi Bcc: x@example.org" from ${OWNER} at 10:00 UTC {unknown}`);
  const msg = buildReply({ from: BOT, to: OWNER, subject: replySubject('hello\r\nBcc: x@example.org'), body: 'b', inReplyTo: '<a@b>\r\nX-Evil: 1' });
  const head = msg.split('\r\n\r\n')[0];
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.doesNotMatch(head, /^X-Evil:/m);
  assert.match(head, /^Subject: Re: hello Bcc: x@example\.org$/m);
  assert.equal(replySubject('Re: done'), 'Re: done');
  assert.equal(encodeHeader('plain'), 'plain');
  assert.equal(decodeWords(encodeHeader('Café')), 'Café');
  assert.equal(decodeWords('=?iso-8859-1?Q?caf=E9_ok?='), 'café ok');
  assert.throws(() => buildReply({ from: BOT, to: 'x@y.z>, other@example.org', subject: 's', body: 'b' }), /bare addresses/);
});

test('IMAP reader: literals split across chunks; ledger trims oldest first; settings validate', () => {
  const r = new ResponseReader();
  assert.deepEqual(r.push(Buffer.from('* 1 FETCH (UID 7 BODY[] {5}\r\nab')), []);
  const got = r.push(Buffer.from('cde)\r\nh1 OK\r\n'));
  assert.equal(got.length, 2);
  assert.equal(got[0].literals[0].toString(), 'abcde');
  assert.equal(got[1].text, 'h1 OK');
  assert.deepEqual(Object.keys(trimLedger({ a: '2026-01-01', b: '2026-03-01', c: '2026-02-01' }, 2)), ['c', 'b']);

  const { d, write } = setup();
  assert.throws(() => settings(['--config', write({ source: 'imap', allow: [OWNER], imap: { host: 'h', user: BOT }, smtp: { host: 'h' } })], {}, d), /passwordFile is required/);
  assert.throws(() => settings(['--config', write({ source: 'pop3', allow: [OWNER] })], {}, d), /imap or composio/);
  assert.throws(() => settings(['--config', write({ source: 'composio', allow: [OWNER], composio: { keyFile: 'k' } }), '--every', '5'], {}, d), /30 seconds/);
  const s = settings(['--config', write({ source: 'composio', allow: [OWNER], composio: { keyFile: 'key.txt' } })], { MAIL_REPLY_ALLOW: '@example.org' }, d);
  assert.equal(s.allowed('a@example.org'), true, 'env overrides the config allow-list');
  assert.equal(s.composio.keyFile, join(d, 'key.txt'));
});

test('structured template: bold headline, at most three bold-lead lines, grey footer; mail text is escaped', () => {
  const vars = { nowMs: Date.parse('2026-11-12T10:00:00Z'), tzOffsetH: 8, subject: '<b>hi</b> & "bye"', receivedMs: Date.parse('2026-11-12T09:58:00Z') };
  const { text, html } = renderReply(DEFAULT_TEMPLATE, vars);
  assert.equal(text.split('\n')[0], 'Got it: your message is in the queue');
  assert.ok(text.includes('Your email: “<b>hi</b> & "bye"”, received 2026-11-12 17:58 UTC+8\n'));
  assert.equal((html.match(/<strong>/g) || []).length, 4);
  assert.ok(html.includes('&lt;b&gt;hi&lt;/b&gt; &amp; &quot;bye&quot;'));
  assert.doesNotMatch(html, /<table|<img|<b>hi/);
  assert.equal(renderReply('plain {subject}', vars).html, null, 'a string template stays plain text');
  assert.throws(() => checkTemplate({ headline: 'h', lines: [1, 2, 3, 4].map(() => ({ text: 'x' })) }), /at most 3/);
  assert.throws(() => checkTemplate({ lines: [] }), /headline/);
  assert.throws(() => checkTemplate('  '), /empty/);
});

// ------------------------------------------------------------------------------------------- loop guards

test('Composio never answers itself or another auto-reply, and a thread cannot ping-pong', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const at = (min) => new Date(nowMs - min * MIN).toISOString();
  assert.equal(gmailQuery(['@example.com', OWNER]), `from:(example.com OR ${OWNER}) newer_than:2d -in:sent -in:draft -from:me`);
  const msgs = [
    gmailMsg({ messageId: 'a01', threadId: 't1', messageTimestamp: at(9), sender: OWNER, subject: 'own copy', labelIds: ['SENT'] }),
    gmailMsg({ messageId: 'a02', threadId: 't2', messageTimestamp: at(9), sender: `Me <${BOT}>`, subject: 'from the mailbox itself' }),
    gmailMsg({ messageId: 'a03', threadId: 't3', messageTimestamp: at(9), sender: OWNER, subject: 'out of office' }, { 'Auto-Submitted': 'auto-replied' }),
    gmailMsg({ messageId: 'a04', threadId: 't4', messageTimestamp: at(9), sender: OWNER, subject: 'suppressed' }, { 'X-Auto-Response-Suppress': 'DR, OOF, AutoReply' }),
    gmailMsg({ messageId: 'a05', threadId: 't5', messageTimestamp: at(9), sender: 'MAILER-DAEMON@example.com', subject: 'Undelivered' }),
    gmailMsg({ messageId: 'a06', threadId: 't6', messageTimestamp: at(9), sender: 'Shop <no-reply@example.com>', subject: 'receipt' }),
    gmailMsg({ messageId: 'a07', threadId: 't7', messageTimestamp: at(9), sender: OWNER, subject: 'bounce' }, { 'Return-Path': '<>' }),
    gmailMsg({ messageId: 'a08', threadId: 't8', messageTimestamp: at(9), sender: OWNER, subject: 'list' }, { 'List-Id': '<l.example.com>' }),
    { messageId: 'a09', threadId: 't9', messageTimestamp: at(9), sender: OWNER, subject: 'no headers came back', labelIds: ['INBOX'] },
    gmailMsg({ messageId: 'a10', threadId: 't10', messageTimestamp: at(9), sender: OWNER, subject: 'spoofed' }, { 'Authentication-Results': 'mx.google.com; spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com' }),
    ...[8, 7, 6, 5, 4].map((min, i) => gmailMsg({ messageId: `b0${i}`, threadId: 'loop', messageTimestamp: at(min), sender: OWNER, subject: 'Re: ping' })),
  ];
  const net1 = fakeComposio(msgs);
  const { write } = setup();
  const cfg = write({ source: 'composio', allow: ['@example.com', BOT], self: [BOT], state: 'state.json', composio: { keyFile: 'key.txt' } });
  let out = sink();
  assert.equal(await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs, fetchImpl: net1.fetchImpl }), 0);
  let r = out.json();
  assert.deepEqual(r.replied.map((x) => x.id), ['b00', 'b01', 'b02'], 'at most three acknowledgements in one thread in a day');
  assert.deepEqual(r.skipped, { self: 2, 'auto-submitted': 1, 'auto-response-suppress': 1, 'no-reply-sender': 2, bounce: 1, 'list-mail': 1, 'no-headers': 1, unauthenticated: 1, 'thread-cap': 2 });
  assert.equal(net1.calls.filter((c) => c.tool === 'GMAIL_REPLY_TO_THREAD').length, 3);
  // a later pass: the thread stays capped
  const net2 = fakeComposio([gmailMsg({ messageId: 'b09', threadId: 'loop', messageTimestamp: at(-30), sender: OWNER, subject: 'Re: ping' })]);
  out = sink();
  await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs + 31 * MIN, fetchImpl: net2.fetchImpl });
  assert.deepEqual(out.json().skipped, { 'thread-cap': 1 });
  assert.equal(net2.calls.filter((c) => c.tool === 'GMAIL_REPLY_TO_THREAD').length, 0);
  // a day later the thread is answered again
  const later = nowMs + 25 * 60 * MIN;
  const net3 = fakeComposio([gmailMsg({ messageId: 'b10', threadId: 'loop', messageTimestamp: new Date(later).toISOString(), sender: OWNER, subject: 'Re: ping' })]);
  out = sink();
  await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => later + MIN, fetchImpl: net3.fetchImpl });
  assert.equal(out.json().replied.length, 1);
});

test('IMAP skips X-Auto-Response-Suppress, mailer-daemon, no-reply senders and a null Return-Path', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const h = (n, from, ...extra) => ({ uid: n, at: nowMs - n * MIN, headers: [`From: ${from}`, `Subject: s${n}`, `Message-ID: <g${n}@example.com>`, AUTH_PASS, ...extra] });
  const imap = await mockImap([
    h(1, OWNER, 'X-Auto-Response-Suppress: All'),
    h(2, 'Mail Delivery Subsystem <mailer-daemon@example.com>'),
    h(3, 'noreply@example.com'),
    h(4, 'do-not-reply+abc@example.com'),
    h(5, OWNER, 'Return-Path: <>'),
    h(6, OWNER, 'Return-Path: <owner@example.com>', 'X-Auto-Response-Suppress: None'),
  ]);
  const smtp = await mockSmtp();
  try {
    const { write } = setup();
    const cfg = write({ source: 'imap', allow: ['@example.com'], state: 'state.json', imap: { host: '127.0.0.1', port: imap.port, tls: false, user: BOT, passwordFile: 'pw.txt' }, smtp: { host: '127.0.0.1', port: smtp.port, tls: false } });
    const out = sink();
    await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs });
    assert.deepEqual(out.json().replied.map((x) => x.id), ['<g6@example.com>']);
    assert.deepEqual(out.json().skipped, { 'auto-response-suppress': 1, 'no-reply-sender': 3, bounce: 1 });
    assert.match(smtp.sent[0].data, /^X-Auto-Response-Suppress: All$/m);
    assert.ok(imap.log.commands.some((c) => /^UID FETCH .*RETURN-PATH/.test(c)), 'Return-Path is fetched');
  } finally { await imap.close(); await smtp.close(); }
});

test('IMAP SINCE reaches back a day, so a server west of UTC still returns the last hour', async () => {
  const nowMs = Date.parse('2026-11-12T01:30:00Z');   // 11 Nov 17:30 on a UTC-8 server
  const mail = (uid, min, id) => ({ uid, at: nowMs - min * MIN, headers: [`From: ${OWNER}`, 'Subject: s', `Message-ID: <${id}@example.com>`, AUTH_PASS] });
  const imap = await mockImap([mail(1, 10, 'z1'), mail(2, 180, 'z2')], { zoneOffsetH: -8 });
  const smtp = await mockSmtp();
  try {
    const { write } = setup();
    const cfg = write({ source: 'imap', allow: [OWNER], maxAgeMin: 60, state: 'state.json', imap: { host: '127.0.0.1', port: imap.port, tls: false, user: BOT, passwordFile: 'pw.txt' }, smtp: { host: '127.0.0.1', port: smtp.port, tls: false } });
    const out = sink();
    await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs });
    assert.ok(imap.log.commands.includes('UID SEARCH SINCE 11-Nov-2026'), 'one day before the UTC date of the cut-off');
    assert.deepEqual(out.json().replied.map((x) => x.id), ['<z1@example.com>']);
    assert.deepEqual(out.json().skipped, { 'too-old': 1 }, 'the exact cut-off is still applied here, by the minute');
  } finally { await imap.close(); await smtp.close(); }
});

// ------------------------------------------------------------------------------------------- sender and authentication

test('the sender is the one real addr-spec: a display name, comment or encoded word cannot stand in for it', () => {
  assert.equal(addressOf(`"Boss <${OWNER}>" <attacker@example.net>`), 'attacker@example.net', 'brackets inside a quoted display name');
  assert.equal(addressOf(`"a \\" <${OWNER}>" <attacker@example.net>`), 'attacker@example.net', 'an escaped quote');
  assert.equal(addressOf(`(<${OWNER}>) attacker@example.net`), 'attacker@example.net', 'a comment');
  assert.equal(addressOf(`<${OWNER}> <attacker@example.net>`), '', 'two bracketed addresses: no sender');
  assert.equal(addressOf(`${OWNER}, attacker@example.net`), '', 'two authors: no sender');
  assert.equal(addressOf(`<${OWNER}> attacker@example.net`), '', 'text after the address');
  assert.equal(addressOf(`${OWNER} <attacker@example.net>`), 'attacker@example.net');
  assert.equal(addressOf('=?UTF-8?B?PG93bmVyQGV4YW1wbGUuY29tPg==?= <attacker@example.net>'), 'attacker@example.net', 'an encoded word is never decoded into an address');
  assert.equal(addressOf(`Owner <${OWNER}>`), OWNER);
  assert.equal(addressOf(`  ${OWNER.toUpperCase()}  `), OWNER);
  assert.equal(addressOf('"quoted local"@example.com'), '');
});

test('authentication must be aligned with the From domain', () => {
  const top = (s) => [`mx.example.net; ${s}`];
  const D = 'example.com';
  assert.equal(authPassed(top('dmarc=pass header.from=example.com'), null, D), true);
  assert.equal(authPassed(top('dmarc=pass (p=REJECT) header.from=example.com'), null, 'mail.example.com'), true, 'the organisational domain covers a subdomain');
  assert.equal(authPassed(top('dmarc=pass header.from=example.net'), null, D), false, 'DMARC passed for another domain');
  assert.equal(authPassed(top('dmarc=pass header.from=evil-example.com'), null, D), false);
  assert.equal(authPassed(top('dmarc=pass'), null, D), false, 'no header.from: nothing ties the pass to the sender');
  assert.equal(authPassed(top('spf=pass smtp.mailfrom=attacker@example.net; dkim=pass header.d=example.net'), null, D), false, 'unaligned SPF and DKIM passes');
  assert.equal(authPassed(top('spf=pass; dkim=pass'), null, D), false, 'passes that name no domain');
  assert.equal(authPassed(top('spf=pass smtp.mailfrom=bounce@example.com'), null, D), true, 'aligned SPF');
  assert.equal(authPassed(top('spf=fail smtp.mailfrom=example.com; dkim=pass header.i=@example.com'), null, D), true, 'aligned DKIM');
  assert.equal(authPassed(top('dkim=pass header.d=example.com; dmarc=fail header.from=example.com'), null, D), false, 'a DMARC fail is final');
  assert.equal(authPassed(top('dkim=pass (header.d=example.com) header.d=example.net'), null, D), false, 'comments are not results');
  assert.equal(authPassed(top('dkim=pass header.d=com'), null, D), false, 'a bare TLD is not alignment');
  assert.equal(authPassed(top('spf=pass smtp.mailfrom="a; dkim=pass header.d=example.com x"@example.net'), null, D), false, 'a quoted local part cannot add a result');
  assert.equal(authPassed(top('dkim=pass header.d=example.net header.d=example.com'), null, D), false, 'the first value of a property counts');
  assert.equal(authPassed(top('dmarc=pass header.from=example.com'), null, ''), false);
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const ctx = { allowed: makeAllow([OWNER]), ledger: {}, nowMs, maxAgeMin: 60, requireAuth: true, authKnown: true };
  const msg = { id: 'x', threadId: 't', from: `"<${OWNER}>" <attacker@example.net>`, receivedAt: new Date(nowMs - MIN).toISOString(), headers: { authResults: ['mx.example.net; dmarc=pass header.from=example.net'] } };
  assert.equal(decide(msg, ctx).reason, 'not-allowed');
  assert.equal(decide({ ...msg, from: OWNER }, ctx).reason, 'unauthenticated');
});

// ------------------------------------------------------------------------------------------- seeding, timeouts, header caps

test('--seed records every message it can see, past maxPerPass and whoever sent it, and sends nothing', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const many = [1, 2, 3, 4, 5].map((n) => ({ uid: n, at: nowMs - n * MIN, headers: [`From: ${OWNER}`, `Subject: s${n}`, `Message-ID: <q${n}@example.com>`, AUTH_PASS] }));
  many.push({ uid: 6, at: nowMs - 300 * MIN, headers: [`From: ${OWNER}`, 'Subject: old', 'Message-ID: <q6@example.com>', AUTH_PASS] });
  many.push({ uid: 7, at: nowMs - 6 * MIN, headers: ['From: someone@example.org', 'Subject: stranger', 'Message-ID: <q7@example.org>', AUTH_PASS] });
  const imap = await mockImap(many);
  const smtp = await mockSmtp();
  try {
    const { d, write } = setup();
    const cfg = { source: 'imap', allow: [OWNER], state: 'state.json', maxPerPass: 2, imap: { host: '127.0.0.1', port: imap.port, tls: false, user: BOT, passwordFile: 'pw.txt' }, smtp: { host: '127.0.0.1', port: smtp.port, tls: false } };
    let out = sink();
    assert.equal(await run(['--config', write(cfg), '--seed'], { stdout: out, env: {}, now: () => nowMs }), 0);
    assert.equal(out.json().seeded, true);
    assert.equal(out.json().replied.length, 7);
    assert.ok(out.json().replied.every((x) => x.seeded === true));
    assert.equal(out.json().skipped['over-max-per-pass'], undefined);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).replied).length, 7);
    out = sink();
    await run(['--config', write({ ...cfg, maxAgeMin: 600, maxPerPass: 10 }), '--send'], { stdout: out, env: {}, now: () => nowMs });
    assert.equal(out.json().replied.length, 0, 'nothing seeded is answered later, even with a wider window');
    assert.equal(out.json().skipped.already, 7);
    assert.equal(smtp.sent.length, 0);
  } finally { await imap.close(); await smtp.close(); }
});

test('a server that goes quiet cannot hang a pass (IMAP LOGOUT, SMTP mid-dialogue)', { timeout: 60_000 }, async () => {
  const imap = await mockImap([], { ignoreLogout: true });
  const smtp = await mockSmtp({ dropAtMailFrom: true });
  try {
    const session = await openImap({ host: '127.0.0.1', port: imap.port, tls: false, closeTimeoutMs: 200 });
    const t0 = Date.now();
    await session.close();
    assert.ok(Date.now() - t0 < 5000, `close took ${Date.now() - t0} ms`);
    const sending = sendMail({ host: '127.0.0.1', port: smtp.port, tls: false, from: BOT, to: OWNER, message: 'Subject: x\r\n\r\nb\r\n' });
    const res = await Promise.race([sending.then(() => 'sent', (e) => e.message), new Promise((r) => { setTimeout(() => r('hung'), 5000); })]);
    assert.match(res, /SMTP MAIL FROM: connection closed/);
  } finally { await imap.close(); await smtp.close(); }
});

test('In-Reply-To is one message id; References keeps whole ids and stays inside one header line', () => {
  const id = (n) => `<${String(n).padStart(4, '0')}${'x'.repeat(60)}@example.com>`;
  const many = Array.from({ length: 40 }, (_, i) => id(i)).join(' ');
  const head = buildReply({ from: BOT, to: OWNER, subject: 's', body: 'b', inReplyTo: `${id(99)} <second@example.com> junk`, references: `${many} not-an-id <${'y'.repeat(2000)}@example.com>` }).split('\r\n\r\n')[0];
  const line = (k) => head.split('\r\n').find((l) => l.startsWith(`${k}: `));
  assert.equal(line('In-Reply-To'), `In-Reply-To: ${id(99)}`);
  const refs = line('References').slice(12).split(' ');
  assert.ok(line('References').length <= 998, `References is ${line('References').length} characters`);
  assert.ok(refs.every((r) => /^<[^<>\s]+@[^<>\s]+>$/.test(r)), 'only whole message ids');
  assert.equal(refs.at(-1), id(99), 'the message being answered is last');
  assert.ok(!head.includes('y'.repeat(300)));
  assert.equal(buildReply({ from: BOT, to: OWNER, subject: 's', body: 'b', inReplyTo: 'garbage' }).includes('In-Reply-To'), false);
});

// ------------------------------------------------------------------------------------------- second review

test('requireAuth with no Authentication-Results to read is unauthenticated, never a pass', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const ctx = { allowed: makeAllow([OWNER]), ledger: {}, nowMs, maxAgeMin: 60, requireHeaders: false };
  const bare = { id: 'x', threadId: 't', from: OWNER, receivedAt: new Date(nowMs - MIN).toISOString(), headersKnown: false, headers: {} };
  assert.equal(decide(bare, { ...ctx, requireAuth: true }).reason, 'unauthenticated');
  assert.equal(decide({ ...bare, headers: undefined }, { ...ctx, requireAuth: true }).reason, 'unauthenticated');
  assert.equal(decide(bare, { ...ctx, requireAuth: false }).reply, true);
  // end to end: a Composio message that came back without headers
  const msgs = [{ messageId: 'c01', threadId: 't1', messageTimestamp: new Date(nowMs - MIN).toISOString(), sender: OWNER, subject: 's', labelIds: ['INBOX'] }];
  const { write } = setup();
  let out = sink();
  await run(['--config', write({ source: 'composio', allow: [OWNER], state: 'a.json', composio: { keyFile: 'key.txt', requireHeaders: false } }), '--send'], { stdout: out, env: {}, now: () => nowMs, fetchImpl: fakeComposio(msgs).fetchImpl });
  assert.deepEqual(out.json().skipped, { unauthenticated: 1 });
  assert.equal(out.json().replied.length, 0);
  out = sink();
  await run(['--config', write({ source: 'composio', allow: [OWNER], state: 'b.json', composio: { keyFile: 'key.txt', requireHeaders: false, requireAuth: false } }), '--send'], { stdout: out, env: {}, now: () => nowMs, fetchImpl: fakeComposio(msgs).fetchImpl });
  assert.equal(out.json().replied.length, 1, 'both switches off: the documented way to reply without headers');
});

test('a sender is answered at most maxPerSender times a day, and a capped message is never answered later', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const mail = (n, ...extra) => ({ uid: n, at: nowMs - n * MIN, headers: [`From: ${OWNER}`, `Subject: s${n}`, `Message-ID: <k${n}@example.com>`, AUTH_PASS, ...extra] });
  const imap = await mockImap([mail(1), mail(2), mail(3), mail(4), mail(5), mail(6, 'Precedence: auto_reply')]);
  const smtp = await mockSmtp();
  try {
    const { d, write } = setup();
    const cfg = write({ source: 'imap', allow: [OWNER], state: 'state.json', maxPerSender: 2, maxAgeMin: 3000, imap: { host: '127.0.0.1', port: imap.port, tls: false, user: BOT, passwordFile: 'pw.txt' }, smtp: { host: '127.0.0.1', port: smtp.port, tls: false } });
    let out = sink();
    await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs });
    assert.deepEqual(out.json().replied.map((x) => x.id), ['<k5@example.com>', '<k4@example.com>'], 'over IMAP every message is its own thread: the sender cap is what stops a loop');
    assert.deepEqual(out.json().skipped, { 'auto-submitted': 1, 'sender-cap': 3 });
    out = sink();
    await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs + 25 * 60 * MIN });
    assert.equal(out.json().replied.length, 0, 'a day later, still inside maxAgeMin: the capped messages stay unanswered');
    assert.equal(smtp.sent.length, 2);
    assert.throws(() => settings(['--config', write({ source: 'composio', allow: [OWNER], maxPerSender: 0, composio: { keyFile: 'key.txt' } })], {}, d), /maxPerSender/);
  } finally { await imap.close(); await smtp.close(); }
  // the same for a capped Gmail thread
  const loop = [4, 3, 2, 1].map((min, i) => gmailMsg({ messageId: `d0${i}`, threadId: 'loop', messageTimestamp: new Date(nowMs - min * MIN).toISOString(), sender: OWNER, subject: 'Re: ping' }));
  const { write } = setup();
  const cfg = write({ source: 'composio', allow: [OWNER], state: 'state.json', maxAgeMin: 3000, composio: { keyFile: 'key.txt' } });
  let out = sink();
  await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs, fetchImpl: fakeComposio(loop).fetchImpl });
  assert.deepEqual(out.json().skipped, { 'thread-cap': 1 });
  const next = fakeComposio(loop);
  out = sink();
  await run(['--config', cfg, '--send'], { stdout: out, env: {}, now: () => nowMs + 25 * 60 * MIN, fetchImpl: next.fetchImpl });
  assert.equal(next.calls.filter((c) => c.tool === 'GMAIL_REPLY_TO_THREAD').length, 0, 'the capped message does not resume the thread a day later');
  assert.deepEqual(out.json().skipped, { already: 4 });
});

test('the texts say what --seed really covers on each transport', async () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const seedRow = readme.split('\n').find((l) => l.startsWith('| `--seed`'));
  assert.doesNotMatch(seedRow, /Not limited by `maxPerPass`, the allow-list or `maxAgeMin`/);
  assert.match(seedRow, /Composio: only mail from allowed senders/);
  assert.match(seedRow, /IMAP: any sender/);
  const out = sink();
  await run(['--help'], { stdout: out, env: {} });
  assert.match(out.lines.join(''), /--seed +record every message one listing returns/);
});

test('a DMARC result for another domain refuses the sender whatever that result is', () => {
  const top = (s) => [`mx.example.net; ${s}`];
  const D = 'example.com';
  assert.equal(authPassed(top('spf=pass smtp.mailfrom=example.com; dmarc=none header.from=example.net'), null, D), false);
  assert.equal(authPassed(top('dkim=pass header.d=example.com; dmarc=temperror header.from=example.net'), null, D), false);
  assert.equal(authPassed(top('dmarc=bestguesspass header.from=example.net; spf=pass smtp.mailfrom=example.com'), null, D), false);
  assert.equal(authPassed(top('spf=pass smtp.mailfrom=example.com; dmarc=none header.from=example.com'), null, D), true, 'no policy, aligned SPF');
  assert.equal(authPassed(top('dmarc=none header.from=example.com'), null, D), false, 'no policy and nothing aligned');
});

test('Composio: two From headers mean no sender; the summary field never stands in for them', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  assert.equal(gmailHeaders({ headers: [{ name: 'From', value: OWNER }, { name: 'from', value: 'attacker@example.net' }] }).from, '');
  assert.equal(gmailHeaders({ headers: [{ name: 'From', value: OWNER }] }).from, OWNER);
  const two = gmailMsg({ messageId: 'e01', threadId: 't1', messageTimestamp: new Date(nowMs - MIN).toISOString(), sender: OWNER, subject: 's' });
  two.payload.headers.push({ name: 'From', value: 'attacker@example.net' });
  const none = gmailMsg({ messageId: 'e02', threadId: 't2', messageTimestamp: new Date(nowMs - MIN).toISOString(), sender: OWNER, subject: 's' });
  none.payload.headers = none.payload.headers.filter((h) => h.name !== 'From');
  const net1 = fakeComposio([two, none]);
  const { write } = setup();
  const out = sink();
  await run(['--config', write({ source: 'composio', allow: [OWNER], state: 'state.json', composio: { keyFile: 'key.txt' } }), '--send'], { stdout: out, env: {}, now: () => nowMs, fetchImpl: net1.fetchImpl });
  assert.deepEqual(out.json().skipped, { 'not-allowed': 2 });
  assert.equal(out.json().replied.length, 0);
});

test('Return-Path: only <> and mailer-daemon or postmaster are bounces; a mail service bounce address is not', () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const ctx = { allowed: makeAllow([OWNER]), ledger: {}, nowMs, maxAgeMin: 60, requireAuth: false };
  const m = (returnPath) => ({ id: 'x', threadId: 't', from: OWNER, receivedAt: new Date(nowMs - MIN).toISOString(), headers: { returnPath } });
  assert.equal(decide(m('<bounces+123-ab=example.com@em1.example.com>'), ctx).reply, true);
  assert.equal(decide(m('<bounce-md_31.6f=owner@example.com>'), ctx).reply, true);
  assert.equal(decide(m('<noreply@example.com>'), ctx).reply, true);
  assert.equal(decide(m('<>'), ctx).reason, 'bounce');
  assert.equal(decide(m('< >'), ctx).reason, 'bounce');
  assert.equal(decide(m('<MAILER-DAEMON@mx.example.com>'), ctx).reason, 'bounce');
  assert.equal(decide(m('postmaster@example.com'), ctx).reason, 'bounce');
});
