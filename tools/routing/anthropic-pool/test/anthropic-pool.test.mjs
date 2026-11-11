// Offline tests: a local stub of the Messages and Batches endpoints, a fake `claude` script, made-up keys. Run: node --test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cycle, normaliseConfig, dirsOf, rankPools, choosePool, poolState, costOf, findCredential, Refusal, AGENT_ENV_ALLOW } from '../anthropic-pool.mjs';
import { startStub } from '../examples/stub-api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'anthropic-pool.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-pool-test-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// Made-up keys, assembled at run time. None is real.
const KEY_A = 'sk-ant-' + 'api03-' + crypto.randomBytes(12).toString('hex');
const KEY_B = 'sk-ant-' + 'api03-' + crypto.randomBytes(12).toString('hex');
const SEEN = []; // every stdout/stderr of every CLI run, checked for key values at the end

const PRICES = { 'claude-sonnet-5-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.1 }, 'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_write: 0.125, cache_read: 0.01 } };
let n = 0;
function sandbox(over = {}) {
  const dir = path.join(ROOT, `s${++n}`);
  fs.mkdirSync(dir);
  const cfg = {
    ledger_dir: 'ledger',
    price_per_mtok_usd: PRICES,
    pools: [
      { name: 'alpha', key_env: 'TEST_KEY_A', monthly_budget_usd: 10, reset_day: 20, per_run_cap_usd: 2, max_concurrent: 2 },
      { name: 'beta', key_env: 'TEST_KEY_B', monthly_budget_usd: 10, reset_day: 13, per_run_cap_usd: 2, max_concurrent: 2 },
    ],
    ...over,
  };
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return { dir, file, cfg, ledger: path.join(dir, 'ledger', 'ledger.jsonl'), batches: path.join(dir, 'ledger', 'runs', 'batches.jsonl') };
}
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// Async spawn: the stub server lives in this process, so the CLI must not block it.
function cli(args, env = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^ANTHROPIC_/i.test(k)) delete base[k];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { windowsHide: true, env: { ...base, TEST_KEY_A: KEY_A, TEST_KEY_B: KEY_B, ANTHROPIC_POOL_NOW: '2026-11-11T12:00:00Z', ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      SEEN.push(out, err);
      let json = null;
      try { json = JSON.parse(out.trim().split('\n').pop()); } catch {}
      resolve({ code, out, err, json });
    });
  });
}

function ctxFor(s, env, now = Date.parse('2026-11-11T12:00:00Z')) {
  const cfg = normaliseConfig(JSON.parse(fs.readFileSync(s.file, 'utf8')), s.dir, {});
  return { cfg, env, dirs: dirsOf(cfg), now: () => now };
}

test('cycle: starts on the reset day, clamps to short months, honours the time zone', () => {
  const c = cycle(Date.parse('2026-11-11T12:00:00Z'), 13);
  assert.equal(new Date(c.start).toISOString(), '2026-10-13T00:00:00.000Z');
  assert.equal(new Date(c.end).toISOString(), '2026-11-13T00:00:00.000Z');
  const feb = cycle(Date.parse('2027-02-28T12:00:00Z'), 31);
  assert.equal(new Date(feb.start).toISOString(), '2027-02-28T00:00:00.000Z');
  assert.equal(new Date(feb.end).toISOString(), '2027-03-31T00:00:00.000Z');
  const sgt = cycle(Date.parse('2026-11-12T17:00:00Z'), 13, 8); // 01:00 on the 13th at UTC+8: a new cycle
  assert.equal(new Date(sgt.start).toISOString(), '2026-11-12T16:00:00.000Z');
});

test('pool choice: the soonest-expiring ready pool, falling back when it has no key, no credit or no free slot', () => {
  const s = sandbox();
  const env = { TEST_KEY_A: KEY_A, TEST_KEY_B: KEY_B };
  assert.equal(choosePool(ctxFor(s, env)).name, 'beta', 'beta resets on the 13th, before alpha on the 20th');
  assert.equal(choosePool(ctxFor(s, { TEST_KEY_A: KEY_A })).name, 'alpha', 'beta has no key');
  assert.equal(choosePool(ctxFor(s, { TEST_KEY_A: KEY_A, TEST_KEY_B: 'not-a-key' })).name, 'alpha', 'beta key has the wrong prefix');
  // beta at its run limit (claims held by this live process)
  const ctx = ctxFor(s, env);
  fs.mkdirSync(ctx.dirs.inflight, { recursive: true });
  for (const i of [1, 2]) fs.writeFileSync(path.join(ctx.dirs.inflight, `r${i}.json`), JSON.stringify({ run_id: `r${i}`, pid: process.pid, reserve_usd: 0.1, pool: 'beta', ts: new Date().toISOString() }));
  assert.equal(choosePool(ctx).name, 'alpha', 'beta has 2/2 runs in flight');
  assert.equal(poolState(ctx, ctx.cfg.pools[1]).reserved_usd, 0.2);
  fs.rmSync(ctx.dirs.inflight, { recursive: true });
  // beta spent out this cycle
  fs.mkdirSync(path.dirname(s.ledger), { recursive: true });
  fs.writeFileSync(s.ledger, JSON.stringify({ ts: '2026-11-01T00:00:00Z', pool: 'beta', cost_usd: 9.99 }) + '\n');
  assert.equal(choosePool(ctx).name, 'alpha', 'beta has USD0.01 left');
  // a row from the previous cycle does not count
  fs.writeFileSync(s.ledger, JSON.stringify({ ts: '2026-10-01T00:00:00Z', pool: 'beta', cost_usd: 9.99 }) + '\n');
  assert.equal(choosePool(ctx).name, 'beta');
  // nothing ready: a refusal with exit code 3 that names each pool
  assert.throws(() => choosePool(ctxFor(s, {})), (e) => e instanceof Refusal && e.code === 3 && /alpha/.test(e.message) && /beta/.test(e.message));
  assert.equal(rankPools(ctxFor(s, {}), { ignoreKeys: true }).ready[0].pool.name, 'beta', 'a dry run may rank pools without keys');
});

test('costOf: half price for batches, cache writes split 5 min / 1 h', () => {
  const p = PRICES['claude-sonnet-5-5'];
  assert.equal(costOf({ input_tokens: 1000, output_tokens: 500 }, p), 0.007);
  assert.equal(costOf({ input_tokens: 1000, output_tokens: 500 }, p, 0.5), 0.0035);
  const c = costOf({ cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 } }, p);
  assert.equal(Math.round(c * 1e6), 2000 * 2.5 + 1000 * 4); // 1000 unnamed tokens stay at the 5-minute rate
});

test('budget refusals exit 3: a spent pool, and a worst case over the cap', async () => {
  const s = sandbox();
  fs.mkdirSync(path.dirname(s.ledger), { recursive: true });
  fs.writeFileSync(s.ledger, JSON.stringify({ ts: '2026-11-01T00:00:00Z', pool: 'beta', cost_usd: 10 }) + '\n');
  const r1 = await cli(['api', 'hello', '--pool', 'beta', '--config', s.file]);
  assert.equal(r1.code, 3);
  assert.equal(r1.json.ok, false);
  assert.match(r1.json.error, /only USD0\.00 is available on pool beta/);
  const r2 = await cli(['api', 'hello', '--pool', 'alpha', '--max-tokens', '1000000', '--config', s.file]);
  assert.equal(r2.code, 3);
  assert.match(r2.json.error, /worst-case cost USD5\.00 \(half price, batch\) is over the USD2\.00 cap/);
  assert.equal(readJsonl(s.ledger).length, 1, 'a refusal books nothing');
});

test('--dry-run: every check, no network, says batch or real-time', async () => {
  const s = sandbox({ base_url: 'http://127.0.0.1:9' }); // nothing listens there; a network call would fail
  const r = await cli(['api', 'hello', '--dry-run', '--config', s.file], { TEST_KEY_B: '' });
  assert.equal(r.code, 0);
  assert.deepEqual([r.json.would, r.json.pool, r.json.key, r.json.network], ['batch', 'beta', 'missing', false]);
  const late = await cli(['api', 'hello', '--dry-run', '--config', s.file], { ANTHROPIC_POOL_NOW: '2026-11-12T12:00:00Z' });
  assert.equal(late.json.would, 'realtime');
  assert.match(late.json.why, /ends in 12\.0 h/);
  assert.equal(fs.existsSync(s.ledger), false);
});

test('batch path end to end: create, poll, results, one ledger row at half price', async () => {
  const stub = await startStub({ key: KEY_B, pollsBeforeEnd: 2 });
  try {
    const s = sandbox();
    const r = await cli(['api', 'Summarise this.', '--model', 'sonnet', '--poll-sec', '0.05', '--tag', 't1', '--note', 'test run', '--config', s.file], { ANTHROPIC_BASE_URL: stub.url });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.mode, 'batch');
    assert.equal(r.json.pool, 'beta');
    assert.equal(r.json.text, 'stub reply to: Summarise this.');
    assert.equal(r.json.cost_usd, 0.0035);
    const paths = stub.requests.map((q) => `${q.method} ${q.path.replace(/msgbatch_stub_\d+/, 'ID')}`);
    assert.deepEqual(paths, ['POST /v1/messages/batches', 'GET /v1/messages/batches/ID', 'GET /v1/messages/batches/ID', 'GET /v1/messages/batches/ID/results']);
    assert.ok(stub.requests.every((q) => q.key === KEY_B && q.version === '2023-06-01'), 'the chosen pool\'s key, in the header only');
    const sent = JSON.parse(stub.requests[0].body).requests[0];
    assert.equal(sent.params.model, 'claude-sonnet-5-5');
    const rows = readJsonl(s.ledger);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].mode, rows[0].pool, rows[0].cost_usd, rows[0].tag, rows[0].note, rows[0].failed], ['batch', 'beta', 0.0035, 't1', 'test run', 0]);
    assert.equal(fs.readdirSync(path.join(s.dir, 'ledger', 'runs', 'inflight')).length, 0, 'the run slot was released');
  } finally { await stub.close(); }
});

test('--now goes real-time at full price; so does a cycle ending within 26 h', async () => {
  const stub = await startStub({ key: KEY_A });
  try {
    const s = sandbox();
    const out = path.join(s.dir, 'reply.txt');
    const r = await cli(['api', 'Quick one', '--now', '--pool', 'alpha', '--out', out, '--config', s.file], { ANTHROPIC_BASE_URL: stub.url });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([r.json.mode, r.json.cost_usd, r.json.http], ['api', 0.007, 200]);
    assert.equal(fs.readFileSync(out, 'utf8'), 'stub reply to: Quick one');
    assert.deepEqual(stub.requests.map((q) => q.path), ['/v1/messages']);
    // a pool whose cycle ends 12 h from now goes real-time without --now
    const s2 = sandbox({ pools: [{ name: 'alpha', key_env: 'TEST_KEY_A', monthly_budget_usd: 10, reset_day: 13, per_run_cap_usd: 2 }] });
    const late = await cli(['api', 'Late', '--config', s2.file], { ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_POOL_NOW: '2026-11-12T12:00:00Z' });
    assert.equal(late.code, 0, late.err);
    assert.equal(late.json.mode, 'api');
    assert.match(late.json.why, /under 26 h/);
    assert.equal(readJsonl(s2.ledger)[0].cost_usd, 0.007);
  } finally { await stub.close(); }
});

test('a batch that outlives --wait-min is recorded as pending, reserved, then collected once', async () => {
  const stub = await startStub({ key: KEY_B, pollsBeforeEnd: Infinity });
  try {
    const s = sandbox();
    const env = { ANTHROPIC_BASE_URL: stub.url };
    const r = await cli(['api', 'Slow one', '--wait-min', '0.002', '--poll-sec', '0.03', '--config', s.file], env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.pending, true);
    const id = r.json.batch_id;
    assert.equal(fs.existsSync(s.ledger), false, 'nothing booked yet');
    const st = await cli(['status', '--config', s.file], env);
    assert.equal(st.json.uncollected[0].batch_id, id);
    assert.ok(st.json.pools.find((p) => p.name === 'beta').reserved_usd > 0, 'its worst case stays reserved');
    const early = await cli(['collect', id, '--config', s.file], env);
    assert.equal(early.json.still_processing[0].batch_id, id);
    stub.endAll();
    const c = await cli(['collect', '--config', s.file], env);
    assert.equal(c.code, 0, c.err);
    assert.equal(c.json.collected.length, 1);
    assert.equal(c.json.collected[0].text, 'stub reply to: Slow one');
    assert.equal(c.json.collected[0].cost_usd, 0.0035);
    const again = await cli(['collect', '--config', s.file], env);
    assert.equal(again.json.collected.length, 0, 'never booked twice');
    assert.equal(readJsonl(s.ledger).length, 1);
    const st2 = await cli(['status', '--config', s.file], env);
    assert.equal(st2.json.uncollected.length, 0);
    assert.equal(st2.json.pools.find((p) => p.name === 'beta').reserved_usd, 0);
    const missing = await cli(['collect', 'msgbatch_nope', '--config', s.file], env);
    assert.equal(missing.code, 2);
  } finally { await stub.close(); }
});

test('--jsonl sends many prompts as ONE batch; a failed request is reported per custom_id', async () => {
  const stub = await startStub({ key: KEY_B });
  try {
    const s = sandbox();
    const inFile = path.join(s.dir, 'prompts.jsonl');
    const outFile = path.join(s.dir, 'results.jsonl');
    fs.writeFileSync(inFile, ['a', 'b', 'FAIL c'].map((p, i) => JSON.stringify({ custom_id: `q${i}`, prompt: p })).join('\n'));
    const r = await cli(['api', '--jsonl', inFile, '--out', outFile, '--poll-sec', '0.05', '--config', s.file], { ANTHROPIC_BASE_URL: stub.url });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([r.json.requests, r.json.succeeded, r.json.failed], [3, 2, 1]);
    assert.equal(stub.requests.filter((q) => q.method === 'POST').length, 1);
    const rows = readJsonl(outFile);
    assert.equal(rows.find((x) => x.custom_id === 'q2').error.includes('stub failure'), true);
    assert.equal(readJsonl(s.ledger)[0].cost_usd, 0.007, 'two successes at half price');
    const dup = path.join(s.dir, 'dup.jsonl');
    fs.writeFileSync(dup, '{"custom_id":"x","prompt":"a"}\n{"custom_id":"x","prompt":"b"}\n');
    assert.equal((await cli(['api', '--jsonl', dup, '--out', outFile, '--config', s.file])).code, 2);
  } finally { await stub.close(); }
});

// ---------- --mcp-config: rejected configs name the key path, never the value ----------
const FAKE_SK = 'sk-' + 'ant-api03-' + 'Zq8Lm2Xv9TnR4wKd7YpB';
const FAKE_BEARER = 'Bearer ' + 'eyJhbGciOi' + 'JIUzI1NiJ9madeup';
const FAKE_HEX = '9f86d081884c7d659a2feaa0c55ad015' + 'a3bf4f1b2b0b822c';
const FAKE_B64 = 'Qm9ndXNLZXlNYWRlVXBGb3JUZXN0' + 'OnlyNotReal0123456';
const server = (extra = {}) => ({ command: 'node', args: ['./mcp-server/index.js', '--port', '8765'], ...extra });
function rejected(r, mention, secrets = []) {
  if (r.code === 0 || r.code === null) return 'was accepted';
  if (mention && !r.json.error.includes(mention)) return `message does not mention ${mention}`;
  for (const x of secrets) if ((r.out + r.err).includes(x)) return 'the value leaked into the output';
  return null;
}
async function credentialCases(cliPath, s) {
  const w = (name, obj) => { const f = path.join(s.dir, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  const run = (f) => cliAt(cliPath, ['agent', 'hi', '--print-args', '--mcp-config', f, '--config', s.file]);
  return [
    ['env ANTHROPIC_API_KEY', rejected(await run(w('c1.json', { mcpServers: { tool: server({ env: { ANTHROPIC_API_KEY: FAKE_SK } }) } })), 'mcpServers.tool.env.ANTHROPIC_API_KEY', [FAKE_SK])],
    ['sk- value', rejected(await run(w('c2.json', { mcpServers: { tool: server({ env: { NOTE: FAKE_SK } }) } })), 'env.NOTE', [FAKE_SK])],
    ['Bearer value', rejected(await run(w('c3.json', { mcpServers: { tool: server({ headers: { 'X-Note': FAKE_BEARER } }) } })), 'headers.X-Note', [FAKE_BEARER])],
    ['hex run', rejected(await run(w('c4.json', { mcpServers: { tool: server({ env: { SALT: FAKE_HEX } }) } })), 'env.SALT', [FAKE_HEX])],
    ['base64 run', rejected(await run(w('c5.json', { mcpServers: { tool: server({ env: { BLOB: FAKE_B64 } }) } })), 'env.BLOB', [FAKE_B64])],
    ['--api-key flag', rejected(await run(w('c6.json', { mcpServers: { tool: server({ args: ['--api-key=x'] }) } })), 'args[0]', ['--api-key=x'])],
  ];
}
function cliAt(cliPath, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cliPath, ...args], { windowsHide: true, env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { let json = null; try { json = JSON.parse(out.trim().split('\n').pop()); } catch {} resolve({ code, out, err, json }); });
  });
}

test('--mcp-config: a clean config is passed last as an absolute path; credential-looking ones are refused', async () => {
  const s = sandbox();
  const good = path.join(s.dir, 'mcp.json');
  fs.writeFileSync(good, JSON.stringify({ mcpServers: { tool: server({ env: { LOG_LEVEL: 'info', DEVICE: 'emulator-5554' } }) } }));
  const ok = await cli(['agent', 'hi', '--print-args', '--mcp-config', good, '--config', s.file]);
  assert.equal(ok.code, 0, ok.err);
  const a = ok.json.args;
  assert.equal(a[a.length - 2], '--mcp-config');
  assert.equal(a[a.length - 1], path.resolve(good));
  assert.ok(a.includes('--strict-mcp-config'));
  for (const [name, problem] of await credentialCases(CLI, s)) assert.equal(problem, null, name);
  const garbage = path.join(s.dir, 'garbage.json');
  fs.writeFileSync(garbage, 'not json ' + FAKE_SK);
  assert.equal(rejected(await cli(['agent', 'hi', '--print-args', '--mcp-config', garbage, '--config', s.file]), 'not valid JSON', [FAKE_SK]), null);
  assert.equal(rejected(await cli(['agent', 'hi', '--print-args', '--mcp-config', path.join(s.dir, 'nope.json'), '--config', s.file]), 'does not exist'), null);
  const arr = path.join(s.dir, 'arr.json');
  fs.writeFileSync(arr, '{"mcpServers":[]}');
  assert.equal(rejected(await cli(['agent', 'hi', '--print-args', '--mcp-config', arr, '--config', s.file]), 'mcpServers'), null);
  assert.equal(findCredential({ mcpServers: { x: { command: 'node', args: ['/usr/local/lib/node_modules/some-server/dist/index.js'] } } }), null, 'a long path is not a key');
});

test('positive controls: the rejection check notices an accepted or leaky result, and a tool with the check removed fails the cases', async () => {
  assert.ok(rejected({ code: 0, out: '', err: '', json: {} }, null), 'an accepted result must fail the check');
  assert.ok(rejected({ code: 2, out: FAKE_SK, err: '', json: { error: 'x' } }, null, [FAKE_SK]), 'a leaked value must fail the check');
  const s = sandbox();
  const mutant = path.join(s.dir, 'mutant.mjs');
  const src = fs.readFileSync(CLI, 'utf8');
  const needle = 'const cred = findCredential(j);';
  assert.ok(src.includes(needle), 'mutation site present');
  fs.writeFileSync(mutant, src.replace(needle, 'const cred = null;'));
  for (const [name, problem] of await credentialCases(mutant, s)) assert.ok(problem, `case "${name}" passed against a tool with no credential check, so it proves nothing`);
});

test('--print-args prints the claude argv and touches no pool, key or ledger', async () => {
  const s = sandbox();
  const r = await cli(['agent', 'hi', '--print-args', '--model', 'haiku', '--budget', '9', '--tools', 'Read,Grep', '--config', s.file], { TEST_KEY_A: '', TEST_KEY_B: '' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.command, ['claude']);
  assert.deepEqual(r.json.args, ['--bare', '-p', '--model', 'claude-haiku-5-5', '--max-budget-usd', '2.00', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Grep']);
  assert.equal(fs.existsSync(path.join(s.dir, 'ledger')), false);
});

test('agent run: the key reaches only the child, through an env allow-list; the cost is booked', async () => {
  const s0 = sandbox();
  const fake = path.join(s0.dir, 'fake-claude.mjs');
  const probe = path.join(s0.dir, 'probe.json');
  fs.writeFileSync(fake, `import fs from 'node:fs'; import crypto from 'node:crypto';
let stdin = ''; process.stdin.on('data', (d) => (stdin += d)); process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ argv: process.argv.slice(2), prompt: stdin, cwd: process.cwd(),
    keySha: crypto.createHash('sha256').update(process.env.ANTHROPIC_API_KEY || '').digest('hex'), envNames: Object.keys(process.env) }));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.42, result: 'done' }));
});`);
  const s = sandbox({ claude_command: [process.execPath, fake] });
  const r = await cli(['agent', 'Fix the typo.', '--pool', 'alpha', '--budget', '1.5', '--config', s.file], { UNRELATED_SECRET: 'do-not-pass' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json.cost_usd, r.json.cost_known, r.json.cap_usd, r.json.result], [0.42, true, 1.5, 'done']);
  const p = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.equal(p.prompt, 'Fix the typo.');
  assert.equal(p.keySha, crypto.createHash('sha256').update(KEY_A).digest('hex'));
  assert.ok(p.argv.includes('--bare') && p.argv[p.argv.indexOf('--max-budget-usd') + 1] === '1.50');
  const allowed = new Set([...AGENT_ENV_ALLOW, 'ANTHROPIC_API_KEY']);
  // On Windows, libuv itself adds a few required variables to every child (SYSTEMDRIVE, HOMEDRIVE, HOMEPATH, ...).
  const libuvAdds = /^(=|SYSTEMDRIVE$|HOMEDRIVE$|HOMEPATH$|LOGONSERVER$|USERDOMAIN$|USERNAME$)/i;
  const extra = p.envNames.filter((k) => !allowed.has(k.toUpperCase()) && !(process.platform === 'win32' && libuvAdds.test(k)));
  assert.deepEqual(extra, [], 'only allow-listed variables reach the child');
  assert.ok(!p.envNames.includes('TEST_KEY_B') && !p.envNames.includes('UNRELATED_SECRET'));
  const row = readJsonl(s.ledger)[0];
  assert.deepEqual([row.mode, row.pool, row.cost_usd], ['agent', 'alpha', 0.42]);
  const denied = sandbox({ claude_command: [process.execPath, fake], deny_cwd: ['./private'] });
  const d = await cli(['agent', 'x', '--cwd', path.join(denied.dir, 'private', 'repo'), '--config', denied.file]);
  assert.equal(d.code, 2);
  assert.match(d.json.error, /deny_cwd/);
});

test('configuration errors exit 2: plain http to a remote host, a key pasted into key_env', async () => {
  const s = sandbox({ base_url: 'http://api.example.com' });
  const r = await cli(['status', '--config', s.file]);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /must be https/);
  const s2 = sandbox({ pools: [{ name: 'x', key_env: FAKE_SK, monthly_budget_usd: 1, reset_day: 1 }] });
  const r2 = await cli(['status', '--config', s2.file]);
  assert.equal(r2.code, 2);
  assert.ok(!r2.out.includes(FAKE_SK) && !r2.err.includes(FAKE_SK));
  assert.equal((await cli(['api', '--bogus', '--config', s.file])).code, 2);
});

test('no key value ever appears in stdout, stderr, the ledger or any run file', () => {
  assert.ok(SEEN.length > 20, 'the earlier tests ran the CLI');
  for (const chunk of SEEN) for (const k of [KEY_A, KEY_B]) assert.ok(!chunk.includes(k), 'a key leaked into CLI output');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(ROOT).filter((f) => !f.endsWith('fake-claude.mjs'));
  assert.ok(files.some((f) => f.endsWith('ledger.jsonl')));
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    for (const k of [KEY_A, KEY_B]) assert.ok(!t.includes(k), `a key leaked into ${path.basename(f)}`);
  }
});
