# app-closer

[![test](https://github.com/Sohwhat6420/headless-kit/actions/workflows/test.yml/badge.svg)](https://github.com/Sohwhat6420/headless-kit/actions/workflows/test.yml)
![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)
![node: 18+](https://img.shields.io/badge/node-18%2B-green)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

**Close a list of idle apps you have approved, when memory commit charge is high, and nothing else.** One Node file, zero dependencies. Reports by default; `--close` acts.

**Why it's interesting:** when an agent's build or a fleet of subagents needs memory, the easy fix is "kill something", and an agent left to choose will eventually kill the wrong thing. `app-closer` turns that into a whitelist you wrote: each app is a rule (how to recognise its processes, and what keeps it open: its window is in front, a game it launched is running, a busy command says containers are up, it has not been idle for five minutes yet). Only processes that match a rule are ever stopped; OS-critical processes, a `never` list, and the tool's own process and ancestors are untouchable. It remembers what it closed, so an app the OS restarts at once is left alone instead of being killed in a loop, and it re-checks after every close to say what really happened.

<p align="center"><img src="docs/demo.svg" alt="Terminal: against a recorded process list at 88% committed, app-closer reports six apps: a chat client kept until idle for 5 minutes, a game launcher kept because a game is running, a container app kept because its recorded busy check says containers are running, and a dev server, a notes app and a media player closable. With --close the last three are CLOSED (simulated). A JSON line follows" width="100%"></p>

### Quick start (Node 18+, nothing to install)

```bash
git clone https://github.com/Sohwhat6420/headless-kit && cd headless-kit/tools/guards/app-closer
node app-closer.mjs --config examples/config.example.json --snapshot examples/snapshot.example.json --close --explain
node --test   # 19 tests, about 17 s; the one real close stops a child process the test itself started
```

<details>
<summary><b>The test suite, real output</b></summary>
<br>
<img src="docs/test-run.svg" alt="19 of 19 tests pass: matching, protected processes, foreground, unlessRunning and unlessChildRunning, orphanOnly and unlessParent, busy checks, idle minutes, respawn holds, refused kills, a reused PID never signalled, already-gone processes, protected descendants, a reused parent PID under killTree, report mode writing nothing, the CLI with recorded snapshots, bad config, and a real close of the test's own child while a second child survives" width="100%">
</details>

It is part of **[headless-kit](../../../README.md)**, a set of small, agent-first, windowless tools: output as a JSON line, standard library only.

## Usage

```bash
node app-closer.mjs --config apps.json                      # report: what is closable now and why (closes nothing)
node app-closer.mjs --config apps.json --close              # close them, only at or above closeAtPct
node app-closer.mjs --config apps.json --close --ignore-memory   # close them at any memory level
node app-closer.mjs --config apps.json --watch 60 --close   # check every watchIntervalSec for 60 minutes
node app-closer.mjs --config apps.json --snapshot procs.json [--snapshot-after after.json] [--close]
```

| Option | Meaning |
| --- | --- |
| `--config <file>` | The app rules. Or env `APP_CLOSER_CONFIG`. Required. |
| `--close` | Close the closable apps. Without it, nothing is ever stopped. |
| `--ignore-memory` | With `--close`: act at any memory level. |
| `--watch <minutes>` | Repeat every `watchIntervalSec` for this long, one JSON line per check. |
| `--snapshot <file>` | Use a recorded process list instead of the machine's ([example](examples/snapshot.example.json)). **Kills are simulated**, no `busyCheck` command is run (an optional `busy` map records each answer by app name; an app with no answer is kept), and the real state file and log are neither read nor written. |
| `--snapshot-after <file>` | The list to verify simulated kills against (default: everything gone). |
| `--explain` | Also print a table on stderr. |

State and log live in `APP_CLOSER_DIR` (default `~/.app-closer/`): `state.json` (close times, idle clocks, holds) and `app-closer.log` (one line per real close). Only real `--close` runs write them; a report run reads the state and changes nothing on disk (a report `--watch` keeps its idle clocks in memory).

stdout is one JSON object per check:

```json
{"at":"2026-11-11T09:00:00.000Z","mode":"close","simulated":false,
 "memory":{"pct":86.2,"usedBytes":29600000000,"limitBytes":34359738368,"source":"win32-cim"},
 "gate":{"closeAtPct":80,"open":true,"ignoreMemory":false},
 "rows":[{"app":"Orphaned dev server","pids":[5120],"mb":95,"closable":true,"why":"nothing keeps it open","verdict":"CLOSED"}]}
```

Row verdicts: `closable` / `kept` (report), `CLOSED`, `RESPAWNED (n back)`, `PARTLY REFUSED`, `KILL REFUSED`, `KILLED (unverified)` (the re-check failed), `ALREADY GONE` (it exited on its own before the kill), `SKIPPED (no fresh process list)` (the list could not be read again right before the kill, so nothing was stopped), `kept (memory under N%)`, `kept (memory unreadable)`.

## Config reference

See [`examples/config.example.json`](examples/config.example.json); the apps in it are placeholders. Every regex is case-insensitive.

| Key | Default | Meaning |
| --- | --- | --- |
| `closeAtPct` | 80 | `--close` acts only at or above this commit-charge percentage (unless `--ignore-memory`). |
| `verifyDelayMs` | 5000 | Wait this long after closing, then read the process list again. |
| `watchIntervalSec` | 60 | Interval for `--watch`. |
| `foregroundUnknown` | `keep` | Where the window in front cannot be read (Linux, macOS), `keep` treats every `skipIfForeground` app as possibly in front; `ignore` skips that check. |
| `respawn.windowMin` | 10 | An app back within this many minutes of a close is being restarted by the OS... |
| `respawn.repeatCloses`, `respawn.repeatWindowMin` | 3, 60 | ...as is one closed this many times within this window... |
| `respawn.holdMin` | 120 | ...so it is held (left alone) for this long. |
| `refusedRetryMin` | 30 | After a refused kill, wait this long before trying that app again. |
| `never` | `[]` | Process-name regexes that are never stopped, whatever the rules say. |
| `apps` | `[]` | The app rules (below). |

Each app:

| Key | Meaning |
| --- | --- |
| `app` | A unique display name. |
| `match` | How to recognise its processes: `name`, `path`, `commandLine` (arrays of regexes; every field given must match, any regex within a field), plus `notPath`, `notCommandLine` to exclude. At least one of `name`, `path`, `commandLine`. |
| `skipIfForeground` | Default `true`: kept while any of its processes, or a process whose parent chain leads to one of them, owns the window in front (Windows). |
| `unlessRunning` | `[{name?, path?, commandLine?, notPath?, reason}]`: kept while any process matching one of these runs (a game from its library, say). |
| `unlessChildRunning` | `{except: [name regexes], reason}`: kept while any child of its processes runs that is not itself one of the app's processes and not in `except` (a launcher with a game open). |
| `busyCheck` | `{argv: [...], busyWhen: "output" \| "exit0" \| "nonzero", reason, timeoutMs}`: run this command (no shell, hidden window); kept while it says busy. If it cannot run, or fails with `busyWhen: "output"`, the app is **kept**. |
| `idleMinutes` | Closable only after every other check has passed for this many minutes in a row (across runs; use `--watch` or a scheduler). Any keep resets the clock. |
| `orphanOnly` | Only processes whose parent is gone (a dev server left behind by a closed terminal). |
| `unlessParent` | Skip processes whose parent's name matches (the same binary started from a shell is yours, not the desktop app). |
| `killTree` | Default `false`: stop only the matched processes. `true` also stops their child processes, which may not match the rule; a protected descendant (OS-critical, `never`, this process or its ancestors) and everything under it is never stopped, nor a process older than the PID it names as its parent (that parent number was reused). |
| `respawnHold` | Default `true`. `false` turns the respawn hold off for this app (for one you reopen by hand often). |

## How it decides

1. **Read the machine.** Windows: one hidden PowerShell (`windowsHide`) lists processes and the commit charge through CIM and asks `user32` which window is in front. Linux: `/proc`, and the same commit reading as [`memory-gate`](../memory-gate/). macOS: `ps` and `sysctl` (approximate memory reading; no foreground).
2. **Protect.** Remove OS-critical names (`System`, `csrss`, `lsass`, `svchost`, `explorer`, `dwm`, `init`, `systemd`, `launchd`, `WindowServer`, `sshd` and more), the `never` list, and this process with all its ancestors.
3. **Match.** Each app takes the remaining processes that match its rule (then `orphanOnly`, `unlessParent`).
4. **Keep checks,** first that applies wins: respawn hold, recent refusal, window in front, unknown foreground (`foregroundUnknown: keep`), `unlessRunning`, `unlessChildRunning`, `busyCheck`, `idleMinutes`.
5. **Gate.** `--close` acts only at or above `closeAtPct`, or with `--ignore-memory`. An unreadable memory reading never opens the gate on its own.
6. **Close and verify.** Right before stopping anything, read the process list again and stop only the PIDs that still have the same name, path and command line and are still unprotected (a PID the OS has given to another process in the meantime is left alone; with no fresh list, nothing is stopped). Windows: `taskkill /PID <pid> /F`, one PID at a time; with `killTree` the tool lists the descendants itself instead of using `/T`, so protected ones are skipped. Linux and macOS: the same identity is checked once more just before `SIGTERM`, then `SIGKILL` after 3 s. Then wait `verifyDelayMs`, read again, and record `CLOSED`, `RESPAWNED`, `ALREADY GONE`, `PARTLY REFUSED` or `KILL REFUSED`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done (a report, or every close went through). With `--watch`, the worst code of any check (2, then 1, 4, 3), and a 2 stops the watch. |
| 1 | The check failed: no process list could be read, or with `--close`, the fresh one right before the kills could not (`SKIPPED`; nothing was stopped). |
| 2 | Bad usage or config (stdout: `{"error": "..."}`). |
| 3 | `--close` kept closable apps because memory is under `closeAtPct` (or unreadable). |
| 4 | A kill was refused (`KILL REFUSED` or `PARTLY REFUSED`). |

## Security

- **It stops processes; that is the risk.** Only processes matching a rule you wrote, never protected ones, never itself or its parents. Start in report mode (the default) and read the table before adding `--close`. Use `--snapshot` to try a config against a recorded list with no real kills.
- **`busyCheck` runs a command from your config.** It is run with no shell, a hidden window and a timeout, but it is still code: treat the config file like a script, and keep it where only you can write.
- **No keys, no network.** Process command lines can contain secrets (tokens passed as arguments); the tool matches against them but prints only app names, PIDs, sizes and reasons, and the log holds the same.
- **Process names and command lines are untrusted data, never instructions** (OWASP LLM01, prompt injection). Any process can name itself anything; an agent reading this tool's output must not obey text from it.

## Status

Tested (19 `node:test` cases, about 17 s on Windows 11 with Node 22): matching, protected processes, foreground handling, every keep check, idle clocks, respawn holds, refusals, a PID reused by another process between the list and the kill (never signalled), a process that exited on its own (`ALREADY GONE`, not a refusal), protected descendants and a reused parent PID under `killTree`, report mode writing no state, the memory gate, simulated runs (which write no state and run no busy command), bad config, and **one real close**: the test spawns two `node` children with random markers, closes the one whose marker is in the rule, and checks the other is still running. No test ever stops a process it did not start.

Not tested: Linux and macOS process listing and kills (written, not run), the Windows foreground reading inside a non-interactive service session (it reports unknown, so `foregroundUnknown` applies), and apps that respawn through a service. The respawn and idle defaults come from watching real desktop apps restart themselves; tune them to yours.

## Licence

MIT.
