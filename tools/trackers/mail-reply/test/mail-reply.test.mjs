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
import { buildReply, encodeHeader } from '../lib/smtp.mjs';

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

function mockImap(messages, { password = PASSWORD } = {}) {
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
        else if (/^UID SEARCH /i.test(cmd)) sock.write(`* SEARCH ${messages.map((m) => m.uid).join(' ')}\r\n${tag} OK search done\r\n`);
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
        else if (/^LOGOUT/i.test(cmd)) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
        else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ port: server.address().port, log, close: () => new Promise((r) => server.close(r)) })));
}

function mockSmtp({ failRcpt = false } = {}) {
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

test('Composio Connect (ck_ key): lists mail from the allow-list, replies in the thread to the sender, labels it', async () => {
  const nowMs = Date.parse('2026-11-12T10:00:00Z');
  const msgs = [
    { messageId: 'a1b2c3', threadId: 't1', messageTimestamp: new Date(nowMs - 2 * MIN).toISOString(), sender: `Owner <${OWNER}>`, subject: 'note this' },
    { messageId: 'd4e5f6', threadId: 't2', messageTimestamp: new Date(nowMs - 2 * MIN).toISOString(), sender: 'x@evil-example.com', subject: 'not allowed' },
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
  assert.equal(tools[0].args.query, `from:(${OWNER}) newer_than:2d`);
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
  const msgs = [{ messageId: 'a1b2c3', threadId: 't1', messageTimestamp: new Date(nowMs - MIN).toISOString(), sender: OWNER, subject: 's' }];
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
  assert.equal(authPassed([AUTH_PASS.slice(24)]), true);
  assert.equal(authPassed([AUTH_FAIL.slice(24), AUTH_PASS.slice(24)]), false, 'a forged lower header is ignored');
  assert.equal(authPassed(['mx.example.net; spf=pass; dkim=pass']), true);
  assert.equal(authPassed(['mx.example.net; spf=pass; dkim=fail']), false);
  assert.equal(authPassed([AUTH_PASS.slice(24)], 'mx.other.net'), false, 'authServId pins the server');
  assert.equal(authPassed([]), false);
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
