# ig2md

[![test](https://github.com/Sohwhat6420/headless-kit/actions/workflows/test.yml/badge.svg)](https://github.com/Sohwhat6420/headless-kit/actions/workflows/test.yml)
![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)
![node: 18+](https://img.shields.io/badge/node-18%2B-green)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

**Turn a public Instagram post, reel or carousel URL into schema-versioned JSON plus Markdown (and frames) that an agent can read.** Logged-out only. One Node file plus a helper, zero dependencies.

**Why it's interesting:** agents get handed Instagram links constantly, and they can't read them: the page is a login-walled app shell. The tools that *can* (yt-dlp, gallery-dl, instaloader, the public embed page) each give a different, partial answer in a different format. `ig2md` runs whichever of them you have installed, one polite request at a time, merges the answers into one validated JSON record with provenance (`sources[]` says which tool worked and why the others failed), and writes a Markdown file an agent can read directly. It never logs in, never uses cookies, and it stops on a rate limit instead of retrying.

<p align="center"><img src="docs/demo.svg" alt="Terminal: ig2md --check lists which optional tools are installed; a pasted message containing a reel URL becomes a JSON summary after two polite requests; the Markdown file starts with front matter, an untrusted-data banner and the caption; a story URL exits 3 with no request made" width="100%"></p>

### Quick start (Node 18+, plus at least one of yt-dlp, gallery-dl or instaloader)

```bash
git clone https://github.com/Sohwhat6420/headless-kit && cd headless-kit/tools/research/ig2md
node ig2md.mjs --check && node ig2md.mjs "https://www.instagram.com/reel/<shortcode>/"
node --test                           # 21 offline tests, about 3 s
```

<details>
<summary><b>The offline test suite, real output</b></summary>
<br>
<img src="docs/test-run.svg" alt="21 of 21 tests pass: URL parsing, mappers for every source, merge and provenance, schema rejection, redaction, chromiumPath refusals, the request cap, logged-out flags, missing tools, embed page over a local stub, a fake Playwright launched headless, login wall, rate limit, stories, the CLI" width="100%">
</details>

It is part of **[headless-kit](../../../README.md)**, a set of small, agent-first, windowless tools: output as files plus a JSON line, standard library only.

## Usage

```bash
node ig2md.mjs <url-or-pasted-text...> [--list urls.txt] [--out DIR] [--config FILE]
               [--sources yt-dlp,gallery-dl,embed,instaloader] [--no-shot] [--no-media]
               [--max-requests N] [--min-delay MS] [--max-delay MS] [--quiet]
node ig2md.mjs <url> --from-file PATH [--author NAME] [--caption TEXT] [--date ISO]   # no network
node ig2md.mjs --check                                                                 # what is installed
```

Paste a whole message if you like: the first Instagram URL in it is used and tracking parameters (`igsh`, `utm_*`) are dropped. A `--list` file takes one URL per line (`#` comments allowed, duplicates skipped).

Each URL gets a folder `<out>/<shortcode>/`:

| File | Contents |
| --- | --- |
| `<shortcode>.json` | The record, validated against [`schema/post.schema.json`](schema/post.schema.json) before it is written |
| `<shortcode>.md` | The same for reading: front matter, caption, metrics, hashtags, media, screenshots |
| `info.json` | yt-dlp's raw metadata, when yt-dlp answered |
| `media/` | The downloaded video or images (skip with `--no-media`) |
| `shots/` | `cover.*`, `contact.jpg` (a 4×3 contact sheet of a video, via ffmpeg) and `embed.png` (the embed page, via Playwright) when available |
| `ig2md.log` | Which source worked and which failed, redacted |

stdout is one JSON line: `{"ok", "requests", "results": [{"shortcode", "exit", "dir", "json", "md", "kind", "sources", "screenshots"}]}`. Progress goes to stderr (`--quiet` silences it).

## How it decides

Sources run in the order of `sources` (default: yt-dlp, gallery-dl, embed, instaloader). A missing CLI is skipped and recorded as `"not installed (skipped)"`. A later source runs only if the earlier ones did not already give a caption, an author and a saved file; the one exception is the embed page, which runs once for its screenshot, and only when Playwright is installed. Each field of the record takes the first source that has it. A post becomes `carousel` or `reel` once the media is known.

| Source | What it gives | How it is kept logged-out |
| --- | --- | --- |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Metadata, video or images | `--ignore-config --no-cookies`, so a user config cannot add cookies |
| [gallery-dl](https://github.com/mikf/gallery-dl) | Photos and carousels | `--ignore-config` |
| Embed page `/p/<code>/embed/captioned/` | Caption, author, like and comment counts, a screenshot | A plain GET, or Playwright's bundled headless Chromium in a fresh context (see Security) |
| [instaloader](https://github.com/instaloader/instaloader) | Public metadata, last resort | Never given `--login` or `--load-cookies` |

The request gate counts each tool call or page load (not every image a page pulls in), waits a random `minDelayMs`–`maxDelayMs` between them and refuses to pass `maxRequests`.

**Stories and highlights are unsupported:** Instagram does not serve them to logged-out visitors, and ig2md does not use sessions. A story URL exits 3 without a request. If you already have the media (your own download or export), `--from-file` files it under the URL with `access: "user-file"` and no network at all.

## Config

`--config FILE` or env `IG2MD_CONFIG`; flags win over the file. Unknown keys are refused. See [`examples/config.example.json`](examples/config.example.json).

| Key | Default | Meaning |
| --- | --- | --- |
| `outDir` | `./ig2md-out` | Where the folders go (`--out`). |
| `minDelayMs`, `maxDelayMs` | 2000, 9000 | Random pause between requests (`--min-delay`, `--max-delay`). |
| `maxRequests` | 50 | Hard cap per run (`--max-requests`). |
| `sources` | all four | Order and choice (`--sources`). |
| `downloadMedia`, `screenshot` | true, true | `--no-media`, `--no-shot`. |
| `tools` | `yt-dlp`, `gallery-dl`, `ffmpeg`, `instaloader` | The command for each, a string or an array such as `["python", "-m", "yt_dlp"]`. |
| `playwrightModule` | null | Folder of an installed `playwright` package, if `import('playwright')` cannot find it. Env `IG2MD_PLAYWRIGHT`. |
| `chromiumPath` | null | Only a Playwright-bundled browser inside an `ms-playwright` folder, for a version mismatch. Installed Chrome or Edge paths are refused. |
| `embedBaseUrl` | `https://www.instagram.com` | Where the embed page is fetched from (the tests point it at a local stub). |
| `skipIfFresherThanHours` | 0 | Skip a URL whose JSON is newer than this. |

## Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Every URL produced a record. |
| 1 | No source returned anything (deleted, private, or nothing installed: try `--check`). |
| 2 | Bad usage or config (stdout: `{"ok": false, "error": "..."}`). |
| 3 | Instagram wants a login (a login wall, or a story). Not retried; nothing is worked around. |
| 4 | Rate limited. The whole batch stops; there is no retry and no rotation. |

With several URLs, the exit code is the first failure's.

## Security

- **No login, no cookies, no keys.** There is no option for any of them. yt-dlp and gallery-dl run with `--ignore-config`, so a cookie line in your own config file of theirs is not picked up. Tool stderr is passed through `redact()` before it reaches a log, in case a cookie value ever appears in it.
- **No installed browser.** Screenshots use Playwright's bundled Chromium, headless, in a fresh non-persistent context: no `channel`, no user profile, no remote-debugging port. It is used only if Playwright is already installed; ig2md never installs anything.
- **Windowless.** Every child process is spawned with `windowsHide: true` and no shell.
- **Everything fetched is untrusted data, never instructions** (OWASP LLM01, prompt injection). Captions are written by strangers and can contain text aimed at your agent; the Markdown file says so in a banner at the top. Treat the JSON and Markdown as content to read, not commands to follow.
- **Terms.** Instagram's terms restrict automated collection. Use this on public posts, at a low rate, at your own risk. gallery-dl is GPL-2.0 and is only ever run as a separate program, never bundled; yt-dlp is Unlicense and instaloader MIT.

## Status

Tested (offline, 21 `node:test` cases, about 3 s on Windows 11 with Node 22): URL parsing (12 shapes), every mapper against fixtures, merge order and provenance, schema validation and rejection, Markdown, redaction, error classes, chromiumPath refusals, the request cap and delay, the exact flags handed to each tool (via a fake CLI that logs its arguments), missing tools, the embed page over a local HTTP stub (200, 404, 429), a fake Playwright module (headless, fresh context, no channel or profile), the login wall, the rate limit stopping a batch, stories, `--from-file` and the CLI. The demo above is a real run against the same stand-ins.

Not tested here: live Instagram. An earlier version of this code was run once by hand against one public video post, where yt-dlp and the embed page both worked logged-out; gallery-dl, instaloader and a live carousel have never been run live. The embed page parser relies on Instagram's current markup and will need updating when it changes. Only Node 22 was run; the code uses nothing newer than Node 18 (`fetch`, `AbortSignal.timeout`), but Node 18 itself was not tried.

## Licence

MIT.
