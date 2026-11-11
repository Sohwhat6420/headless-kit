// Tests never stop a real process they did not start themselves: the rules are checked against fake process lists,
// --snapshot runs simulate their kills, and the one real close targets a child this test spawned, matched by a
// random marker in its command line (a second spawned child, with another marker, must survive). Run: node --test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normaliseConfig, normaliseSnapshot, assess, verify, procMatches, protectedPids, runBusyCheck, parseArgs, UsageError } from '../app-closer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'app-closer.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-closer-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const MIN = 60000;
const T0 = Date.parse('2026-11-11T09:00:00Z');

// A small fake machine. pid 100 = a shell (in front), 200 = chat app, 300/301 = launcher + helper, 302 = a game it started.
const P = {
  shell: { pid: 100, ppid: 1, name: 'shell.exe', path: 'C:/Apps/shell.exe', commandLine: 'shell', mb: 10 },
  chat: { pid: 200, ppid: 1, name: 'chat-client.exe', path: 'C:/Apps/Chat/chat-client.exe', commandLine: 'chat-client --tray', mb: 300 },
  chatHelper: { pid: 201, ppid: 200, name: 'chat-client.exe', path: 'C:/Apps/Chat/chat-client.exe', commandLine: 'chat-client --type=renderer', mb: 150 },
  launcher: { pid: 300, ppid: 1, name: 'GameLauncher.exe', path: 'C:/Games/GameLauncher.exe', commandLine: 'GameLauncher', mb: 200 },
  helper: { pid: 301, ppid: 300, name: 'GameLauncherHelper.exe', path: 'C:/Games/GameLauncherHelper.exe', commandLine: 'helper', mb: 80 },
  game: { pid: 302, ppid: 300, name: 'SomeGame.exe', path: 'C:/Games/Library/SomeGame/SomeGame.exe', commandLine: 'SomeGame', mb: 4000 },
  explorer: { pid: 50, ppid: 1, name: 'explorer.exe', path: 'C:/Windows/explorer.exe', commandLine: 'explorer', mb: 100 },
};
const snap = (procs, extra = {}) => normaliseSnapshot({ procs, commitPct: 90, fgPid: P.shell.pid, ...extra });
const cfgOf = (apps, extra = {}) => normaliseConfig({ apps, verifyDelayMs: 0, ...extra });
const idleDeps = { busy: () => ({ busy: false }), selfPid: 999999 };
const rowOf = (res, app) => res.rows.find((r) => r.app === app);

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, APP_CLOSER_CONFIG: '', APP_CLOSER_DIR: path.join(tmp, 'state-' + randomUUID()), ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* left null */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const writeJson = (name, j) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(j)); return f; };

test('matching: every given field must match (any regex within a field); not* fields exclude', () => {
  const m = normaliseConfig({ apps: [{ app: 'x', match: { name: ['^chat-client', '^other'], path: ['[\\\\/]Chat[\\\\/]'], notCommandLine: ['--type=renderer'] } }] }).apps[0].match;
  assert.ok(procMatches(P.chat, m));
  assert.ok(!procMatches(P.chatHelper, m), 'notCommandLine excludes the renderer');
  assert.ok(!procMatches(P.launcher, m));
  assert.ok(!procMatches({ ...P.chat, path: 'C:/Elsewhere/chat-client.exe' }, m), 'path must match too');
});

test('protected: OS-critical names, the never list, this process and its ancestors are never rows', () => {
  const me = { pid: 700, ppid: 600, name: 'node.exe', path: '', commandLine: 'node app-closer.mjs', mb: 50 };
  const parent = { pid: 600, ppid: 1, name: 'node.exe', path: '', commandLine: 'node runner', mb: 50 };
  const other = { pid: 800, ppid: 1, name: 'node.exe', path: '', commandLine: 'node server', mb: 50 };
  const backup = { pid: 900, ppid: 1, name: 'backup-agent.exe', path: '', commandLine: '', mb: 5 };
  const s = snap([P.shell, P.explorer, me, parent, other, backup]);
  const cfg = cfgOf([{ app: 'everything', match: { name: ['.'] }, skipIfForeground: false }], { never: ['^backup-agent'] });
  const prot = protectedPids(s, cfg, 700);
  for (const pid of [50, 600, 700, 900]) assert.ok(prot.has(pid), `pid ${pid} protected`);
  const res = assess(s, cfg, {}, T0, { ...idleDeps, selfPid: 700 });
  assert.deepEqual(rowOf(res, 'everything').pids.sort(), [100, 800]);
});

test('the window in front keeps its app (whole parent chain); an unknown foreground keeps it unless told otherwise', () => {
  const cfg = cfgOf([{ app: 'Chat', match: { name: ['^chat-client'] } }]);
  let r = rowOf(assess(snap([P.shell, P.chat, P.chatHelper], { fgPid: 201 }), cfg, {}, T0, idleDeps), 'Chat');
  assert.equal(r.closable, false);
  assert.match(r.why, /window is in front/);
  r = rowOf(assess(snap([P.shell, P.chat, P.chatHelper]), cfg, {}, T0, idleDeps), 'Chat');
  assert.equal(r.closable, true);
  assert.equal(r.mb, 450);
  r = rowOf(assess(snap([P.chat], { fgPid: null }), cfg, {}, T0, idleDeps), 'Chat');
  assert.equal(r.closable, false);
  assert.match(r.why, /unknown on this platform/);
  const ign = cfgOf([{ app: 'Chat', match: { name: ['^chat-client'] } }], { foregroundUnknown: 'ignore' });
  assert.equal(rowOf(assess(snap([P.chat], { fgPid: null }), ign, {}, T0, idleDeps), 'Chat').closable, true);
});

test('unlessRunning and unlessChildRunning keep a launcher while its game is open', () => {
  const launcher = { app: 'Launcher', match: { name: ['^GameLauncher(Helper)?\\.exe$'] } };
  const withChild = cfgOf([{ ...launcher, unlessChildRunning: { except: ['^GameLauncherHelper'], reason: 'a game is open' } }]);
  let r = rowOf(assess(snap([P.shell, P.launcher, P.helper, P.game]), withChild, {}, T0, idleDeps), 'Launcher');
  assert.equal(r.closable, false);
  assert.match(r.why, /a game is open \(SomeGame\.exe\)/);
  r = rowOf(assess(snap([P.shell, P.launcher, P.helper]), withChild, {}, T0, idleDeps), 'Launcher');
  assert.equal(r.closable, true, 'its own helper does not count as a game');
  const withRunning = cfgOf([{ ...launcher, unlessRunning: [{ path: ['[\\\\/]Library[\\\\/]'], reason: 'a library game runs' }] }]);
  r = rowOf(assess(snap([P.shell, P.launcher, { ...P.game, ppid: 1 }]), withRunning, {}, T0, idleDeps), 'Launcher');
  assert.equal(r.why, 'a library game runs');
});

test('orphanOnly takes only processes whose parent is gone; unlessParent skips ones started from a shell', () => {
  const dev = (pid, ppid) => ({ pid, ppid, name: 'python.exe', path: '', commandLine: `python dev-server.py --port ${pid}`, mb: 40 });
  const cfg = cfgOf([{ app: 'Dev server', match: { name: ['^python'], commandLine: ['dev-server\\.py'] }, orphanOnly: true }]);
  assert.deepEqual(rowOf(assess(snap([P.shell, dev(400, 100), dev(401, 12345)]), cfg, {}, T0, idleDeps), 'Dev server').pids, [401]);
  const notes = { pid: 500, ppid: 100, name: 'notes-app.exe', path: 'C:/Apps/notes-app.exe', commandLine: 'notes-app', mb: 90 };
  const notes2 = { ...notes, pid: 501, ppid: 1 };
  const c2 = cfgOf([{ app: 'Notes', match: { name: ['^notes-app'] }, unlessParent: ['^shell\\.exe$'] }]);
  assert.deepEqual(rowOf(assess(snap([P.shell, notes, notes2]), c2, {}, T0, idleDeps), 'Notes').pids, [501]);
});

test('busyCheck: busy keeps it, idle lets it close, a check that fails keeps it to be safe', () => {
  const cfg = cfgOf([{ app: 'Chat', match: { name: ['^chat-client'] }, busyCheck: { argv: ['fake'], reason: 'in a call' } }]);
  const s = snap([P.shell, P.chat]);
  assert.equal(rowOf(assess(s, cfg, {}, T0, { ...idleDeps, busy: () => ({ busy: true }) }), 'Chat').why, 'in a call');
  assert.equal(rowOf(assess(s, cfg, {}, T0, { ...idleDeps, busy: () => ({ busy: false }) }), 'Chat').closable, true);
  const f = rowOf(assess(s, cfg, {}, T0, { ...idleDeps, busy: () => ({ failed: true, why: 'busy check exited 1' }) }), 'Chat');
  assert.equal(f.closable, false);
  assert.match(f.why, /kept to be safe/);
});

test('runBusyCheck runs the argv with no shell: output, exit code, and a missing command', () => {
  const node = process.execPath;
  assert.deepEqual(runBusyCheck({ argv: [node, '-e', 'console.log("abc")'], busyWhen: 'output', timeoutMs: 20000 }), { busy: true });
  assert.deepEqual(runBusyCheck({ argv: [node, '-e', ''], busyWhen: 'output', timeoutMs: 20000 }), { busy: false });
  assert.deepEqual(runBusyCheck({ argv: [node, '-e', 'process.exit(0)'], busyWhen: 'exit0', timeoutMs: 20000 }), { busy: true });
  assert.deepEqual(runBusyCheck({ argv: [node, '-e', 'process.exit(3)'], busyWhen: 'nonzero', timeoutMs: 20000 }), { busy: true });
  assert.equal(runBusyCheck({ argv: ['definitely-not-a-command-' + randomUUID()], busyWhen: 'output', timeoutMs: 20000 }).failed, true);
});

test('idleMinutes: closable only after the app has been idle that long across runs; a keep resets the clock', () => {
  const cfg = cfgOf([{ app: 'Chat', match: { name: ['^chat-client'] }, idleMinutes: 5 }]);
  let res = assess(snap([P.shell, P.chat]), cfg, {}, T0, idleDeps);
  assert.match(rowOf(res, 'Chat').why, /idle for 0\.0 min; closes after 5/);
  res = assess(snap([P.shell, P.chat]), cfg, res.state, T0 + 3 * MIN, idleDeps);
  assert.equal(rowOf(res, 'Chat').closable, false);
  const inFront = assess(snap([P.shell, P.chat], { fgPid: 200 }), cfg, res.state, T0 + 4 * MIN, idleDeps);
  assert.equal(inFront.state.idleSince.Chat, undefined, 'being in front resets the idle clock');
  res = assess(snap([P.shell, P.chat]), cfg, res.state, T0 + 6 * MIN, idleDeps);
  assert.equal(rowOf(res, 'Chat').closable, true);
  assert.match(rowOf(res, 'Chat').why, /idle for 6 min/);
});

test('respawn: an app the OS restarts at once is held, then released after holdMin; repeated closes also hold', () => {
  const cfg = cfgOf([{ app: 'Chat', match: { name: ['^chat-client'] } }]);
  const s = snap([P.shell, P.chat]);
  const res = assess(s, cfg, {}, T0, idleDeps);
  const closed = [{ ...rowOf(res, 'Chat'), killed: [200] }];
  const v = verify(closed, snap([P.shell, { ...P.chat, pid: 210 }]), cfg, res.state, T0, idleDeps);
  assert.equal(v.verdicts.get('Chat'), 'RESPAWNED (1 back)');
  let r = assess(snap([P.shell, { ...P.chat, pid: 210 }]), cfg, v.state, T0 + 2 * MIN, idleDeps);
  assert.match(rowOf(r, 'Chat').why, /OS restarts it/);
  r = assess(snap([P.shell, { ...P.chat, pid: 210 }]), cfg, r.state, T0 + 125 * MIN, idleDeps);
  assert.equal(rowOf(r, 'Chat').closable, true, 'released after holdMin');
  // Three closes inside repeatWindowMin, each coming back after the respawn window: held too.
  const st = { closeLog: { Chat: [T0 - 50 * MIN, T0 - 35 * MIN, T0 - 20 * MIN] }, closedAt: { Chat: T0 - 20 * MIN } };
  assert.equal(rowOf(assess(s, cfg, st, T0, idleDeps), 'Chat').closable, false);
  const noHold = cfgOf([{ app: 'Chat', match: { name: ['^chat-client'] }, respawnHold: false }]);
  assert.equal(rowOf(assess(s, noHold, st, T0, idleDeps), 'Chat').closable, true);
});

test('refused kills: none sent is KILL REFUSED, a survivor is PARTLY REFUSED; both wait refusedRetryMin', () => {
  const cfg = cfgOf([{ app: 'Chat', match: { name: ['^chat-client'] } }]);
  const res = assess(snap([P.shell, P.chat, P.chatHelper]), cfg, {}, T0, idleDeps);
  const row = rowOf(res, 'Chat');
  let v = verify([{ ...row, killed: [] }], null, cfg, res.state, T0, idleDeps);
  assert.equal(v.verdicts.get('Chat'), 'KILL REFUSED');
  assert.match(rowOf(assess(snap([P.shell, P.chat]), cfg, v.state, T0 + 10 * MIN, idleDeps), 'Chat').why, /was refused/);
  assert.equal(rowOf(assess(snap([P.shell, P.chat]), cfg, v.state, T0 + 31 * MIN, idleDeps), 'Chat').closable, true);
  v = verify([{ ...row, killed: [200, 201] }], snap([P.shell, P.chatHelper]), cfg, res.state, T0, idleDeps);
  assert.equal(v.verdicts.get('Chat'), 'PARTLY REFUSED');
  v = verify([{ ...row, killed: [200, 201] }], snap([P.shell]), cfg, res.state, T0, idleDeps);
  assert.equal(v.verdicts.get('Chat'), 'CLOSED');
});

test('CLI with --snapshot: report closes nothing; --close obeys the memory gate; kills are simulated', () => {
  const cfg = writeJson('cfg.json', { verifyDelayMs: 0, closeAtPct: 80, apps: [{ app: 'Chat', match: { name: ['^chat-client'] } }] });
  const hot = writeJson('hot.json', { commitPct: 91, fgPid: 100, procs: [P.shell, P.chat] });
  const cool = writeJson('cool.json', { commitPct: 40, fgPid: 100, procs: [P.shell, P.chat] });
  const blind = writeJson('blind.json', { fgPid: 100, procs: [P.shell, P.chat] });
  const back = writeJson('back.json', { commitPct: 91, fgPid: 100, procs: [P.shell, { ...P.chat, pid: 220 }] });
  let r = cli(['--config', cfg, '--snapshot', hot]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.mode, 'report');
  assert.equal(r.json.rows[0].verdict, 'closable');
  r = cli(['--config', cfg, '--snapshot', cool, '--close']);
  assert.equal(r.code, 3);
  assert.equal(r.json.rows[0].verdict, 'kept (memory under 80%)');
  r = cli(['--config', cfg, '--snapshot', blind, '--close']);
  assert.equal(r.code, 3);
  assert.equal(r.json.rows[0].verdict, 'kept (memory unreadable)');
  r = cli(['--config', cfg, '--snapshot', hot, '--close', '--explain']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.simulated, true);
  assert.equal(r.json.rows[0].verdict, 'CLOSED');
  assert.match(r.err, /CLOSED\s+Chat/);
  r = cli(['--config', cfg, '--snapshot', cool, '--close', '--ignore-memory']);
  assert.equal(r.json.rows[0].verdict, 'CLOSED');
  r = cli(['--config', cfg, '--snapshot', hot, '--snapshot-after', back, '--close']);
  assert.equal(r.json.rows[0].verdict, 'RESPAWNED (1 back)');
  // A simulated run never writes the real state or log, so it cannot hold a real app afterwards.
  const dir = path.join(tmp, 'sim-state');
  r = cli(['--config', cfg, '--snapshot', hot, '--close'], { APP_CLOSER_DIR: dir });
  assert.equal(r.json.rows[0].verdict, 'CLOSED');
  assert.equal(fs.existsSync(dir), false);
});

test('bad usage and bad config exit 2 with a JSON error', () => {
  assert.throws(() => parseArgs(['--ignore-memory']), UsageError);
  assert.throws(() => parseArgs(['--watch', '0']), UsageError);
  assert.throws(() => normaliseConfig({ apps: [{ app: 'a', match: {} }] }), /at least one of/);
  assert.throws(() => normaliseConfig({ apps: [{ app: 'a', match: { name: ['('] } }] }), /bad regex/);
  assert.throws(() => normaliseConfig({ apps: [{ app: 'a', match: { name: 'x' } }, { app: 'a', match: { name: 'y' } }] }), /duplicate/);
  assert.throws(() => normaliseConfig({ apps: [{ app: 'a', match: { name: 'x' }, busyCheck: { argv: 'docker ps' } }] }), /argv/);
  const bad = writeJson('bad.json', { apps: 'nope' });
  for (const args of [[], ['--config', bad], ['--config', path.join(tmp, 'missing.json')], ['--close', '--wat'], ['--snapshot-after', 'x']]) {
    const r = cli(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.json && r.json.error, args.join(' '));
  }
});

test('a real close stops only the spawned child that matches; report mode and a non-matching child are left alone', { timeout: 120000 }, async () => {
  const target = randomUUID(), bystander = randomUUID();
  const start = (marker) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { windowsHide: true, stdio: 'ignore' });
  const a = start(target), b = start(bystander);
  const exited = (c) => new Promise((res) => { if (c.exitCode !== null || c.signalCode !== null) res(true); else c.once('exit', () => res(true)); });
  const aGone = exited(a);
  try {
    await new Promise((r) => setTimeout(r, 500));
    const cfg = writeJson('real.json', { verifyDelayMs: 300, apps: [{ app: 'Test child', match: { name: ['^node(\\.exe)?$'], commandLine: [target] }, skipIfForeground: false }] });
    let r = cli(['--config', cfg]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json.rows.map((x) => [x.app, x.pids, x.verdict]), [['Test child', [a.pid], 'closable']]);
    assert.equal(a.exitCode, null, 'report mode stopped nothing');
    r = cli(['--config', cfg, '--close', '--ignore-memory']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.simulated, false);
    assert.equal(r.json.rows[0].verdict, 'CLOSED');
    assert.equal(await Promise.race([aGone, new Promise((res) => setTimeout(() => res(false), 10000))]), true, 'the target exited');
    assert.equal(b.exitCode, null, 'the bystander is still running');
  } finally {
    for (const c of [a, b]) { try { c.kill(); } catch { /* already gone */ } }
  }
});

test('--help exits 0', () => {
  const r = cli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /--ignore-memory/);
});
