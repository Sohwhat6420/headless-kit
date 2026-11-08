# DEVLOG

This tool was written in a scripts folder that is not a git repository, so there is no commit history to carry over. This is the real timeline, reconstructed from my notes and file dates. Dates are real; nothing is backdated. The first commit in this repo is the code as it stood on 7 Nov 2026, generalised (default state folder is now `~/.detached-run`, internal references removed).

## 19 to 25 Oct 2026: windows everywhere

On 19 Oct, background processes an AI agent had started were flashing console windows on my desktop every few seconds while I was trying to work. The rule from then on: nothing a session starts may open a window. On 25 Oct the launcher was built to meet it.

For my own children the fix is easy: Node's `windowsHide: true`, Python's `creationflags=CREATE_NO_WINDOW`. The hard case is a process that has to **outlive** the session that started it, so it can't be that session's child.

The idea: let WMI start it. `Invoke-CimMethod Win32_Process Create` makes the new process a child of `WmiPrvSE.exe`, so it isn't yours. First attempt: pass `CREATE_NO_WINDOW` (`0x08000000`) in `Win32_ProcessStartup.CreateFlags`. WMI refused it with `ReturnValue 21` (invalid parameter; re-checked on 7 Nov 2026, see `examples/`). `ShowWindow = 0` (SW_HIDE) is accepted and is the only window control used.

The design that came out of it: WMI starts **this script in `supervise` mode**; the supervisor then spawns the real command with `windowsHide: true`, sends its output to a log and records the PID and exit code. Two hops, and the real command is never a child of the launching session.

Then it needed proof, not belief. `test/windowwatch.py` polls every 50 ms for any visible top-level window that wasn't there at the start. A positive control (a 1x1 off-screen tool window) proves it can see something. The suite starts a Node and a Python target, then checks parentage, output, status, stop and a recycled-PID guard (liveness is PID **plus** `CreationDate`, so a reused PID never reads as alive). The tests run serially on purpose: fanning out process-spawning tests is the kind of thing that made the windows flash in the first place.

## 26 Oct 2026: it turns out the parent matters for more than windows

A tray app I'd "installed" from the same agent session never started at login and kept dying. Investigation: the host was an MSIX app, and its children were running under the package's file and registry redirection. The write-up is [docs/WHY-MSIX.md](docs/WHY-MSIX.md). The point for this tool: because `detached-run` processes descend from `WmiPrvSE`, they see the real `%APPDATA%` and the real registry, and they survive the host's updates. A separate survival test (sentinel started through `detached-run`, launching session killed, sentinel still alive and outside any package) passed; it depends on that other project's helper scripts, so it isn't included here.

## 7 Nov 2026: published

Generalised for a public repo: no personal paths, a neutral default state folder, tests moved under `test/`, a README with the measured results, and this log.

## Ideas not done

- Restart with backoff; start at login through a scheduled task.
- A "die with me" mode (job objects) so the two behaviours can be compared.
