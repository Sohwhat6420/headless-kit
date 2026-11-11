// Offline tests: a local mock of the Arctic Shift API. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, flattenTree, pickPost, matches } from '../reddit-pull.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reddit-pull.mjs');

const post = (i, over = {}) => ({ id: `p${i}`, subreddit: 'demo', created_utc: 1_700_000_000 - i, author: 'a', link_flair_text: null,
  score: i, num_comments: 0, title: `post ${i}`, url: 'https://example.com', selftext: i % 2 ? 'claude code' : 'other', ...over });

function mock(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const json = (res, data, status = 200, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ data }));
};
function cli(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { windowsHide: true, env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('parseArgs reads flags and rejects unknown ones', () => {
  const o = parseArgs(['--sub', 'a', '--sub', 'b', '--comments', '--min-score', '5', '--grep', 'x|y', '--out', 'o']);
  assert.deepEqual(o.subs, ['a', 'b']);
  assert.equal(o.comments, true);
  assert.equal(o.minScore, 5);
  assert.ok(o.grep.test('Y'));
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.throws(() => parseArgs(['--sub']), /needs a value/);
});

test('flattenTree tags depth and skips "more" nodes', () => {
  const c = (id, kids) => ({ kind: 't1', data: { id, created_utc: 1_700_000_000, link_id: 't3_p', body: id, replies: kids ? { data: { children: kids } } : '' } });
  const rows = flattenTree([c('a', [c('b', [c('c')])]), { kind: 'more', data: {} }, c('d')]);
  assert.deepEqual(rows.map((r) => [r.id, r.depth]), [['a', 0], ['b', 1], ['c', 2], ['d', 0]]);
  assert.equal(rows[0].post, 'p');
});

test('pickPost truncates long bodies; matches greps title and body', () => {
  const p = pickPost(post(1, { selftext: 'x'.repeat(9000) }));
  assert.equal(p.body.length, 6000);
  assert.ok(matches({ title: 'Hello', body: '' }, /hello/i));
  assert.ok(!matches({ title: 'Hello', body: '' }, /bye/i));
});

test('CLI pulls two pages, filters, writes files and prints one JSON line', async () => {
  const all = Array.from({ length: 130 }, (_, i) => post(i + 1));
  const srv = await mock((req, res) => {
    const u = new URL(req.url, 'http://x');
    const before = Number(u.searchParams.get('before')) || Infinity;
    const page = all.filter((p) => p.created_utc < before).slice(0, 100);
    json(res, page);
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const r = await cli(['--sub', 'demo', '--min-score', '100', '--grep', 'claude', '--out', out, '--api-base', `http://127.0.0.1:${srv.address().port}`]);
  srv.close();
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 1);
  const res = JSON.parse(lines[0]);
  assert.equal(res.ok, true);
  // ids 100..130 have score >= 100; odd ones match "claude code" -> 15
  assert.equal(res.subs[0].posts, 15);
  const posts = JSON.parse(fs.readFileSync(path.join(out, 'demo.posts.json'), 'utf8'));
  assert.equal(posts.length, 15);
  assert.ok(posts[0].score >= posts[1].score, 'sorted by score, high first');
});

test('CLI waits out a 429 using X-RateLimit-Reset, then succeeds', async () => {
  let hits = 0;
  const srv = await mock((req, res) => {
    hits++;
    if (hits === 1) return json(res, [], 429, { 'x-ratelimit-reset': '1' });
    json(res, [post(1)]);
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const t0 = Date.now();
  const r = await cli(['--sub', 'demo', '--out', out, '--api-base', `http://127.0.0.1:${srv.address().port}`]);
  srv.close();
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - t0 >= 900, 'waited about a second');
  assert.equal(JSON.parse(r.out).subs[0].posts, 1);
});

test('CLI reports failure as JSON and exit 1 when the API stays down', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  // Nothing listens on port 9; fetch fails every time. Shrink the wait by using --max-pages 1 (retries still run).
  const r = await cli(['--sub', 'demo', '--out', out, '--api-base', 'http://127.0.0.1:9', '--max-pages', '1'], { REDDIT_PULL_RETRY_MS: '20' });
  assert.equal(r.code, 1);
  const res = JSON.parse(r.out.trim());
  assert.equal(res.ok, false);
  assert.ok(res.failed_requests >= 1);
});

test('CLI usage errors exit 2 with JSON', async () => {
  const r = await cli(['--sub', 'demo']);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out.trim()).ok, false);
});

test('CLI thread mode flattens the tree', async () => {
  const node = (id, kids) => ({ kind: 't1', data: { id, created_utc: 1_700_000_000, link_id: 't3_p1', body: id, replies: kids ? { data: { children: kids } } : '' } });
  const srv = await mock((req, res) => {
    if (req.url.startsWith('/posts/ids')) return json(res, [post(1)]);
    json(res, [node('a', [node('b')])]);
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const r = await cli(['--thread', 'p1', '--out', out, '--api-base', `http://127.0.0.1:${srv.address().port}`]);
  srv.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).comments, 2);
});
