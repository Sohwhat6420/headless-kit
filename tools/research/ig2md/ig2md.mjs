#!/usr/bin/env node
// ig2md: a public Instagram post, reel or carousel URL -> <shortcode>.json (schema-versioned) + <shortcode>.md + frames.
// Logged-out and public only: it runs yt-dlp, gallery-dl, the public embed page and instaloader (each optional; a
// missing one is skipped), politely and one request at a time, and merges what they return. No login, no cookies.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, parseInput, parseUrlList, mapYtDlp, mapGalleryDl, mapEmbed, mapInstaloader, merge, hasContent, validate, renderMd, redact, run, classifyError } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, 'schema', 'post.schema.json'), 'utf8'));
const VERSION = '0.1.0';

export class UsageError extends Error {}

export const DEFAULTS = {
  outDir: './ig2md-out',
  minDelayMs: 2000, maxDelayMs: 9000, // random pause between requests, one request at a time
  maxRequests: 50,                    // hard cap on network requests per invocation
  sources: ['yt-dlp', 'gallery-dl', 'embed', 'instaloader'],
  downloadMedia: true,
  screenshot: true,
  tools: { ytdlp: 'yt-dlp', gallerydl: 'gallery-dl', ffmpeg: 'ffmpeg', instaloader: 'instaloader' },
  playwrightModule: null,             // folder of an installed playwright package, if import('playwright') cannot find it
  chromiumPath: null,                 // a Playwright-bundled Chromium / headless-shell binary only
  embedBaseUrl: 'https://www.instagram.com',
  skipIfFresherThanHours: 0,
};
const SOURCE_NAMES = ['yt-dlp', 'gallery-dl', 'embed', 'instaloader'];
const TOOL_KEYS = Object.keys(DEFAULTS.tools);

// ---------- config: defaults, then the JSON file (--config or IG2MD_CONFIG), then flags ----------
export function loadConfig(path, env = process.env) {
  const p = path || env.IG2MD_CONFIG || null;
  let cfg = {};
  if (p) {
    try { cfg = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (e) { throw new UsageError(`config ${p}: ${e.code === 'ENOENT' ? 'not found' : e.message}`); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new UsageError(`config ${p}: not a JSON object`);
  }
  for (const k of Object.keys(cfg)) if (k !== '$comment' && !(k in DEFAULTS)) throw new UsageError(`config: unknown key "${k}"`);
  const c = { ...DEFAULTS, ...cfg, tools: { ...DEFAULTS.tools, ...(cfg.tools || {}) } };
  delete c.$comment;
  if (env.IG2MD_PLAYWRIGHT) c.playwrightModule = env.IG2MD_PLAYWRIGHT;
  checkConfig(c);
  return c;
}

export function checkConfig(c) {
  const nonNeg = (k) => { if (!Number.isFinite(c[k]) || c[k] < 0) throw new UsageError(`${k} must be a number >= 0`); };
  nonNeg('minDelayMs'); nonNeg('maxDelayMs'); nonNeg('skipIfFresherThanHours');
  if (c.maxDelayMs < c.minDelayMs) throw new UsageError('maxDelayMs must be >= minDelayMs');
  if (!Number.isInteger(c.maxRequests) || c.maxRequests < 1) throw new UsageError('maxRequests must be an integer >= 1');
  if (!Array.isArray(c.sources) || !c.sources.length) throw new UsageError('sources must be a non-empty list');
  for (const s of c.sources) if (!SOURCE_NAMES.includes(s)) throw new UsageError(`unknown source "${s}" (known: ${SOURCE_NAMES.join(', ')})`);
  for (const [k, v] of Object.entries(c.tools)) {
    if (!TOOL_KEYS.includes(k)) throw new UsageError(`tools: unknown key "${k}"`);
    const ok = (typeof v === 'string' && v) || (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x));
    if (!ok) throw new UsageError(`tools.${k} must be a command string or a non-empty array of strings`);
  }
  if (!/^https?:\/\/[^\s]+$/.test(String(c.embedBaseUrl))) throw new UsageError('embedBaseUrl must be an http(s) URL');
  return c;
}

// Only a Playwright-bundled browser may be named: never an installed Chrome or Edge.
export function checkChromiumPath(p) {
  if (!p) return { ok: true };
  const s = String(p);
  if (/google[\\/ ]chrome|microsoft[\\/ ]edge|msedge|program files|\/applications\/|\/usr\/bin\/|\/opt\/google/i.test(s)) return { ok: false, why: 'chromiumPath points at an installed browser; only a Playwright-bundled Chromium is allowed' };
  if (!/ms-playwright/i.test(s)) return { ok: false, why: 'chromiumPath must be inside a Playwright browsers folder (ms-playwright)' };
  if (!existsSync(s)) return { ok: false, why: 'chromiumPath not found' };
  return { ok: true };
}

// ---------- tool detection (local, no network) ----------
const detected = new Map();
export async function detectTool(cmd, versionFlag = '--version') {
  const key = JSON.stringify([cmd, versionFlag]);
  if (!detected.has(key)) {
    const r = await run(cmd, [versionFlag], { timeoutMs: 20000 });
    detected.set(key, r.code === 0 ? ((r.out || r.err).trim().split(/\r?\n/)[0] || 'unknown version').slice(0, 80) : null);
  }
  return detected.get(key);
}

export async function loadPlaywright(cfg) {
  const specs = cfg.playwrightModule ? [pathToFileURL(resolve(cfg.playwrightModule, 'index.mjs')).href] : ['playwright', 'playwright-core'];
  for (const spec of specs) {
    try { const m = await import(spec); const pw = m.chromium ? m : m.default; if (pw?.chromium) return pw; } catch { /* not installed */ }
  }
  return null;
}

// ---------- request gate: a cap and a random polite pause ----------
export function makeGate(cfg, log, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let n = 0;
  return {
    get count() { return n; },
    async take(label) {
      if (n >= cfg.maxRequests) throw Object.assign(new Error(`request cap ${cfg.maxRequests} reached`), { cap: true });
      if (n > 0) await sleep(cfg.minDelayMs + Math.random() * Math.max(0, cfg.maxDelayMs - cfg.minDelayMs));
      n++; log(`request ${n}: ${label}`);
    },
  };
}

const lastLine = (s, code) => redact(String(s || '').trim().split(/\r?\n/).pop() || `exit ${code}`);

// ---------- sources ----------
// yt-dlp and gallery-dl get --ignore-config so a user config can never add cookies or a login behind our back.
async function srcYtDlp(t, cfg, gate, dirs, o) {
  const base = ['--ignore-config', '--no-cookies', '--no-warnings', '--no-playlist'];
  await gate.take('yt-dlp metadata');
  const r = await run(cfg.tools.ytdlp, [...base, '--dump-single-json', t.url], { timeoutMs: 120000 });
  if (r.code !== 0) return { name: 'yt-dlp', ok: false, error: lastLine(r.err, r.code), cls: classifyError(r.err) };
  let j; try { j = JSON.parse(r.out); } catch { return { name: 'yt-dlp', ok: false, error: 'unparseable JSON', cls: 'other' }; }
  writeFileSync(join(dirs.base, 'info.json'), JSON.stringify(j, null, 2));
  const data = mapYtDlp(j);
  if (o.download && data) {
    await gate.take('yt-dlp media');
    const d = await run(cfg.tools.ytdlp, [...base, '-o', join(dirs.media, '%(autonumber)s.%(ext)s'), t.url], { timeoutMs: 300000 });
    if (d.code === 0) attachFiles(data, dirs);
  }
  return { name: 'yt-dlp', ok: true, data };
}

async function srcGalleryDl(t, cfg, gate, dirs, o) {
  await gate.take('gallery-dl metadata');
  const r = await run(cfg.tools.gallerydl, ['--ignore-config', '-j', t.url], { timeoutMs: 120000 });
  if (r.code !== 0) return { name: 'gallery-dl', ok: false, error: lastLine(r.err, r.code), cls: classifyError(r.err) };
  let j; try { j = JSON.parse(r.out); } catch { return { name: 'gallery-dl', ok: false, error: 'unparseable JSON', cls: 'other' }; }
  const data = mapGalleryDl(j);
  if (!data) return { name: 'gallery-dl', ok: false, error: 'no media in output', cls: 'other' };
  if (o.download) {
    await gate.take('gallery-dl media');
    const d = await run(cfg.tools.gallerydl, ['--ignore-config', '-D', dirs.media, t.url], { timeoutMs: 300000 });
    if (d.code === 0) attachFiles(data, dirs);
  }
  return { name: 'gallery-dl', ok: true, data };
}

// The public embed page. With Playwright installed: its bundled Chromium, headless, in a fresh non-persistent context
// (no channel, no profile, no remote-debugging port). Without it: one plain HTTPS GET, no screenshot.
async function srcEmbed(t, cfg, gate, dirs, o, log) {
  const url = `${cfg.embedBaseUrl.replace(/\/+$/, '')}/p/${t.shortcode}/embed/captioned/`;
  let pw = null;
  if (o.screenshot) {
    const ck = checkChromiumPath(cfg.chromiumPath);
    if (!ck.ok) return { name: 'embed', ok: false, error: ck.why, cls: 'other' };
    pw = await loadPlaywright(cfg);
    if (!pw) log('embed: playwright not installed, fetching the HTML without a screenshot');
  }
  await gate.take('embed page');
  let html = null, shot = null, status = null;
  if (pw) {
    let browser;
    try {
      browser = await pw.chromium.launch({ headless: true, ...(cfg.chromiumPath ? { executablePath: cfg.chromiumPath } : {}) });
      const context = await browser.newContext({ viewport: { width: 540, height: 900 } });
      const page = await context.newPage();
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      status = resp?.status() ?? null;
      html = await page.content();
      if (status && status < 400) { shot = join(dirs.shots, 'embed.png'); await page.screenshot({ path: shot, fullPage: true }); }
    } catch (e) { return { name: 'embed', ok: false, error: String(e.message || e).split('\n')[0], cls: classifyError(e.message) }; }
    finally { try { await browser?.close(); } catch {} }
  } else {
    try {
      const resp = await fetch(url, { headers: { 'user-agent': `Mozilla/5.0 (compatible; ig2md/${VERSION})` }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
      status = resp.status; html = await resp.text();
    } catch (e) { return { name: 'embed', ok: false, error: String(e.message || e), cls: 'other' }; }
  }
  if (status && status >= 400) return { name: 'embed', ok: false, error: `HTTP ${status}`, cls: status === 429 ? 'rate_limited' : status === 404 ? 'not_found' : 'other' };
  const data = mapEmbed(html);
  if (!data) return { name: 'embed', ok: false, error: 'embed page had no readable caption, author or media (it may be a login page)', cls: /login/i.test(html || '') ? 'needs_login' : 'other', shot };
  return { name: 'embed', ok: true, data, shot };
}

async function srcInstaloader(t, cfg, gate, dirs) {
  const tmp = join(dirs.base, '_instaloader');
  mkdirSync(tmp, { recursive: true });
  await gate.take('instaloader');
  // No --login and no --load-cookies: instaloader stays anonymous.
  const r = await run(cfg.tools.instaloader, ['--quiet', '--no-video-thumbnails', '--no-compress-json', '--no-pictures', '--no-videos', '--dirname-pattern', tmp, '--', `-${t.shortcode}`], { timeoutMs: 120000 });
  if (r.code !== 0) return { name: 'instaloader', ok: false, error: lastLine(r.err, r.code), cls: classifyError(r.err) };
  const f = readdirSync(tmp).find((x) => x.endsWith('.json'));
  if (!f) return { name: 'instaloader', ok: false, error: 'no JSON written', cls: 'other' };
  let j; try { j = JSON.parse(readFileSync(join(tmp, f), 'utf8')); } catch { return { name: 'instaloader', ok: false, error: 'unparseable JSON', cls: 'other' }; }
  const data = mapInstaloader(j);
  return data ? { name: 'instaloader', ok: true, data } : { name: 'instaloader', ok: false, error: 'unmappable output', cls: 'other' };
}

const SRC = { 'yt-dlp': srcYtDlp, 'gallery-dl': srcGalleryDl, embed: srcEmbed, instaloader: srcInstaloader };
const CLI_OF = { 'yt-dlp': 'ytdlp', 'gallery-dl': 'gallerydl', instaloader: 'instaloader' };

function attachFiles(data, dirs) {
  const files = existsSync(dirs.media) ? readdirSync(dirs.media).sort() : [];
  data.media.forEach((m, i) => { if (files[i]) m.file = `media/${files[i]}`; });
}

// ---------- frames: a cover, and a 4x3 contact sheet for videos (ffmpeg, if installed) ----------
async function makeFrames(post, cfg, dirs, log) {
  const first = post.media.find((m) => m.file);
  if (!first) return;
  const abs = join(dirs.base, first.file);
  if (first.type === 'image') {
    const dest = join(dirs.shots, 'cover' + extname(abs)); copyFileSync(abs, dest);
    post.screenshots.cover = `shots/${basename(dest)}`; return;
  }
  if (!(await detectTool(cfg.tools.ffmpeg, '-version'))) { log('ffmpeg not installed: no cover or contact sheet'); return; }
  const cover = join(dirs.shots, 'cover.jpg');
  const a = await run(cfg.tools.ffmpeg, ['-y', '-loglevel', 'error', '-i', abs, '-frames:v', '1', '-q:v', '3', cover]);
  if (a.code === 0 && existsSync(cover)) post.screenshots.cover = 'shots/cover.jpg';
  const sheet = join(dirs.shots, 'contact.jpg');
  const fps = `${12 / Math.max(first.duration_s || 10, 1)}`;
  const b = await run(cfg.tools.ffmpeg, ['-y', '-loglevel', 'error', '-i', abs, '-vf', `fps=${fps},scale=320:-1,tile=4x3`, '-frames:v', '1', sheet]);
  if (b.code === 0 && existsSync(sheet)) post.screenshots.contact_sheet = 'shots/contact.jpg';
}

// ---------- one target ----------
export async function processTarget(t, cfg, opts = {}) {
  const log = opts.log || (() => {});
  const gate = opts.gate || makeGate(cfg, log);
  const rel = join(cfg.outDir, t.shortcode);
  const base = resolve(rel);
  const dirs = { base, rel, media: join(base, 'media'), shots: join(base, 'shots') };

  if (opts.fromFile) return fromFile(t, cfg, opts, dirs, log);
  if (t.kind === 'story' || t.kind === 'highlight') {
    return { exit: EXIT.NEEDS_LOGIN, error: 'Stories and highlights are not served to logged-out visitors, so ig2md does not support them. To file media you already have, pass --from-file <path>.' };
  }
  if (cfg.skipIfFresherThanHours > 0 && existsSync(join(base, `${t.shortcode}.json`))) {
    const ageH = (Date.now() - statSync(join(base, `${t.shortcode}.json`)).mtimeMs) / 3.6e6;
    if (ageH < cfg.skipIfFresherThanHours) return { exit: EXIT.OK, skipped: true, dir: rel };
  }
  for (const d of [dirs.base, dirs.media, dirs.shots]) mkdirSync(d, { recursive: true });
  const o = { download: cfg.downloadMedia && !opts.noMedia, screenshot: cfg.screenshot && !opts.noShot };

  // The embed page is worth a request "just for the screenshot" only if a screenshot is possible.
  const canShoot = o.screenshot && cfg.sources.includes('embed') && checkChromiumPath(cfg.chromiumPath).ok && Boolean(await loadPlaywright(cfg));
  const results = []; let shot = null; let worst = null;
  for (const name of cfg.sources) {
    // A later source runs only if earlier ones did not already give caption + author + a saved file,
    // except the embed page, which still runs once for its screenshot when Playwright is installed.
    const have = results.filter((r) => r.ok).map((r) => r.data);
    const complete = have.some((d) => d.caption != null && d.author?.username && d.media.some((m) => m.file));
    if (complete && !(name === 'embed' && canShoot && !shot)) continue;
    if (name === 'instaloader' && have.some((d) => d.caption != null)) continue;
    if (CLI_OF[name] && !(await detectTool(cfg.tools[CLI_OF[name]]))) { results.push({ name, ok: false, error: `${name} not installed (skipped)`, cls: 'missing' }); continue; }
    let r;
    try { r = await SRC[name](t, cfg, gate, dirs, o, log); }
    catch (e) { if (e.cap) { results.push({ name, ok: false, error: e.message, cls: 'other' }); break; } r = { name, ok: false, error: String(e.message || e), cls: 'other' }; }
    results.push(r);
    if (r.shot) shot = r.shot;
    if (!r.ok) log(`${name}: ${r.error}`);
    if (!r.ok && r.cls === 'rate_limited') { worst = 'rate_limited'; log(`${name}: rate limited, stopping (no retries)`); break; }
    if (!r.ok && r.cls === 'needs_login') worst = worst || 'needs_login';
  }

  const post = merge(t, results, { access: 'anonymous', embed: shot ? 'shots/embed.png' : null });
  if (!hasContent(post)) {
    const code = worst === 'rate_limited' ? EXIT.RATE_LIMITED : worst === 'needs_login' ? EXIT.NEEDS_LOGIN : EXIT.NO_SOURCE;
    const msg = code === EXIT.NEEDS_LOGIN ? 'Instagram wants a login for this post. ig2md is logged-out only: not retrying, no workaround attempted.'
      : code === EXIT.RATE_LIMITED ? 'Rate limited by Instagram; stopped.'
      : 'No source returned anything (the post may be deleted or private, or no tool is installed: run --check).';
    writeFileSync(join(base, 'ig2md.log'), redact(JSON.stringify({ sources: post.sources }, null, 2)));
    return { exit: code, error: msg, sources: post.sources };
  }
  await makeFrames(post, cfg, dirs, log);
  return finish(post, dirs, t);
}

async function fromFile(t, cfg, opts, dirs, log) {
  const src = resolve(opts.fromFile);
  if (!existsSync(src) || !statSync(src).isFile()) return { exit: EXIT.USAGE, error: `--from-file not found: ${opts.fromFile}` };
  for (const d of [dirs.base, dirs.media, dirs.shots]) mkdirSync(d, { recursive: true });
  copyFileSync(src, join(dirs.media, basename(src)));
  const isVid = /\.(mp4|mov|webm|mkv)$/i.test(src);
  const post = merge(t, [{ name: 'from-file', ok: true, data: {
    author: { username: opts.author || t.user || null, full_name: null, verified: null }, date: opts.date || null, caption: opts.caption || null,
    counts: {}, media: [{ type: isVid ? 'video' : 'image', file: `media/${basename(src)}`, width: null, height: null, duration_s: null, alt_text: null }], carousel: false, location: null } }], { access: 'user-file' });
  await makeFrames(post, cfg, dirs, log);
  return finish(post, dirs, t);
}

function finish(post, dirs, t) {
  const errs = validate(post, SCHEMA);
  if (errs.length) return { exit: EXIT.NO_SOURCE, error: 'schema validation failed: ' + errs.slice(0, 5).join('; ') };
  writeFileSync(join(dirs.base, `${t.shortcode}.json`), JSON.stringify(post, null, 2) + '\n');
  writeFileSync(join(dirs.base, `${t.shortcode}.md`), renderMd(post));
  writeFileSync(join(dirs.base, 'ig2md.log'), redact(JSON.stringify({ sources: post.sources, access: post.access }, null, 2)));
  return { exit: EXIT.OK, dir: dirs.rel, json: join(dirs.rel, `${t.shortcode}.json`), md: join(dirs.rel, `${t.shortcode}.md`), kind: post.kind, sources: post.sources, screenshots: post.screenshots };
}

// ---------- CLI ----------
export function parseArgs(argv) {
  const o = { inputs: [] };
  const num = (a, v) => { const n = Number(v); if (v === undefined || v === '' || !Number.isFinite(n)) throw new UsageError(`${a} needs a number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const nx = () => { const v = argv[++i]; if (v === undefined) throw new UsageError(`${a} needs a value`); return v; };
    if (a === '--config') o.config = nx();
    else if (a === '--out') o.out = nx();
    else if (a === '--list') o.list = nx();
    else if (a === '--from-file') o.fromFile = nx();
    else if (a === '--author') o.author = nx();
    else if (a === '--caption') o.caption = nx();
    else if (a === '--date') o.date = nx();
    else if (a === '--max-requests') o.maxRequests = num(a, argv[++i]);
    else if (a === '--min-delay') o.minDelay = num(a, argv[++i]);
    else if (a === '--max-delay') o.maxDelay = num(a, argv[++i]);
    else if (a === '--sources') o.sources = nx().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--no-shot') o.noShot = true;
    else if (a === '--no-media') o.noMedia = true;
    else if (a === '--check') o.check = true;
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version') o.version = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else o.inputs.push(a);
  }
  return o;
}

export const HELP = `ig2md ${VERSION}: a public Instagram post, reel or carousel URL -> JSON + Markdown + frames (logged-out only)

usage: ig2md <url-or-pasted-text...> [--list urls.txt] [--out DIR] [--config FILE]
             [--sources yt-dlp,gallery-dl,embed,instaloader] [--no-shot] [--no-media]
             [--max-requests N] [--min-delay MS] [--max-delay MS] [--quiet]
       ig2md <url> --from-file PATH [--author NAME] [--caption TEXT] [--date ISO]   (no network)
       ig2md --check        which optional tools are installed (yt-dlp, gallery-dl, instaloader, ffmpeg, playwright)

Writes <out>/<shortcode>/<shortcode>.json (schema 1.0) + <shortcode>.md + media/ + shots/.
stdout: one JSON line. Progress: stderr. Config: --config or IG2MD_CONFIG (see examples/config.example.json).
Exit: 0 ok · 1 no source returned anything · 2 usage · 3 needs a login (unsupported) · 4 rate limited (batch stops)`;

export async function check(cfg) {
  const tools = {};
  for (const [name, key, flag] of [['yt-dlp', 'ytdlp'], ['gallery-dl', 'gallerydl'], ['instaloader', 'instaloader'], ['ffmpeg', 'ffmpeg', '-version']]) tools[name] = await detectTool(cfg.tools[key], flag);
  const pw = await loadPlaywright(cfg);
  return { ok: true, tools, playwright: pw ? 'found' : null, sources: cfg.sources, maxRequests: cfg.maxRequests, delayMs: [cfg.minDelayMs, cfg.maxDelayMs] };
}

export async function main(argv = process.argv.slice(2)) {
  let o, cfg;
  try {
    o = parseArgs(argv);
    if (o.help) { console.log(HELP); return EXIT.OK; }
    if (o.version) { console.log(VERSION); return EXIT.OK; }
    cfg = loadConfig(o.config);
    if (o.out) cfg.outDir = o.out;
    if (o.maxRequests != null) cfg.maxRequests = o.maxRequests;
    if (o.minDelay != null) cfg.minDelayMs = o.minDelay;
    if (o.maxDelay != null) cfg.maxDelayMs = o.maxDelay;
    if (o.sources) cfg.sources = o.sources;
    checkConfig(cfg);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.log(JSON.stringify({ ok: false, error: e.message }));
    console.error(`ig2md: ${e.message} (try --help)`);
    return EXIT.USAGE;
  }
  if (o.check) { console.log(JSON.stringify(await check(cfg))); return EXIT.OK; }
  if (!o.inputs.length && !o.list) { console.error(HELP); console.log(JSON.stringify({ ok: false, error: 'no URL given' })); return EXIT.USAGE; }

  const targets = [];
  for (const i of o.inputs) { const t = parseInput(i); if (t) targets.push(t); else console.error(`[ig2md] not an Instagram URL: ${i.slice(0, 80)}`); }
  if (o.list) {
    try { targets.push(...parseUrlList(readFileSync(o.list, 'utf8'))); } catch (e) { console.log(JSON.stringify({ ok: false, error: `--list ${o.list}: ${e.code || e.message}` })); return EXIT.USAGE; }
  }
  if (!targets.length) { console.log(JSON.stringify({ ok: false, error: 'no valid Instagram URLs' })); return EXIT.USAGE; }
  if (o.fromFile && targets.length !== 1) { console.log(JSON.stringify({ ok: false, error: '--from-file takes exactly one URL' })); return EXIT.USAGE; }

  const log = o.quiet ? () => {} : (m) => console.error(`[ig2md] ${redact(m)}`);
  const gate = makeGate(cfg, log);
  let worst = 0; const results = [];
  for (const t of targets) {
    const r = await processTarget(t, cfg, { log, gate, fromFile: o.fromFile, author: o.author, caption: o.caption, date: o.date, noMedia: o.noMedia, noShot: o.noShot });
    results.push({ shortcode: t.shortcode, ...r });
    if (r.exit) worst = worst || r.exit;
    if (r.error) log(`${t.shortcode}: ${r.error}`);
    if (r.exit === EXIT.RATE_LIMITED) break; // a rate limit stops the whole batch
  }
  console.log(JSON.stringify({ ok: worst === 0, requests: gate.count, results }));
  return worst;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => { process.exitCode = c; });
