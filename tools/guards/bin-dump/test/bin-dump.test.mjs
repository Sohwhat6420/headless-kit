// Offline tests against a temporary bin, a temporary fake home and temporary victims. Run: node --test
// Nothing outside the test's own temp folder is moved: every refusal case asserts the path is still there.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BD = join(HERE, '..', 'bin-dump.mjs');
const work = mkdtempSync(join(tmpdir(), 'bin-dump-test-'));
const bin = join(work, 'bin');
const home = join(work, 'home');
mkdirSync(home);
const env = { ...process.env, BIN_DUMP_DIR: bin, BIN_DUMP_CONFIG: '', USERPROFILE: home, HOME: home };
const hasGit = !spawnSync('git', ['--version'], { windowsHide: true }).error;

function bd(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [BD, ...args], { encoding: 'utf8', windowsHide: true, env: { ...env, ...extraEnv } });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* left null */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const manifest = () => (existsSync(join(bin, 'MANIFEST.tsv')) ? readFileSync(join(bin, 'MANIFEST.tsv'), 'utf8').split(/\r?\n/).filter(Boolean) : []);
const drive = (p) => (parse(p).root.match(/^([A-Za-z]):/) || [])[1]?.toUpperCase() || 'ROOT';
const victim = join(work, 'victim');
let firstBinPath;
after(() => rmSync(work, { recursive: true, force: true }));

test('a folder moves with its tree intact, under <date>_<who>/<drive>/<path>, with one manifest row', () => {
  mkdirSync(join(victim, 'sub'), { recursive: true });
  writeFileSync(join(victim, 'sub', 'a.txt'), 'x'.repeat(1000));
  const r = bd([victim, '--who', 'TEST 1', '--why', 'old\tscratch\nfolder']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(victim));
  const lines = manifest();
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('at\taction\twho\t'));
  const c = lines[1].split('\t');
  assert.deepEqual([c[1], c[2], c[3], c[4], c[6]], ['move', 'TEST-1', '1000', victim, 'old scratch folder']);
  assert.match(c[5], /[\\/]\d{4}-\d{2}-\d{2}_TEST-1[\\/]/);
  assert.ok(c[5].includes(join(drive(victim), victim.slice(parse(victim).root.length))));
  assert.ok(existsSync(join(c[5], 'sub', 'a.txt')));
  assert.equal(r.json.moved[0].binPath, c[5]);
  assert.equal(r.json.movedBytes, 1000);
  assert.ok(existsSync(join(bin, 'README.txt')));
  firstBinPath = c[5];
});

test('the same path again gets a ~2 suffix and never overwrites', () => {
  mkdirSync(victim);
  writeFileSync(join(victim, 'b.txt'), 'y');
  const r = bd([victim, '--who', 'TEST 1', '--why', 'again']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.moved[0].binPath, firstBinPath + '~2');
  assert.ok(existsSync(join(firstBinPath, 'sub', 'a.txt')));
});

test('refusals: each exits 1, keeps the path where it is and writes no manifest row', () => {
  const repo = join(work, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const nested = join(work, 'holder');
  mkdirSync(join(nested, 'proj', '.git'), { recursive: true });
  const before = manifest().length;
  const cases = [
    [bin, /is the rubbish bin or inside it/],
    [join(bin, 'MANIFEST.tsv'), /is the rubbish bin or inside it/],
    [work, /contains the rubbish bin/],
    [home, /is the home folder or contains it/],
    [parse(work).root, /contains the rubbish bin|filesystem or drive root/],
    [repo, /git repository/],
    [nested, /git repository/],
    [join(work, 'nope'), /does not exist/],
  ];
  for (const [p, why] of cases) {
    const r = bd([p, '--who', 's', '--why', 'w']);
    assert.equal(r.code, 1, p);
    assert.match(r.err, why, p);
    assert.match(r.json.refused[0].reason, why);
    assert.equal(existsSync(p), !p.endsWith('nope'), p);
  }
  assert.equal(manifest().length, before);
});

test('protected paths from the config are refused, and so is anything containing them; files inside are not', () => {
  const area = join(work, 'area');
  const keep = join(area, 'keep');
  mkdirSync(keep, { recursive: true });
  writeFileSync(join(keep, 'inside.txt'), 'i');
  const cfg = join(work, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ protect: [keep] }));
  for (const p of [keep, area]) {
    const r = bd([p, '--who', 's', '--why', 'w', '--config', cfg]);
    assert.equal(r.code, 1);
    assert.match(r.err, /protected path/);
    assert.ok(existsSync(p));
  }
  const r = bd([join(keep, 'inside.txt'), '--who', 's', '--why', 'w', '--config', cfg]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(join(keep, 'inside.txt')));
});

test('usage errors exit 2 and move nothing', () => {
  const f = join(work, 'f.txt');
  writeFileSync(f, 'z');
  for (const args of [[f, '--who', 's'], [f, '--who', 's', '--why', '  '], ['--who', 's', '--why', 'w'], [f, '--why', 'w'], [f, '--who', 's', '--why', 'w', '--frob']]) {
    const r = bd(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.json.error);
  }
  const bad = join(work, 'bad.json');
  writeFileSync(bad, '{"protect": "nope"}');
  assert.equal(bd([f, '--who', 's', '--why', 'w', '--config', bad]).code, 2);
  // An option where a value belongs is a missing value: `--who --dry-run` must not name the mover "--dry-run"
  // (and so silently turn a dry run into a real move).
  for (const args of [[f, '--who', '--dry-run', '--why', 'w'], [f, '--who', 's', '--why', '--dry-run'], ['--restore', '--dry-run']]) {
    const r = bd(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.json.error, /needs a value/);
  }
  assert.ok(existsSync(f));
});

test('--dry-run moves nothing; a single file moves; a mixed batch moves the good one and exits 1', () => {
  const f = join(work, 'f2.txt');
  writeFileSync(f, 'z');
  const n = manifest().length;
  let r = bd([f, '--who', 's', '--why', 'w', '--dry-run']);
  assert.equal(r.code, 0);
  assert.ok(existsSync(f));
  assert.equal(manifest().length, n);
  assert.equal(r.json.moved[0].wouldMove, true);
  r = bd([f, '--who', 's', '--why', 'file']);
  assert.ok(r.code === 0 && !existsSync(f) && manifest().length === n + 1);
  const g = join(work, 'g.txt');
  writeFileSync(g, 'g');
  r = bd([g, join(work, 'repo'), '--who', 's', '--why', 'mixed']);
  assert.equal(r.code, 1);
  assert.ok(!existsSync(g) && existsSync(join(work, 'repo')));
  assert.equal(r.json.moved.length, 1);
  assert.equal(r.json.refused.length, 1);
});

test('--allow-clean-clones passes a clean clone and still refuses a dirty one and a linked worktree', { skip: !hasGit && 'git is not on PATH' }, () => {
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true });
  const clones = join(work, 'clones');
  mkdirSync(join(clones, 'clean'), { recursive: true });
  git(join(clones, 'clean'), 'init', '-q');
  const dirty = join(work, 'dirty-holder');
  mkdirSync(join(dirty, 'd'), { recursive: true });
  git(join(dirty, 'd'), 'init', '-q');
  writeFileSync(join(dirty, 'd', 'local.txt'), 'work');
  const wt = join(work, 'wt-holder');
  mkdirSync(join(wt, 'w'), { recursive: true });
  writeFileSync(join(wt, 'w', '.git'), 'gitdir: elsewhere');
  let r = bd([clones, '--who', 's', '--why', 'clone']);
  assert.ok(r.code === 1 && existsSync(clones));
  r = bd([dirty, '--who', 's', '--why', 'clone', '--allow-clean-clones']);
  assert.ok(r.code === 1 && /uncommitted/.test(r.err) && existsSync(dirty), r.err);
  r = bd([wt, '--who', 's', '--why', 'clone', '--allow-clean-clones']);
  assert.ok(r.code === 1 && /worktree/.test(r.err) && existsSync(wt), r.err);
  r = bd([clones, '--who', 's', '--why', 'clone', '--allow-clean-clones']);
  assert.ok(r.code === 0 && !existsSync(clones), r.err);
});

test('a who name loses characters a folder name cannot keep, and its trailing dots', () => {
  const h = join(work, 'h.txt');
  writeFileSync(h, 'h');
  const r = bd([h, '--session', 'lane. .', '--why', 'dots']);
  const c = manifest().at(-1).split('\t');
  assert.equal(r.code, 0, r.err);
  assert.equal(c[2], 'lane');
  assert.match(c[5], /_lane[\\/]/);
});

test('a read-only manifest does not lose the record: a pending manifest is written instead', { skip: process.getuid?.() === 0 && 'root ignores file modes' }, () => {
  const k = join(work, 'k.txt');
  writeFileSync(k, 'k');
  chmodSync(join(bin, 'MANIFEST.tsv'), 0o444);
  let r;
  try { r = bd([k, '--who', 's', '--why', 'locked manifest']); } finally { chmodSync(join(bin, 'MANIFEST.tsv'), 0o644); }
  const pend = readdirSync(bin).filter((n) => n.startsWith('MANIFEST.pending-'));
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(k));
  assert.equal(pend.length, 1);
  assert.match(readFileSync(join(bin, pend[0]), 'utf8'), /locked manifest/);
});

test('--restore moves an entry back and refuses when something is in the way', () => {
  const t = join(work, 'restore-me.txt');
  writeFileSync(t, 'r');
  const m = bd([t, '--who', 's', '--why', 'try restore']);
  const binPath = m.json.moved[0].binPath;
  writeFileSync(t, 'new occupant');
  let r = bd(['--restore', binPath]);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /already exists/);
  assert.equal(readFileSync(t, 'utf8'), 'new occupant');
  bd([t, '--who', 's', '--why', 'clear the way']);
  // --dry-run with --restore says what would happen and changes nothing: no move, no manifest row.
  const rowsBefore = manifest().length;
  r = bd(['--restore', binPath, '--who', 'undo', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.wouldRestore.to, t);
  assert.ok(existsSync(binPath), 'a dry-run restore must leave the bin entry where it is');
  assert.ok(!existsSync(t), 'a dry-run restore must not put the file back');
  assert.equal(manifest().length, rowsBefore, 'a dry-run restore must not write a manifest row');
  r = bd(['--restore', binPath, '--who', 'undo']);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(t, 'utf8'), 'r');
  assert.ok(!existsSync(binPath));
  assert.equal(manifest().at(-1).split('\t')[1], 'restore');
  assert.equal(bd(['--restore', join(work, 'not-in-bin')]).code, 1);
});

test('--status reports the bin as JSON; --help exits 0', () => {
  const r = bd(['--status']);
  assert.equal(r.code, 0);
  assert.equal(r.json.exists, true);
  assert.ok(r.json.entries >= 8);
  assert.ok(r.json.bytes > 0);
  assert.ok(Array.isArray(r.json.recent) && r.json.recent.length <= 10);
  const h = bd(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /--allow-clean-clones/);
});
