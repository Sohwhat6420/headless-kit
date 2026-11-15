#!/usr/bin/env node
// stub-github.mjs: a local imitation of the three GitHub REST endpoints lane-mailbox reads, backed by a plain folder,
// so the poller can be tried (and tested end to end) with no network and no token. Each request rescans the folder;
// any change becomes a new "commit" whose added files are the new ones.
//
//   node examples/stub-github.mjs --dir ./fake-mailbox [--port 8788]
//   then: GH_TOKEN=stub node lane-mailbox.mjs wait --repo example-owner/example-mailbox --api-base http://127.0.0.1:8788
//   and drop a file into ./fake-mailbox/inbox/ to wake it.
//
// Endpoints: GET /repos/:owner/:repo/commits/:branch (ETag, 304), GET /repos/:owner/:repo/compare/:a...:b,
// GET /repos/:owner/:repo/contents/:path?ref=... (raw). Any "Authorization: Bearer <something>" is accepted.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

function listing(dir) {
  const out = {};
  const walk = (d, rel) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else { const st = fs.statSync(path.join(d, e.name)); out[r] = `${st.size}:${st.mtimeMs}`; }
    }
  };
  walk(dir, '');
  return out;
}

export function startStub({ dir, port = 0 } = {}) {
  const commits = []; // [{ sha, files: { path: stamp }, changed: [{ filename, status }] }]
  const requests = [];
  const rescan = () => {
    const now = listing(dir);
    const prev = commits.at(-1)?.files || {};
    const changed = [];
    for (const [p, v] of Object.entries(now)) if (!(p in prev)) changed.push({ filename: p, status: 'added' }); else if (prev[p] !== v) changed.push({ filename: p, status: 'modified' });
    for (const p of Object.keys(prev)) if (!(p in now)) changed.push({ filename: p, status: 'removed' });
    if (!commits.length || changed.length) {
      const sha = crypto.createHash('sha1').update(JSON.stringify([commits.length, now])).digest('hex');
      commits.push({ sha, files: now, changed });
    }
    return commits.at(-1);
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://stub');
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    requests.push({ method: req.method, path: u.pathname, auth: !!req.headers.authorization });
    if (!/^Bearer \S+/.test(req.headers.authorization || '')) return send(401, { message: 'Requires authentication' });
    let m;
    if ((m = /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+$/.exec(u.pathname))) {
      const head = rescan();
      const etag = `"${head.sha}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
      return send(200, { sha: head.sha }, { etag });
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(u.pathname))) {
      const a = commits.findIndex((c) => c.sha === m[1]), b = commits.findIndex((c) => c.sha === m[2]);
      if (a < 0 || b < 0) return send(404, { message: 'Not Found' });
      return send(200, { status: 'ahead', files: commits.slice(a + 1, b + 1).flatMap((c) => c.changed) });
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(u.pathname))) {
      const rel = decodeURIComponent(m[1]);
      const full = path.resolve(dir, rel);
      if (!full.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(full)) return send(404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(fs.readFileSync(full));
    }
    return send(404, { message: 'Not Found' });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${srv.address().port}`, requests, close: () => new Promise((r) => srv.close(r)) });
  }));
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const dir = path.resolve(arg('--dir', '.'));
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  const s = await startStub({ dir, port: Number(arg('--port', 8788)) });
  process.stderr.write(`stub GitHub for ${dir} on ${s.url}\n`);
}
