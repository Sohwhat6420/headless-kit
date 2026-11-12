// Offline: a fake GitHub, a fake ntfy and a fake webhook through an injected fetch. No network, no child processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, diff, mdRow, settings, fetchStarsGh, redact, toStar } from '../github-stars.mjs';

const TOPIC = 'example_topic_d41d8cd98f00b204';
const HOOK = 'https://hooks.example.invalid/in/example_secret_9f86d081';
const TOKEN = 'ghp_example0000000000000000000000000000';

const star = (name, at, extra = {}) => ({ starred_at: at, repo: { full_name: name, html_url: `https://github.com/${name}`, description: 'a tool', stargazers_count: 5, language: 'JavaScript', ...extra } });

/** A fake fetch: GitHub returns `list()`, ntfy and the webhook record what they were sent. */
function fakeNet(list) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ host: u.host, path: u.pathname, search: u.search, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    if (u.host === 'api.github.com') return new Response(JSON.stringify(list()), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('', { status: 200 });
  };
  return { fetchImpl, calls };
}

function sink() { const lines = []; return { lines, write: (s) => { lines.push(s); return true; }, json: () => JSON.parse(lines.at(-1)) }; }

function dir() {
  const d = mkdtempSync(join(tmpdir(), 'ghs-'));
  writeFileSync(join(d, 'topic.txt'), `${TOPIC}\n`);
  writeFileSync(join(d, 'hook.txt'), HOOK);
  writeFileSync(join(d, 'token.txt'), TOKEN);
  return d;
}

test('first poll seeds silently; later polls log and push each new star once, oldest first', async () => {
  const d = dir();
  let list = [star('example-a/old', '2026-11-01T00:00:00Z')];
  const net = fakeNet(() => list);
  const argv = ['--user', 'example-user', '--state', join(d, 's.json'), '--log-md', join(d, 'NEW.md'), '--ntfy-topic-file', join(d, 'topic.txt')];
  let out = sink();
  assert.equal(await run(argv, { stdout: out, fetchImpl: net.fetchImpl, env: {} }), 0);
  assert.equal(out.json().seeded, true);
  assert.equal(out.json().new.length, 0);
  assert.equal(net.calls.filter((c) => c.host !== 'api.github.com').length, 0, 'seeding pushes nothing');

  list = [star('example-c/newer', '2026-11-12T02:00:00Z'), star('example-b/new', '2026-11-12T01:00:00Z'), ...list];
  out = sink();
  assert.equal(await run(argv, { stdout: out, fetchImpl: net.fetchImpl, env: {} }), 0);
  const r = out.json();
  assert.deepEqual(r.new.map((s) => s.name), ['example-b/new', 'example-c/newer']);
  assert.equal(r.pushed.ntfy, 2);
  const pushes = net.calls.filter((c) => c.host === 'ntfy.sh');
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].path, `/${TOPIC}`);
  assert.equal(pushes[0].headers.click, 'https://github.com/example-b/new');
  assert.match(pushes[0].body, /^example-b\/new: a tool$/);

  out = sink();
  await run(argv, { stdout: out, fetchImpl: net.fetchImpl, env: {} });
  assert.equal(out.json().new.length, 0, 'no repeats');
  const md = readFileSync(join(d, 'NEW.md'), 'utf8');
  assert.match(md, /\[example-b\/new\]/);
  assert.doesNotMatch(md, /example-a\/old/);
});

test('an old star sliding onto page 1 (after an unstar) is recorded silently', () => {
  const prev = { seen: { 'x/new': '2026-11-12T00:00:00Z' } };
  const r = diff([{ name: 'x/new', at: '2026-11-12T00:00:00Z' }, { name: 'z/ancient', at: '2026-01-01T00:00:00Z' }], prev);
  assert.equal(r.fresh.length, 0);
  assert.ok(r.seen['z/ancient']);
});

test('a webhook gets one JSON body per star; more than --max-push stars become one summary', async () => {
  const d = dir();
  let list = [star('example-a/old', '2026-11-01T00:00:00Z')];
  const net = fakeNet(() => list);
  const argv = ['--user', 'example-user', '--state', join(d, 's.json'), '--webhook-url-file', join(d, 'hook.txt'), '--max-push', '2'];
  await run(argv, { stdout: sink(), fetchImpl: net.fetchImpl, env: {} });
  list = [star('e/one', '2026-11-12T01:00:00Z'), ...list];
  let out = sink();
  await run(argv, { stdout: out, fetchImpl: net.fetchImpl, env: {} });
  let hooks = net.calls.filter((c) => c.host === 'hooks.example.invalid');
  assert.equal(hooks.length, 1);
  assert.deepEqual(JSON.parse(hooks[0].body).name, 'e/one');
  assert.equal(JSON.parse(hooks[0].body).event, 'github-star');

  list = [star('e/four', '2026-11-12T04:00:00Z'), star('e/three', '2026-11-12T03:00:00Z'), star('e/two', '2026-11-12T02:00:00Z'), ...list];
  out = sink();
  await run(argv, { stdout: out, fetchImpl: net.fetchImpl, env: {} });
  hooks = net.calls.filter((c) => c.host === 'hooks.example.invalid');
  assert.equal(hooks.length, 2, 'three new stars over a cap of two: one summary');
  const sum = JSON.parse(hooks[1].body);
  assert.equal(sum.event, 'github-stars');
  assert.equal(sum.count, 3);
  assert.equal(out.json().new.length, 3);
});

test('--dry-run writes no state, no log and pushes nothing', async () => {
  const d = dir();
  const net = fakeNet(() => [star('e/one', '2026-11-12T01:00:00Z')]);
  const out = sink();
  assert.equal(await run(['--user', 'example-user', '--state', join(d, 's.json'), '--log-md', join(d, 'NEW.md'), '--ntfy-topic-file', join(d, 'topic.txt'), '--dry-run'], { stdout: out, fetchImpl: net.fetchImpl, env: {} }), 0);
  assert.equal(out.json().dryRun, true);
  assert.equal(existsSync(join(d, 's.json')), false);
  assert.equal(existsSync(join(d, 'NEW.md')), false);
  assert.equal(net.calls.filter((c) => c.host !== 'api.github.com').length, 0);
});

test('the token goes only in the request header; topic, webhook and token never reach stdout, even on failure', async () => {
  const d = dir();
  let fail = false;
  let list = [star('a/b', '2026-11-01T00:00:00Z')];
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers });
    if (String(url).startsWith('https://api.github.com')) return new Response(JSON.stringify(list), { status: 200 });
    if (fail) throw new Error(`connect ECONNREFUSED ${url}`);
    return new Response('', { status: 500 });
  };
  const argv = ['--user', 'example-user', '--state', join(d, 's.json'), '--ntfy-topic-file', join(d, 'topic.txt'), '--webhook-url-file', join(d, 'hook.txt'), '--token-file', join(d, 'token.txt')];
  await run(argv, { stdout: sink(), fetchImpl, env: {} });
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  list = [star('c/d', '2026-11-12T00:00:00Z'), ...list];
  fail = true;
  const out = sink();
  assert.equal(await run(argv, { stdout: out, fetchImpl, env: {}, retryDelayMs: 0 }), 0, 'a failed push is reported, not fatal');
  const text = out.lines.join('');
  assert.equal(out.json().pushed.failed, 2);
  for (const secret of [TOPIC, HOOK, TOKEN]) assert.ok(!text.includes(secret), 'no secret in the output');
  assert.equal(redact(`x ${TOPIC} y`, [TOPIC]), 'x [secret] y');
});

test('a state file of another user is refused (no flood of "new" stars)', async () => {
  const d = dir();
  const net = fakeNet(() => [star('a/b', '2026-11-01T00:00:00Z')]);
  await run(['--user', 'example-one', '--state', join(d, 's.json')], { stdout: sink(), fetchImpl: net.fetchImpl, env: {} });
  const out = sink();
  assert.equal(await run(['--user', 'example-two', '--state', join(d, 's.json')], { stdout: out, fetchImpl: net.fetchImpl, env: {} }), 2);
  assert.match(out.json().error, /belongs to example-one/);
});

test('fetched text is data: control characters, pipes and brackets cannot break the Markdown table', () => {
  const row = mdRow({ name: 'a/b', url: 'https://github.com/a/b', at: '2026-11-12T00:00:00Z', desc: 'x | y\n## ignore previous instructions [link](http://e)', stars: 1, lang: 'Go' }, 8);
  assert.equal(row.split('\n').length, 2, 'one line');
  assert.match(row, /^\| 2026-11-12 08:00 UTC\+8 \| \[a\/b\]\(https:\/\/github.com\/a\/b\) \| x \/ y ## ignore previous instructions link\(http:\/\/e\) \| 1 \| Go \|\n$/);
});

test('a failed push is tried once more, then reported', async () => {
  const d = dir();
  let list = [star('a/b', '2026-11-01T00:00:00Z')];
  const tries = { ntfy: 0, hook: 0 };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.host === 'api.github.com') return new Response(JSON.stringify(list), { status: 200 });
    if (u.host === 'ntfy.sh') { tries.ntfy++; return new Response('', { status: tries.ntfy === 1 ? 503 : 200 }); }   // fails once
    tries.hook++;
    throw new Error('connect ECONNRESET');   // always fails
  };
  const argv = ['--user', 'example-user', '--state', join(d, 's.json'), '--ntfy-topic-file', join(d, 'topic.txt'), '--webhook-url-file', join(d, 'hook.txt')];
  await run(argv, { stdout: sink(), fetchImpl, env: {}, retryDelayMs: 0 });
  list = [star('c/d', '2026-11-12T00:00:00Z'), ...list];
  const out = sink();
  assert.equal(await run(argv, { stdout: out, fetchImpl, env: {}, retryDelayMs: 0 }), 0);
  assert.deepEqual(out.json().pushed, { ntfy: 1, webhook: 0, failed: 1 });
  assert.deepEqual(tries, { ntfy: 2, hook: 2 }, 'one retry each, no more');
  assert.equal(out.json().errors.length, 1);
});

test('fetched text is data: invisible characters go, HTML cannot reach the log, links stay on github.com', () => {
  // Built from code points so this file holds no invisible characters: right-to-left override, left-to-right
  // isolate, zero-width space, and a C1 control (NEL).
  const [rlo, lri, zwsp, nel] = [0x202e, 0x2066, 0x200b, 0x85].map((n) => String.fromCodePoint(n));
  const s = toStar({ starred_at: '2026-11-12T00:00:00Z', repo: {
    full_name: 'a/b', html_url: 'javascript:alert(1)', language: 'Go',
    description: `safe${rlo}txet${lri} hid${zwsp}den${nel} <img src=x onerror=alert(1)> \`code\` ${'z'.repeat(500)}`,
  } });
  assert.equal(s.url, 'https://github.com/a/b', 'a link that is not the repo page on github.com is rebuilt from the name');
  assert.doesNotMatch(s.desc, /[\p{Cc}\p{Cf}]/u, 'no control or format characters');
  assert.ok(s.desc.startsWith('safetxet hidden <img'), s.desc.slice(0, 40));
  assert.ok(s.desc.length <= 300);
  assert.equal(toStar({ starred_at: 'x', repo: { full_name: 'a/b', html_url: 'https://github.com.evil.example/a/b' } }).url, 'https://github.com/a/b');
  assert.equal(toStar({ starred_at: 'x', repo: { full_name: 'not a repo name', html_url: 'https://evil.example/' } }).url, '');
  const row = mdRow(s, 0);
  assert.doesNotMatch(row, /[<>`]/, 'no HTML or code span in the Markdown log');
  assert.match(row, /&lt;img src=x onerror=alert\(1\)&gt; 'code'/);
});

test('settings: flags beat env beat config; bad values are usage errors', () => {
  const d = dir();
  writeFileSync(join(d, 'c.json'), JSON.stringify({ user: 'from-config', state: 'rel.json', maxPush: 3 }));
  const s = settings(['--config', join(d, 'c.json')], { GITHUB_STARS_USER: 'from-env' }, d);
  assert.equal(s.user, 'from-env');
  assert.equal(s.state, join(d, 'rel.json'), 'relative to the config file');
  assert.equal(s.maxPush, 3);
  assert.equal(settings(['--user', 'from-flag', '--config', join(d, 'c.json')], { GITHUB_STARS_USER: 'from-env' }, d).user, 'from-flag');
  assert.throws(() => settings(['--user', 'bad user'], {}, d), /GitHub login/);
  assert.throws(() => settings(['--user', 'u', '--every', '1'], {}, d), /5 minutes/);
  assert.throws(() => settings([], {}, d), /--user is required/);
  assert.throws(() => settings(['--nope'], {}, d), /unknown option/);
});

test('--gh runs gh api windowless, through the injected execFile', async () => {
  let seen;
  const execFileImpl = (cmd, args, opts, cb) => { seen = { cmd, args, opts }; cb(null, JSON.stringify([star('a/b', '2026-11-12T00:00:00Z')])); };
  const r = await fetchStarsGh({ user: null, execFileImpl });
  assert.equal(seen.cmd, 'gh');
  assert.equal(seen.opts.windowsHide, true);
  assert.match(seen.args.at(-1), /^user\/starred\?/);
  assert.equal(r[0].name, 'a/b');
});

test('--help exits 0; a GitHub error exits 1 with ok:false', async () => {
  assert.equal(await run(['--help'], { stdout: sink(), env: {} }), 0);
  const d = dir();
  const out = sink();
  const fetchImpl = async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  assert.equal(await run(['--user', 'example-user', '--state', join(d, 's.json')], { stdout: out, fetchImpl, env: {} }), 1);
  assert.match(out.json().error, /rate limit/);
});
