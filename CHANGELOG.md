# Changelog

All notable changes to headless-kit. Dates are UTC.

## Unreleased

### Added

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
- `mail-reply`, `--seed`: records every message the mailbox returns, no longer capped by `maxPerPass` or filtered
  by the allow-list or `maxAgeMin`.
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
