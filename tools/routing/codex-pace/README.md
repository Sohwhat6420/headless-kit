# Codex pace router

A zero-dependency Node 18+ CLI that recommends `cloud`, `local`, `hold` or `stale`
before handing work to Codex. It only reads usage and reports a decision; it does
not start jobs or contact a service.

Codex Cloud, the local Codex CLI, the IDE extension and the web app share one
ChatGPT-plan allowance, with a short rolling window (about five hours) and a weekly
window. Choosing Cloud saves local memory; it does not create more allowance.

## Three example runs

From this tool's directory, use the included synthetic snapshot and a fixed clock:

```sh
node codex-pace.mjs --usage examples/usage.json --now 2026-11-13T12:00:00Z --memory-percent 20
```

Prints `cloud`, a reason, and a JSON line of numbers; exits 0.

```sh
node codex-pace.mjs --usage examples/usage.json --now 2026-11-13T12:00:00Z --memory-percent 20 --needs-local --json
```

Prints one JSON decision with `"decision":"local"`; exits 10.

```sh
node codex-pace.mjs --usage examples/usage.json --now 2026-11-13T12:00:00Z --memory-percent 75 --needs-local --json
```

Prints one JSON decision with `"decision":"hold"` and a memory reason; exits 20.

## Flags

| Flag | Meaning |
| --- | --- |
| `--usage <file>` | Read a usage JSON file. `--usage -` reads JSON from stdin. |
| `--from-sessions [dir]` | Recursively read JSONL session logs. Without a directory, use the Codex CLI's default session folder. This is also the default source when neither source flag is given. |
| `--memory-percent <n>` | Committed memory, 0–100. Default: `(1 - os.freemem() / os.totalmem()) * 100`. |
| `--needs-local` | The job requires local files or devices. |
| `--local-running <n>` | Number of active local Codex runs; nonnegative integer, default 0. |
| `--urgent` | Bypass weekly pace and the short-window soft limit. Hard caps and local resource checks still apply. |
| `--now <ISO>` | Override the current clock. |
| `--max-age-minutes <n>` | Maximum snapshot age, nonnegative number, default 30. |
| `--json` | Emit exactly one JSON line. Default output is three lines: decision, reason, numbers. |
| `--help` | Print help and exit 0. |

Choose at most one usage source. Duplicate or unknown options are errors.

## Usage data

See `examples/usage.json` for the input shape. `taken_at` and reset dates are ISO
8601 date-times; `primary` is the short window and `secondary` is the weekly window.
Both windows carry numeric `used_percent` (0–100), positive `window_minutes`, and
`resets_at`. Extra fields are ignored. Missing or invalid fields are tolerated,
but an incomplete reading cannot authorise a run: it returns `stale` unless an
available reading already requires a hard-cap hold. Unknown output numbers are
`null`; usage is never assumed to be zero.

Session parsing searches for a key named `rate_limits`, including nested payloads.
It selects the newest usable event by its `timestamp` (or `taken_at`), regardless
of file name or modification time. Broken JSON lines and incomplete events are
skipped. Both windows must be usable. Reset values may be ISO `resets_at`, epoch
seconds or milliseconds, or `resets_in_seconds` relative to the event timestamp.
The aliases `reset_at`, `reset_in_seconds` and `reset_after_seconds` are accepted.
Directories are traversed without following symbolic links. Logs are streamed
one line at a time and their other contents are never printed.

## Decision order

Thresholds live together in the exported `CONSTANTS` object.

1. Snapshot age strictly greater than the maximum gives `stale`, including for urgent jobs.
2. Primary usage **>= 90%** or weekly usage **>= 97%** gives `hold`, including for urgent jobs.
3. Weekly elapsed fraction is `clamp(1 - time_until_reset / window_duration, 0, 1)`.
   Expected usage is that fraction times 100. Usage **> expected + 10** points
   gives `hold` with reason `over weekly pace`, unless urgent. Exactly expected + 10 is allowed.
4. Primary usage **>= 75%** gives `hold` unless urgent, reporting minutes to reset.
5. Otherwise choose `cloud` unless local access is required. Choose `local` only
   with memory **< 75%** and no active local run; otherwise hold for memory or concurrency.

Reset countdowns have a floor of zero. Weekly spare is `expected - used` in
percentage points and can be negative. Expired reset timestamps do not clear
recorded usage; refresh the snapshot to obtain new usage.

## Output and exit codes

JSON contains `decision`, `reason`, `primary_used`, `secondary_used`,
`expected_weekly`, `spare_weekly`, `hours_to_weekly_reset`,
`minutes_to_primary_reset`, `memory_percent` and `taken_at`. Numbers are unrounded;
`reason` is one plain-English line. Text output's final line also includes
`local_running` and `max_age_minutes`.

| Exit | Meaning |
| --- | --- |
| 0 | Cloud (or help) |
| 10 | Local |
| 20 | Hold |
| 3 | Stale, incomplete, or no usable rate-limit event |
| 2 | Bad arguments, invalid usage JSON, or unreadable input |

Errors go to stderr. An unreadable session directory is an input error; a readable
folder with no usable event returns `stale` and exit 3.

## Tests and limits

Run `npm test` here, or the repository's root `npm test` for all tools. Tests are
offline and use fixed clocks, synthetic fixtures and temporary files. Paths use
Node's path helpers and subprocess tests use no shell. Linux is validated;
Windows execution has not been verified in this change.

Memory from the OS is the requested total/free-memory estimate, not a platform
specific commit-charge counter. This router uses supplied snapshots rather than
querying allowance services and makes no estimate of the next job's cost. It
reads no credentials and sends no network requests.
