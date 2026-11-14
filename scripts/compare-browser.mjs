// The same job done two ways: an agent driving a browser, and the headless-kit tool.
// Measures what lands in the agent's context each way, in bytes and in tokens.
//
//   node scripts/compare-browser.mjs --playwright <dir of the playwright package> --tokenizer <dir of gpt-tokenizer>
//   node scripts/compare-browser.mjs ... --sub rust --user antirez --out result.json
//
// Neither package is a dependency of the kit. They are needed only to take this measurement:
//   - Playwright drives its own bundled Chromium, headless (no window), to load the real page and take the
//     accessibility snapshot a browser tool hands an agent (the same call Playwright MCP's browser_snapshot uses).
//   - gpt-tokenizer counts tokens with the o200k_base encoding. Other models' tokenisers give different
//     counts; the bytes are exact and are reported next to every token figure.
//
// stdout: one JSON object. stderr: a human summary. Exit 0 measured, 1 a route failed or a control failed,
// 2 usage error. Writes only inside a fresh temp folder, which it removes. One process at a time.
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, platform, release } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
if (argv.includes('--help')) {
  process.stderr.write('usage: node scripts/compare-browser.mjs --playwright DIR --tokenizer DIR [--sub NAME] [--user LOGIN] [--out FILE]\n');
  process.exit(0);
}
const SUB = flag('--sub', 'rust');
const USER = flag('--user', 'antirez');
const OUT = flag('--out', null);
const pwDir = flag('--playwright', null);
const tkDir = flag('--tokenizer', null);
if (!/^[A-Za-z0-9_]{2,21}$/.test(SUB) || !/^[A-Za-z0-9-]{1,39}$/.test(USER)) { process.stderr.write('bad --sub or --user\n'); process.exit(2); }

const load = async (dir, name, entry) => {
  try { return await import(dir ? pathToFileURL(resolve(dir, entry)).href : name); }
  catch (e) { process.stderr.write(`cannot load ${name}: ${e.message}\n(install it somewhere and pass its folder; it is not a dependency of the kit)\n`); process.exit(2); }
};
const pw = await load(pwDir, 'playwright', 'index.mjs');
const tk = await load(tkDir, 'gpt-tokenizer/encoding/o200k_base', 'esm/encoding/o200k_base.js');
const chromium = pw.chromium || pw.default?.chromium;
const countTokens = tk.countTokens || tk.default?.countTokens;
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const size = (s) => ({ bytes: bytes(s), tokens: countTokens(s) });

const tmp = mkdtempSync(join(tmpdir(), 'hk-compare-'));
const run = (script, args) => {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [join(root, script), ...args], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ms: Math.round(performance.now() - t0) };
};

// ---------------------------------------------------------------------------------------------
// The browser route: load the page, wait for it to settle, take what a browser tool gives the agent.
// ---------------------------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-GB' });
const view = async (url) => {
  const page = await ctx.newPage();
  const t0 = performance.now();
  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    status = resp ? resp.status() : 0;
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const snapshot = typeof page._snapshotForAI === 'function'
      ? await page._snapshotForAI().then((s) => (typeof s === 'string' ? s : s.full ?? JSON.stringify(s)))
      : await page.locator('body').ariaSnapshot();
    const text = await page.evaluate(() => document.body.innerText);
    const html = await page.content();
    return { url, status, title: await page.title(), ms: Math.round(performance.now() - t0), snapshot, text, html };
  } finally { await page.close(); }
};

const cases = [];
let failed = false;
const control = (name, ok, detail) => { if (!ok) failed = true; return { name, ok, detail }; };

// Case 1: what is new in a subreddit. ---------------------------------------------------------
const since = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
const out1 = join(tmp, 'sub');
const k1 = run('tools/research/reddit-pull/reddit-pull.mjs', ['--sub', SUB, '--after', since, '--max-pages', '1', '--out', out1]);
let posts = [];
try { posts = JSON.parse(readFileSync(join(out1, `${SUB}.posts.json`), 'utf8')); } catch { /* reported below */ }
const titlesTxt = existsSync(join(out1, `${SUB}.titles.txt`)) ? readFileSync(join(out1, `${SUB}.titles.txt`), 'utf8') : '';
const b1 = await view(`https://www.reddit.com/r/${SUB}/new/`);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const seen1 = posts.filter((p) => p.title && norm(b1.text).includes(norm(p.title).slice(0, 40))).length;
const blocked1 = seen1 < 3;
cases.push({
  job: `What is new in r/${SUB}`,
  browser: { tool: 'accessibility snapshot of the page (Playwright, headless Chromium)', url: b1.url, http: b1.status, title: b1.title, ms: b1.ms,
    blocked: blocked1, page_says: blocked1 ? b1.text.trim().split(/\r?\n/)[0].slice(0, 120) : undefined,
    snapshot: size(b1.snapshot), page_text: size(b1.text), html: size(b1.html), posts_on_the_page_also_in_the_pull: seen1 },
  kit: { tool: `reddit-pull --sub ${SUB} --after ${since} --max-pages 1`, exit: k1.status, ms: k1.ms,
    agent_reads: size(k1.stdout + k1.stderr), stdout: size(k1.stdout), posts: posts.length,
    on_disk: { titles_txt: size(titlesTxt), posts_json_bytes: existsSync(join(out1, `${SUB}.posts.json`)) ? bytes(readFileSync(join(out1, `${SUB}.posts.json`), 'utf8')) : 0 } },
  controls: [
    control('the kit run succeeded and wrote posts', k1.status === 0 && posts.length > 0, `exit ${k1.status}, ${posts.length} posts`),
    { name: 'the browser reached the real page, not a block page', ok: !blocked1, detail: `HTTP ${b1.status}, ${seen1} of the pulled titles are on the page` },
  ],
});

// Case 2: read one thread with its comments. ---------------------------------------------------
const thread = [...posts].sort((a, b) => (b.num_comments ?? b.comments ?? 0) - (a.num_comments ?? a.comments ?? 0))[0];
if (thread) {
  const out2 = join(tmp, 'thread');
  const k2 = run('tools/research/reddit-pull/reddit-pull.mjs', ['--thread', thread.id, '--out', out2]);
  const tf = join(out2, `thread-${thread.id}.json`);
  const tjson = existsSync(tf) ? readFileSync(tf, 'utf8') : '';
  let ncomments = 0;
  try { const j = JSON.parse(tjson); ncomments = (j.comments || []).length; } catch { /* reported below */ }
  const b2 = await view(`https://www.reddit.com/r/${SUB}/comments/${thread.id}/`);
  const hasTitle = norm(b2.text).includes(norm(thread.title).slice(0, 40));
  const blocked2 = !hasTitle;
  cases.push({
    job: 'Read one thread and its comments',
    thread: { id: thread.id, title: thread.title },
    browser: { tool: 'accessibility snapshot of the page (Playwright, headless Chromium)', url: b2.url, http: b2.status, title: b2.title, ms: b2.ms,
      blocked: blocked2, page_says: blocked2 ? b2.text.trim().split(/\r?\n/)[0].slice(0, 120) : undefined,
      snapshot: size(b2.snapshot), page_text: size(b2.text), html: size(b2.html) },
    kit: { tool: `reddit-pull --thread ${thread.id}`, exit: k2.status, ms: k2.ms, agent_reads: size(k2.stdout + k2.stderr), stdout: size(k2.stdout),
      comments: ncomments, on_disk: { thread_json: size(tjson) } },
    controls: [
      control('the kit run succeeded and wrote the thread', k2.status === 0 && tjson.length > 0, `exit ${k2.status}, ${ncomments} comments`),
      { name: 'the browser reached the same thread', ok: !blocked2, detail: `HTTP ${b2.status}, title on the page: ${hasTitle}` },
    ],
  });
}

// Case 3: has this account starred anything new. -----------------------------------------------
const state = join(tmp, 'stars.json');
const seed = run('tools/trackers/github-stars/github-stars.mjs', ['--user', USER, '--state', state]);
const k3 = run('tools/trackers/github-stars/github-stars.mjs', ['--user', USER, '--state', state]);
let read3 = 0;
try { read3 = JSON.parse(k3.stdout).read; } catch { /* reported below */ }
const b3 = await view(`https://github.com/${USER}?tab=stars`);
cases.push({
  job: `Has ${USER} starred anything new on GitHub`,
  browser: { tool: 'accessibility snapshot of the page (Playwright, headless Chromium)', url: b3.url, http: b3.status, title: b3.title, ms: b3.ms,
    snapshot: size(b3.snapshot), page_text: size(b3.text), html: size(b3.html), note: 'one page of the list (30 repositories); the agent still has to compare it with what it saw last time' },
  kit: { tool: `github-stars --user ${USER} (second poll, nothing new)`, exit: k3.status, ms: k3.ms, agent_reads: size(k3.stdout + k3.stderr), stdout: size(k3.stdout), stars_checked: read3 },
  controls: [
    control('the kit seeded, then polled', seed.status === 0 && k3.status === 0 && read3 > 0, `exits ${seed.status} and ${k3.status}, ${read3} stars checked`),
    control('the browser reached the stars page', b3.status === 200 && /star/i.test(b3.title + b3.text.slice(0, 4000)), `HTTP ${b3.status}`),
  ],
});

// Case 4 (no browser): is there memory to start something heavy. -------------------------------
const win = platform() === 'win32';
const pl = spawnSync(win ? 'tasklist' : 'ps', win ? [] : ['aux'], { encoding: 'utf8', windowsHide: true });
const k4 = run('tools/guards/memory-gate/memory-gate.mjs', []);
cases.push({
  job: 'Is there memory to start something heavy',
  raw: { tool: win ? 'tasklist (the process list an agent would otherwise read)' : 'ps aux (the process list an agent would otherwise read)', exit: pl.status,
    snapshot: size(pl.stdout || ''), lines: (pl.stdout || '').split(/\r?\n/).length },
  kit: { tool: 'memory-gate', exit: k4.status, ms: k4.ms, agent_reads: size(k4.stdout + k4.stderr), stdout: size(k4.stdout), says: (() => { try { const j = JSON.parse(k4.stdout); return { verdict: j.verdict, pct: j.pct }; } catch { return null; } })() },
  controls: [
    control('memory-gate answered with one of its documented exit codes', [0, 3, 4, 5].includes(k4.status) && k4.stdout.trim().startsWith('{'), `exit ${k4.status}`),
    control('the process list was read', pl.status === 0 && (pl.stdout || '').length > 1000, `exit ${pl.status}`),
  ],
});

const chromiumVersion = browser.version();
await browser.close();
rmSync(tmp, { recursive: true, force: true });

// A ratio only where both routes did the job. A blocked browser read nothing, so it gets no ratio.
for (const c of cases) {
  const other = c.browser || c.raw;
  c.ratio = other.blocked ? null : {
    by_tokens: Number((other.snapshot.tokens / Math.max(1, c.kit.agent_reads.tokens)).toFixed(1)),
    by_bytes: Number((other.snapshot.bytes / Math.max(1, c.kit.agent_reads.bytes)).toFixed(1)),
  };
}
const result = {
  ok: !failed,
  measured_at: new Date().toISOString(),
  machine: { platform: platform(), release: release(), node: process.version },
  tokenizer: 'o200k_base (gpt-tokenizer)',
  browser: `Playwright, headless Chromium ${chromiumVersion}`,
  cases,
};
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
const n = (x) => x.toLocaleString('en-GB');
for (const c of cases) {
  const other = c.browser || c.raw;
  const left = other.blocked
    ? `BLOCKED, read nothing useful ("${other.page_says}")`
    : `${n(other.snapshot.tokens)} tokens (${n(other.snapshot.bytes)} B)`;
  process.stderr.write(`\n${c.job}\n  ${c.browser ? 'browser snapshot' : 'raw output      '} : ${left}\n` +
    `  headless-kit     : ${n(c.kit.agent_reads.tokens)} tokens (${n(c.kit.agent_reads.bytes)} B), ${c.kit.ms} ms\n` +
    (c.ratio ? `  ratio            : ${c.ratio.by_tokens}x fewer tokens\n` : '') +
    c.controls.map((k) => `  ${k.ok ? 'ok  ' : (other.blocked ? 'no  ' : 'FAIL')} ${k.name}: ${k.detail}\n`).join(''));
}
process.stdout.write(JSON.stringify(result) + '\n');
process.exit(failed ? 1 : 0);
