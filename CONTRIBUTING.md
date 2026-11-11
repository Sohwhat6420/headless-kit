# Contributing

Thanks for helping. headless-kit stays useful only if every item stays small, cheap and honest, so a new tool or
hook has to meet the same bar as the existing ones.

## The bar for a new item

- **One job, zero dependencies.** One Node 18+ ES module file (a helper file is fine), standard library only. If
  it needs an external program (yt-dlp, ffmpeg), detect it and skip cleanly when it is missing.
- **Machine-readable.** A result an agent can check: one JSON object on stdout (or a file plus a JSON line),
  progress on stderr, documented exit codes, `--help` that exits 0.
- **No windows, ever.** Every child process uses `windowsHide: true` and no shell unless it is unavoidable.
- **Safe by default.** Report before acting, never spend money or send anything without an explicit flag, fail
  open in hooks, never print a key.
- **Tested offline.** `node --test` suites that touch no network and never kill or change anything they did not
  create.
- **Honest README.** What it does, a 30-second try-it, a real demo (`docs/demo.svg`) and test run
  (`docs/test-run.svg`), a Security section, and a Status section that says what is untested.

## Where things go

| Kind | Folder |
| --- | --- |
| A CLI | `tools/<category>/<tool>/` with `<tool>.mjs`, `package.json`, `README.md`, `test/`, `examples/`, `docs/` |
| A command hook | `hooks/<hook>/` with the script, a `hook.json` fragment, tests and README; add its entries to `hooks/hooks.json` |
| A mod with its own plugin | `hooks/<name>/.claude-plugin/plugin.json`, then list it in `.claude-plugin/marketplace.json` |

Categories today: `routing`, `guards`, `research`. Propose a new one in the pull request if none fits.

## Before you open a pull request

```bash
npm test                                  # every suite, from the repo root
claude plugin validate .                  # if you touched hooks or the plugin files (needs Claude Code)
```

- Add a row to the table in the root README and a line to `CHANGELOG.md`.
- No personal data in code, fixtures or demos: no real names, usernames in paths, e-mail addresses, IP
  addresses or account labels. Use `example_*` placeholders.
- British English in prose.

By contributing you agree that your work is released under the MIT licence.
