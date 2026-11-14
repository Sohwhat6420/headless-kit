// Reproducible measurements behind the numbers in the root README.
//
//   node scripts/measure.mjs            offline: static audit + timed tool runs (default 15 runs each)
//   node scripts/measure.mjs --live     also one small reddit-pull run against the public Arctic Shift API
//   node scripts/measure.mjs --runs 30  more runs per case
//
// stdout: one JSON object. stderr: a human summary. Exit 0 measured, 1 a check failed (a tool exited
// unexpectedly or printed something other than one JSON line), 2 usage error.
// Writes only inside a fresh temp folder, which it removes. Runs one process at a time (no fan-out).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  process.stderr.write('usage: node scripts/measure.mjs [--live] [--runs N]\n');
  process.exit(0);
}
const live = argv.includes('--live');
const ri = argv.indexOf('--runs');
const RUNS = ri >= 0 ? Number(argv[ri + 1]) : 15;
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 200) { process.stderr.write('--runs must be 1 to 200\n'); process.exit(2); }

const rel = (p) => relative(root, p).replace(/\\/g, '/');
const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    if (n === 'node_modules' || n === '.git' || n === '.preview') continue;
    const p = join(d, n);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};
const sizeOf = (p) => (statSync(p).isDirectory() ? walk(p).reduce((s, f) => s + statSync(f).size, 0) : statSync(p).size);

// ---------------------------------------------------------------------------------------------
// 1. Static audit
// ---------------------------------------------------------------------------------------------
const subdirs = (d) => (existsSync(d) ? readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory()).sort() : []);
const tools = [];
for (const c of subdirs(join(root, 'tools'))) for (const t of subdirs(join(root, 'tools', c))) tools.push(`tools/${c}/${t}`);
const hooks = subdirs(join(root, 'hooks')).map((h) => `hooks/${h}`);

const pkgs = walk(root).filter((p) => p.endsWith('package.json'));
const deps = {};
for (const p of pkgs) {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(j[k] || {})) (deps[rel(p)] ||= []).push(name);
  }
}

// Every child-process call in shipped code (tests excluded): spawn, spawnSync, execFile, execFileSync, exec,
// execSync, fork, and the injectable *Impl aliases. The call's argument text is read with bracket matching.
const CALL = /(^|[^.\w$])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|execFileImpl|execFileSyncImpl)\s*\(/g;
const sources = walk(root).filter((p) => ['.mjs', '.js', '.ts'].includes(extname(p)) && !/[\\/](test|fixtures)[\\/]/.test(p) && !p.endsWith('.test.ts'));
const calls = [];
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  if (!/child_process/.test(text)) continue;
  for (const m of text.matchAll(CALL)) {
    const before = text.slice(Math.max(0, m.index - 12), m.index + m[1].length);
    if (/function\s*$/.test(before)) continue;                 // a definition, not a call
    let i = m.index + m[0].length, depth = 1;
    while (i < text.length && depth) { const ch = text[i++]; if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; }
    const args = text.slice(m.index + m[0].length, i - 1);
    const line = text.slice(0, m.index).split('\n').length;
    calls.push({ at: `${rel(file)}:${line}`, fn: m[2], windowsHide: /windowsHide\s*:\s*true/.test(args), shellTrue: /shell\s*:\s*true/.test(args) });
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Timed runs (offline, examples and fixtures shipped in the repo)
// ---------------------------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'hk-measure-'));
function run(c) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, c.args, {
    cwd: join(root, c.cwd || '.'), input: c.stdin ? readFileSync(join(root, c.stdin)) : undefined,
    env: { ...process.env, ...(c.env || {}) }, encoding: 'utf8', windowsHide: true, timeout: c.timeout || 60000, maxBuffer: 64 << 20,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, code: r.status, out: r.stdout || '' };
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const r1 = (v) => Math.round(v * 10) / 10;

const cases = [
  { id: 'node-startup', note: 'baseline: Node starting and exiting, no tool', args: ['-e', '0'], expectJson: false },
  { id: 'memory-gate', note: 'a real reading of this machine', cwd: 'tools/guards/memory-gate', args: ['memory-gate.mjs'], okCodes: [0, 3, 4, 5] },
  { id: 'model-router', note: 'five example pools, bulk task', cwd: 'tools/routing/model-router', args: ['model-router.mjs', '--task', 'bulk', '--config', 'examples/config.example.json', '--at', '2026-11-19T08:00:00Z'], reads: ['tools/routing/model-router/examples/config.example.json'] },
  { id: 'lane-model-check', note: 'example transcript', cwd: 'tools/guards/lane-model-check', args: ['lane-model-check.mjs', '--transcript', 'examples/transcript.example.jsonl', '--expect', 'model-small'], reads: ['tools/guards/lane-model-check/examples/transcript.example.jsonl'] },
  { id: 'token-totals', note: 'fixture session logs', cwd: 'tools/research/token-totals', args: ['token-totals.mjs'], env: { TOKEN_TOTALS_ROOT: 'test/fixtures/projects', TOKEN_TOTALS_LEDGER: join(tmp, 'ledger.jsonl') }, reads: ['tools/research/token-totals/test/fixtures/projects'] },
  { id: 'plan-depth (hook)', note: 'PreToolUse ExitPlanMode on a thin plan, input on stdin', cwd: 'hooks/plan-depth', args: ['plan-depth.mjs'], stdin: 'hooks/plan-depth/examples/exit-plan-thin.json' },
];

let failures = 0;
const timed = [];
for (const c of cases) {
  const ms = []; let last;
  for (let i = 0; i < RUNS; i++) { last = run(c); ms.push(last.ms); }
  const lines = last.out.split('\n').filter(Boolean);
  let oneJson = false;
  try { oneJson = lines.length === 1 && typeof JSON.parse(lines[0]) === 'object'; } catch { /* not JSON */ }
  const codeOk = (c.okCodes || [0]).includes(last.code);
  const ok = codeOk && (c.expectJson === false || oneJson);
  if (!ok) failures++;
  timed.push({
    id: c.id, note: c.note, runs: RUNS, medianMs: r1(median(ms)), minMs: r1(Math.min(...ms)), maxMs: r1(Math.max(...ms)),
    exitCode: last.code, stdoutBytes: Buffer.byteLength(last.out), oneJsonLine: c.expectJson === false ? null : oneJson,
    inputBytes: c.reads ? c.reads.reduce((s, p) => s + sizeOf(join(root, p)), 0) : null, ok,
  });
}

// ---------------------------------------------------------------------------------------------
// 3. Live (opt-in): one small reddit-pull run. About 2 to 6 requests to a free, volunteer-run API.
// ---------------------------------------------------------------------------------------------
let liveRun = null;
if (live) {
  const after = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const out = join(tmp, 'reddit');
  const args = ['reddit-pull.mjs', '--sub', 'rust', '--after', after, '--comments', '--max-pages', '3', '--out', out];
  const r = run({ cwd: 'tools/research/reddit-pull', args, timeout: 300000 });
  let parsed = null; try { parsed = JSON.parse(r.out.trim()); } catch { /* reported below */ }
  const written = existsSync(out) ? sizeOf(out) : 0;
  if (r.code !== 0 || !parsed) failures++;
  liveRun = {
    command: `node reddit-pull.mjs ${args.slice(1).join(' ').replace(out, '<tmp>/reddit')}`,
    ms: Math.round(r.ms), exitCode: r.code, stdoutBytes: Buffer.byteLength(r.out), bytesWrittenToFiles: written,
    ratio: written && r.out ? Math.round(written / Buffer.byteLength(r.out)) : null, result: parsed,
  };
}
rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------------
const result = {
  measuredAt: new Date().toISOString(),
  machine: { platform: platform(), release: release(), node: process.version, cpu: cpus()[0]?.model || null, cpus: cpus().length, memGB: r1(totalmem() / 2 ** 30) },
  items: { tools: tools.length, hooks: hooks.length, total: tools.length + hooks.length },
  dependencies: { packageJsonFiles: pkgs.length, total: Object.values(deps).flat().length, byFile: deps },
  childProcessCalls: { total: calls.length, withWindowsHide: calls.filter((c) => c.windowsHide).length, withShellTrue: calls.filter((c) => c.shellTrue).length, missingWindowsHide: calls.filter((c) => !c.windowsHide).map((c) => c.at) },
  timed,
  live: liveRun,
  ok: failures === 0,
};
process.stdout.write(JSON.stringify(result) + '\n');

const e = (s) => process.stderr.write(s + '\n');
e(`items: ${result.items.tools} tools + ${result.items.hooks} hooks = ${result.items.total}`);
e(`dependencies: ${result.dependencies.total} across ${result.dependencies.packageJsonFiles} package.json files`);
e(`child-process calls: ${result.childProcessCalls.withWindowsHide} of ${result.childProcessCalls.total} pass windowsHide: true; shell: true in ${result.childProcessCalls.withShellTrue}`);
e(`timed (${RUNS} runs each, ${result.machine.platform}, Node ${result.machine.node}):`);
for (const t of timed) e(`  ${t.id.padEnd(18)} median ${String(t.medianMs).padStart(6)} ms   stdout ${String(t.stdoutBytes).padStart(5)} B   exit ${t.exitCode}${t.ok ? '' : '   CHECK FAILED'}`);
if (liveRun) e(`live reddit-pull: ${liveRun.ms} ms, stdout ${liveRun.stdoutBytes} B, files ${liveRun.bytesWrittenToFiles} B (${liveRun.ratio}x), exit ${liveRun.exitCode}`);
process.exit(failures ? 1 : 0);
