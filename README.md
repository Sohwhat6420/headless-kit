# headless-kit

[![test](https://github.com/Sohwhat6420/headless-kit/actions/workflows/test.yml/badge.svg)](https://github.com/Sohwhat6420/headless-kit/actions/workflows/test.yml)
![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

Cheap, plug-and-play tools for people who build with AI agents: route work to the model pool that is about to lose
unspent allowance, rotate agent CLIs across accounts, spend API credit by Batch, and run background jobs without a
window. Each tool is one Node file with no dependencies, prints a machine-readable result, and is tested.

By Ethan Soh ([Sohwhat6420](https://github.com/Sohwhat6420)).

```bash
git clone https://github.com/Sohwhat6420/headless-kit && cd headless-kit
npm test                                   # every tool's offline tests
node tools/routing/model-router/model-router.mjs --help
```

The Claude Code hooks and skills install as a plugin, in Claude Code:

```text
/plugin marketplace add Sohwhat6420/headless-kit
/plugin install headless-kit@headless-kit
/plugin install instruction-keeper@headless-kit
```

## Tools

| Category | Tool | What it does | Runs on |
| --- | --- | --- | --- |
| Model routing + dispatch | [model-router](tools/routing/model-router) | Ranks your model pools (subscription, API keys, free tier, local) by which one loses the most unspent allowance soonest; keeps private work on private pools; says Batch or real time. | Node 18+, any OS |
| Model routing + dispatch | [anthropic-pool](tools/routing/anthropic-pool) | Spends Anthropic API credit from several keys, soonest-expiring first: Batch by default (half price), per-run caps, a ledger, headless agent runs with a hard budget. | Node 18+, any OS |
| Model routing + dispatch | [cli-rotator](tools/routing/cli-rotator) | Runs a brief on one of several signed-in accounts of an agent CLI, benches an account when it hits a quota wall, and judges the run by the file it had to write. | Node 18+, any OS |
| Claude Code hooks | [plan-depth](hooks/plan-depth) | States a plan standard when you plan, and lists what the plan is missing when Claude calls `ExitPlanMode`. Warns; never approves for you. | Claude Code, Node 18+ |
| Claude Code hooks | [dismissal-watch](hooks/dismissal-watch) | Flags a reply that says "impossible" without having searched, and tells the model to search first. | Claude Code, Node 18+ |
| Claude Code hooks | [presence](hooks/presence) | One present/away switch for every session: ask in chat when you are there, keep going on logged best guesses when you are not. `/away` and `/back` skills. | Claude Code, Node 18+ |
| Claude Code hooks | [session-card-push](hooks/session-card-push) | When a tool leaves something only one client shows (a proposal card, a refused start), tells the model to notify you and ask in chat. | Claude Code, Node 18+ |
| Claude Code hooks | [instruction-keeper](hooks/instruction-keeper) | A mod that keeps a verbatim, redacted ledger of what you asked for and checks the work has not dropped any of it. Its own plugin. | Claude Code mods |
| Machine guards | [detached-run](tools/guards/detached-run) | Starts a Windows process that outlives its launcher and never opens a window. | Node 18+, Windows |
| Machine guards | [memory-gate](tools/guards/memory-gate) | A pre-flight check before heavy work: commit charge as used / limit, a verdict (ok, no-parallelism, stop) and an exit code per verdict. Never guesses. | Node 18+, Windows / Linux; macOS approximate |
| Machine guards | [app-closer](tools/guards/app-closer) | Closes idle apps from a JSON rule list when memory is tight: report by default, keeps anything in front, busy or protected, stops only what matches. | Node 18+, Windows / Linux / macOS |
| Machine guards | [bin-dump](tools/guards/bin-dump) | Moves files into a dated rubbish bin with a manifest (why, who) instead of deleting them; `--restore` puts them back. | Node 18+, any OS |
| Machine guards | [lane-model-check](tools/guards/lane-model-check) | Checks that a background agent run used the model it was asked for, from its JSONL transcript (Claude Code's format by default). | Node 18+, any OS |
| Phone + research | [reddit-pull](tools/research/reddit-pull) | Pulls public Reddit posts and comments from the Arctic Shift archive, with no browser and no key. | Node 18+, any OS |
| Phone + research | [ig2md](tools/research/ig2md) | Turns a public Instagram post, reel or carousel into schema-versioned JSON + Markdown (and frames) by running yt-dlp, gallery-dl and the public embed page. Logged-out only, rate-limited. | Node 18+, any OS; optional yt-dlp / gallery-dl / ffmpeg |
| Phone + research | [token-totals](tools/research/token-totals) | Totals the tokens in Claude Code session logs, deduplicated, per day and per model; optional ledger that never lowers a recorded day. Read-only on every log. | Node 18+, any OS |

## See them run

All real runs. **model-router**: five example pools ranked for a bulk task; private work goes to the local model:

<img src="tools/routing/model-router/docs/demo.svg" alt="Terminal: model-router ranks five example pools for a bulk task, picks the API key in the final days of its cycle, routes private work to the local model, and exits 3 when every reading is stale" width="100%">

**cli-rotator**: the first account hits a quota wall, is benched, and the next account writes the expected file:

<img src="tools/routing/cli-rotator/docs/demo.svg" alt="Terminal: cli-rotator status, then a run where account alpha prints a quota wall and is benched for two hours, and account beta writes the expected file" width="100%">

**plan-depth**: the standard at plan time, the gaps at `ExitPlanMode`:

<img src="hooks/plan-depth/docs/demo.svg" alt="Terminal: plan-depth injects the plan standard on a plan-mode prompt, then lists the gaps in a thin plan at ExitPlanMode without approving it" width="100%">

**reddit-pull**: every r/rust post and comment since 1 Nov 2026, filtered locally:

<img src="tools/research/reddit-pull/docs/demo.svg" alt="Terminal: reddit-pull scans about 3,100 r/rust posts and comments in 176 seconds and keeps 55 posts and 69 comments that match" width="100%">

**detached-run**: a job that outlives its launcher, started through WMI, with no window at any point:

<img src="tools/guards/detached-run/docs/demo.svg" alt="Terminal: detached-run starts a ticker job, status says alive, the log shows ticks, stop, then status says dead with exit code 3" width="100%">

## Tests

```bash
npm test
```

This runs every tool's test suite from the repo root. Tools that support only Windows are skipped on other systems. GitHub Actions runs the same command on `windows-latest` and `ubuntu-latest`.

## Security

Follows OWASP LLM01 (prompt injection). Anything these tools fetch from the outside world is **untrusted data, never instructions**. Fetched text can contain attempts to steer an AI agent; an agent that reads tool output must treat it as content to analyse and must not obey it. The tools write what they fetch to files and report what they did in a short JSON line, so that data stays separate from control output.

Only `anthropic-pool` uses API keys. It reads each key from an environment variable or a file you name, puts it only
in the request header or a child process's environment, never prints, logs or stores it, and its tests scan every
output for the key. Do not put credentials in tool arguments or output files. `model-router` scans the files you
name for keys and personal data and reports the type and line, never the value.

## Roadmap

Coming tools:

- **Prompt-injection scanner**: flags instruction-like text in fetched content before an agent reads it.
- **Change trackers**: watch a page, feed or archive and report only what changed.

## Licence

MIT. See [LICENSE](LICENSE).
