#!/usr/bin/env node
/**
 * bin-dump.mjs: a rubbish bin for agents. Instead of deleting, move paths into a dated bin folder and record
 * what, where from, who and why in a manifest. A person empties the bin when they choose.
 *
 *   node bin-dump.mjs <path> [<path> ...] --who <name> --why "<text>" [--dry-run] [--allow-clean-clones]
 *   node bin-dump.mjs --status
 *   node bin-dump.mjs --restore <bin path> [--who <name>]
 *   common: [--bin <dir>] [--config <file.json>]
 *
 * Where it goes: <bin>/<YYYY-MM-DD>_<who>/<drive letter or ROOT>/<rest of the original path>.
 * A clash gets a ~2, ~3 ... suffix; nothing in the bin is ever overwritten.
 * Every move appends one row to <bin>/MANIFEST.tsv: at, action, who, bytes, original, bin_path, why.
 *
 * Refuses: a missing path · the bin or anything in it · anything containing the bin · a protected path or anything
 * containing one (the home folder always; more from the config) · a filesystem or drive root · a git repository or
 * worktree root at the top or up to `gitDepth` levels down. --allow-clean-clones lets a repository through only
 * when it is a plain clone (a .git folder, not a linked worktree) with no changes, no unpushed commits, no stash.
 *
 * How: rename (same volume: instant). Across volumes (EXDEV): copy, then remove the source; a removal that fails
 * half-way is reported, and the copy still gets its manifest row. Spawns nothing except `git` (windowsHide) for
 * --allow-clean-clones.
 *
 * stdout: one JSON object per run. stderr: one human line per path.
 * Exit 0 all moved (or --status / --restore succeeded) · 1 a refusal or a failed move (the others still run) ·
 * 2 bad usage or bad config.
 */
import { existsSync, mkdirSync, renameSync, cpSync, rmSync, lstatSync, readdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, parse } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HEADER = 'at\taction\twho\tbytes\toriginal\tbin_path\twhy\n';

const HELP = `bin-dump: move paths into a dated rubbish bin with a manifest, instead of deleting them.

usage:
  node bin-dump.mjs <path> [<path> ...] --who <name> --why "<text>" [--dry-run] [--allow-clean-clones]
  node bin-dump.mjs --status
  node bin-dump.mjs --restore <bin path> [--who <name>]

options:
  --who <name>           who is moving it (an agent, session or job name); --session is an alias
  --why <text>           why; required, recorded in the manifest
  --dry-run              say what would move (or, with --restore, come back); move nothing, write nothing
  --allow-clean-clones   let a git clone through if it is clean, fully pushed and has no stash
  --bin <dir>            the bin folder (env BIN_DUMP_DIR; config "bin"; default ~/RubbishBin)
  --config <file>        JSON {"bin", "protect": [paths], "gitDepth": 2} (env BIN_DUMP_CONFIG)
  --status               size, entry count and the newest manifest rows
  --restore <bin path>   move an entry back to where it came from (refused if something is there now)

stdout: one JSON object. exit: 0 ok · 1 a refusal or failed move · 2 bad usage or config`;

class UsageError extends Error {}

const expand = (p) => (p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p);
const caseFold = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p) => { const s = resolve(p).replace(/\\/g, '/').replace(/\/+$/, ''); return caseFold ? s.toLowerCase() : s; };
const within = (child, parent) => { const c = norm(child), p = norm(parent); return c === p || c.startsWith(p + '/') || (p === '' && c.startsWith('/')); };
const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ').trim();
const human = (n) => n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
const say = (s) => process.stderr.write(`[bin-dump] ${s}\n`);

function parseArgs(argv) {
  const o = { paths: [], dry: false, allowClones: false, status: false, help: false };
  // A value that is itself an option (`--who --dry-run`) is a missing value, not a name.
  const need = (i, f) => {
    if (i + 1 >= argv.length || /^--?[A-Za-z]/.test(argv[i + 1])) throw new UsageError(`${f} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.dry = true;
    else if (a === '--allow-clean-clones') o.allowClones = true;
    else if (a === '--status') o.status = true;
    else if (a === '--who' || a === '--session') { o.who = need(i, a); i++; }
    else if (a === '--why') { o.why = need(i, a); i++; }
    else if (a === '--bin') { o.bin = need(i, a); i++; }
    else if (a === '--config') { o.config = need(i, a); i++; }
    else if (a === '--restore') { o.restore = need(i, a); i++; }
    else if (a === '--') { o.paths.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith('--')) throw new UsageError(`unknown option: ${a}`);
    else o.paths.push(a);
  }
  return o;
}

function loadSettings(o, env) {
  const cfgPath = o.config ?? (env.BIN_DUMP_CONFIG || undefined);
  let cfg = {};
  if (cfgPath) {
    try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch (e) { throw new UsageError(`--config: ${e.code === 'ENOENT' ? 'file not found' : 'not valid JSON'}: ${cfgPath}`); }
  }
  const bin = resolve(expand(o.bin ?? (env.BIN_DUMP_DIR || undefined) ?? cfg.bin ?? join(homedir(), 'RubbishBin')));
  if (cfg.protect != null && !Array.isArray(cfg.protect)) throw new UsageError('config "protect" must be an array of paths');
  const protect = (cfg.protect || []).map((p) => resolve(expand(String(p))));
  const gitDepth = cfg.gitDepth == null ? 2 : Number(cfg.gitDepth);
  if (!Number.isInteger(gitDepth) || gitDepth < 0 || gitDepth > 6) throw new UsageError('config "gitDepth" must be an integer from 0 to 6');
  return { bin, protect, gitDepth, home: resolve(homedir()), manifest: join(bin, 'MANIFEST.tsv') };
}

function sizeOf(p) {
  let st;
  try { st = lstatSync(p); } catch { return 0; }
  if (!st.isDirectory() || st.isSymbolicLink()) return st.size;
  let total = 0;
  let names = [];
  try { names = readdirSync(p); } catch { return 0; }
  for (const n of names) total += sizeOf(join(p, n));
  return total;
}

function reposNear(p, depth, out = []) {
  if (existsSync(join(p, '.git'))) { out.push(p); return out; }
  if (depth === 0) return out;
  let entries = [];
  try { entries = readdirSync(p, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) reposNear(join(p, e.name), depth - 1, out);
  return out;
}

/** Why this repository is not a throwaway clone, or null when it is clean, fully pushed and stash-free. */
function notCleanClone(repo) {
  if (!lstatSync(join(repo, '.git')).isDirectory()) return 'is a linked worktree';
  // --no-optional-locks: a read-only check must not take index.lock in a repository something else is using.
  const git = (...a) => spawnSync('git', ['--no-optional-locks', '-C', repo, ...a], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const st = git('status', '--porcelain');
  if (st.error) return 'cannot be checked (git is not on PATH)';
  if (st.status !== 0) return 'cannot be checked (git status failed)';
  if (st.stdout.trim()) return 'has uncommitted changes';
  // Any git error is "cannot be checked", never "clean": an empty stdout from a failed command proves nothing.
  const lg = git('log', '--oneline', '--branches', '--not', '--remotes');
  if (lg.error || lg.status !== 0) return 'cannot be checked (git log failed)';
  if (lg.stdout.trim()) return 'has unpushed commits';
  const sl = git('stash', 'list');
  if (sl.error || sl.status !== 0) return 'cannot be checked (git stash list failed)';
  if (sl.stdout.trim()) return 'has a stash';
  return null;
}

function refusal(abs, s, allowClones) {
  if (!existsSync(abs)) {
    try { lstatSync(abs); } catch { return 'does not exist'; } // a dangling symlink still exists as a link
  }
  if (within(abs, s.bin)) return 'is the rubbish bin or inside it';
  if (within(s.bin, abs)) return 'contains the rubbish bin';
  if (within(s.home, abs)) return 'is the home folder or contains it';
  for (const p of s.protect) if (within(p, abs)) return `is a protected path or contains one (${p})`;
  if (norm(abs) === norm(parse(abs).root)) return 'is a filesystem or drive root';
  let repos = [];
  try { if (lstatSync(abs).isDirectory()) repos = reposNear(abs, s.gitDepth); } catch { /* exists, unreadable: the move reports it */ }
  if (!repos.length) return null;
  if (!allowClones) return 'is (or holds) a git repository or worktree; remove a worktree with `git worktree remove`, or pass --allow-clean-clones for throwaway clones';
  for (const r of repos) { const why = notCleanClone(r); if (why) return `holds ${r}, which ${why}`; }
  return null;
}

function destFor(abs, bin, day, who) {
  const { root } = parse(abs);
  const drive = (root.match(/^([A-Za-z]):/) || [])[1];
  const unc = /^[\\/]{2}/.test(root);
  const rest = abs.slice(root.length);
  const base = join(bin, `${day}_${who}`, drive ? drive.toUpperCase() : unc ? 'UNC' : 'ROOT', rest);
  if (!existsSync(base)) return base;
  for (let i = 2; ; i++) if (!existsSync(`${base}~${i}`)) return `${base}~${i}`;
}

// Across volumes the copy can finish and the source removal then fail half-way: the error carries `copied`.
function move(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  try { renameSync(src, dst); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  cpSync(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true, verbatimSymlinks: true });
  try { rmSync(src, { recursive: true, force: false }); } catch (e) { e.copied = true; throw e; }
}

function ensureBin(s) {
  mkdirSync(s.bin, { recursive: true });
  if (!existsSync(s.manifest)) writeFileSync(s.manifest, HEADER);
  const readme = join(s.bin, 'README.txt');
  if (!existsSync(readme)) writeFileSync(readme, [
    'This is a rubbish bin: files and folders that tools or agents would otherwise have deleted are moved here.',
    'Empty it whenever you like: delete the whole folder, or any dated subfolder.',
    'MANIFEST.tsv records each entry: when, who moved it, its size, where it came from, where it is now and why.',
    'If a path is too long for your file manager, delete the folder from a terminal instead.',
    '',
  ].join('\n'));
}

function appendRow(s, row) {
  const line = row.map(clean).join('\t') + '\n';
  try { appendFileSync(s.manifest, line); return null; } catch (e) {
    const pending = join(s.bin, `MANIFEST.pending-${process.pid}.tsv`);
    try { appendFileSync(pending, line); say(`warning: MANIFEST.tsv not writable (${e.code}); recorded in ${pending}.`); return pending; }
    catch { say(`warning: no manifest writable; the move was ${row[4]} -> ${row[5]}.`); return 'none'; }
  }
}

function readRows(s) {
  if (!existsSync(s.manifest)) return [];
  const lines = readFileSync(s.manifest, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = (lines[0] || '').split('\t');
  return lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i] || `col${i}`, v])));
}

function status(s) {
  if (!existsSync(s.bin)) return { out: { bin: s.bin, exists: false, bytes: 0, entries: 0, recent: [] }, code: 0 };
  const rows = readRows(s);
  const bytes = sizeOf(s.bin);
  say(`${s.bin}: ${human(bytes)} on disk, ${rows.length} manifest row${rows.length === 1 ? '' : 's'}.`);
  return { out: { bin: s.bin, exists: true, bytes, entries: rows.length, recent: rows.slice(-10) }, code: 0 };
}

function restore(s, binPath, who, dry) {
  const abs = resolve(binPath);
  if (!within(abs, s.bin) || norm(abs) === norm(s.bin)) return { out: { restored: null, error: 'not a path inside the bin' }, code: 1 };
  const row = readRows(s).reverse().find((r) => r.action === 'move' && r.bin_path && norm(r.bin_path) === norm(abs));
  if (!row) return { out: { restored: null, error: 'no manifest row for that bin path' }, code: 1 };
  if (!existsSync(abs)) return { out: { restored: null, error: 'that bin entry no longer exists' }, code: 1 };
  if (existsSync(row.original)) return { out: { restored: null, error: `something already exists at ${row.original}; move it first` }, code: 1 };
  if (dry) { say(`would restore ${abs} -> ${row.original}`); return { out: { dryRun: true, restored: null, wouldRestore: { from: abs, to: row.original } }, code: 0 }; }
  try { move(abs, row.original); } catch (e) { return { out: { restored: null, error: `${e.code || ''} ${e.message}`.trim() }, code: 1 }; }
  appendRow(s, [new Date().toISOString(), 'restore', who || 'unknown', row.bytes, row.original, abs, `restored (moved in for: ${row.why})`]);
  say(`restored ${abs} -> ${row.original}`);
  return { out: { restored: { from: abs, to: row.original } }, code: 0 };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let o, s;
  try {
    o = parseArgs(argv);
    if (o.help) { process.stdout.write(HELP + '\n'); return 0; }
    s = loadSettings(o, env);
    if (!o.status && !o.restore && (!o.paths.length || !o.who || !o.why || !clean(o.why))) {
      throw new UsageError('need at least one path, --who <name> and a non-empty --why "<text>"');
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
    say(`${e.message}\n${HELP.split('\n').slice(2, 7).join('\n')}`);
    return 2;
  }
  if (o.status) { const r = status(s); process.stdout.write(JSON.stringify(r.out) + '\n'); return r.code; }
  if (o.restore) {
    const r = restore(s, o.restore, o.who && o.who.replace(/[^A-Za-z0-9._-]+/g, '-'), o.dry);
    if (r.out.error) say(`restore refused: ${r.out.error}.`);
    process.stdout.write(JSON.stringify({ bin: s.bin, ...r.out }) + '\n');
    return r.code;
  }

  // Windows drops a folder name's trailing dots and spaces, so strip them (spaces are already `-` by then).
  const who = o.who.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60).replace(/[.-]+$/, '') || 'unknown';
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const result = { bin: s.bin, dryRun: o.dry, who, moved: [], refused: [], failed: [], movedBytes: 0 };

  if (!o.dry) ensureBin(s);
  for (const p of o.paths) {
    const abs = resolve(expand(p));
    const no = refusal(abs, s, o.allowClones);
    if (no) { say(`REFUSED ${abs}: ${no}.`); result.refused.push({ path: abs, reason: no }); continue; }
    const bytes = sizeOf(abs);
    const dst = destFor(abs, s.bin, day, who);
    if (o.dry) { say(`would move ${abs} (${human(bytes)}) -> ${dst}`); result.moved.push({ original: abs, binPath: dst, bytes, wouldMove: true }); continue; }
    let partial = false;
    try { move(abs, dst); } catch (e) {
      const what = e.copied
        ? `a full copy is in ${dst}, but the source was only partly removed; close whatever holds it, then bin-dump the rest`
        : 'nothing was removed; close whatever holds it and run again';
      say(`FAILED ${abs}: ${e.code || ''} ${e.message}. ${what}.`);
      result.failed.push({ path: abs, error: `${e.code || ''} ${e.message}`.trim(), partial: !!e.copied, binPath: e.copied ? dst : undefined });
      if (!e.copied) continue;
      partial = true; // the copy is in the bin, so it still gets a manifest row
    }
    const pending = appendRow(s, [now.toISOString(), 'move', who, bytes, abs, dst, o.why]);
    if (pending) result.manifestPending = pending;
    if (partial) continue;
    say(`moved ${abs} (${human(bytes)}) -> ${dst}`);
    result.moved.push({ original: abs, binPath: dst, bytes });
    result.movedBytes += bytes;
  }
  if (!o.dry) say(`${result.moved.length} moved, ${human(result.movedBytes)}; ${result.refused.length + result.failed.length} refused or failed. Bin: ${s.bin}`);
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.refused.length || result.failed.length ? 1 : 0;
}

const self = process.argv[1] ? resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : false;
if (self) process.exitCode = main();
