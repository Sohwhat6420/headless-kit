#!/usr/bin/env node
/**
 * detached-run.test.mjs — proves detached-run.mjs starts processes with ZERO windows.
 *
 *   node test/detached-run.test.mjs
 *
 * windowwatch.py polls every 50 ms for any new visible top-level window while we start a node
 * target and a python (console-subsystem) target, read status, and stop both. Also compares an
 * EnumWindows visible-window count before and after. Serial on purpose: no fan-out of spawning tests.
 * Exit 0 only when every check passes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DR = join(HERE, '..', 'detached-run.mjs');
const WATCH = join(HERE, 'windowwatch.py');
const dir = mkdtempSync(join(tmpdir(), 'detached-run-test-'));
const env = { ...process.env, DETACHED_RUN_DIR: dir };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let fails = 0;
const check = (ok, what, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!ok) fails++; };

const dr = (...args) => spawnSync(process.execPath, [DR, ...args], { encoding: 'utf8', windowsHide: true, env, timeout: 90000 });
const ps = (cmd) => (spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const visibleCount = () => Number((spawnSync('python', ['-c', [
  'import ctypes', 'from ctypes import wintypes', 'u=ctypes.WinDLL("user32")', 'n=[0]',
  'P=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)',
  'def cb(h,_):', '    n[0]+=bool(u.IsWindowVisible(h)); return True',
  'u.EnumWindows(P(cb),0)', 'print(n[0])'].join('\n')], { encoding: 'utf8', windowsHide: true }).stdout || '').trim());

// Positive control: windowwatch must SEE a window, or a 0 below proves nothing. A 1x1 tool window
// far off-screen, no activation, for 0.6 s: visible to EnumWindows, invisible to the user.
{
  const ctl = spawn('python', [WATCH, '4'], { windowsHide: true });
  let out = '';
  ctl.stdout.on('data', (d) => { out += d; });
  const done = new Promise((r) => ctl.on('exit', r));
  sleep(1200);
  spawnSync('python', ['-c', [
    'import ctypes, time', 'u=ctypes.WinDLL("user32")',
    'u.CreateWindowExW.restype=ctypes.c_void_p',
    'h=u.CreateWindowExW(0x08000080,"STATIC","dr-ctl",0x90000000,-30000,-30000,1,1,None,None,None,None)',
    'time.sleep(0.6)', 'u.DestroyWindow(ctypes.c_void_p(h))'].join('\n')], { windowsHide: true });
  await done;
  check(/new visible windows: [1-9]/.test(out), 'positive control: windowwatch sees an off-screen test window', out.trim().split('\n').pop());
}

const stopFile = join(dir, 'watch.stop');
const before = visibleCount();
let watchOut = '';
const watch = spawn('python', [WATCH, '120', '--stop-file', stopFile], { windowsHide: true });
watch.stdout.on('data', (d) => { watchOut += d; });
const watchDone = new Promise((r) => watch.on('exit', r));
sleep(1500); // let windowwatch take its baseline

const targets = [
  ['t-node', [process.execPath, '-e', 'setTimeout(()=>{},60000)']],
  ['t-python', ['python', '-c', 'import time; print("hello", flush=True); time.sleep(60)']],
];
const pids = new Set();
for (const [name, cmd] of targets) {
  const r = dr('start', name, '--', ...cmd);
  check(r.status === 0, `start ${name}`, r.status === 0 ? '' : r.stderr.trim());
  let rec = {};
  try { rec = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* checked below */ }
  check(Number.isInteger(rec.pid) && !!rec.pidCreated, `${name} PID file has pid + pidCreated`, `pid=${rec.pid}`);
  if (rec.pid) pids.add(rec.pid);
  if (rec.supervisorPid) {
    pids.add(rec.supervisorPid);
    const parent = ps(`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${rec.supervisorPid}"; (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)").Name`);
    check(parent !== 'node.exe' && parent !== 'powershell.exe', `${name} supervisor is not parented to this session`, `parent=${parent || '(gone: orphaned, also fine)'}`);
  }
  const s = dr('status', name);
  check(s.status === 0, `${name} status says alive`);
}
sleep(2000);
check(readFileSync(join(dir, 't-python.log'), 'utf8').includes('hello'), 't-python stdout reached its log');

for (const [name] of targets) {
  const k = dr('stop', name);
  check(k.status === 0, `stop ${name}`);
  check(dr('status', name).status === 3, `${name} status says dead after stop`);
}

// PID reuse guard: a record whose pidCreated does not match the live process reads dead.
writeFileSync(join(dir, 't-reuse.json'), JSON.stringify({ name: 't-reuse', pid: process.pid, pidCreated: '2000-01-01T00:00:00.0000000Z' }));
check(dr('status', 't-reuse').status === 3, 'recycled PID (CreationDate mismatch) reads dead');

sleep(1000);
writeFileSync(stopFile, '');
await watchDone;
const after = visibleCount();
const newLines = watchOut.split('\n').filter((l) => l.startsWith('NEW '));
const ours = newLines.filter((l) => [...pids].some((p) => l.includes(`pid=${p} `)) || /ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS|PseudoConsoleWindow/.test(l));
console.log(watchOut.trim().split('\n').map((l) => '   watch: ' + l).join('\n'));
check(ours.length === 0, 'no console / terminal / our-PID window appeared at any 50 ms poll', `${ours.length} of ${newLines.length} new windows`);
check(after === before, 'EnumWindows visible count unchanged', `before=${before} after=${after}`);

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
