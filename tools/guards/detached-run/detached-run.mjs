#!/usr/bin/env node
/**
 * detached-run.mjs — start a long-running process on Windows that outlives the process that started it,
 * with NO window on the desktop. Node 18+, no dependencies.
 *
 *   node detached-run.mjs start <name> [--cwd DIR] -- <exe> [args...]
 *   node detached-run.mjs status <name>      exit 0 alive · 3 dead · 2 no PID file
 *   node detached-run.mjs stop <name>        kills the recorded PID (and its tree), never by name
 *   node detached-run.mjs list
 *
 * ── HOW ───────────────────────────────────────────────────────────────────
 * A hidden PowerShell (windowsHide) calls Invoke-CimMethod Win32_Process Create with a
 * Win32_ProcessStartup ShowWindow=0 (SW_HIDE). The new process is parented to WmiPrvSE,
 * not to us, so it survives the launching process, its parent app and that app's restart or update.
 * What WMI starts is THIS script in `supervise` mode; the supervisor spawns the real command
 * with windowsHide:true and stdout/stderr to ~/.detached-run/<name>.log, writes the PID file,
 * and records the exit code when the command ends.
 * ⛔ CreateFlags 0x08000000 (CREATE_NO_WINDOW) is REFUSED by WMI (not in its documented
 *    set; measured 25 Oct 2026), so ShowWindow=0 is the only window control used.
 * ⛔ Never DETACHED_PROCESS, CREATE_NEW_CONSOLE, `start`, or a .cmd shim.
 *
 * ── PID FILE ──────────────────────────────────────────────────────────────
 * ~/.detached-run/<name>.json: {name, pid, pidCreated, supervisorPid, cmd, cwd, log, startedAt,
 * exitedAt?, exitCode?}. Liveness = the PID exists AND its CreationDate equals pidCreated,
 * so a recycled PID never reads as alive.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Override with DETACHED_RUN_DIR. The supervisor is started by WMI and inherits none of our environment,
// so it takes its run directory from the spec file's location instead (see supervise()).
export let RUN_DIR = process.env.DETACHED_RUN_DIR || join(homedir(), '.detached-run');
const SELF = fileURLToPath(import.meta.url);
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

const pidFile = (name) => join(RUN_DIR, `${name}.json`);
const readRec = (name) => { try { return JSON.parse(readFileSync(pidFile(name), 'utf8')); } catch { return null; } };
// `stop` and the supervisor's exit handler can write the same record at the same moment (the child dies the
// instant taskkill returns). Each writer uses its own temp file, and a rename that Windows refuses because the
// other writer holds the target (EPERM / EBUSY / EACCES) is retried for up to about a second.
function writeRec(rec) {
  mkdirSync(RUN_DIR, { recursive: true });
  const tmp = `${pidFile(rec.name)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2));
  for (let i = 0; ; i++) {
    try { renameSync(tmp, pidFile(rec.name)); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
// Windows command-line quoting (CommandLineToArgvW rules).
function winQuote(a) {
  a = String(a);
  if (a && !/[\s"]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/** CreationDate of a live PID as a string, or null when no such process. */
export function creationOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const r = ps(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`);
  return r.out || null;
}

export function isAlive(rec) {
  if (!rec || !rec.pid || rec.exitedAt) return false;
  const c = creationOf(rec.pid);
  return !!c && (!rec.pidCreated || c === rec.pidCreated);
}

function start(name, cwd, argv) {
  const old = readRec(name);
  if (old && isAlive(old)) { console.error(`detached-run: "${name}" is already running (pid ${old.pid})`); return 4; }
  mkdirSync(RUN_DIR, { recursive: true });
  const spec = { name, cmd: argv, cwd, log: join(RUN_DIR, `${name}.log`), requestedAt: new Date().toISOString() };
  const specPath = join(RUN_DIR, `${name}.spec.json`);
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  try { writeFileSync(pidFile(name), JSON.stringify({ name, starting: true, requestedAt: spec.requestedAt })); } catch { /* best effort */ }

  const cmdLine = [process.execPath, SELF, 'supervise', specPath].map(winQuote).join(' ');
  const r = ps([
    `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }`,
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psq(cmdLine)}; CurrentDirectory = ${psq(cwd)}; ProcessStartupInformation = $si }`,
    `"$($r.ReturnValue) $($r.ProcessId)"`,
  ].join('; '));
  const [rv, spid] = r.out.split(/\s+/).map(Number);
  if (r.code !== 0 || rv !== 0) { console.error(`detached-run: Win32_Process.Create failed (ReturnValue ${rv}) ${r.err}`); return 1; }

  // Wait for the supervisor to record the real PID.
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const rec = readRec(name);
    if (rec && rec.pid) { console.log(JSON.stringify(rec)); return 0; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  console.error(`detached-run: supervisor ${spid} started but wrote no PID within 15 s; see ${spec.log}`);
  return 1;
}

function supervise(specPath) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  RUN_DIR = dirname(specPath);
  const fd = openSync(spec.log, 'a');
  const [exe, ...args] = spec.cmd;
  const child = spawn(exe, args, { cwd: spec.cwd, stdio: ['ignore', fd, fd], windowsHide: true });
  child.on('error', (e) => {
    writeRec({ name: spec.name, pid: null, cmd: spec.cmd, cwd: spec.cwd, log: spec.log, startedAt: new Date().toISOString(), exitedAt: new Date().toISOString(), error: e.message });
    process.exit(1);
  });
  if (!child.pid) return;
  const rec = { name: spec.name, pid: child.pid, pidCreated: creationOf(child.pid), supervisorPid: process.pid,
    cmd: spec.cmd, cwd: spec.cwd, log: spec.log, startedAt: new Date().toISOString() };
  writeRec(rec);
  child.on('exit', (code, signal) => {
    const cur = readRec(spec.name) || rec;
    if (cur.pid === rec.pid) writeRec({ ...cur, exitedAt: new Date().toISOString(), exitCode: code, signal: signal || undefined });
    process.exit(0);
  });
}

function status(name) {
  const rec = readRec(name);
  if (!rec) { console.log(`${name}: no PID file`); return 2; }
  const alive = isAlive(rec);
  console.log(JSON.stringify({ ...rec, alive }));
  return alive ? 0 : 3;
}

function stop(name) {
  const rec = readRec(name);
  if (!rec || !rec.pid) { console.log(`${name}: nothing recorded`); return 2; }
  if (!isAlive(rec)) { console.log(`${name}: pid ${rec.pid} already gone`); return 0; }
  const r = spawnSync('taskkill.exe', ['/PID', String(rec.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  console.log((r.stdout || r.stderr || '').trim());
  writeRec({ ...readRec(name), exitedAt: new Date().toISOString(), exitCode: null, stoppedBy: 'detached-run stop' });
  return r.status === 0 ? 0 : 1;
}

function list() {
  if (!existsSync(RUN_DIR)) return 0;
  for (const f of readdirSync(RUN_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.spec.json'))) {
    const rec = readRec(f.slice(0, -5));
    if (rec) console.log(`${isAlive(rec) ? 'ALIVE' : 'dead '}  ${rec.name}  pid=${rec.pid}  ${(rec.cmd || []).join(' ')}`);
  }
  return 0;
}

function main(argv) {
  const [verb, name, ...rest] = argv;
  if (verb === 'supervise') { supervise(name); return null; }
  if (verb === 'list') return list();
  if (!verb || !name || !NAME_RE.test(name)) {
    console.error('usage: detached-run.mjs start <name> [--cwd DIR] -- <exe> [args...] | status <name> | stop <name> | list');
    return 2;
  }
  if (verb === 'status') return status(name);
  if (verb === 'stop') return stop(name);
  if (verb === 'start') {
    const dd = rest.indexOf('--');
    if (dd < 0 || dd === rest.length - 1) { console.error('detached-run: give the command after --'); return 2; }
    const opts = rest.slice(0, dd);
    const ci = opts.indexOf('--cwd');
    const cwd = resolve(ci >= 0 ? opts[ci + 1] : process.cwd());
    return start(name, cwd, rest.slice(dd + 1));
  }
  console.error(`detached-run: unknown verb ${verb}`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
