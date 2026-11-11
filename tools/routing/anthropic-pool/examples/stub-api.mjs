#!/usr/bin/env node
// stub-api.mjs: a local imitation of the Anthropic Messages and Message Batches endpoints, so anthropic-pool can be
// tried and tested with no network and no spending. It answers every prompt with a canned reply and fixed usage.
//
//   node examples/stub-api.mjs [--port 8787]     then:  ANTHROPIC_BASE_URL=http://127.0.0.1:8787 node anthropic-pool.mjs ...
//
// Endpoints: POST /v1/messages, POST /v1/messages/batches, GET /v1/messages/batches/:id, GET /v1/messages/batches/:id/results.
// A batch ends after `pollsBeforeEnd` retrieves (default 1). A prompt containing "FAIL" comes back as an errored result.
// Any x-api-key starting "sk-ant-" is accepted unless `key` is given, in which case only that one is.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

export function startStub({ key = null, pollsBeforeEnd = 1, usage = { input_tokens: 1000, output_tokens: 500 }, port = 0 } = {}) {
  const batches = new Map();
  const requests = [];
  let n = 0;
  const reply = (params) => {
    const prompt = String((params.messages && params.messages[0] && params.messages[0].content) || '');
    return { id: `msg_stub_${++n}`, type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: `stub reply to: ${prompt.slice(0, 40)}` }], usage: { ...usage } };
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const send = (status, obj, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      const k = req.headers['x-api-key'];
      requests.push({ method: req.method, path: req.url, key: k, version: req.headers['anthropic-version'], body });
      if (!k || (key ? k !== key : !String(k).startsWith('sk-ant-'))) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      let json = {};
      try { json = body ? JSON.parse(body) : {}; } catch { return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'body is not JSON' } }); }
      const base = `http://${req.headers.host}`;
      const u = new URL(req.url, base);
      if (req.method === 'POST' && u.pathname === '/v1/messages') return send(200, reply(json));
      if (req.method === 'POST' && u.pathname === '/v1/messages/batches') {
        if (!Array.isArray(json.requests) || !json.requests.length) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'requests must be a non-empty array' } });
        const id = `msgbatch_stub_${++n}`;
        batches.set(id, { id, requests: json.requests, polls: 0, forceEnded: false });
        return send(200, { id, type: 'message_batch', processing_status: 'in_progress', request_counts: { processing: json.requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 } });
      }
      const m = u.pathname.match(/^\/v1\/messages\/batches\/([^/]+)(\/results)?$/);
      if (req.method === 'GET' && m) {
        const b = batches.get(decodeURIComponent(m[1]));
        if (!b) return send(404, { type: 'error', error: { type: 'not_found_error', message: 'no such batch' } });
        if (m[2]) {
          const lines = b.requests.map((r) => /FAIL/.test(JSON.stringify(r.params.messages))
            ? { custom_id: r.custom_id, result: { type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error', message: 'stub failure' } } } }
            : { custom_id: r.custom_id, result: { type: 'succeeded', message: reply(r.params) } });
          return send(200, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'application/x-jsonl');
        }
        b.polls++;
        const ended = b.forceEnded || b.polls >= pollsBeforeEnd;
        return send(200, { id: b.id, type: 'message_batch', processing_status: ended ? 'ended' : 'in_progress',
          results_url: ended ? `${base}/v1/messages/batches/${b.id}/results` : null });
      }
      return send(404, { type: 'error', error: { type: 'not_found_error', message: `no route ${req.method} ${u.pathname}` } });
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    requests, batches,
    endAll: () => { for (const b of batches.values()) b.forceEnded = true; },
    close: () => new Promise((r) => srv.close(r)),
  })));
}

const direct = (() => { try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } })();
if (direct) {
  const i = process.argv.indexOf('--port');
  const s = await startStub({ port: i > 0 ? Number(process.argv[i + 1]) : 8787 });
  process.stdout.write(JSON.stringify({ ok: true, base_url: s.url, note: 'set ANTHROPIC_BASE_URL to this; Ctrl+C stops it' }) + '\n');
}
