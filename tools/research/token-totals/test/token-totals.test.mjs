// Offline tests on small fixture transcripts (test/fixtures). Never reads this machine's real logs. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, cpSync, rmSync, statSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dayOf, getPath, readRecord, scanSource, summarise, updateLedger, archiveLogs, settings, parseArgs, checkSource, walk, defaultClaudeRoot, CLAUDE_CODE_MAP, UsageError, EXIT } from '../token-totals.mjs';

const FX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PROJECTS = join(FX, 'projects');
const GATEWAY = join(FX, 'gateway');
const CLI = fileURLToPath(new URL('../token-totals.mjs', import.meta.url));
const CLEAN = { TOKEN_TOTALS_ROOT: '', TOKEN_TOTALS_CONFIG: '', TOKEN_TOTALS_LEDGER: '', TOKEN_TOTALS_TZ: '' };
const tmp = () => mkdtempSync(join(tmpdir(), 'token-totals-'));
const claude = (roots) => ({ name: 'claude-code', roots, ext: '.jsonl', mustContain: '"usage"', skipModels: ['<synthetic>'], fields: CLAUDE_CODE_MAP });
const GW = { name: 'gateway', root: GATEWAY, fields: { timestamp: 'ts', id: 'request_id', model: 'model', input: 'usage.prompt_tokens', output: 'usage.completion_tokens', cache_read: 'usage.cached_tokens' } };

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, ...CLEAN, ...env } });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const fingerprint = (root) => walk(root).map((f) => `${f}|${statSync(f).mtimeMs}|${createHash('sha256').update(readFileSync(f)).digest('hex')}`).join('\n');

test('dayOf: ISO strings, epoch seconds and milliseconds, junk; getPath on dotted paths', () => {
  assert.equal(dayOf('2026-11-01T23:30:00.000Z'), '2026-11-01');
  assert.equal(dayOf(1793613600), '2026-11-02');
  assert.equal(dayOf(1793613600000), '2026-11-02');
  assert.equal(dayOf('not a time'), null); assert.equal(dayOf(undefined), null);
  const d = new Date('2026-11-01T23:30:00.000Z');
  assert.equal(dayOf('2026-11-01T23:30:00.000Z', 'local'), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  assert.equal(getPath({ a: { b: { c: 3 } } }, 'a.b.c'), 3); assert.equal(getPath({ a: 1 }, 'a.b.c'), undefined); assert.equal(getPath({}, null), undefined);
});

test('readRecord: Claude Code map, dedup key, synthetic replies skipped, no usage is not a record', () => {
  const src = claude([]);
  const r = readRecord({ timestamp: '2026-11-01T09:00:00Z', requestId: 'r', message: { id: 'm', model: 'x', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } }, src, 'utc');
  assert.deepEqual([r.day, r.model, r.key, r.total], ['2026-11-01', 'x', 'm|r', 10]);
  assert.equal(readRecord({ timestamp: 't', message: { model: '<synthetic>', usage: { input_tokens: 0 } } }, src), null);
  assert.equal(readRecord({ timestamp: 't', message: { content: 'hi' } }, src), null);
  assert.equal(readRecord({ timestamp: '2026-11-01T00:00:00Z', message: { usage: { output_tokens: -5, input_tokens: 'x' } } }, src, 'utc').total, 0, 'negative or non-numeric counts add nothing');
});

test('scan: totals deduplicated by message id + request id across files, nested subagent logs included', async () => {
  const s = await scanSource(claude([PROJECTS]));
  assert.equal(s.files, 3);
  assert.equal(s.replies, 4);
  assert.equal(s.duplicates_skipped, 2, 'the second content block and the resumed-session copy');
  assert.equal(s.without_time, 1); assert.equal(s.unparseable, 1);
  const out = summarise([s]);
  assert.deepEqual(out.totals, { input: 85, output: 1000, cache_write: 3500, cache_read: 26000, total: 30585, replies: 4 });
  assert.deepEqual(Object.keys(out.by_day), ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.equal(out.by_day['2026-11-01'].total, 14315);
  assert.equal(out.by_day['2026-11-01'].models['claude-opus-4-1'].total, 8105);
  assert.deepEqual(Object.keys(out.by_model), ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'], 'largest first');
  assert.equal(out.by_model['claude-sonnet-4-5'].replies, 2);
  assert.equal(out.sources[0].first_day, '2026-11-01'); assert.equal(out.sources[0].last_day, '2026-11-03');
  assert.equal(out.by_day['2026-11-01'].sources, undefined, 'per-source split only with more than one source');
});

test('by month, and an inclusive --since/--until window', async () => {
  const all = summarise([await scanSource(claude([PROJECTS]))], 'month');
  assert.deepEqual(Object.keys(all.by_month), ['2026-11']); assert.equal(all.by_month['2026-11'].total, 30585);
  const w = summarise([await scanSource(claude([PROJECTS]), { since: '2026-11-02', until: '2026-11-02' })]);
  assert.deepEqual(Object.keys(w.by_day), ['2026-11-02']); assert.equal(w.totals.total, 12320);
});

test('another JSONL source through a field map: epoch timestamps, its own dedup, junk skipped', async () => {
  const src = checkSource(GW, 0);
  const s = await scanSource(src);
  assert.equal(s.replies, 2); assert.equal(s.duplicates_skipped, 1); assert.equal(s.without_time, 1);
  const out = summarise([await scanSource(claude([PROJECTS])), s]);
  assert.equal(out.totals.total, 30585 + 1650 + 150);
  assert.deepEqual(out.by_day['2026-11-02'].sources, { 'claude-code': 12320, gateway: 1650 });
  assert.equal(out.by_model['example-model-small'].cache_read, 0);
  assert.throws(() => checkSource({ ...GW, name: 'claude-code' }, 0), /reserved/);
  assert.throws(() => checkSource({ ...GW, fields: { model: 'm' } }, 0), /timestamp/);
  assert.throws(() => checkSource({ ...GW, fields: { timestamp: 'ts' } }, 0), /at least one/);
  assert.throws(() => checkSource({ ...GW, host: 'x' }, 0), /unknown key "host"/);
  assert.throws(() => checkSource({ name: 'x', fields: GW.fields }, 0), /root/);
});

test('ledger: adds days, never lowers one when logs are deleted, raises one that grew, dry run writes nothing', async () => {
  const dir = tmp(); const logs = join(dir, 'logs'); cpSync(PROJECTS, logs, { recursive: true });
  const ledger = join(dir, 'ledger', 'tokens.jsonl');
  const first = updateLedger(ledger, [await scanSource(claude([logs]))], { now: 'T1' });
  assert.deepEqual([first.added, first.raised, first.kept, first.days], [3, 0, 0, 3]);
  assert.equal(first.totals.total, 30585);
  // Claude Code prunes old transcripts: delete one and the recorded day must stay as it was.
  rmSync(join(logs, '-home-dev-other'), { recursive: true });
  const second = updateLedger(ledger, [await scanSource(claude([logs]))], { now: 'T2' });
  assert.deepEqual([second.added, second.raised, second.kept, second.days], [0, 0, 2, 3]);
  const lines = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.day === '2026-11-03').total, 3950);
  // a day that grew is raised
  appendFileSync(join(logs, '-home-dev-demo-app', '0002-session-b.jsonl'), JSON.stringify({ type: 'assistant', requestId: 'req_B2', timestamp: '2026-11-02T09:00:00Z', message: { id: 'msg_B2', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 9 } } }) + '\n');
  const third = updateLedger(ledger, [await scanSource(claude([logs]))], { now: 'T3' });
  assert.equal(third.raised, 1);
  const day2 = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.day === '2026-11-02');
  assert.equal(day2.total, 12330); assert.equal(day2.updated, 'T3'); assert.equal(day2.models['claude-sonnet-4-5'].replies, 2);
  // dry run and a different calendar
  const before = readFileSync(ledger, 'utf8');
  updateLedger(ledger, [await scanSource(claude([PROJECTS]))], { dryRun: true });
  assert.equal(readFileSync(ledger, 'utf8'), before);
  assert.throws(() => updateLedger(ledger, [], { tz: 'local' }), UsageError);
});

test('archive: gzip copies that round-trip, unchanged files skipped, changed ones rewritten', async () => {
  const dir = tmp(); const logs = join(dir, 'logs'); cpSync(PROJECTS, logs, { recursive: true }); const arch = join(dir, 'archive');
  const dry = await archiveLogs(arch, [await scanSource(claude([logs]))], { dryRun: true });
  assert.equal(dry.written, 3); assert.equal(existsSync(arch), false);
  const a = await archiveLogs(arch, [await scanSource(claude([logs]))]);
  assert.deepEqual([a.considered, a.written, a.unchanged], [3, 3, 0]);
  const rel = join('-home-dev-demo-app', '0001-session-a.jsonl');
  assert.equal(gunzipSync(readFileSync(join(arch, rel + '.gz'))).toString('utf8'), readFileSync(join(logs, rel), 'utf8'));
  const b = await archiveLogs(arch, [await scanSource(claude([logs]))]);
  assert.deepEqual([b.written, b.unchanged], [0, 3]);
  appendFileSync(join(logs, rel), '\n');
  const c = await archiveLogs(arch, [await scanSource(claude([logs]))]);
  assert.deepEqual([c.written, c.unchanged], [1, 2]);
  assert.ok(existsSync(join(arch, 'manifest.json')));
  assert.ok(!readdirSync(arch, { withFileTypes: false }).some((n) => n.endsWith('.tmp')));
});

test('settings: precedence, defaults, and refusing a ledger or archive inside a log folder', () => {
  const s = settings(parseArgs([]), { CLAUDE_CONFIG_DIR: join(tmpdir(), 'cfgdir') });
  assert.deepEqual(s.sources[0].roots, [join(tmpdir(), 'cfgdir', 'projects')]);
  assert.equal(defaultClaudeRoot({}).endsWith(join('.claude', 'projects')), true);
  const dir = tmp(); const cfg = join(dir, 'c.json');
  writeFileSync(cfg, JSON.stringify({ roots: ['from-config'], tz: 'local', by: 'month', sources: [GW] }));
  const c = settings(parseArgs(['--config', cfg]), {});
  assert.deepEqual(c.sources.map((x) => x.name), ['claude-code', 'gateway']); assert.deepEqual(c.sources[0].roots, ['from-config']); assert.equal(c.tz, 'local'); assert.equal(c.by, 'month');
  assert.deepEqual(settings(parseArgs(['--config', cfg]), { TOKEN_TOTALS_ROOT: 'env-root' }).sources[0].roots, ['env-root']);
  assert.deepEqual(settings(parseArgs(['--config', cfg, '--root', 'flag-root', '--tz', 'utc']), { TOKEN_TOTALS_ROOT: 'env-root' }).sources[0].roots, ['flag-root']);
  assert.deepEqual(settings(parseArgs(['--config', cfg, '--no-claude']), {}).sources.map((x) => x.name), ['gateway']);
  assert.throws(() => settings(parseArgs(['--root', PROJECTS, '--ledger', join(PROJECTS, 'ledger.jsonl')]), {}), /outside the log folders/);
  assert.throws(() => settings(parseArgs(['--root', PROJECTS, '--archive', join(PROJECTS, 'a')]), {}), /outside the log folders/);
  assert.throws(() => settings(parseArgs(['--since', '1 Nov']), {}), /YYYY-MM-DD/);
  assert.throws(() => settings(parseArgs(['--tz', 'Asia/Somewhere']), {}), /utc or local/);
  writeFileSync(cfg, JSON.stringify({ hosts: ['a'] })); assert.throws(() => settings(parseArgs(['--config', cfg]), {}), /unknown key "hosts"/);
  assert.throws(() => parseArgs(['--frobnicate']), UsageError);
  assert.throws(() => parseArgs(['--root']), UsageError);
});

test('CLI: one JSON object, --table, --help, usage and no-logs exit codes; the logs are never modified', () => {
  const before = fingerprint(PROJECTS);
  const r = cli(['--root', PROJECTS]);
  assert.equal(r.code, 0, r.err); assert.equal(r.out.trim().split('\n').length, 1); assert.equal(r.json.totals.total, 30585);
  const t = cli(['--root', PROJECTS, '--table', '--by', 'month']);
  assert.equal(t.code, 0); assert.match(t.out, /2026-11 .* 30\.6K/); assert.match(t.out, /2 duplicate lines skipped/);
  assert.equal(cli(['--help']).code, 0);
  const bad = cli(['--bogus']); assert.equal(bad.code, EXIT.USAGE); assert.equal(bad.json.ok, false);
  const none = cli(['--root', join(tmp(), 'nothing-here')]); assert.equal(none.code, EXIT.NO_LOGS); assert.equal(none.json.error, 'no log files found');
  const env = cli([], { TOKEN_TOTALS_ROOT: PROJECTS }); assert.equal(env.code, 0); assert.equal(env.json.totals.replies, 4);
  const dir = tmp();
  const withAll = cli(['--root', PROJECTS, '--ledger', join(dir, 'l.jsonl'), '--archive', join(dir, 'arch')]);
  assert.equal(withAll.code, 0, withAll.err); assert.equal(withAll.json.ledger.added, 3); assert.equal(withAll.json.archive.written, 3);
  assert.equal(fingerprint(PROJECTS), before, 'fixture logs unchanged byte for byte, mtimes included');
});
