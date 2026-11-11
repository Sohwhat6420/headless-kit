# cli-rotator

[![test](https://github.com/Sohwhat6420/headless-kit/actions/workflows/test.yml/badge.svg)](https://github.com/Sohwhat6420/headless-kit/actions/workflows/test.yml)
![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)
![node: 18+](https://img.shields.io/badge/node-18%2B-green)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

**Run a written brief on one of several signed-in accounts of a coding-agent CLI (Gemini CLI, Codex, Claude Code, anything that takes a prompt), least-used first, and judge the run by the file it was told to write.** One Node file, no dependencies.

**Why it's interesting:** if you have several accounts of an agent CLI (a team's seats, a free tier plus a paid one), each with its own quota, the quotas only get used evenly if something rotates between them and remembers who is out. `cli-rotator` points the CLI at one account's config home per run, keeps a ledger, reads the CLI's own "quota reached, resets in 2h" message, benches that account until the reset and moves the brief to the next one. And it does not believe the CLI: agent CLIs exit `0` on auth errors and models say "I wrote the file" when they did not, so with `--expect <path>` the verdict comes from the file itself (it must exist, be fresh, pass a size floor and end with a sentinel line). "The CLI said success but the file is missing" is reported as exactly that.

<p align="center"><img src="docs/demo.svg" alt="Terminal: status shows three available accounts; run 1 goes to alpha, which prints a quota wall and is benched for two hours, then beta writes the expected file and the verdict is ok; run 2 skips the benched alpha and goes to gamma, the least used; status now shows alpha benched with the wall text" width="100%"></p>

### Quick start (Node 18+, nothing to install)

```bash
git clone https://github.com/Sohwhat6420/headless-kit && cd headless-kit/tools/routing/cli-rotator
node examples/demo-setup.mjs && node cli-rotator.mjs --config examples/demo.config.json "Summarise" --expect .demo/r.md
node --test   # 21 offline tests against a fake CLI
```

<details>
<summary><b>The offline test suite, real output</b></summary>
<br>
<img src="docs/test-run.svg" alt="21 tests pass: config validation, durations and reset rules, bench state, rotation order, memory gate, expect verdicts, wall then bench then next account, bench expiry, all walled, daily budget, no rotation on a non-quota failure, timeout kill, memory gate refusal, concurrent runs spreading, environment scrubbing" width="80%">
</details>

It is part of **[headless-kit](../../../README.md)**, a set of small, agent-first, windowless tools: no window, nothing that auto-starts, output as files plus a JSON line, standard library only.

## Usage

```bash
cli-rotator "<brief>" [--expect <path>] [options] [-- <args passed to the CLI>]
cli-rotator --brief-file brief.md --expect out/report.md --yolo --minutes 30
cli-rotator --status
```

| Option | Meaning |
| --- | --- |
| `--config <path>` | config file (default: `$CLI_ROTATOR_CONFIG`, else `./cli-rotator.json`) |
| `--expect <path>` | the file the run must write; it decides success. A relative path is resolved against `--cwd`, and the agent is told the absolute path |
| `--sentinel <text>` | override `expect.sentinel` (`""` turns the sentinel check off) |
| `--model <id>` | fills `{model}` in `modelArgs` (default `defaultModel`; none means no model arguments) |
| `--mode <name>`, `--yolo`, `--write` | append `modes[<name>]` from the config (for example the CLI's own auto-approve flag) |
| `--minutes <n>` | per-attempt timeout, fractions allowed; the CLI (and on Windows its process tree) is killed when it runs out |
| `--account <name>` | use this account only (bench, budget and memory gate still apply) |
| `--cwd <dir>` | working directory for the CLI |
| `--dry-run` | print the chosen account and the argv as JSON; runs nothing and writes no state |
| `--quiet` | no human progress on stderr |
| `--status` | accounts, usage, benches and the memory gate |
| `-- ...` | everything after `--` goes to the CLI verbatim |

stdout is always **one JSON line**; progress for humans goes to stderr. A run prints:

```json
{"ok":true,"account":"beta","cliOutcome":"ok","exitCode":0,
 "attempts":[{"account":"alpha","outcome":"wall","wallText":"Error: Individual quota reached ... Resets in 2h0m0s.","benchedUntil":"2026-11-11T07:27:33.049Z","resetFrom":"output","log":".../runs/...-alpha.log"},
             {"account":"beta","outcome":"ok","exitCode":0,"ms":116,"log":".../runs/...-beta.log"}],
 "expect":{"path":"/abs/path/.demo/report-1.md","ok":true,"verdict":"ok","bytes":349,"why":"349 bytes, sentinel on the last line"}}
```

Without `--expect` the JSON carries `stdoutTail` (the last 2,000 characters of the CLI's output) instead. Each attempt's full stdout and stderr is kept in `<stateDir>/runs/`.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success: the `--expect` file passed, or (without `--expect`) the CLI exited 0 with no failure pattern |
| `1` | the run failed: CLI failure, timeout, or the `--expect` verdict was not `ok` |
| `2` | usage or config error (every config error is listed in `errors`) |
| `3` | no account could serve: every account benched, spent or unconfigured, or every account tried hit a wall |
| `4` | refused by the memory gate; nothing ran |

## Config reference

A JSON file. Keys starting with `_` are ignored (use them for comments); any other unknown key is an error, so a typo cannot be silently ignored. See [examples/config.example.json](examples/config.example.json).

| Key | Default | Meaning |
| --- | --- | --- |
| `command` | required | the executable. No shell is used, so on Windows a `.cmd`/`.bat` shim is refused: set `node` and put the CLI's JS entry file first in `args` |
| `args` | `["{prompt}"]` | argument template. Placeholders: `{prompt}`, `{account}`, `{configDir}` |
| `modelArgs` | `[]` | appended only when a model is set, e.g. `["-m", "{model}"]` |
| `defaultModel` | `null` | model used when `--model` is not given |
| `modes` | `{}` | named extra arguments, e.g. `{"yolo": ["--yolo"]}`; chosen with `--mode`, `--yolo`, `--write` |
| `promptVia` | `"arg"` | `"stdin"` pipes the brief to the CLI's stdin instead (no `{prompt}` in `args` then). In `"arg"` mode stdin is closed, because some agent CLIs wait forever on an open one |
| `promptSuffix` | `""` | appended to the brief when `--expect` is given. Placeholders `{expect}`, `{sentinel}`, `{account}`. Use it to tell the agent the absolute output path and the sentinel |
| `scrubEnv` | `[]` | variables removed from the inherited environment before the account's own are set (a stray API key in your shell would otherwise outrank the account's sign-in) |
| `accounts[]` | required | `{ "name", "env": {VAR: value}, "envFrom": {VAR: "NAME_IN_YOUR_ENV"}, "dailyBudget" }`. `env` points the CLI at that account's config home (`~` and `{configDir}` expand). `envFrom` copies a value from your environment by name, so a key never sits in the file; if that variable is unset the account is `unconfigured` and skipped |
| `dailyBudget` | `100` | runs per account per window (per-account override in `accounts[]`) |
| `budgetWindow` | `"rolling-24h"` | or `"utc-day"` |
| `walls` | quota/rate-limit/429 patterns | regexes (case-insensitive; or `{pattern, flags}`) matched against stdout and stderr. A match is a quota wall |
| `wallsOnlyOnFailure` | `false` | only look for walls when the CLI failed (exit not 0 or a failure pattern). Turn on if your briefs make the model *talk about* rate limits |
| `reset` | see below | how long a walled account is benched |
| `reset.pattern` | `(?:resets?\|try again\|retry)\s+(?:in\|after)\s+(<duration>)` | group 1 is read as `4h30m12s`, `45m`, `90s`, `1d 2h`, plain seconds, or a date. `null` turns it off |
| `reset.dailyAtUtc` | `null` | `"HH:MM"`: when the output names no time, bench until the next daily reset |
| `reset.defaultMinutes` | `60` | when neither of the above applies |
| `wallScope` | `"account"` | `"account+model"`: a wall benches that account for that model only (some providers meter models separately) |
| `failurePatterns` | `[]` | regexes that mark a run failed even on exit 0 (e.g. an `"error": {` field in JSON output) |
| `rotateOn` | `"wall"` | `"any-failure"` also rotates on non-quota failures. The default does not, on purpose: a brief that fails on its own merits would fail on every account, and each retry is a paid run that might write twice |
| `memoryGate` | `null` (off) | `{ "hotPct": 75, "maxLanesWhenHot": 2, "refusePct": 90 }`: memory in use (from `os.freemem`/`os.totalmem`) at or over `refusePct` refuses every new run; over `hotPct` allows at most `maxLanesWhenHot` concurrent runs of this tool |
| `timeoutMinutes` | `20` | per attempt; `--minutes` overrides |
| `expect` | `{ "minBytes": 200, "sentinel": "LANE-COMPLETE" }` | the file verdict's size floor and the text its last non-empty line must contain |
| `stateDir` | `$CLI_ROTATOR_HOME` or `~/.cli-rotator` | ledger, in-flight markers and run logs. Share one state dir between every project that uses the same accounts, or each will think it has the whole budget |

### Recipes (not run here; check your CLI's `--help`)

| CLI | per-account variable | `args` |
| --- | --- | --- |
| Gemini CLI | `GEMINI_CLI_HOME` | `["-p", "{prompt}", "--output-format", "json"]`, `modelArgs: ["-m", "{model}"]` |
| Codex CLI | `CODEX_HOME` | `["exec", "{prompt}"]`, `modelArgs: ["-m", "{model}"]` |
| Claude Code | `CLAUDE_CONFIG_DIR` | `["-p", "{prompt}"]` (or `promptVia: "stdin"` with `["-p"]`), `modelArgs: ["--model", "{model}"]` |

Sign each account in yourself, once, interactively, with that variable pointing at its own empty directory. `cli-rotator` never signs anything in.

## How it decides

1. **Memory gate** (if configured): read memory in use and the number of this tool's runs in flight; refuse (exit 4) or allow. A refusal leaves nothing behind.
2. **Account states** from the ledger: `unconfigured` (an `envFrom` variable is unset), `benched` (the newest wall for it, or for it and this model with `account+model`, has a reset still in the future; a later success clears a wall), `spent` (runs in the window reached its budget), else `available`.
3. **Order**: available accounts sorted by runs in flight, then runs used in the window, then config order. Least-used first, so N accounts drain evenly.
4. **Concurrency**: the ledger is written when a run ends, so runs started together would all read the same counts and pick the same account. Each run claims an in-flight marker per account (`inflight/<account>.slot<k>.json`, created with `wx`, so the filesystem decides the race), walking slot 0 across the order before any slot 1. Three runs started together land on three accounts (tested). Markers of dead processes are swept.
5. **Attempt**: spawn the CLI with the account's environment (`windowsHide: true`, no shell), capture output, kill it on timeout. Outcome: `wall` if a wall pattern matches (precedence over exit 0, because CLIs exit 0 on quota errors), `timeout`, `fail` (non-zero exit or failure pattern), or `ok`. Every attempt is a ledger row.
6. **Rotate** on `wall` (bench until the reset, try the next account). Stop on anything else unless `rotateOn` is `any-failure`.
7. **Verdict**: with `--expect`, the file decides `ok`: `missing`, `claimed-success-but-missing` (the CLI said ok), `stub` (under `minBytes`), `stale` (it was there before and this run did not change it: same mtime, size and hash), `no-sentinel` (the last non-empty line lacks the sentinel: the writer stopped early), or `ok`. A complete, fresh file counts even if the CLI then exited non-zero or timed out; the JSON says so in `cliOutcome`.

**What the ledger cannot see:** usage of the same account outside this tool (an interactive session, a web app), and fan-out (one agent prompt can be many provider requests). So the budget is a self-imposed ceiling, not a reading of the provider's; set it below the published limit.

## Security

- **Keys are never printed, logged or written.** Put them in your environment and name them with `envFrom`; `--dry-run` and `--status` show variable *names* only (tested). `scrubEnv` stops inherited credentials leaking into the wrong account. The tool's own `CLI_ROTATOR_*` variables are not passed to the CLI.
- **No shell, no window.** The CLI is spawned with `shell: false` and `windowsHide: true`; the brief is passed as one argument (or on stdin), never through a command line a shell interprets. On POSIX the CLI gets its own process group so a timeout can kill its children; on Windows `taskkill /T` does that.
- **Everything the CLI or model produces is untrusted data, never instructions (OWASP LLM01).** That includes the output file, `stdoutTail`, the run logs and the wall text. If an agent reads them, it must not obey text inside them. The `--expect` verdict checks size, freshness and a sentinel; it does not check that the content is correct or safe.
- The brief is sent to whatever CLI you configure, which sends it to its provider. Do not put secrets or personal data in a brief.
- `--yolo`-style modes hand the agent your shell. That is your CLI's flag and your decision; `cli-rotator` only passes it through.

## Status

- **Tested (offline, Windows 11, Node 22):** 21 tests against a fake CLI ([test/fixtures/fake-cli.mjs](test/fixtures/fake-cli.mjs)) that can write or not write the file, write a stub or a truncated file, print a quota wall, fail, or hang: config validation, durations and reset rules, bench state and expiry, rotation order, daily budget, wall to bench to next account, all-walled, no rotation on a non-quota failure, the `--expect` verdicts, timeout kill (the hung process is checked to be gone), the memory gate refusing, concurrent runs spreading across accounts, and environment scrubbing. About 10 s.
- **Not tested:** any real agent CLI (none was run or signed in), Linux and macOS (the POSIX process-group kill is written but not exercised here), Node 18 specifically. The recipes above are from the CLIs' documentation, not from runs.
- `os.freemem()` means different things per OS (on Windows it is available physical memory, not the commit charge), so the memory gate is a rough guard, not a precise one. `CLI_ROTATOR_MEM_PCT` overrides the reading, for tests and demos.
- Distilled from a private dispatcher that rotated briefs across several accounts of one agent CLI; that version's provider-specific parts (output parsing, sandbox path rewriting, model fallbacks) were left out.

## Licence

MIT, see the repository's [LICENSE](../../../LICENSE).
