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
