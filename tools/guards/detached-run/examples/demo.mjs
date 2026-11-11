#!/usr/bin/env node
/**
 * demo.mjs: a 10-second tour of detached-run. Starts a throwaway "ticker" job, reads its status and log,
 * stops it, and checks it reads dead. Uses a temporary state directory and cleans up after itself.
 *
 *   node examples/demo.mjs
 *
 * Paths in the printed output are shortened to <tmp> so the transcript is safe to paste anywhere.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DR = join(dirname(fileURLToPath(import.meta.url)), '..', 'detached-run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'detached-run-demo-'));
const env = { ...process.env, DETACHED_RUN_DIR: dir };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tidy = (s) => s.split(dir).join('<tmp>').split(dir.replace(/\\/g, '\\\\')).join('<tmp>').split(dir.replace(/\\/g, '/')).join('<tmp>');

function run(shown, args) {
  console.log(`$ ${shown}`);
  const r = spawnSync(process.execPath, [DR, ...args], { encoding: 'utf8', windowsHide: true, env, timeout: 90000 });
  let out = tidy(((r.stdout || '') + (r.stderr || '')).trim());
  // The record is long; show the fields that matter (pass --full to see everything).
  if (!process.argv.includes('--full')) {
    try {
      const rec = JSON.parse(out);
      const keep = ['name', 'pid', 'supervisorPid', 'alive', 'exitCode', 'stoppedBy'];
      out = JSON.stringify(Object.fromEntries(keep.filter((k) => k in rec).map((k) => [k, rec[k]]))).replace(/}$/, ',…}');
    } catch { /* not JSON: print as is */ }
  }
  if (out) console.log(out);
  console.log(`# exit ${r.status}`);
  return r;
}

const tick = 'setInterval(()=>console.log("tick",new Date().toISOString()),1000)';
try {
  run(`node detached-run.mjs start ticker --cwd <tmp> -- node -e '${tick}'`, ['start', 'ticker', '--cwd', dir, '--', process.execPath, '-e', tick]);
  sleep(3500);
  const st = run('node detached-run.mjs status ticker', ['status', 'ticker']);
  try {
    const rec = JSON.parse(st.stdout);
    const log = readFileSync(rec.log, 'utf8').trim().split('\n');
    console.log(`$ tail -n 2 <tmp>/ticker.log`);
    console.log(log.slice(-2).join('\n'));
  } catch { /* status already printed the problem */ }
  run('node detached-run.mjs stop ticker', ['stop', 'ticker']);
  run('node detached-run.mjs status ticker', ['status', 'ticker']);
} finally {
  spawnSync(process.execPath, [DR, 'stop', 'ticker'], { windowsHide: true, env, timeout: 60000 });
  rmSync(dir, { recursive: true, force: true });
}
