# anthropic-pool

![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)
![node: 18+](https://img.shields.io/badge/node-18%2B-green)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

**Spend Anthropic API credit from several keys, soonest-expiring credit first, with per-run caps, a JSONL ledger and Message Batches at half price by default.** One Node file, zero dependencies.

**Why it's interesting:** if you hold more than one API key with a monthly budget (a team key, a side-project key, a grant), credit that isn't spent by the reset is lost, and an unattended agent loop can run any of them dry. `anthropic-pool` sits in front of them: each call goes to the ready key whose cycle ends soonest, falls back when a key is missing, spent or busy, refuses anything whose worst case is over the cap, and books every run in a ledger. Single calls go through the Message Batches API at half price unless you say `--now`, and it switches to real-time by itself when a batch could outlive the credit. It can also run headless Claude Code (`claude --bare -p`) on a pool key, with the key only in the child's environment and a hard dollar cap. Every result is one JSON line, so an agent can drive it.

<p align="center"><img src="docs/demo.svg" alt="Terminal: status shows two pools, team with USD97.66 available resetting in 20 days and side with USD18.80 resetting in 4 days, so the next run spends side; a dry run says it would batch at half price with a worst case of USD0.01; then a real run against the local stub submits a batch, polls, and books USD0.0035 at half price" width="100%"></p>

### Quick start (Node 18+, nothing to install)

```bash
cd tools/routing/anthropic-pool && cp examples/config.example.json anthropic-pool.config.json   # set your pools and key env vars
node anthropic-pool.mjs status --human
node anthropic-pool.mjs api "Summarise this paragraph: ..." --dry-run      # every check, no network
```

<details>
<summary><b>The offline test suite, real output</b></summary>
<br>
<img src="docs/test-run.svg" alt="15 of 15 tests pass: cycle maths, pool choice and fallback, cost maths, budget refusals, dry run, the batch path end to end, the real-time path, pending batches and collect, JSONL batches, the MCP-config credential check with positive controls, print-args, the agent env allow-list, configuration errors, and a scan proving no key value appears anywhere" width="80%">
</details>

It is part of **[headless-kit](../../../README.md)**, a set of small, agent-first, windowless tools: no window, nothing that auto-starts, output as files plus a JSON line, standard library only.

## Try it with no key and no spending

`examples/stub-api.mjs` is a local imitation of the Messages and Message Batches endpoints (canned replies, fixed usage of 1,000 input and 500 output tokens):

```bash
node examples/stub-api.mjs --port 8787 &
export TEAM_ANTHROPIC_KEY=sk-ant-made-up-for-the-stub ANTHROPIC_BASE_URL=http://127.0.0.1:8787
node anthropic-pool.mjs api "hello" --pool team --poll-sec 1
```

## Usage

```text
anthropic-pool status [--human]
anthropic-pool api "<prompt>" [--model haiku|sonnet|opus|<id>] [--max-tokens 2000] [--system-file f] [--prompt-file f]
                   [--out f] [--now] [--wait-min 60] [--poll-sec 20] [--budget USD] [--pool NAME] [--tag T] [--note TEXT] [--dry-run]
anthropic-pool api --jsonl prompts.jsonl --out results.jsonl [...]
anthropic-pool agent "<prompt>" [--model ..] [--budget USD] [--cwd DIR] [--tools "Read,Grep"] [--mcp-config f.json]
                     [--timeout-min 60] [--permission-mode acceptEdits] [--print-args] [--dry-run]
anthropic-pool collect [batch_id]
```

| Mode | What it does |
| --- | --- |
| `status` | Each pool's cycle, spend, reservations, available credit, runs in flight, key present or missing, and the even-burn pace (how far spend is under or over a straight line from 0 to the budget across the cycle). Lists uncollected batches and which pool the next run would spend. `--human` prints a table instead of JSON. |
| `api` | One Messages call. **By default through the Message Batches API at half price**: it submits, polls every `--poll-sec` seconds for up to `--wait-min` minutes, then writes the text (to `--out`, or into the JSON line) and books one ledger row. If the wait runs out, the batch is recorded as pending (its worst case stays reserved) and `collect` fetches it later. `--now`, or a pool whose cycle ends within `batch_min_hours`, uses the real-time endpoint at full price. |
| `api --jsonl` | Many prompts as **one** batch. Input lines `{custom_id, prompt, system?, max_tokens?}`; output lines `{custom_id, text, error?}`. Needs the batch path, so it refuses to run real-time. |
| `agent` | A headless Claude Code run: `claude --bare -p --model <id> --max-budget-usd <cap> --output-format json`. The prompt goes on stdin, the key only into the child's environment (an allow-list of ordinary variables plus `ANTHROPIC_API_KEY`). `--mcp-config` is checked first (below). `--print-args` prints the argv and exits before any pool, key, ledger or spawn. The reported `total_cost_usd` is booked; if the CLI reports none, the cap is booked. |
| `collect` | Polls each pending batch once (or the one named); an ended one is costed at half price, booked, and marked collected. A lock file stops two collectors booking the same batch twice. |

`--dry-run` works on `api` and `agent`: every check runs (pool choice, cap, worst case, batch or real-time), no network call is made and nothing is spawned. A missing key is reported, not refused, so you can dry-run before setting keys.

### Output

One JSON object on stdout per run, for example:

```json
{"ok":true,"mode":"batch","run_id":"...","batch_id":"msgbatch_...","pool":"side","model":"claude-sonnet-5-5","requests":1,"succeeded":1,"failed":0,"cost_usd":0.0035,"cost_known":true,"price":"batch (half)","input_tokens":1000,"output_tokens":500,"out":null,"text":"..."}
```

A pending batch gives `{"ok":true,"pending":true,"batch_id":"...","collect":"anthropic-pool collect ..."}`. A refusal gives `{"ok":false,"error":"...","exit":3}`. Progress notes go to stderr.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, including a dry run and a batch recorded as pending. |
| `1` | The API call or the agent run failed (HTTP error, a failed single batch request, a non-zero agent exit, a collect error). |
| `2` | Usage or configuration error, including a rejected `--mcp-config` and a `--cwd` inside `deny_cwd`. |
| `3` | Refused for money: no pool is ready, the worst case is over the cap, or the pool already has `max_concurrent` runs in flight. |

## Configuration

`--config <file>`, else `ANTHROPIC_POOL_CONFIG`, else `./anthropic-pool.config.json`. Relative paths in it are resolved from the config file's folder. See [examples/config.example.json](examples/config.example.json); every value there is a placeholder.

| Key | Default | Meaning |
| --- | --- | --- |
| `pools[]` | required | One entry per key (below). |
| `ledger_dir` | `.anthropic-pool` | Where `ledger.jsonl` and `runs/` live. `ANTHROPIC_POOL_DIR` overrides it. |
| `models` | haiku, sonnet, opus → `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | Aliases. Only these aliases and their IDs are accepted by `--model`. |
| `default_model` | `sonnet` | Used when `--model` is omitted. |
| `price_per_mtok_usd` | none | `{ "<model id>": {input, output, cache_write, cache_read[, cache_write_1h]} }`, USD per million tokens. **There are no built-in prices**: `api` refuses a model without a complete entry, because it could not cost the run. The example file's values must be checked against the [pricing page](https://docs.claude.com/en/docs/about-claude/pricing). |
| `timezone_offset_hours` | `0` | The time zone the reset days are counted in. |
| `batch_min_hours` | `26` | A pool whose cycle ends sooner than this goes real-time (batches can take up to 24 h). |
| `base_url` | `https://api.anthropic.com` | `ANTHROPIC_BASE_URL` overrides it. Must be https; plain http is allowed only on localhost. When set to anything other than the default, it is also passed to the agent child. |
| `claude_command` | `["claude"]` | The Claude Code executable, plus any leading arguments. It is spawned directly (no shell), so on Windows point it at `claude.exe`, not an npm `.cmd` shim. |
| `deny_cwd` | `[]` | Folders an agent run must never use as its working directory. |

Each pool:

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | required | Short name, used by `--pool` and in the ledger. |
| `key_env` or `key_file` | one required | The NAME of an environment variable holding the key, or a path to a file holding it (`~` expands). The key must start `sk-ant-`; Admin keys are refused. |
| `monthly_budget_usd` | required | What this pool may spend per cycle. |
| `reset_day` | required | Day of the month the cycle starts (1 to 31; clamped to the month's last day). |
| `per_run_cap_usd` | `5` | No single run may be budgeted above this. |
| `max_concurrent` | `3` | Runs in flight at once on this key. |
| `floor_usd` | `0` | Credit that is never spent. |

Environment: `ANTHROPIC_POOL_CONFIG`, `ANTHROPIC_POOL_DIR`, `ANTHROPIC_BASE_URL`, plus whatever `key_env` names. `ANTHROPIC_POOL_NOW` (an ISO time) pins the clock used for cycles and is meant for tests.

## How it decides

1. **Which pool.** `--pool` if given. Otherwise every pool is checked: key present and well-formed, at least USD0.05 available, fewer than `max_concurrent` runs in flight. Of the ready ones, the one whose cycle **ends soonest** wins (its credit expires first); ties keep config order. If none is ready, it refuses (exit 3) and names each pool's reason.
2. **Available credit** = `monthly_budget_usd` − spend booked this cycle − `floor_usd` − reservations. Reservations are the caps of runs in flight (claim files with a live process id, dropped after 3 h) and the worst cases of uncollected batches (dropped after 30 h, past the API's 24 h expiry).
3. **The cap.** A run's budget is the smallest of `--budget`, `per_run_cap_usd` and the available credit.
4. **Batch or real-time.** Batch by default. Real-time with `--now`, or when the pool's cycle ends within `batch_min_hours`.
5. **Worst case.** Before calling, it estimates about 3 characters per input token plus every allowed output token (halved for a batch). A worst case over the cap is refused; lower `--max-tokens` or shorten the prompt.
6. **Cost.** From the response's `usage`: input, output, cache reads, and cache writes split into 5-minute and 1-hour writes, at the configured prices; batches at half. The ledger gets one row per run: time, run id, pool, mode, model, tag, note, budget, cost, whether the cost was known, token counts. No prompt text is stored.

## Security

- **Keys are never printed, logged or written.** A key is read from its env var or file, sent only in the `x-api-key` header to the configured base URL's origin (a `results_url` on any other origin is refused), or put into the `claude` child's environment. Every line the tool writes passes through a scrubber that replaces any loaded key with `[key]`. The test suite scans all output and every file written for the made-up keys.
- **No global `ANTHROPIC_API_KEY` is ever set**, so other tools on the machine are not moved onto API billing.
- **The agent child gets an environment allow-list** (PATH, HOME, TEMP and similar), not your whole environment. On Windows, libuv also adds a few required variables (SYSTEMDRIVE, HOMEDRIVE, USERNAME and similar).
- **`--mcp-config` is checked before anything else**: it must be an existing `.json` file with an `mcpServers` object and no credential-looking key name (`api_key`, `token`, `secret`, `password`, `authorization`, `bearer`) or value (an `sk-` prefix, a `Bearer` header, a long hex or base64-like run, an `--api-key=` style argument). A rejection names the key path only; neither the value nor a JSON parse error (which can quote the file) is shown. It is passed last, with `--strict-mcp-config`.
- **Child processes are spawned with `windowsHide: true`** and no shell.
- **Model output is untrusted data, never instructions (OWASP LLM01).** Text that comes back from the API or from an agent run, and anything a model wrote to `--out`, must not be obeyed by whatever reads it next.
- Don't put personal or client data in prompts you would not send to a third-party API.

## Status

- **Tested (offline, 15 tests, about 4 s):** cycle maths including short months and time zones; pool choice by reset proximity and fallback on a missing key, a spent pool and a full run limit; cost maths; budget and worst-case refusals; dry runs; the batch path end to end against the stub (create, poll, results, a half-price ledger row, the chosen key in the header); `--now` and the automatic real-time switch; a pending batch, its reservation, and collecting it exactly once; JSONL batches with a failed request; the MCP-config check with positive controls (a copy of the tool with the check removed must fail every credential case); `--print-args`; an agent run through a fake `claude` script (key reaches the child, allow-listed env only, cost booked); configuration errors; and no key value anywhere in output or files.
- **Not tested here:** the real Anthropic API (no key was used and nothing was spent), and a real `claude` CLI run. The request and response shapes follow the published Messages and Message Batches API. Tested on Windows with Node 22; it uses only the standard library and should run on macOS and Linux, but that was not run.
- For `api`, the cap is enforced against an estimate: output is bounded by `--max-tokens`, but input is guessed at 3 characters per token, and text that tokenises more densely can cost more than the estimate. For `agent`, `--max-budget-usd` is enforced by Claude Code itself.
- Spend outside this tool on the same key is not seen. Set `monthly_budget_usd` to what this tool may spend, not the key's whole credit.

## Licence

MIT, see the repository's `LICENSE`.
