// Offline tests: fixtures, a fake CLI for each external tool, a fake playwright module and a local HTTP stub on
// 127.0.0.1. Nothing here reaches the internet or starts a browser. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseInput, parseUrlList, mapYtDlp, mapGalleryDl, mapEmbed, mapInstaloader, merge, validate, renderMd, redact, classifyError, hashtags, mentions, EXIT } from '../lib.mjs';
import { processTarget, makeGate, loadConfig, checkChromiumPath, parseArgs, UsageError, DEFAULTS } from '../ig2md.mjs';

delete process.env.IG2MD_PLAYWRIGHT; delete process.env.IG2MD_CONFIG;
const FXDIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const FX = (n) => readFileSync(join(FXDIR, n), 'utf8');
const J = (n) => JSON.parse(FX(n));
const SCHEMA = JSON.parse(readFileSync(new URL('../schema/post.schema.json', import.meta.url), 'utf8'));
const FAKE = join(FXDIR, 'fake-tool.mjs');
const FAKE_PW = join(FXDIR, 'fake-playwright');
const CLI = fileURLToPath(new URL('../ig2md.mjs', import.meta.url));
const tgt = (u) => parseInput(u);
const tool = (as) => [process.execPath, FAKE, '--as', as];
const MISSING = 'ig2md-test-no-such-tool';
const quietGate = (cfg) => makeGate(cfg, () => {}, async () => {});
const tmp = () => mkdtempSync(join(tmpdir(), 'ig2md-'));
const readLog = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

function cfgFor(dir, over = {}) {
  return {
    ...DEFAULTS, outDir: dir, minDelayMs: 0, maxDelayMs: 0, screenshot: false, sources: ['yt-dlp'], playwrightModule: join(dir, 'no-playwright-here'),
    tools: { ytdlp: tool('yt-dlp'), gallerydl: tool('gallery-dl'), ffmpeg: tool('ffmpeg'), instaloader: tool('instaloader') }, ...over,
  };
}
function withEnv(vars, fn) {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
}
async function stub(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('parser: 12 URL shapes, tracking parameters dropped, non-Instagram refused', () => {
  const cases = [
    ['https://www.instagram.com/p/ABC_123-x/', 'post', 'ABC_123-x'],
    ['https://instagram.com/p/ABC/?igsh=zzz&utm_source=x', 'post', 'ABC'],
    ['https://www.instagram.com/reel/RRR1/', 'reel', 'RRR1'],
    ['https://www.instagram.com/reels/RRR2/', 'reel', 'RRR2'],
    ['https://www.instagram.com/tv/TTT/', 'reel', 'TTT'],
    ['https://www.instagram.com/someuser/p/UUU/', 'post', 'UUU'],
    ['https://www.instagram.com/someuser/reel/VVV/', 'reel', 'VVV'],
    ['look at this https://www.instagram.com/p/FWD1/?igsh=q lol', 'post', 'FWD1'],
    ['https://www.instagram.com/stories/some.user/3141592653/', 'story', '3141592653'],
    ['https://www.instagram.com/stories/highlights/1789/', 'highlight', '1789'],
    ['HTTP://WWW.INSTAGRAM.COM/P/CAPS/', 'post', 'CAPS'],
    ['https://instagram.com/reel/NOQ', 'reel', 'NOQ'],
  ];
  for (const [i, k, s] of cases) { const r = parseInput(i); assert.ok(r, i); assert.equal(r.kind, k, i); assert.equal(r.shortcode, s, i); assert.ok(!r.url.includes('igsh')); }
  assert.equal(parseInput('https://example.com/p/abc'), null);
});

test('list file: comments, blanks, duplicates', () => {
  const l = parseUrlList('# c\n\nhttps://www.instagram.com/p/A/\nhttps://www.instagram.com/p/A/?igsh=1\nnonsense\nhttps://www.instagram.com/reel/B/');
  assert.deepEqual(l.map((x) => x.shortcode), ['A', 'B']);
});

test('hashtags and mentions', () => {
  assert.deepEqual(hashtags('a #AI #ai #Open_Source'), ['ai', 'open_source']);
  assert.deepEqual(mentions('hi @Friend.dev. and @x_y'), ['friend.dev', 'x_y']);
});

test('mappers: yt-dlp, gallery-dl, embed page, instaloader', () => {
  const y = mapYtDlp(J('ytdlp-reel.json'));
  assert.equal(y.author.username, 'example_creator'); assert.equal(y.counts.likes, 1200); assert.equal(y.media[0].type, 'video');
  assert.equal(mapYtDlp({ uploader_id: '2815873', channel: 'example_handle', uploader: 'X' }).author.username, 'example_handle', 'numeric uploader_id falls back to the channel handle');
  assert.equal(y.date, '2024-11-10T00:53:20.000Z');
  const c = mapYtDlp(J('ytdlp-carousel.json')); assert.equal(c.media.length, 3); assert.equal(c.carousel, true); assert.equal(c.media[0].type, 'image');
  const g = mapGalleryDl(J('gallerydl.json')); assert.equal(g.media.length, 1); assert.equal(g.caption, 'Photo #sunset'); assert.equal(g.date, '2026-11-10T03:00:00.000Z');
  const e = mapEmbed(FX('embed.html')); assert.equal(e.author.username, 'example_creator'); assert.equal(e.caption, 'Hello & welcome #embed'); assert.equal(e.counts.comments, 12); assert.equal(e.media[0].remote, 'https://cdn.example/e.jpg?a=1&b=2');
  const i = mapInstaloader(J('instaloader.json')); assert.equal(i.author.verified, true); assert.equal(i.counts.likes, 9);
  assert.equal(mapEmbed('<html></html>'), null);
  assert.equal(mapGalleryDl([[2, {}]]), null);
  assert.equal(mapYtDlp(null), null);
});

test('merge: first source with a field wins, provenance kept, kind refined, schema valid', () => {
  const p = merge(tgt('https://www.instagram.com/p/XYZ/'), [
    { name: 'yt-dlp', ok: false, error: 'boom' },
    { name: 'gallery-dl', ok: true, data: mapGalleryDl(J('gallerydl.json')) },
    { name: 'embed', ok: true, data: mapEmbed(FX('embed.html')) },
  ], { now: '2026-11-10T00:00:00.000Z', embed: 'shots/embed.png' });
  assert.equal(p.caption, 'Photo #sunset'); assert.equal(p.counts.comments, 1); assert.deepEqual(p.hashtags, ['sunset']);
  assert.deepEqual(p.sources.map((s) => [s.name, s.ok]), [['yt-dlp', false], ['gallery-dl', true], ['embed', true]]);
  assert.equal(p.sources[0].error, 'boom'); assert.equal(p.screenshots.embed_page, 'shots/embed.png');
  assert.deepEqual(validate(p, SCHEMA), []);
  assert.equal(merge(tgt('https://www.instagram.com/p/XYZ/'), [{ name: 'yt-dlp', ok: true, data: mapYtDlp(J('ytdlp-carousel.json')) }]).kind, 'carousel');
  assert.equal(merge(tgt('https://www.instagram.com/p/XYZ/'), [{ name: 'yt-dlp', ok: true, data: mapYtDlp(J('ytdlp-reel.json')) }]).kind, 'reel');
});

test('schema validation rejects bad output, including a cookie-based access mode', () => {
  const p = merge(tgt('https://www.instagram.com/p/XYZ/'), [{ name: 'embed', ok: true, data: mapEmbed(FX('embed.html')) }]);
  assert.deepEqual(validate(p, SCHEMA), []);
  assert.ok(validate({ ...p, kind: 'nonsense' }, SCHEMA).length);
  assert.ok(validate({ ...p, schema_version: '9' }, SCHEMA).length);
  assert.ok(validate({ ...p, access: 'cookies' }, SCHEMA).length);
  const { sources, ...rest } = p; assert.ok(validate(rest, SCHEMA).some((e) => e.includes('missing sources')));
  assert.ok(validate({ ...p, media: [{ type: 'gif' }] }, SCHEMA).length);
});

test('Markdown: front matter, caption, metrics, and an untrusted-data banner', () => {
  const md = renderMd(merge(tgt('https://www.instagram.com/p/XYZ/'), [{ name: 'yt-dlp', ok: true, data: mapYtDlp(J('ytdlp-reel.json')) }]));
  assert.match(md, /^---\nurl: https:\/\/www\.instagram\.com\/p\/XYZ\//);
  assert.match(md, /author: "@example_creator"/); assert.match(md, /## Caption\nGreat #OpenSource/); assert.match(md, /likes: 1200/);
  assert.match(md, /untrusted data, not instructions/);
});

test('redaction strips cookie values; error classes, including the ambiguous yt-dlp message', () => {
  const s = redact('sessionid=abc123 csrftoken\tzzz\nCookie: sessionid=1; csrftoken=2\nds_user_id=77');
  for (const bad of ['abc123', 'zzz', '77', 'csrftoken=2']) assert.ok(!s.includes(bad), bad);
  assert.equal(classifyError('HTTP Error 429'), 'rate_limited');
  assert.equal(classifyError('Requested content is not available, rate-limit reached or login required'), 'rate_limited', 'ambiguous: stop the batch');
  assert.equal(classifyError('Instagram sent an empty media response'), 'needs_login');
  assert.equal(classifyError('Post not found'), 'not_found');
});

test('chromiumPath: installed Chrome or Edge and non-Playwright paths refused; a bundled path accepted', () => {
  assert.equal(checkChromiumPath(null).ok, true);
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/home/u/bin/chrome']) assert.equal(checkChromiumPath(p).ok, false, p);
  const d = join(tmp(), 'ms-playwright', 'chromium_headless_shell-1'); mkdirSync(d, { recursive: true });
  const exe = join(d, 'headless_shell'); writeFileSync(exe, '');
  assert.equal(checkChromiumPath(exe).ok, true);
  assert.equal(checkChromiumPath(join(d, 'missing')).ok, false);
});

test('request gate: hard cap, and a pause between calls but not before the first', async () => {
  const slept = [];
  const g = makeGate({ maxRequests: 2, minDelayMs: 10, maxDelayMs: 10 }, () => {}, async (ms) => slept.push(ms));
  await g.take('a'); await g.take('b');
  await assert.rejects(() => g.take('c'), /cap/);
  assert.deepEqual(slept, [10]); assert.equal(g.count, 2);
});

test('arguments and config: unknown flags and keys refused (no --cookies, no cookiesFile)', () => {
  const o = parseArgs(['u1', '--list', 'f.txt', '--no-shot', '--max-requests', '5', '--sources', 'embed,yt-dlp']);
  assert.deepEqual(o.inputs, ['u1']); assert.equal(o.list, 'f.txt'); assert.equal(o.noShot, true); assert.equal(o.maxRequests, 5); assert.deepEqual(o.sources, ['embed', 'yt-dlp']);
  assert.throws(() => parseArgs(['--cookies', 'c.txt']), UsageError);
  assert.throws(() => parseArgs(['--max-requests', 'lots']), UsageError);
  const dir = tmp(); const f = join(dir, 'c.json');
  writeFileSync(f, JSON.stringify({ cookiesFile: 'c.txt' })); assert.throws(() => loadConfig(f, {}), /unknown key "cookiesFile"/);
  writeFileSync(f, JSON.stringify({ minDelayMs: 5000, maxDelayMs: 10 })); assert.throws(() => loadConfig(f, {}), /maxDelayMs/);
  writeFileSync(f, JSON.stringify({ sources: ['yt-dlp', 'browser-cookies'] })); assert.throws(() => loadConfig(f, {}), /unknown source/);
  writeFileSync(f, JSON.stringify({ $comment: 'x', maxRequests: 7, tools: { ytdlp: ['python', '-m', 'yt_dlp'] } }));
  const c = loadConfig(null, { IG2MD_CONFIG: f }); assert.equal(c.maxRequests, 7); assert.deepEqual(c.tools.ytdlp, ['python', '-m', 'yt_dlp']); assert.equal(c.tools.ffmpeg, 'ffmpeg');
});

test('end to end with fake yt-dlp and ffmpeg: JSON + Markdown written and valid, logged-out flags passed', async () => {
  const dir = tmp(); const log = join(dir, 'calls.jsonl'); const cfg = cfgFor(dir);
  await withEnv({ FAKE_MODE: null, FAKE_LOG: log }, async () => {
    const r = await processTarget(tgt('https://www.instagram.com/reel/E2E/'), cfg, { gate: quietGate(cfg) });
    assert.equal(r.exit, 0, JSON.stringify(r));
    const post = JSON.parse(readFileSync(join(dir, 'E2E', 'E2E.json'), 'utf8'));
    assert.deepEqual(validate(post, SCHEMA), []);
    assert.equal(post.access, 'anonymous'); assert.equal(post.media[0].file, 'media/00001.mp4');
    assert.equal(post.screenshots.cover, 'shots/cover.jpg'); assert.equal(post.screenshots.contact_sheet, 'shots/contact.jpg');
    assert.ok(existsSync(join(dir, 'E2E', 'E2E.md'))); assert.deepEqual(post.hashtags, ['opensource', 'ai']);
    const ytCalls = readLog(log).filter((c) => c.as === 'yt-dlp' && !c.args.includes('--version'));
    assert.equal(ytCalls.length, 2);
    for (const c of ytCalls) { assert.ok(c.args.includes('--ignore-config') && c.args.includes('--no-cookies')); assert.ok(!c.args.some((x) => /cookies-from-browser|^--cookies$|--username|--password/.test(x))); }
  });
});

test('a missing tool is skipped and recorded; the next source fills in (gallery-dl carousel of one)', async () => {
  const dir = tmp(); const cfg = cfgFor(dir, { sources: ['yt-dlp', 'gallery-dl'] }); cfg.tools.ytdlp = MISSING;
  const r = await processTarget(tgt('https://www.instagram.com/p/GDL/'), cfg, { gate: quietGate(cfg) });
  assert.equal(r.exit, 0, JSON.stringify(r));
  assert.deepEqual(r.sources.map((s) => [s.name, s.ok]), [['yt-dlp', false], ['gallery-dl', true]]);
  assert.match(r.sources[0].error, /not installed/);
  const post = JSON.parse(readFileSync(join(dir, 'GDL', 'GDL.json'), 'utf8'));
  assert.equal(post.caption, 'Photo #sunset'); assert.equal(post.media[0].file, 'media/photo-1.jpg'); assert.equal(post.screenshots.cover, 'shots/cover.jpg');
});

test('nothing installed: exit 1 with no network request', async () => {
  const dir = tmp(); const cfg = cfgFor(dir, { sources: ['yt-dlp', 'gallery-dl', 'instaloader'] });
  cfg.tools = { ytdlp: MISSING, gallerydl: MISSING, instaloader: MISSING, ffmpeg: MISSING };
  const gate = quietGate(cfg);
  const r = await processTarget(tgt('https://www.instagram.com/p/NONE/'), cfg, { gate });
  assert.equal(r.exit, EXIT.NO_SOURCE); assert.equal(gate.count, 0); assert.match(r.error, /--check/);
});

test('instaloader source: anonymous, no login flags, carousel kind from yt-dlp carousel', async () => {
  const dir = tmp(); const log = join(dir, 'calls.jsonl');
  await withEnv({ FAKE_LOG: log, FAKE_MODE: null }, async () => {
    const cfg = cfgFor(dir, { sources: ['instaloader'] });
    const r = await processTarget(tgt('https://www.instagram.com/p/IL/'), cfg, { gate: quietGate(cfg) });
    assert.equal(r.exit, 0, JSON.stringify(r));
    const post = JSON.parse(readFileSync(join(dir, 'IL', 'IL.json'), 'utf8'));
    assert.equal(post.caption, 'From instaloader #il'); assert.equal(post.author.verified, true);
    assert.ok(readLog(log).filter((c) => c.as === 'instaloader').every((c) => !c.args.includes('--login') && !c.args.includes('--load-cookies')));
  });
  await withEnv({ FAKE_YTDLP: 'carousel' }, async () => {
    const cfg = cfgFor(dir, { downloadMedia: false });
    const r = await processTarget(tgt('https://www.instagram.com/p/CAR/'), cfg, { gate: quietGate(cfg) });
    assert.equal(r.kind, 'carousel');
  });
});

test('embed page by plain HTTP (no playwright): parsed; 429 stops with exit 4; 404 is exit 1', async () => {
  let status = 200; const seen = [];
  const s = await stub((req, res) => { seen.push(req.url); res.writeHead(status, { 'content-type': 'text/html' }); res.end(status === 200 ? FX('embed.html') : 'no'); });
  try {
    const dir = tmp(); const cfg = cfgFor(dir, { sources: ['embed'], screenshot: true, embedBaseUrl: s.url });
    const r = await processTarget(tgt('https://www.instagram.com/reel/EMB/'), cfg, { gate: quietGate(cfg) });
    assert.equal(r.exit, 0, JSON.stringify(r)); assert.equal(seen[0], '/p/EMB/embed/captioned/');
    assert.equal(r.screenshots.embed_page, null, 'no playwright, so no screenshot');
    status = 429; const g = quietGate(cfg);
    const r2 = await processTarget(tgt('https://www.instagram.com/p/RL2/'), cfg, { gate: g });
    assert.equal(r2.exit, EXIT.RATE_LIMITED); assert.equal(g.count, 1);
    status = 404;
    assert.equal((await processTarget(tgt('https://www.instagram.com/p/GONE/'), cfg, { gate: quietGate(cfg) })).exit, EXIT.NO_SOURCE);
  } finally { await s.close(); }
});

test('embed page with playwright: headless, fresh context, no channel, no profile, screenshot saved', async () => {
  const { calls } = await import(pathToFileURL(join(FAKE_PW, 'index.mjs')).href);
  calls.length = 0;
  const dir = tmp(); const cfg = cfgFor(dir, { sources: ['embed'], screenshot: true, playwrightModule: FAKE_PW });
  const r = await processTarget(tgt('https://www.instagram.com/p/PW/'), cfg, { gate: quietGate(cfg) });
  assert.equal(r.exit, 0, JSON.stringify(r));
  const launch = calls.find((c) => c.launch).launch;
  assert.equal(launch.headless, true); assert.equal(launch.channel, undefined); assert.equal(launch.executablePath, undefined);
  assert.ok(!('userDataDir' in launch) && !(launch.args || []).some((a) => /remote-debugging|user-data-dir/.test(a)));
  assert.ok(calls.some((c) => c.newContext)); assert.ok(!calls.some((c) => c.persistent)); assert.ok(calls.some((c) => c.close));
  assert.equal(r.screenshots.embed_page, 'shots/embed.png'); assert.ok(existsSync(join(dir, 'PW', 'shots', 'embed.png')));
  // a chromiumPath pointing at an installed browser is refused before any request
  const g = quietGate(cfg); calls.length = 0;
  const bad = await processTarget(tgt('https://www.instagram.com/p/PW2/'), { ...cfg, chromiumPath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' }, { gate: g });
  assert.equal(bad.exit, EXIT.NO_SOURCE); assert.equal(g.count, 0); assert.equal(calls.length, 0);
  assert.match(bad.sources[0].error, /installed browser/);
});

test('no request is spent on the embed page "for the screenshot" when no screenshot is possible', async () => {
  const hits = [];
  const s = await stub((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end(FX('embed.html')); });
  try {
    const dir = tmp(); const cfg = cfgFor(dir, { sources: ['yt-dlp', 'embed'], screenshot: true, embedBaseUrl: s.url });
    const g = quietGate(cfg);
    const r = await processTarget(tgt('https://www.instagram.com/reel/SKIP/'), cfg, { gate: g });
    assert.equal(r.exit, 0, JSON.stringify(r)); assert.equal(hits.length, 0); assert.equal(g.count, 2, 'yt-dlp metadata + media only');
    assert.deepEqual(r.sources.map((x) => x.name), ['yt-dlp']);
    // with playwright available the embed page does run, once, for its screenshot
    const g2 = quietGate(cfg);
    const r2 = await processTarget(tgt('https://www.instagram.com/reel/SHOT/'), { ...cfg, playwrightModule: FAKE_PW }, { gate: g2 });
    assert.equal(g2.count, 3); assert.equal(r2.screenshots.embed_page, 'shots/embed.png'); assert.equal(hits.length, 0, 'the fake browser makes no HTTP request');
  } finally { await s.close(); }
});

test('login wall: exit 3, no retry, no workaround', async () => {
  const dir = tmp(); const cfg = cfgFor(dir); const g = quietGate(cfg);
  await withEnv({ FAKE_MODE: 'login' }, async () => {
    const r = await processTarget(tgt('https://www.instagram.com/p/LW/'), cfg, { gate: g });
    assert.equal(r.exit, EXIT.NEEDS_LOGIN); assert.match(r.error, /logged-out only/); assert.equal(g.count, 1);
  });
});

test('stories: unsupported (exit 3, no request); --from-file files media you already have', async () => {
  const dir = tmp(); const cfg = cfgFor(dir); const gate = quietGate(cfg);
  const r = await processTarget(tgt('https://www.instagram.com/stories/u/123/'), cfg, { gate });
  assert.equal(r.exit, EXIT.NEEDS_LOGIN); assert.match(r.error, /does not support/); assert.equal(gate.count, 0);
  const f = join(dir, 'saved.jpg'); writeFileSync(f, 'img');
  const r2 = await processTarget(tgt('https://www.instagram.com/stories/u/123/'), cfg, { gate, fromFile: f, author: 'u', caption: 'hi #s' });
  assert.equal(r2.exit, 0, JSON.stringify(r2)); assert.equal(gate.count, 0);
  const post = JSON.parse(readFileSync(join(dir, '123', '123.json'), 'utf8'));
  assert.equal(post.kind, 'story'); assert.equal(post.access, 'user-file'); assert.deepEqual(post.hashtags, ['s']);
  assert.deepEqual(validate(post, SCHEMA), []);
});

function cli(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, IG2MD_CONFIG: '', IG2MD_PLAYWRIGHT: '', ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* left null */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

test('CLI: --help 0, usage errors 2 as JSON, --check, a batch stops on 429, no cookie strings written', () => {
  assert.equal(cli(['--help']).code, 0);
  const none = cli([]); assert.equal(none.code, 2); assert.equal(none.json.ok, false);
  const bad = cli(['--cookies', 'x.txt', 'https://www.instagram.com/p/A/']); assert.equal(bad.code, 2); assert.match(bad.json.error, /unknown option --cookies/);
  const dir = tmp(); const cfgFile = join(dir, 'cfg.json');
  writeFileSync(cfgFile, JSON.stringify({ outDir: join(dir, 'out'), minDelayMs: 0, maxDelayMs: 0, screenshot: false, sources: ['yt-dlp'], playwrightModule: join(dir, 'none'),
    tools: { ytdlp: tool('yt-dlp'), gallerydl: MISSING, ffmpeg: tool('ffmpeg'), instaloader: MISSING } }));
  const chk = cli(['--check', '--config', cfgFile]);
  assert.equal(chk.code, 0); assert.match(chk.json.tools['yt-dlp'], /fake/); assert.equal(chk.json.tools['gallery-dl'], null); assert.equal(chk.json.playwright, null);
  const ok = cli(['--config', cfgFile, 'see https://www.instagram.com/reel/CLI1/?igsh=x']);
  assert.equal(ok.code, 0, ok.err); assert.equal(ok.json.requests, 2); assert.equal(ok.json.results[0].kind, 'reel');
  for (const f of [join(dir, 'out', 'CLI1', 'CLI1.json'), join(dir, 'out', 'CLI1', 'ig2md.log')]) assert.doesNotMatch(readFileSync(f, 'utf8'), /sessionid|csrftoken/i);
  const rl = cli(['--config', cfgFile, 'https://www.instagram.com/p/R1/', 'https://www.instagram.com/p/R2/'], { env: { FAKE_MODE: '429' } });
  assert.equal(rl.code, 4); assert.equal(rl.json.results.length, 1, 'the second URL is never tried'); assert.equal(rl.json.requests, 1);
});

test('a 429 after an earlier source returned content still stops the batch (exit 4) and keeps what was fetched', () => {
  const dir = tmp(); const cfgFile = join(dir, 'cfg.json');
  // No media download, so yt-dlp alone is never "complete" and gallery-dl runs next.
  writeFileSync(cfgFile, JSON.stringify({ outDir: join(dir, 'out'), minDelayMs: 0, maxDelayMs: 0, screenshot: false, downloadMedia: false, sources: ['yt-dlp', 'gallery-dl'],
    playwrightModule: join(dir, 'none'), tools: { ytdlp: tool('yt-dlp'), gallerydl: tool('gallery-dl'), ffmpeg: tool('ffmpeg'), instaloader: MISSING } }));
  const r = cli(['--config', cfgFile, 'https://www.instagram.com/p/A1/', 'https://www.instagram.com/p/A2/'], { env: { FAKE_MODE_GALLERY_DL: '429' } });
  assert.equal(r.code, 4, r.err);
  assert.equal(r.json.results.length, 1, 'the second URL is never tried');
  assert.equal(r.json.requests, 2, 'yt-dlp metadata, then gallery-dl metadata, nothing more');
  const [one] = r.json.results;
  assert.equal(one.exit, 4); assert.match(one.error, /Rate limited.*saved/);
  assert.deepEqual(one.sources.map((s) => [s.name, s.ok]), [['yt-dlp', true], ['gallery-dl', false]]);
  const post = JSON.parse(readFileSync(join(dir, 'out', 'A1', 'A1.json'), 'utf8'));
  assert.deepEqual(validate(post, SCHEMA), []); assert.ok(post.caption, 'the yt-dlp caption was kept');
  assert.ok(!existsSync(join(dir, 'out', 'A2')), 'nothing was fetched for the second URL');
});

test('a 429 on a media download stops the batch too; the metadata is kept and the source says why', () => {
  const dir = tmp(); const cfgFile = join(dir, 'cfg.json');
  writeFileSync(cfgFile, JSON.stringify({ outDir: join(dir, 'out'), minDelayMs: 0, maxDelayMs: 0, screenshot: false, sources: ['yt-dlp', 'gallery-dl'],
    playwrightModule: join(dir, 'none'), tools: { ytdlp: tool('yt-dlp'), gallerydl: tool('gallery-dl'), ffmpeg: tool('ffmpeg'), instaloader: MISSING } }));
  const r = cli(['--config', cfgFile, 'https://www.instagram.com/reel/M1/', 'https://www.instagram.com/reel/M2/'], { env: { FAKE_MEDIA: '429' } });
  assert.equal(r.code, 4, r.err);
  assert.equal(r.json.results.length, 1); assert.equal(r.json.requests, 2, 'yt-dlp metadata and media; gallery-dl never runs');
  assert.deepEqual(r.json.results[0].sources.map((s) => [s.name, s.ok]), [['yt-dlp', true]]);
  assert.match(r.json.results[0].sources[0].error, /media download: .*429/);
  const post = JSON.parse(readFileSync(join(dir, 'out', 'M1', 'M1.json'), 'utf8'));
  assert.ok(post.caption); assert.equal(post.media[0].file ?? null, null, 'no file was saved');
});
