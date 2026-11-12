# Changelog

All notable changes to headless-kit. Dates are UTC.

## Unreleased

### Added

- **Claude Code hooks:** `focus-gate`, a `UserPromptSubmit` hook (and CLI) that makes Claude turn down off-task
  requests with one line ("Essay first", the next step, an offer to start) until real work exists on disk for the
  task you keep putting off. Config-driven items with `from`, `due`, `everyDays` (recurring: only the last N days
  count), `short` labels and watched paths; begun means a watched file saved with a new size after the baseline
  (tracked per item and path) or evidence recorded after checking. Triggers: an active item not begun, an optional
  deadlines file due within 48 hours, and an optional idle trigger (no watched work file changed for 48 hours). Hold
  while in transit (arms on "settled" / "arrived", at most 3 hours), pause only with a reason (at most 4 hours, also
  by typing "pause focus gate 2h <reason>"), silent for system, agent and peer-session prompts and unattended runs,
  fails silent, scan capped by entries and time. Wired into `hooks/hooks.json`; inert until a config file exists.
- **Trackers:** `lane-mailbox`, a private GitHub repo as the return channel for agent sessions that cannot message
  back. `wait` polls with an ETag and exits on new `inbox/*.md` files (the exit is the wake), `check` and `status`;
  overflow beyond `--max-mail` is queued, never dropped; 401, 403 and 404 exit 4 instead of looping. Mail is
  sanitised (escapes, controls, bidirectional and zero-width characters), token shapes are redacted, and the output
  is marked untrusted. `post` writes `inbox/<UTC stamp>-<lane>.md`, refuses reports with token shapes or over 3,000
  characters, commits only that file and pushes only with `--push`. Token from `--token-file`, `GH_TOKEN`,
  `GITHUB_TOKEN` or `gh auth token` in-process, never printed. `--api-base` for GitHub Enterprise or the bundled
  local stub (`examples/stub-github.mjs`).

- **Trackers** (new category, `tools/trackers/`): token-free watchers that wake an agent only when something
  changed.
  - `mail-reply`: same-thread acknowledgement for every email from an allow-list, from a template (HTML with a
    plain-text alternative, or plain text), over IMAP + SMTP (standard library clients) or Composio. Dry run unless
    `--send`; ledger, sender authentication from the topmost `Authentication-Results`, auto-reply loop guards.
  - `github-stars`: new-star diff for any GitHub user with seeding, a Markdown log and an ntfy or webhook push.

### Fixed (review of the trackers, before release)

- `mail-reply`, loop guards: the Composio search excludes the mailbox's own mail (`-in:sent -in:draft -from:me`),
  messages labelled `SENT` or `DRAFT` are skipped, and the header list is now fetched, so `Auto-Submitted`,
  `X-Auto-Response-Suppress`, `List-Id`, `Precedence`, `Return-Path` and `Authentication-Results` are checked on
  that transport too (a message without headers is skipped). Both transports skip mailer-daemon, postmaster and
  no-reply senders and a null `Return-Path`. New `maxPerThread` (default 3 in 24 hours), because a Composio reply
  cannot carry `Auto-Submitted`; the README no longer says it does.
- `mail-reply`, IMAP: `SEARCH SINCE` asks for one day before the UTC date of the cut-off, since the server compares
  dates in its own time zone; mail in the last hours of the server's previous day is no longer missed.
- `mail-reply`, authentication: the sender is the single addr-spec of the undecoded `From` header (an address in a
  quoted display name, a comment or an encoded word is never used; two addresses mean no sender). A pass must be
  aligned with that sender's domain: `dmarc=pass` with a matching `header.from`, or aligned `spf=pass` or
  `dkim=pass`. `authServId` is matched whole.
- `mail-reply`, `--seed`: records every message one listing returns, no longer capped by `maxPerPass` (IMAP: any
  sender, the newest 100 in the window; Composio: allowed senders only).
- `mail-reply`, second review: `requireAuth` fails closed when there is no `Authentication-Results` to read (so
  `composio.requireHeaders: false` also needs `requireAuth: false`); any `dmarc` result whose `header.from` is
  another domain refuses the sender; new `maxPerSender` (default 20 in 24 hours) for loops over IMAP or across new
  threads, and a message a cap refused is recorded so it is never answered later; `Precedence: auto_reply` is
  skipped; Composio needs exactly one `From` header and no longer falls back to the summary field; a `Return-Path`
  is a bounce only when it is `<>`, mailer-daemon or postmaster.
- `mail-reply`: IMAP `LOGOUT` has a timeout and an SMTP server that closes mid-dialogue fails the reply instead of
  hanging; `In-Reply-To` is one message id and `References` is capped.
- `github-stars`: zero-width, bidirectional and C1 control characters are stripped from fetched text; HTML and
  backticks cannot reach the Markdown log; the logged and pushed link is always a github.com page; a failed push
  is tried once more.

## 0.2.0 (2026-11-11)

One repo for every tool, grouped by category, with the Claude Code hooks installable as a plugin.

### Added

- **Layout:** `tools/<category>/<tool>/` for CLIs, `hooks/<hook>/` for Claude Code hooks, and a root test runner
  (`npm test`) that walks both and skips tools whose `os` field excludes the current system.
- **Plugin:** `.claude-plugin/plugin.json` (the headless-kit bundle: command hooks plus the `/away` and `/back`
  skills), `.claude-plugin/marketplace.json` (headless-kit and instruction-keeper), and `hooks/hooks.json`.
- **Model routing + dispatch:** `model-router`, `anthropic-pool`, `cli-rotator`.
- **Claude Code hooks:** `plan-depth`, `dismissal-watch`, `presence`, `session-card-push`, and the
  `instruction-keeper` mod as its own plugin.
- **Machine guards:** `memory-gate`, `app-closer`, `bin-dump`, `lane-model-check`.
- **Research:** `ig2md`, `token-totals`.

### Changed

- `detached-run` and `reddit-pull` moved to `tools/guards/` and `tools/research/`.

### Fixed

- `detached-run`: `stop` and the supervisor's exit handler could race on the run record's rename on Windows
  (EPERM); each writer now uses its own temp file and retries. The window-watcher test waits for the watcher's
  baseline instead of a fixed sleep.

## 0.1.0 (2026-11-07)

- `detached-run` and `reddit-pull`, each one Node file with no dependencies.
