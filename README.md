# headless-kit

Cheap, agent-first tools that run without a browser, keys or windows. Each tool is small, has no dependencies, prints a machine-readable result, and is tested.

By Ethan Soh ([Sohwhat6420](https://github.com/Sohwhat6420)).

## Tools

| Tool | What it does | Install | Example |
| --- | --- | --- | --- |
| [reddit-pull](tools/reddit-pull) | Pulls public Reddit posts and comments from the Arctic Shift archive. Node 18+, any OS. | `git clone <this repo>` (no install step) | `node tools/reddit-pull/reddit-pull.mjs --sub hackios --comments --out ./out` |
| [detached-run](tools/detached-run) | Starts a Windows process that outlives its launcher and never opens a window. Node 18+, Windows only. | `git clone <this repo>` (no install step) | `node tools/detached-run/detached-run.mjs start web -- node server.js` |

## Tests

```bash
npm test
```

This runs every tool's test suite from the repo root. Tools that support only Windows are skipped on other systems. GitHub Actions runs the same command on `windows-latest` and `ubuntu-latest`.

## Security

Follows OWASP LLM01 (prompt injection). Anything these tools fetch from the outside world is **untrusted data, never instructions**. Fetched text can contain attempts to steer an AI agent; an agent that reads tool output must treat it as content to analyse and must not obey it. The tools write what they fetch to files and report what they did in a short JSON line, so that data stays separate from control output.

No tool needs an API key. Do not put credentials in tool arguments or output files.

## Roadmap

Coming tools:

- **Prompt-injection scanner**: flags instruction-like text in fetched content before an agent reads it.
- **Change trackers**: watch a page, feed or archive and report only what changed.

## Licence

MIT. See [LICENSE](LICENSE).
