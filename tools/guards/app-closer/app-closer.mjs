#!/usr/bin/env node
/**
 * app-closer.mjs: close a configured list of idle apps when memory commit charge is high, and nothing else.
 *
 *   node app-closer.mjs [--config apps.json]                 report: what is closable now and why (closes nothing)
 *   node app-closer.mjs --close                               close the closable ones, only at or above closeAtPct
 *   node app-closer.mjs --close --ignore-memory               close them at any memory level
 *   node app-closer.mjs --watch 60 [--close]                  check every watchIntervalSec for 60 minutes
 *   node app-closer.mjs --snapshot procs.json [--snapshot-after after.json] [--close]
 *                                                             use a recorded process list; kills are SIMULATED
 *
 * The config lists apps by rules: how to recognise each app's processes (name, path, command line regexes) and
 * what keeps it open (its window is in front, another process is running, a child of it is running, a busy
 * command says so, it has not been idle long enough). A process is only ever stopped if it matches an app rule
 * and is not protected: OS-critical names, the config's "never" list, this process and its ancestors.
 *
 * Remembered across runs (state file, written by real --close runs only): when each app was closed, so an app the OS restarts at once is held
 * instead of being killed in a loop; how long each app has been idle; kills the OS refused.
 *
 * stdout: one JSON object per check. stderr: a human table with --explain, and error text.
 * Exit 0 done · 1 a check failed (no process list) · 2 bad usage or config · 3 --close kept closable apps because
 * memory is under closeAtPct (or unreadable) · 4 a kill was refused.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = {
  closeAtPct: 80,
  verifyDelayMs: 5000,
  watchIntervalSec: 60,
  foregroundUnknown: 'keep',
  respawn: { windowMin: 10, holdMin: 120, repeatCloses: 3, repeatWindowMin: 60 },
  refusedRetryMin: 30,
  never: [],
  apps: [],
};

// Never stopped, whatever the config says (checked first, by process name, with or without .exe).
export const PROTECTED = [
  'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'dwm',
  'explorer', 'fontdrvhost', 'sihost', 'ctfmon', 'conhost', 'taskhostw', 'spoolsv', 'audiodg', 'msmpeng', 'memcompression',
  'init', 'systemd', 'launchd', 'kernel_task', 'windowserver', 'loginwindow', 'sshd', 'xorg', 'xwayland', 'gnome-shell',
  'kwin_x11', 'kwin_wayland', 'plasmashell', 'dbus-daemon', 'pipewire', 'wireplumber', 'login', 'getty', 'agetty',
];

const HELP = `app-closer: close a configured list of idle apps when memory commit charge is high.

usage: node app-closer.mjs [--config <file>] [--close] [--ignore-memory] [--watch <minutes>]
                           [--snapshot <file> [--snapshot-after <file>]] [--explain]

  --config <file>          the app rules (env APP_CLOSER_CONFIG); see examples/config.example.json
  --close                  close the closable apps (default: report only)
  --ignore-memory          with --close: act at any memory level (default: only at or above closeAtPct)
  --watch <minutes>        repeat the check every watchIntervalSec for this long; one JSON line per check
  --snapshot <file>        use a recorded process list instead of the machine's; kills are simulated
  --snapshot-after <file>  the process list to verify simulated kills against (default: all gone)
  --explain                also print a table on stderr
  --help                   this text

state and log: APP_CLOSER_DIR (default ~/.app-closer)
exit: 0 done · 1 check failed · 2 bad usage or config · 3 kept: memory under closeAtPct · 4 a kill was refused`;

export class UsageError extends Error {}

/* ───────────────────────────── config ───────────────────────────── */

const rx = (list, where) => {
  if (list == null) return null;
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((s) => { try { return new RegExp(String(s), 'i'); } catch (e) { throw new UsageError(`${where}: bad regex ${JSON.stringify(s)} (${e.message})`); } });
};

/** Validate the config and compile its regexes. */
export function normaliseConfig(j) {
  if (!j || typeof j !== 'object') throw new UsageError('config must be a JSON object');
  const c = { ...DEFAULTS, ...j, respawn: { ...DEFAULTS.respawn, ...(j.respawn || {}) } };
  if (!Array.isArray(c.apps)) throw new UsageError('config "apps" must be an array');
  for (const k of ['closeAtPct', 'verifyDelayMs', 'watchIntervalSec', 'refusedRetryMin']) {
    if (!Number.isFinite(Number(c[k])) || Number(c[k]) < 0) throw new UsageError(`config "${k}" must be a number >= 0`);
    c[k] = Number(c[k]);
  }
  if (!['keep', 'ignore'].includes(c.foregroundUnknown)) throw new UsageError('config "foregroundUnknown" must be "keep" or "ignore"');
  c.neverRx = rx(c.never, 'never') || [];
  const names = new Set();
  c.apps = c.apps.map((a, i) => {
    const where = `apps[${i}]`;
    if (!a || typeof a.app !== 'string' || !a.app) throw new UsageError(`${where}: needs an "app" name`);
    if (names.has(a.app)) throw new UsageError(`${where}: duplicate app name "${a.app}"`);
    names.add(a.app);
    const m = a.match || {};
    const match = { name: rx(m.name, `${where}.match.name`), path: rx(m.path, `${where}.match.path`), commandLine: rx(m.commandLine, `${where}.match.commandLine`),
      notPath: rx(m.notPath, `${where}.match.notPath`), notCommandLine: rx(m.notCommandLine, `${where}.match.notCommandLine`) };
    if (!match.name && !match.path && !match.commandLine) throw new UsageError(`${where}: match needs at least one of name, path, commandLine`);
    const unlessRunning = (a.unlessRunning || []).map((u, k) => ({ name: rx(u.name, `${where}.unlessRunning[${k}].name`), path: rx(u.path, `${where}.unlessRunning[${k}].path`),
      commandLine: rx(u.commandLine, `${where}.unlessRunning[${k}].commandLine`), notPath: rx(u.notPath, `${where}.unlessRunning[${k}].notPath`), reason: u.reason || 'another process it serves is running' }));
    const uc = a.unlessChildRunning ? { except: rx(a.unlessChildRunning.except || [], `${where}.unlessChildRunning.except`), reason: a.unlessChildRunning.reason || 'a child process of it is running' } : null;
    let busy = null;
    if (a.busyCheck) {
      if (!Array.isArray(a.busyCheck.argv) || !a.busyCheck.argv.length || !a.busyCheck.argv.every((x) => typeof x === 'string')) throw new UsageError(`${where}.busyCheck.argv must be a non-empty array of strings`);
      const when = a.busyCheck.busyWhen || 'output';
      if (!['output', 'exit0', 'nonzero'].includes(when)) throw new UsageError(`${where}.busyCheck.busyWhen must be output, exit0 or nonzero`);
      busy = { argv: a.busyCheck.argv, busyWhen: when, reason: a.busyCheck.reason || 'its busy check says it is in use', timeoutMs: Number(a.busyCheck.timeoutMs) || 15000 };
    }
    return {
      app: a.app, match, unlessRunning, unlessChildRunning: uc, busyCheck: busy,
      unlessParent: rx(a.unlessParent, `${where}.unlessParent`),
      orphanOnly: !!a.orphanOnly, skipIfForeground: a.skipIfForeground !== false, killTree: !!a.killTree,
      respawnHold: a.respawnHold !== false, idleMinutes: Math.max(0, Number(a.idleMinutes) || 0),
    };
  });
  return c;
}

/* ─────────────────────────── matching ─────────────────────────── */

const any = (list, s) => list.some((r) => r.test(s || ''));

export function procMatches(p, m) {
  if (m.name && !any(m.name, p.name)) return false;
  if (m.path && !any(m.path, p.path)) return false;
  if (m.commandLine && !any(m.commandLine, p.commandLine)) return false;
  if (m.notPath && any(m.notPath, p.path)) return false;
  if (m.notCommandLine && any(m.notCommandLine, p.commandLine)) return false;
  return true;
}

const bare = (n) => String(n || '').toLowerCase().replace(/\.exe$/, '');

/** PIDs that may never be stopped: OS-critical names, the config's never list, this process and its ancestors. */
export function protectedPids(s, cfg, selfPid = process.pid) {
  const out = new Set([0, 4]);
  for (let p = s.byPid.get(selfPid), guard = 0; p && guard < 64; p = s.byPid.get(p.ppid), guard++) out.add(p.pid);
  out.add(selfPid);
  for (const p of s.procs) if (PROTECTED.includes(bare(p.name)) || any(cfg.neverRx, p.name)) out.add(p.pid);
  return out;
}

/** Turn a recorded or read process list into the shape used here. */
export function normaliseSnapshot(raw) {
  const procs = (Array.isArray(raw.procs) ? raw.procs : raw.procs ? [raw.procs] : []).map((p) => ({
    pid: Number(p.pid ?? p.ProcessId), ppid: Number(p.ppid ?? p.ParentProcessId ?? 0), name: String(p.name ?? p.Name ?? ''),
    path: String(p.path ?? p.ExecutablePath ?? ''), commandLine: String(p.commandLine ?? p.CommandLine ?? ''), mb: Number(p.mb ?? p.MB ?? 0) || 0,
  })).filter((p) => Number.isInteger(p.pid) && p.pid > 0);
  let commit = null;
  if (raw.commit && raw.commit.limitBytes) commit = { usedBytes: Number(raw.commit.usedBytes), limitBytes: Number(raw.commit.limitBytes), pct: (Number(raw.commit.usedBytes) / Number(raw.commit.limitBytes)) * 100, source: raw.commit.source || 'snapshot' };
  else if (raw.commitPct != null) commit = { usedBytes: null, limitBytes: null, pct: Number(raw.commitPct), source: 'snapshot' };
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const fgPid = raw.fgPid == null || raw.fgPid === 0 ? null : Number(raw.fgPid);
  // The window in front, plus its whole parent chain (multi-process apps often put the window on a child).
  const fgFamily = new Set();
  for (let f = byPid.get(fgPid), guard = 0; f && !fgFamily.has(f.pid) && guard < 64; f = byPid.get(f.ppid), guard++) fgFamily.add(f.pid);
  return { procs, byPid, commit, fgPid, fgKnown: raw.fgKnown !== false && fgPid != null, fgFamily };
}

/* ─────────────────────────── reading the machine ─────────────────────────── */

function powershell(script) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', timeout: 90000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
}

const WIN_SNAPSHOT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$fgPid = 0
try {
  Add-Type -ErrorAction Stop @"
using System; using System.Runtime.InteropServices;
public static class AcFg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }
"@
  [void][AcFg]::GetWindowThreadProcessId([AcFg]::GetForegroundWindow(), [ref]$fgPid)
} catch { $fgPid = 0 }
$os = Get-CimInstance Win32_OperatingSystem
$procs = @(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}}, @{n='ppid';e={$_.ParentProcessId}}, @{n='name';e={$_.Name}}, @{n='path';e={$_.ExecutablePath}}, @{n='commandLine';e={$_.CommandLine}}, @{n='mb';e={[int]($_.PrivatePageCount/1MB)}})
[pscustomobject]@{ fgPid = $fgPid; totalKB = $os.TotalVirtualMemorySize; freeKB = $os.FreeVirtualMemory; procs = $procs } | ConvertTo-Json -Depth 4 -Compress
`;

function snapshotWindows() {
  // PowerShell 5's ConvertTo-Json can leave raw control characters inside strings (a command line can hold one).
  const j = JSON.parse(powershell(WIN_SNAPSHOT).replace(/[\u0000-\u001f]/g, ' '));
  const total = Number(j.totalKB) * 1024, free = Number(j.freeKB) * 1024;
  return { fgPid: j.fgPid || null, fgKnown: !!j.fgPid, procs: j.procs, commit: total ? { usedBytes: total - free, limitBytes: total, source: 'win32-cim' } : null };
}

function linuxCommit() {
  try {
    const kb = {};
    for (const l of readFileSync('/proc/meminfo', 'utf8').split('\n')) { const m = /^(\w+):\s+(\d+)/.exec(l); if (m) kb[m[1]] = Number(m[2]) * 1024; }
    let oc = 0;
    try { oc = Number(readFileSync('/proc/sys/vm/overcommit_memory', 'utf8').trim()); } catch { /* default heuristic */ }
    // Only strict overcommit (2) enforces CommitLimit; otherwise use RAM + swap in use, the Windows-like measure.
    if (oc === 2 && kb.CommitLimit) return { usedBytes: kb.Committed_AS, limitBytes: kb.CommitLimit, source: 'linux-commit' };
    if (kb.MemTotal && kb.MemAvailable != null) return { usedBytes: kb.MemTotal - kb.MemAvailable + Math.max(0, (kb.SwapTotal || 0) - (kb.SwapFree || 0)), limitBytes: kb.MemTotal + (kb.SwapTotal || 0), source: 'linux-available' };
  } catch { /* unreadable */ }
  return null;
}

function snapshotLinux() {
  const procs = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const name = readFileSync(`/proc/${d}/comm`, 'utf8').trim();
      let path = '';
      try { path = readlinkSync(`/proc/${d}/exe`); } catch { /* another user's process */ }
      const commandLine = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
      const rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${d}/status`, 'utf8'));
      procs.push({ pid: Number(d), ppid, name: path ? basename(path) : name, path, commandLine, mb: rss ? Math.round(Number(rss[1]) / 1024) : 0 });
    } catch { /* exited while we read */ }
  }
  return { fgPid: null, fgKnown: false, procs, commit: linuxCommit() };
}

function snapshotDarwin() {
  const run = (args) => spawnSync('ps', args, { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 << 20 }).stdout || '';
  const comm = new Map();
  for (const l of run(['-A', '-o', 'pid=', '-o', 'comm=']).split('\n')) { const m = /^\s*(\d+)\s+(.*)$/.exec(l); if (m) comm.set(Number(m[1]), m[2]); }
  const procs = [];
  for (const l of run(['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss=', '-o', 'args=']).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const path = comm.get(Number(m[1])) || '';
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), name: basename(path), path, commandLine: m[4], mb: Math.round(Number(m[3]) / 1024) });
  }
  let commit = null;
  const lv = spawnSync('sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8', windowsHide: true }).stdout;
  const ms = spawnSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8', windowsHide: true }).stdout;
  if (/^\d+$/.test(String(lv).trim()) && /^\d+$/.test(String(ms).trim())) {
    const mem = Number(ms);
    commit = { usedBytes: Math.round(mem * (100 - Number(lv)) / 100), limitBytes: mem, source: 'darwin-memorystatus (approximate)' };
  }
  return { fgPid: null, fgKnown: false, procs, commit };
}

export function readSnapshot(platform = process.platform) {
  if (platform === 'win32') return normaliseSnapshot(snapshotWindows());
  if (platform === 'linux') return normaliseSnapshot(snapshotLinux());
  if (platform === 'darwin') return normaliseSnapshot(snapshotDarwin());
  throw new Error(`no process list on platform ${platform}`);
}

/* ─────────────────────────── deciding ─────────────────────────── */

export function runBusyCheck(b) {
  const r = spawnSync(b.argv[0], b.argv.slice(1), { encoding: 'utf8', windowsHide: true, timeout: b.timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error) return { failed: true, why: `busy check could not run (${r.error.code || r.error.message})` };
  if (b.busyWhen === 'output') return r.status === 0 ? { busy: !!(r.stdout || '').trim() } : { failed: true, why: `busy check exited ${r.status}` };
  if (b.busyWhen === 'exit0') return { busy: r.status === 0 };
  return { busy: r.status !== 0 };
}

const MIN = 60000;

/**
 * Pure apart from deps.busy: returns { rows, state }. Rows: [{ app, pids, mb, closable, why }].
 * `st` is the state from the last run; a new state object is returned.
 */
export function assess(s, cfg, st0 = {}, now = Date.now(), deps = {}) {
  const busy = deps.busy || runBusyCheck; // called as busy(busyCheck, appName)
  const st = structuredClone({ idleSince: {}, closedAt: {}, closeLog: {}, heldSince: {}, refusedAt: {}, ...st0 });
  const prot = protectedPids(s, cfg, deps.selfPid ?? process.pid);
  const rows = [];
  for (const a of cfg.apps) {
    let ps = s.procs.filter((p) => !prot.has(p.pid) && procMatches(p, a.match));
    if (a.orphanOnly) ps = ps.filter((p) => !s.byPid.has(p.ppid));
    if (a.unlessParent) ps = ps.filter((p) => !any(a.unlessParent, s.byPid.get(p.ppid)?.name));
    if (!ps.length) { delete st.idleSince[a.app]; continue; }
    const pids = ps.map((p) => p.pid);
    const row = { app: a.app, pids, mb: ps.reduce((n, p) => n + (p.mb || 0), 0), closable: true, why: 'nothing keeps it open' };
    const keep = (why) => { row.closable = false; row.why = why; delete st.idleSince[a.app]; };

    // An app back soon after being closed, or closed again and again, is being restarted by the OS: hold it.
    const closedAt = st.closedAt[a.app];
    const recent = (st.closeLog[a.app] || []).filter((t) => now - t < cfg.respawn.repeatWindowMin * MIN);
    if (a.respawnHold && ((closedAt && now - closedAt < cfg.respawn.windowMin * MIN) || recent.length >= cfg.respawn.repeatCloses)) st.heldSince[a.app] ??= now;
    if (st.heldSince[a.app] && now - st.heldSince[a.app] >= cfg.respawn.holdMin * MIN) { delete st.heldSince[a.app]; delete st.closedAt[a.app]; delete st.closeLog[a.app]; }
    if (st.refusedAt[a.app] && now - st.refusedAt[a.app] >= cfg.refusedRetryMin * MIN) delete st.refusedAt[a.app];

    const children = () => s.procs.filter((p) => pids.includes(p.ppid) && !pids.includes(p.pid) && !(a.unlessChildRunning.except || []).some((r) => r.test(p.name)));
    let b;
    if (st.heldSince[a.app]) keep(`came back after being closed; the OS restarts it, so it is left alone for ${cfg.respawn.holdMin} min`);
    else if (st.refusedAt[a.app]) keep(`the last kill was refused; retried after ${cfg.refusedRetryMin} min`);
    else if (a.skipIfForeground && ps.some((p) => s.fgFamily.has(p.pid))) keep('its window is in front');
    else if (a.skipIfForeground && !s.fgKnown && cfg.foregroundUnknown === 'keep') keep('the window in front is unknown on this platform (set foregroundUnknown or skipIfForeground to change this)');
    else if (a.unlessRunning.find((u) => s.procs.some((p) => procMatches(p, u)))) keep(a.unlessRunning.find((u) => s.procs.some((p) => procMatches(p, u))).reason);
    else if (a.unlessChildRunning && children().length) keep(`${a.unlessChildRunning.reason} (${children().slice(0, 3).map((p) => p.name).join(', ')})`);
    else if (a.busyCheck && (b = busy(a.busyCheck, a.app)) && (b.failed || b.busy)) keep(b.failed ? `${b.why}; kept to be safe` : a.busyCheck.reason);
    else if (a.idleMinutes) {
      st.idleSince[a.app] ??= now;
      const mins = (now - st.idleSince[a.app]) / MIN;
      if (mins < a.idleMinutes) { row.closable = false; row.why = `idle for ${mins.toFixed(1)} min; closes after ${a.idleMinutes}`; }
      else row.why = `idle for ${mins.toFixed(0)} min`;
    }
    rows.push(row);
  }
  return { rows, state: st };
}

/* ─────────────────────────── acting ─────────────────────────── */

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export const sameProc = (a, b) => !!a && !!b && a.name === b.name && a.path === b.path && a.commandLine === b.commandLine;

/** This PID's identity read at this instant (POSIX), or null if it is gone or unreadable. */
function identityNow(pid, platform = process.platform) {
  try {
    if (platform === 'linux') {
      let path = '';
      try { path = readlinkSync(`/proc/${pid}/exe`); } catch { /* another user's process */ }
      const name = path ? basename(path) : readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
      return { name, path, commandLine };
    }
    if (platform === 'darwin') {
      const ps = (f) => (spawnSync('ps', ['-p', String(pid), '-o', `${f}=`], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).stdout || '').trim();
      const path = ps('comm');
      return path ? { name: basename(path), path, commandLine: ps('args') } : null;
    }
  } catch { /* gone */ }
  return null;
}

/** Add each target's descendants (from snapshot s), leaving out protected PIDs. */
export function treeOf(pids, s, prot = new Set()) {
  const all = pids.filter((p) => !prot.has(p));
  if (!s) return all;
  for (let i = 0; i < all.length; i++) for (const p of s.procs) if (p.ppid === all[i] && !all.includes(p.pid) && !prot.has(p.pid)) all.push(p.pid);
  return all;
}

/**
 * Stop these PIDs for real. Returns the PIDs a stop was sent to. `expect` (pid -> process from the snapshot the
 * decision was made on) is checked again right before each signal on POSIX: a PID that now names another process
 * (reused) is skipped. With `tree`, descendants are stopped too, never a protected one (`prot`).
 */
export function realKill(pids, { tree = false, s = null, prot = new Set(), expect = null, platform = process.platform } = {}) {
  const done = [];
  const all = tree ? treeOf(pids, s, prot) : pids.filter((p) => !prot.has(p));
  if (platform === 'win32') {
    // No /T: the tree is expanded above, so a protected descendant is never stopped.
    for (const pid of all) {
      try { execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30000 }); if (pids.includes(pid)) done.push(pid); }
      catch { /* gone already, or refused: the caller tells the two apart */ }
    }
    return done;
  }
  const sent = [];
  for (const pid of all) {
    if (expect?.has(pid) && !sameProc(identityNow(pid, platform), expect.get(pid))) continue; // exited or reused
    try { process.kill(pid, 'SIGTERM'); sent.push(pid); if (pids.includes(pid)) done.push(pid); } catch { /* gone or refused */ }
  }
  for (let t = 0; t < 30 && sent.some(alive); t++) sleep(100);
  for (const pid of sent) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* refused */ } }
  return done;
}

/** After closing, look again. Returns Map app -> verdict, and the new state. */
export function verify(closed, after, cfg, st0, now = Date.now(), deps = {}) {
  const st = structuredClone(st0);
  const out = new Map();
  const appBy = new Map(cfg.apps.map((a) => [a.app, a]));
  for (const r of closed) {
    // Every target had already exited (or its PID now names another process) before a stop was sent: nothing
    // was refused, so this is neither a refusal nor a close.
    if (r.skipped) { out.set(r.app, 'SKIPPED (no fresh process list)'); continue; }
    if (!r.killed.length && r.gone?.length && r.pids.every((pid) => r.gone.includes(pid))) { out.set(r.app, 'ALREADY GONE'); continue; }
    if (!r.killed.length) { st.refusedAt[r.app] = now; out.set(r.app, 'KILL REFUSED'); continue; }
    st.closedAt[r.app] = now;
    st.closeLog[r.app] = [...(st.closeLog[r.app] || []), now].filter((t) => now - t < cfg.respawn.repeatWindowMin * MIN);
    delete st.idleSince[r.app];
    if (!after) { out.set(r.app, 'KILLED (unverified)'); continue; }
    const a = appBy.get(r.app);
    const prot = protectedPids(after, cfg, deps.selfPid ?? process.pid);
    let back = after.procs.filter((p) => !prot.has(p.pid) && procMatches(p, a.match));
    if (a.orphanOnly) back = back.filter((p) => !after.byPid.has(p.ppid));
    const survivors = back.filter((p) => r.pids.includes(p.pid));
    const fresh = back.length - survivors.length;
    if (fresh) out.set(r.app, `RESPAWNED (${fresh} back)`);
    else if (survivors.length) { delete st.closedAt[r.app]; st.refusedAt[r.app] = now; out.set(r.app, 'PARTLY REFUSED'); }
    else out.set(r.app, 'CLOSED');
  }
  return { verdicts: out, state: st };
}

/* ─────────────────────────── state and log ─────────────────────────── */

function stateDir(env) { return resolve(env.APP_CLOSER_DIR || join(homedir(), '.app-closer')); }
function readState(dir) { try { return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')); } catch { return {}; } }
function writeState(dir, st) { try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'state.json'), JSON.stringify(st, null, 2)); } catch { /* best effort */ } }
function log(dir, line) { try { mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, 'app-closer.log'), `${new Date().toISOString()} ${line}\n`); } catch { /* logging must not stop a close */ } }

/* ─────────────────────────── one check ─────────────────────────── */

function loadJson(file, what) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`${what}: ${e.code === 'ENOENT' ? 'file not found' : 'not valid JSON'}: ${file}`); }
}

export function once(o, cfg, env = process.env, deps = {}) {
  const dir = stateDir(env);
  const simulated = !!o.snapshot;
  const raw = simulated ? loadJson(o.snapshot, '--snapshot') : null;
  const s = simulated ? normaliseSnapshot(raw) : (deps.snapshot || readSnapshot)();
  const now = deps.now ?? Date.now();
  // A simulated run runs no busy-check command either: the snapshot may record each app's answer under "busy"
  // ({"<app>": true|false}); with no answer recorded, the app is kept, as when a real check cannot run.
  const simBusy = (b, app) => (raw.busy && typeof raw.busy[app] === 'boolean' ? { busy: raw.busy[app] } : { failed: true, why: 'busy check not run in a simulated run' });
  const adeps = simulated && !deps.busy ? { ...deps, busy: simBusy } : deps;
  // A simulated run (--snapshot) neither reads nor writes the real state, so it can never hold or release a real
  // app. Report mode reads it but never writes it (a --watch report keeps its state in memory between checks).
  const prior = simulated ? {} : deps.state ?? readState(dir);
  const { rows, state } = assess(s, cfg, prior, now, adeps);
  const pct = s.commit ? Math.round(s.commit.pct * 10) / 10 : null;
  const gateOpen = o.ignoreMemory || (pct != null && pct >= cfg.closeAtPct);
  let st = state;
  const toClose = o.close && gateOpen ? rows.filter((r) => r.closable) : [];
  if (toClose.length && !simulated) {
    // The decision may be seconds old (a busy check can take 15 s): look again right before stopping anything,
    // and keep only PIDs that still name the same process and are still not protected. A PID that has exited, or
    // been reused by another process, is never signalled.
    let fresh = null;
    try { fresh = (deps.snapshot || readSnapshot)(); } catch { fresh = null; }
    const freshProt = fresh ? protectedPids(fresh, cfg, deps.selfPid ?? process.pid) : new Set();
    for (const r of toClose) {
      r.gone = [];
      r.target = fresh ? r.pids.filter((pid) => {
        const ok = sameProc(fresh.byPid.get(pid), s.byPid.get(pid)) && !freshProt.has(pid);
        if (!ok) r.gone.push(pid);
        return ok;
      }) : [];
      r.fresh = fresh;
      r.freshProt = freshProt;
    }
  }
  const isAlive = deps.alive || alive;
  for (const r of toClose) {
    const a = cfg.apps.find((x) => x.app === r.app);
    if (simulated) { r.killed = [...r.pids]; continue; }
    if (!r.fresh) { r.killed = []; r.skipped = true; continue; } // no fresh process list: nothing is stopped blind
    const expect = new Map(r.target.map((pid) => [pid, s.byPid.get(pid)]));
    r.killed = r.target.length ? (deps.kill || realKill)(r.target, { tree: a.killTree, s: r.fresh, prot: r.freshProt, expect }) : [];
    // A stop that failed because the process exited first is not a refusal.
    for (const pid of r.target) if (!r.killed.includes(pid) && !isAlive(pid)) r.gone.push(pid);
    delete r.fresh; delete r.freshProt;
  }
  let verdicts = new Map();
  if (toClose.length) {
    let after = null;
    if (simulated) after = o.snapshotAfter ? normaliseSnapshot(loadJson(o.snapshotAfter, '--snapshot-after')) : normaliseSnapshot({ procs: [] });
    else if (toClose.some((r) => r.killed.length)) { sleep(cfg.verifyDelayMs); try { after = (deps.snapshot || readSnapshot)(); } catch { after = null; } }
    ({ verdicts, state: st } = verify(toClose, after, cfg, st, now, deps));
    if (!simulated) for (const r of toClose) log(dir, `${verdicts.get(r.app)} ${r.app} pids=${r.pids.join(',')} ~${r.mb} MB (${r.why})`);
  }
  if (!simulated && o.close) writeState(dir, st);
  let keptByGate = false;
  for (const r of rows) {
    if (verdicts.has(r.app)) r.verdict = verdicts.get(r.app);
    else if (r.closable && o.close && !gateOpen) { r.verdict = pct == null ? 'kept (memory unreadable)' : `kept (memory under ${cfg.closeAtPct}%)`; keptByGate = true; }
    else r.verdict = r.closable ? 'closable' : 'kept';
    delete r.killed; delete r.target; delete r.gone; delete r.skipped;
  }
  const out = {
    at: new Date(now).toISOString(), mode: o.close ? 'close' : 'report', simulated,
    memory: { pct, usedBytes: s.commit?.usedBytes ?? null, limitBytes: s.commit?.limitBytes ?? null, source: s.commit?.source ?? null },
    gate: { closeAtPct: cfg.closeAtPct, open: !!gateOpen, ignoreMemory: !!o.ignoreMemory },
    rows,
  };
  const refused = rows.some((r) => /REFUSED/.test(r.verdict));
  return { out, code: refused ? 4 : keptByGate ? 3 : 0, state: st };
}

function explain(out) {
  const m = out.memory.pct == null ? 'memory unreadable' : `memory ${out.memory.pct}% committed`;
  const lines = [`${m} · ${out.mode}${out.simulated ? ' (simulated)' : ''} · closes at ${out.gate.closeAtPct}%${out.gate.ignoreMemory ? ' (ignored)' : ''}`];
  if (!out.rows.length) lines.push('  nothing on the list is running.');
  for (const r of out.rows) lines.push(`  ${r.verdict.padEnd(24)} ${r.app.padEnd(20)} ~${String(r.mb).padStart(5)} MB  ${r.why}`);
  return lines.join('\n') + '\n';
}

/* ─────────────────────────── CLI ─────────────────────────── */

export function parseArgs(argv) {
  const o = { close: false, ignoreMemory: false, explain: false, help: false };
  const vals = { '--config': 'config', '--watch': 'watch', '--snapshot': 'snapshot', '--snapshot-after': 'snapshotAfter' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--close') o.close = true;
    else if (a === '--ignore-memory') o.ignoreMemory = true;
    else if (a === '--explain') o.explain = true;
    else if (vals[a]) { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${a} needs a value`); o[vals[a]] = argv[++i]; }
    else throw new UsageError(`unknown argument: ${a}`);
  }
  if (o.watch != null && !(Number(o.watch) > 0)) throw new UsageError('--watch needs a number of minutes > 0');
  if (o.snapshotAfter && !o.snapshot) throw new UsageError('--snapshot-after needs --snapshot');
  if (o.ignoreMemory && !o.close) throw new UsageError('--ignore-memory only makes sense with --close');
  return o;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let o, cfg;
  try {
    o = parseArgs(argv);
    if (o.help) { process.stdout.write(HELP + '\n'); return 0; }
    const cfgPath = o.config ?? (env.APP_CLOSER_CONFIG || undefined);
    if (!cfgPath) throw new UsageError('no config: pass --config <file> or set APP_CLOSER_CONFIG (see examples/config.example.json)');
    cfg = normaliseConfig(loadJson(cfgPath, '--config'));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
    process.stderr.write(`app-closer: ${e.message}\n`);
    return 2;
  }
  let mem; // a --watch report run's state, kept in memory between checks (report mode never writes the file)
  const tick = () => {
    try {
      const r = once(o, cfg, env, !o.close && mem ? { state: mem } : {});
      if (!o.close) mem = r.state;
      process.stdout.write(JSON.stringify(r.out) + '\n');
      if (o.explain) process.stderr.write(explain(r.out));
      return r.code;
    } catch (e) {
      if (e instanceof UsageError) { process.stdout.write(JSON.stringify({ error: e.message }) + '\n'); process.stderr.write(`app-closer: ${e.message}\n`); return 2; }
      process.stdout.write(JSON.stringify({ error: `check failed: ${e.message}` }) + '\n');
      process.stderr.write(`app-closer: check failed: ${e.message}\n`);
      return 1;
    }
  };
  if (o.watch == null) return tick();
  const end = Date.now() + Number(o.watch) * MIN;
  log(stateDir(env), `WATCH start ${o.watch} min pid=${process.pid}`);
  // The watch exits with the most serious code any check returned: 2 stops it at once; then 1, 4, 3, 0.
  const rank = { 0: 0, 3: 1, 4: 2, 1: 3, 2: 4 };
  let worst = 0;
  const loop = () => {
    const code = tick();
    if ((rank[code] ?? 3) > rank[worst]) worst = code;
    process.exitCode = worst;
    if (code === 2) return;
    if (Date.now() < end) setTimeout(loop, cfg.watchIntervalSec * 1000); else log(stateDir(env), 'WATCH end');
  };
  loop();
  return undefined;
}

const self = process.argv[1] ? resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : false;
if (self) { const code = main(); if (code !== undefined) process.exitCode = code; }
