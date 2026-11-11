// Offline tests: fixture transcripts in a temp folder, never a real agent's files. Run: node --test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modelMatches, getPath, findTranscript, expectedFromPlan, loadConfig, parseArgs, readModels, UsageError, DEFAULTS } from '../lane-model-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'lane-model-check.mjs');
const EX = path.join(HERE, '..', 'examples');
const TRANSCRIPT = path.join(EX, 'transcript.example.jsonl');
const PLAN = path.join(EX, 'plan.example.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-model-check-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, LANE_MODEL_CHECK_CONFIG: '', ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* left null */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

test('model matching: equal, or the expected id plus a separator; never a longer word', () => {
  assert.ok(modelMatches('model-small', 'model-small'));
  assert.ok(modelMatches('model-small', 'model-small-20261001'));
  assert.ok(modelMatches('model-small', 'model-small[1m]'));
  assert.ok(modelMatches('model-small', 'model-small@2026'));
  assert.ok(modelMatches('Model-Small', 'model-small-20261001'));
  assert.ok(!modelMatches('model-small', 'model-smaller'));
  assert.ok(!modelMatches('model-small', 'model-large'));
  assert.ok(!modelMatches('model-small', 'model-small-20261001', true));
  assert.ok(modelMatches('model-small', 'MODEL-SMALL', true));
});

test('the first real model turn decides; a synthetic placeholder is skipped', async () => {
  const seen = await readModels(TRANSCRIPT, DEFAULTS);
  assert.deepEqual(seen, [{ model: 'model-small-20261001', line: 4 }]);
  const r = cli(['--transcript', TRANSCRIPT, '--expect', 'model-small']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.verdict, 'match');
  assert.equal(r.json.actual, 'model-small-20261001');
});

test('a mismatch exits 1 and names both models', () => {
  const r = cli(['--transcript', TRANSCRIPT, '--expect', 'model-large', '--explain']);
  assert.equal(r.code, 1);
  assert.equal(r.json.verdict, 'mismatch');
  assert.equal(r.json.expected, 'model-large');
  assert.equal(r.json.actual, 'model-small-20261001');
  assert.match(r.err, /MISMATCH expected model-large, got model-small-20261001/);
});

test('--all catches a later turn on another model and counts turns per model', () => {
  const r = cli(['--transcript', TRANSCRIPT, '--expect', 'model-small', '--all']);
  assert.equal(r.code, 1);
  assert.equal(r.json.turns, 3);
  assert.equal(r.json.firstMismatch, 'model-large-20261001');
  assert.equal(r.json.firstMismatchLine, 7);
  assert.deepEqual(r.json.models.map((m) => [m.model, m.turns, m.matches]), [['model-small-20261001', 2, true], ['model-large-20261001', 1, false]]);
});

test('not yet: a missing transcript, or one with no model turn, exits 3 (poll again)', () => {
  const empty = path.join(tmp, 'empty.jsonl');
  fs.writeFileSync(empty, '{"type":"user","message":{"content":"hi"}}\n{"type":"assistant","message":{"model":"<synthetic>"}}\n{"type":"assist');
  let r = cli(['--transcript', empty, '--expect', 'model-small']);
  assert.equal(r.code, 3);
  assert.equal(r.json.why, 'no model turn yet');
  r = cli(['--transcript', path.join(tmp, 'nope.jsonl'), '--expect', 'model-small']);
  assert.equal(r.code, 3);
  assert.equal(r.json.verdict, 'pending');
});

test('readModels rejects with the error code when the file cannot be opened (never a silent empty result)', async () => {
  await assert.rejects(readModels(path.join(tmp, 'gone.jsonl'), DEFAULTS), { code: 'ENOENT' });
});

// chmod cannot make a file unreadable on Windows, and root reads anything: the Linux CI runner covers this.
test('an unreadable transcript exits 2 (error), never 1 (mismatch)', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs a non-root POSIX user' }, () => {
  const locked = path.join(tmp, 'locked.jsonl');
  fs.copyFileSync(TRANSCRIPT, locked);
  fs.chmodSync(locked, 0o000);
  try {
    const r = cli(['--transcript', locked, '--expect', 'model-large']);
    assert.equal(r.code, 2, r.err);
    assert.equal(r.json.verdict, 'error');
    assert.match(r.json.error, /EACCES/);
  } finally { fs.chmodSync(locked, 0o600); }
});

test('a torn last line (still being written) is skipped, not fatal', async () => {
  const torn = path.join(tmp, 'torn.jsonl');
  fs.writeFileSync(torn, '{"type":"assistant","message":{"model":"model-large-1"}}\n{"type":"assistant","message":{"mod');
  assert.deepEqual((await readModels(torn, DEFAULTS, true)).map((s) => s.model), ['model-large-1']);
});

test('--session finds <id>.jsonl in any subfolder of a configured folder, and rejects path tricks', () => {
  const root = path.join(tmp, 'projects');
  fs.mkdirSync(path.join(root, 'proj-a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'proj-b'), { recursive: true });
  fs.copyFileSync(TRANSCRIPT, path.join(root, 'proj-b', 'abc-123.jsonl'));
  const cfgFile = path.join(tmp, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ transcriptDirs: [root + '/*'] }));
  const cfg = loadConfig(cfgFile);
  assert.equal(findTranscript('abc-123', cfg), path.join(root, 'proj-b', 'abc-123.jsonl'));
  assert.equal(findTranscript('missing-1', cfg), null);
  assert.throws(() => findTranscript('../etc', cfg), UsageError);
  assert.throws(() => findTranscript('a/b', cfg), UsageError);
  const r = cli(['--session', 'abc-123', '--expect', 'model-small', '--config', cfgFile]);
  assert.equal(r.code, 0, r.err);
  const p = cli(['--session', 'not-there', '--expect', 'model-small', '--config', cfgFile]);
  assert.equal(p.code, 3);
});

test('--plan/--lane reads the expected model, ids case-insensitive, arrays or keyed objects', () => {
  assert.equal(expectedFromPlan(PLAN, 'DOCS-SWEEP', DEFAULTS), 'model-small');
  assert.equal(expectedFromPlan(PLAN, 'design-review', DEFAULTS), 'model-large');
  assert.throws(() => expectedFromPlan(PLAN, 'nope', DEFAULTS), /has no model/);
  const keyed = path.join(tmp, 'keyed.json');
  fs.writeFileSync(keyed, JSON.stringify({ jobs: { Alpha: { engine: { id: 'model-x' } }, beta: 'model-y' } }));
  const cfg = { ...DEFAULTS, plan: { lanesPath: 'jobs', idField: 'id', modelField: 'engine.id' } };
  assert.equal(expectedFromPlan(keyed, 'alpha', cfg), 'model-x');
  assert.equal(expectedFromPlan(keyed, 'BETA', cfg), 'model-y');
  const r = cli(['--transcript', TRANSCRIPT, '--plan', PLAN, '--lane', 'design-review']);
  assert.equal(r.code, 1);
  assert.equal(r.json.lane, 'design-review');
  assert.equal(r.json.expected, 'model-large');
});

test('another agent format is a config change: turn marker and model path', async () => {
  const f = path.join(tmp, 'other.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ kind: 'event', name: 'start' }),
    JSON.stringify({ kind: 'response', meta: { engine: 'engine-9-mini' } }),
  ].join('\n'));
  const cfgFile = path.join(tmp, 'other.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ turn: { field: 'kind', equals: 'response' }, modelField: 'meta.engine' }));
  const r = cli(['--transcript', f, '--expect', 'engine-9', '--config', cfgFile]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.actual, 'engine-9-mini');
  assert.equal(getPath({ a: { b: { c: 1 } } }, 'a.b.c'), 1);
  assert.equal(getPath({ a: 1 }, 'a.b.c'), undefined);
});

test('bad usage and bad config exit 2 with a JSON error', () => {
  assert.throws(() => parseArgs(['--expect']), UsageError);
  const badCfg = path.join(tmp, 'bad.json');
  fs.writeFileSync(badCfg, '{"transcriptDirs": "nope"}');
  for (const args of [[], ['--expect', 'm'], ['--transcript', TRANSCRIPT], ['--transcript', TRANSCRIPT, '--session', 'x', '--expect', 'm'],
    ['--transcript', TRANSCRIPT, '--expect', 'm', '--lane', 'x'], ['--transcript', TRANSCRIPT, '--expect', 'm', '--config', badCfg],
    ['--transcript', TRANSCRIPT, '--plan', path.join(tmp, 'no-plan.json'), '--lane', 'x'], ['--wat']]) {
    const r = cli(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.json.verdict, 'error');
  }
});

test('--help exits 0', () => {
  const r = cli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /--plan <file>/);
});
