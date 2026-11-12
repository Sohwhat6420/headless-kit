#!/usr/bin/env node
// github-stars: token-free tracker for new GitHub stars. Plain HTTP (or the gh CLI), a JSON state file, an
// optional Markdown log and an optional push (ntfy or a webhook). No model runs, ever; an agent reads the result.
//
//   node github-stars.mjs --user octocat --state stars.json            one poll, one JSON object on stdout
//   node github-stars.mjs --user octocat --ntfy-topic-file topic.txt    ... and push each new star
//   node github-stars.mjs --user octocat --every 15                     poll every 15 minutes (one JSON line each)
//
// The first poll with no state file SEEDS from the current stars and announces nothing.
// Exit codes: 0 ok, 1 fetch or file error, 2 bad usage or config, 4 another poll holds the state lock.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';
const API = 'https://api.github.com';
const UA = `headless-kit-github-stars/${VERSION}`;
const DAY = 86_400_000;

const HELP = `github-stars ${VERSION}: new-star diff for any GitHub user, token-free (no model calls).

  node github-stars.mjs --user LOGIN [options]

  --user LOGIN            whose stars to watch (env GITHUB_STARS_USER)
  --state FILE            state file (env GITHUB_STARS_STATE; default ./github-stars-state.json)
  --log-md FILE           append one Markdown table row per new star
  --ntfy-topic-file FILE  push each new star to ntfy (env NTFY_TOPIC_FILE; the topic is never printed)
  --ntfy-base URL         ntfy server (env NTFY_BASE; default https://ntfy.sh)
  --webhook-url-file FILE POST each new star as JSON to the URL in this file (env GITHUB_STARS_WEBHOOK_FILE)
  --token-file FILE       GitHub token for a higher rate limit (env GITHUB_TOKEN also works; never printed)
  --gh                    use the signed-in gh CLI instead of plain HTTP (no --user: your own stars)
  --max-push N            more than N new stars in one poll: one summary push instead (default 10)
  --tz-offset H           hours east of UTC for the Markdown log times (default 0)
  --every MIN             keep polling every MIN minutes (minimum 5); one JSON line per poll
  --dry-run               fetch and diff only: write nothing, push nothing
  --config FILE           JSON config with the same keys (env GITHUB_STARS_CONFIG)
  --help                  this text

Precedence: flags, then environment, then the config file, then the defaults.`;

// ---------------------------------------------------------------------------------------------- settings

const FLAGS = {
  '--user': 'user', '--state': 'state', '--log-md': 'logMd', '--ntfy-topic-file': 'ntfyTopicFile', '--ntfy-base': 'ntfyBase',
  '--webhook-url-file': 'webhookUrlFile', '--token-file': 'tokenFile', '--max-push': 'maxPush', '--tz-offset': 'tzOffsetH',
  '--every': 'everyMin', '--config': 'config',
};
const BOOLS = { '--gh': 'gh', '--dry-run': 'dryRun', '--help': 'help' };

export class UsageError extends Error {}

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOLS[a]) { o[BOOLS[a]] = true; continue; }
    if (FLAGS[a]) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      o[FLAGS[a]] = argv[++i];
      continue;
    }
    throw new UsageError(`unknown option ${a}`);
  }
  return o;
}

/** Flags, then environment, then the config file, then the defaults. Relative config paths resolve against the config file. */
export function settings(argv, env = process.env, cwd = process.cwd()) {
  const flags = parseArgs(argv);
  if (flags.help) return { help: true };
  const cfgPath = flags.config || env.GITHUB_STARS_CONFIG || null;
  let file = {};
  if (cfgPath) {
    try { file = JSON.parse(readFileSync(resolve(cwd, cfgPath), 'utf8')); } catch (e) { throw new UsageError(`config ${cfgPath}: ${e.code || e.message}`); }
  }
  const base = cfgPath ? dirname(resolve(cwd, cfgPath)) : cwd;
  const fromFile = (k) => (file[k] === undefined || file[k] === null ? undefined : file[k]);
  const path = (v, b) => (v === undefined ? undefined : isAbsolute(String(v)) ? String(v) : resolve(b, String(v)));
  const pick = (k, envName, def, isPath = false) => {
    if (flags[k] !== undefined) return isPath ? path(flags[k], cwd) : flags[k];
    if (envName && env[envName]) return isPath ? path(env[envName], cwd) : env[envName];
    if (fromFile(k) !== undefined) return isPath ? path(fromFile(k), base) : fromFile(k);
    return isPath ? path(def, cwd) : def;
  };
  const s = {
    user: pick('user', 'GITHUB_STARS_USER', undefined),
    state: pick('state', 'GITHUB_STARS_STATE', 'github-stars-state.json', true),
    logMd: pick('logMd', null, undefined, true),
    ntfyTopicFile: pick('ntfyTopicFile', 'NTFY_TOPIC_FILE', undefined, true),
    ntfyBase: String(pick('ntfyBase', 'NTFY_BASE', 'https://ntfy.sh')).replace(/\/+$/, ''),
    webhookUrlFile: pick('webhookUrlFile', 'GITHUB_STARS_WEBHOOK_FILE', undefined, true),
    tokenFile: pick('tokenFile', null, undefined, true),
    gh: Boolean(flags.gh || file.gh),
    maxPush: Number(pick('maxPush', null, 10)),
    tzOffsetH: Number(pick('tzOffsetH', null, 0)),
    everyMin: pick('everyMin', null, undefined),
    dryRun: Boolean(flags.dryRun),
  };
  if (s.user !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(String(s.user))) throw new UsageError('--user must be a GitHub login');
  if (!s.user && !s.gh) throw new UsageError('--user is required (or --gh for your own stars)');
  if (!Number.isInteger(s.maxPush) || s.maxPush < 1) throw new UsageError('--max-push must be a whole number from 1');
  if (!Number.isFinite(s.tzOffsetH) || Math.abs(s.tzOffsetH) > 14) throw new UsageError('--tz-offset must be between -14 and 14');
  if (s.everyMin !== undefined) {
    s.everyMin = Number(s.everyMin);
    if (!Number.isFinite(s.everyMin) || s.everyMin < 5) throw new UsageError('--every must be 5 minutes or more');
  }
  if (!/^https?:\/\//.test(s.ntfyBase)) throw new UsageError('--ntfy-base must be an http(s) URL');
  return s;
}

/** A one-line secret from a file (or null). Never logged. */
export function readSecret(file) {
  if (!file || !existsSync(file)) return null;
  const v = readFileSync(file, 'utf8').trim();
  return v && !/\s/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------------------------- source

// Untrusted text to one capped line. Format characters (zero-width, bidirectional overrides and isolates, BOM) are
// removed outright, since they can hide or reorder what a reader sees; control characters (C0 and C1) become a space.
const clean = (s, max) => String(s ?? '').replace(/\p{Cf}+/gu, '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** The link that is logged and pushed is always a page on github.com: GitHub's own, else rebuilt from the name. */
function repoUrl(name, url) {
  const u = clean(url, 300);
  if (/^https:\/\/github\.com\/[^\s?#]+$/.test(u)) return u;
  return REPO_NAME.test(name) ? `https://github.com/${name}` : '';
}

/** One star from GitHub's star+json shape. Every text field is untrusted data. */
export function toStar(s) {
  const r = s.repo || {};
  return {
    name: clean(r.full_name, 140), at: s.starred_at, url: repoUrl(clean(r.full_name, 140), r.html_url),
    desc: clean(r.description, 300), stars: Number(r.stargazers_count) || 0, lang: clean(r.language, 40),
  };
}

const LIST_QUERY = 'per_page=100&sort=created&direction=desc';

/** Page 1 (the 100 newest) of a user's stars over plain HTTP. */
export async function fetchStars({ user, token = null, fetchImpl = fetch, apiBase = API }) {
  const headers = { accept: 'application/vnd.github.star+json', 'user-agent': UA, 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(`${apiBase}/users/${encodeURIComponent(user)}/starred?${LIST_QUERY}`, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    const left = res.headers.get('x-ratelimit-remaining');
    throw new Error(`GitHub answered HTTP ${res.status}${left === '0' ? ' (rate limit; add --token-file)' : ''}`);
  }
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('GitHub answered with something other than a list');
  return list.filter((s) => s && s.repo && s.starred_at).map(toStar);
}

/** The same list through the gh CLI (its own sign-in; windowless). */
export function fetchStarsGh({ user, execFileImpl = execFile }) {
  const path = user ? `users/${encodeURIComponent(user)}/starred?${LIST_QUERY}` : `user/starred?${LIST_QUERY}`;
  return new Promise((ok, fail) => {
    execFileImpl('gh', ['api', '-H', 'Accept: application/vnd.github.star+json', path], { windowsHide: true, timeout: 60_000, maxBuffer: 32 << 20 }, (err, stdout) => {
      if (err) return fail(new Error(`gh api failed: ${String(err.message).split('\n')[0].slice(0, 160)}`));
      try { ok(JSON.parse(stdout).filter((s) => s && s.repo && s.starred_at).map(toStar)); } catch { fail(new Error('gh api did not return JSON')); }
    });
  });
}

// ---------------------------------------------------------------------------------------------- diff

/**
 * The diff. prev = the state file (or null). Returns {seeded, fresh (oldest first), seen (next state's map)}.
 * Only page 1 is read, so after an unstar an old star can slide onto the page: anything starred more than a day
 * before the newest star already known is recorded silently, never announced.
 */
export function diff(stars, prev) {
  const seen = { ...(prev?.seen || {}) };
  if (!prev) {
    for (const s of stars) seen[s.name] = s.at;
    return { seeded: true, fresh: [], seen };
  }
  const known = Object.values(seen).map(Date.parse).filter(Number.isFinite);
  const watermark = known.length ? Math.max(...known) - DAY : 0;
  for (const s of stars) if (!seen[s.name] && Date.parse(s.at) < watermark) seen[s.name] = s.at;
  const fresh = stars.filter((s) => !seen[s.name]).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const s of fresh) seen[s.name] = s.at;
  return { seeded: false, fresh, seen };
}

export function mdHeader(user) {
  return `# New GitHub stars${user ? ` of ${clean(user, 40)}` : ''} (written by github-stars; no model calls)\n\n| Starred | Repo | What it is | Stars | Lang |\n|---|---|---|---|---|\n`;
}

export function mdRow(s, tzOffsetH = 0) {
  const t = new Date(Date.parse(s.at) + tzOffsetH * 3_600_000).toISOString().replace('T', ' ').slice(0, 16);
  const zone = tzOffsetH ? `UTC${tzOffsetH > 0 ? '+' : ''}${tzOffsetH}` : 'UTC';
  const cell = (v, max) => clean(v, max).replace(/\|/g, '/').replace(/[[\]]/g, '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, "'");
  return `| ${t} ${zone} | [${cell(s.name, 140)}](${encodeURI(cell(s.url, 300))}) | ${cell(s.desc, 160)} | ${s.stars} | ${cell(s.lang, 40)} |\n`;
}

// ---------------------------------------------------------------------------------------------- push

/** Redact every secret from a message before it is shown. */
export const redact = (msg, secrets) => secrets.filter(Boolean).reduce((m, s) => m.split(s).join('[secret]'), String(msg));

export async function pushNtfy({ base, topic, title, body, click, fetchImpl = fetch }) {
  const headers = { title, tags: 'star', 'content-type': 'text/plain; charset=utf-8' };
  if (click) headers.click = click;
  const res = await fetchImpl(`${base}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
}

export async function pushWebhook({ url, payload, fetchImpl = fetch }) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
}

/** Run it; if it fails, wait and run it once more (a push that fails twice is reported). */
const twice = async (fn, delayMs) => {
  try { return await fn(); } catch { if (delayMs > 0) await new Promise((r) => { setTimeout(r, delayMs); }); return fn(); }
};

// ---------------------------------------------------------------------------------------------- one poll

function lock(file) {
  const l = `${file}.lock`;
  if (existsSync(l)) {
    const pid = Number(readFileSync(l, 'utf8'));
    let alive = false;
    try { if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch { /* gone */ }
    if (alive) return null;
  }
  mkdirSync(dirname(l), { recursive: true });
  writeFileSync(l, String(process.pid));
  return () => { try { unlinkSync(l); } catch { /* already gone */ } };
}

const loadState = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
function saveState(f, s) {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, f);
}

/** A path under the working folder is shown relative to it (no home folder in logs). */
const shown = (f) => { const r = relative(process.cwd(), f); return r && !r.startsWith('..') && !isAbsolute(r) ? r : f; };

/** One poll with every side effect injectable. Returns the JSON result. */
export async function poll(s, { fetchImpl = fetch, execFileImpl = execFile, env = process.env, now = () => new Date(), retryDelayMs = 2000 } = {}) {
  const token = readSecret(s.tokenFile) || env.GITHUB_TOKEN || null;
  const topic = readSecret(s.ntfyTopicFile);
  const hook = readSecret(s.webhookUrlFile);
  const secrets = [token, topic, hook];
  if (s.ntfyTopicFile && !topic) throw new UsageError('the ntfy topic file is missing or empty');
  if (s.webhookUrlFile && !(hook && /^https?:\/\//.test(hook))) throw new UsageError('the webhook file must hold one http(s) URL');

  const stars = s.gh ? await fetchStarsGh({ user: s.user, execFileImpl }) : await fetchStars({ user: s.user, token, fetchImpl });
  const prev = loadState(s.state);
  const who = s.user || '(gh user)';
  if (prev && prev.user && prev.user !== who) throw new UsageError(`the state file belongs to ${prev.user}, not ${who}; use another --state`);
  const d = diff(stars, prev);
  const out = { ok: true, user: who, read: stars.length, seeded: d.seeded, new: d.fresh, pushed: { ntfy: 0, webhook: 0, failed: 0 }, state: shown(s.state), dryRun: s.dryRun };
  if (s.dryRun) return out;

  if (s.logMd && d.fresh.length) {
    if (!existsSync(s.logMd)) { mkdirSync(dirname(s.logMd), { recursive: true }); writeFileSync(s.logMd, mdHeader(s.user)); }
    for (const st of d.fresh) appendFileSync(s.logMd, mdRow(st, s.tzOffsetH));
  }
  const at = now().toISOString();
  saveState(s.state, { user: who, seen: d.seen, ...(prev ? { seededAt: prev.seededAt } : { seededAt: at }), lastPoll: at });

  if (!d.fresh.length || (!topic && !hook)) return out;
  const batch = d.fresh.length > s.maxPush
    ? [{ title: `${d.fresh.length} new GitHub stars`, body: `${d.fresh.slice(-5).map((x) => x.name).join(', ')} and ${d.fresh.length - Math.min(5, d.fresh.length)} more`, click: null, payload: { event: 'github-stars', user: who, count: d.fresh.length, repos: d.fresh.map((x) => x.name) } }]
    : d.fresh.map((x) => ({ title: 'New GitHub star', body: `${x.name}${x.desc ? `: ${clean(x.desc, 140)}` : ''}`, click: x.url, payload: { event: 'github-star', user: who, ...x } }));
  out.errors = [];
  for (const b of batch) {
    if (topic) {
      try { await twice(() => pushNtfy({ base: s.ntfyBase, topic, title: b.title, body: b.body, click: b.click, fetchImpl }), retryDelayMs); out.pushed.ntfy++; }
      catch (e) { out.pushed.failed++; out.errors.push(redact(`ntfy: ${e.message}`, secrets)); }
    }
    if (hook) {
      try { await twice(() => pushWebhook({ url: hook, payload: b.payload, fetchImpl }), retryDelayMs); out.pushed.webhook++; }
      catch (e) { out.pushed.failed++; out.errors.push(redact(`webhook: ${e.message}`, secrets)); }
    }
  }
  if (!out.errors.length) delete out.errors;
  return out;
}

// ---------------------------------------------------------------------------------------------- CLI

/** The CLI as a function: returns the exit code. Loops when --every is given (until `signal` aborts). */
export async function run(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, signal, ...deps } = {}) {
  let s;
  try { s = settings(argv, env, cwd); } catch (e) { stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`); return 2; }
  if (s.help) { stdout.write(`${HELP}\n`); return 0; }
  const release = s.dryRun ? () => {} : lock(s.state);
  if (!release) { stdout.write(`${JSON.stringify({ ok: false, error: 'another poll holds the state lock' })}\n`); return 4; }
  const secrets = () => [readSecret(s.tokenFile), env.GITHUB_TOKEN, readSecret(s.ntfyTopicFile), readSecret(s.webhookUrlFile)];
  try {
    for (;;) {
      let code = 0;
      try { stdout.write(`${JSON.stringify(await poll(s, { env, ...deps }))}\n`); }
      catch (e) {
        code = e instanceof UsageError ? 2 : 1;
        stdout.write(`${JSON.stringify({ ok: false, error: redact(e.message, secrets()) })}\n`);
      }
      if (!s.everyMin) return code;
      if (code === 2) return 2;
      if (code) stderr.write('poll failed; trying again next round\n');
      const stop = await new Promise((r) => {
        const t = setTimeout(() => r(false), s.everyMin * 60_000);
        signal?.addEventListener('abort', () => { clearTimeout(t); r(true); }, { once: true });
      });
      if (stop || signal?.aborted) return 0;
    }
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
