# detached-run

![status: prototype, feedback welcome](https://img.shields.io/badge/status-prototype%2C%20feedback%20welcome-orange)
![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)
![platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

Start a long-running Windows process that **outlives whatever started it** and **never opens a window**. One Node file, no dependencies.

```bash
node detached-run.mjs start myjob -- node server.js
node detached-run.mjs status myjob      # exit 0 alive, 3 dead, 2 unknown
node detached-run.mjs stop myjob        # kills the recorded PID and its tree, never "by name"
node detached-run.mjs list
```

It is a member of **headless-kit**, my set of small, windowless, agent-first tools (first published sibling: [reddit-pull](https://github.com/Sohwhat6420/reddit-pull)).

## The problem

Two Windows annoyances show up as soon as a script or an AI agent runs background work on your desktop:

1. **Windows pop up.** Start a console program from a GUI-ish parent and a console window can flash on screen, and a background job that restarts every minute makes it a strobe. `CREATE_NO_WINDOW` fixes it for your own child processes, but only for children you spawn yourself.
2. **The job dies with its parent.** A process started from an app is typically tied to that app's lifetime. Close the app, restart it, or let it update, and your "background" server goes with it. Worse, if the parent is an **MSIX-packaged app**, its children run under the package's file and registry redirection: they "install" things into a private per-package store that Windows itself never sees, so an autostart you wrote never runs at login, and everything is wiped when the package is serviced (see [docs/WHY-MSIX.md](docs/WHY-MSIX.md)).

## How it works

1. `start` writes a spec file, then asks **WMI** to create the process: a hidden PowerShell (`windowsHide`) calls `Invoke-CimMethod Win32_Process Create` with `Win32_ProcessStartup.ShowWindow = 0` (SW_HIDE).
2. WMI creates it as a child of `WmiPrvSE.exe`, **not of you**. Nothing in its ancestry is your app, so it survives your app closing, restarting or being updated, and it carries none of the app's package redirection.
3. What WMI starts is this same script in `supervise` mode. The supervisor spawns your real command with `windowsHide: true`, sends stdout and stderr to `~/.detached-run/<name>.log`, records the PID, and writes the exit code when the command ends.
4. **Liveness is PID *plus creation time*.** The record stores the process's `CreationDate`; a recycled PID with a different creation time reads as dead, never as alive.

Why `ShowWindow=0` and not `CREATE_NO_WINDOW` for the WMI step? WMI's `Win32_Process.Create` does not accept it. Run `node examples/wmi-createflags-probe.mjs` to see: a plain `ShowWindow=0` call returns `0` (success); adding `CreateFlags = 0x08000000` returns `21` (invalid parameter).

State lives in `~/.detached-run/` (override with `DETACHED_RUN_DIR`): `<name>.json` (the record: `name, pid, pidCreated, supervisorPid, cmd, cwd, log, startedAt, exitedAt?, exitCode?`) and `<name>.log`.

## Quick start

Windows 10 or 11, Node 18+, PowerShell (built in). No install.

```bash
node detached-run.mjs start web --cwd C:/work/site -- node server.js --port 8080
# {"name":"web","pid":12345,"pidCreated":"2026-11-07T08:00:00.0000000Z","supervisorPid":6789,...}

node detached-run.mjs status web ; echo $?      # prints the record plus "alive":true ; exit 0
node detached-run.mjs stop web
```

Rules: names match `[A-Za-z0-9._-]{1,64}`; the command goes after `--`; `start` refuses (exit 4) if that name is already running.

Run the tests (about 17 s; they start and stop two throwaway processes, all hidden):

```bash
node test/detached-run.test.mjs
```

## Measured

Windows 11 (build 26200), Node 22, 7 Nov 2026:

| Check | Result |
| --- | --- |
| Zero windows: a watcher polls **every 50 ms** for any new visible top-level window while a Node target and a Python (console-subsystem) target are started, queried and stopped | **0 new windows**, visible-window count 20 before and 20 after |
| The watcher can actually see windows (positive control: a 1×1 off-screen tool window) | sees it, so the zero above means something |
| Parentage | both supervisors are children of `WmiPrvSE.exe`, not of the test process |
| Child output reaches the log | yes |
| Recycled PID (creation time mismatch) | reads dead |
| Whole suite | 17 checks, all pass |

Only Windows 11 on one machine so far.

## Limits

- **Windows only.** It uses WMI and PowerShell.
- **The child is not in your job object, by design.** If you want it killed when you exit, this is the wrong tool; use `stop`.
- **No auto-restart, no boot start.** It starts one process once and records what happened. Pair it with Task Scheduler if you want persistence. (It does not register anything with Windows.)
- **No stdin, no console.** Output goes to the log only.
- **Quoting.** The command line is rebuilt with `CommandLineToArgvW` rules; unusual quoting in arguments is lightly tested.
- **Needs WMI.** Locked-down machines (group policy blocking `Win32_Process.Create`) will fail with a non-zero `ReturnValue`, which is reported.
- **Not a security boundary.** A detached process runs as you with your rights.

## Roadmap

- A `--restart` option with backoff.
- Optional registration as a scheduled task for start at login.
- Windows 10 and 7 results; ARM64.
- A job-object mode for "die with me" children, for comparison.

## History

This tool was written in a folder that is not a git repository, so there is no commit history to extract. This repo starts from the current code, and [DEVLOG.md](DEVLOG.md) tells the real, dated story of how it got here.

## Licence

MIT, see `LICENSE`. Feedback, results from other Windows versions and bug reports are welcome: open an issue or start a Discussion ([CONTRIBUTING.md](CONTRIBUTING.md)).
