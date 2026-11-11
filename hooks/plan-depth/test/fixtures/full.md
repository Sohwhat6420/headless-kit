# Plan: weekly sales report tool

Build a small command-line tool that reads sales CSV files and writes a weekly summary.

## Features

### 1. Data import

**Goal:** load sales rows from CSV. **Acceptance:** 10,000 rows in under 2 s; a missing column gives a clear error.

**How:**

1. Create `src/import.mjs` exporting `loadRows(path)`; reuse the CSV splitter at `src/util/csv.mjs:14`.
2. Validate the header against `COLUMNS` in `src/schema.mjs:3`; throw `MissingColumn` with the column name.
3. Return rows as `{date, region, amount}` objects, amounts in integer cents.
4. Test with `node --test test/import.test.mjs`.

### 2. Summary report

**Goal:** totals per region and month. **Acceptance:** totals match the spreadsheet to the cent.

**How:**

1. Create `src/summary.mjs` with `summarise(rows)` returning a Map keyed by `region|YYYY-MM`.
2. Reuse the money formatter at `src/util/money.mjs:7`.
3. Render one Markdown table with `src/render.mjs`.

### 3. CSV export

**Goal:** export the summary for the finance team. **Acceptance:** opens cleanly in a spreadsheet app.

**How:**

1. Add `src/export.mjs` writing UTF-8 with a BOM and CRLF line ends.
2. Fix the column order in `EXPORT_COLUMNS` at `src/schema.mjs:20`.
3. Add the `--csv` flag in `src/cli.mjs:31`.

## Verification log

| # | Claim | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Node has a built-in test runner | confirmed | https://nodejs.org/api/test.html |
| 2 | The CSV splitter handles quoted commas | confirmed | src/util/csv.mjs:14 |
| 3 | Header names live in one constant | confirmed | src/schema.mjs:3 |
| 4 | The money formatter rounds half up | confirmed | src/util/money.mjs:7 |
| 5 | Spreadsheet apps need a BOM for UTF-8 CSV | unclear | https://example.com/csv-utf8 |
| 6 | The team machines run Node 20+ | confirmed | probe: `node -v` printed v20.11.0 |

## Unknowns → tests

| Unknown | Test | Pass threshold |
| --- | --- | --- |
| Import speed on the real file | `node bench/import.mjs` | under 2 s for 10,000 rows |

## Questions log

- Round 1: "CSV or XLSX?" Answer: "CSV is fine."

## Dispatch plan

| Stage | Doer | Where it runs | Why manual |
| --- | --- | --- | --- |
| Import | subagent | local | |
| Summary | subagent | local | |
| Export | main session (manual) | local | needs a visual check in a spreadsheet app |

Load line per phase: week 1 import, week 2 summary, week 3 export.

Reviewed-by: a fresh reviewer subagent; two gaps fixed.

## Prior art

- https://nodejs.org/api/test.html: reused for tests.
- https://github.com/adaltas/node-csv: rejected, more than we need.
- https://www.npmjs.com/package/csv-parse: rejected, an extra dependency.

## Coverage checklist

| Base | Answer |
| --- | --- |
| Safety and hard lines | read-only on the source files |
| Privacy | sales data stays on the machine |
| Security and trust | standard library only |
| Portability | Windows, macOS and Linux |
| Failure modes and edge cases | missing column, empty file, quoted commas |
| Rollback and undo | `git revert`; no data changed |
| Cost | none beyond build time |
| Host impact | under 50 MB RAM |
| Observability | prints row counts and timings |
| Tests | `node --test` plus the bench script |
| Manual steps | one spreadsheet check in week 3 |
| Records | release notes |
| Clean-up | delete sample outputs after the check |
| Follow-ups | a chart view, staged after release |
