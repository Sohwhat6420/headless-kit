#!/usr/bin/env bash
# Records the terminal sessions the README shots are drawn from. Run from the repo root:
#     bash assets/src/capture.sh
# Each command below is run for real and written, with everything it printed (stdout and stderr together, the
# way a terminal shows them), to assets/src/shot-*.txt. Nothing is edited afterwards. The runs reach Arctic Shift
# and GitHub's public API, read this machine's memory, and leave nothing behind (out/ and stars.json are removed).
set -u
cd "$(dirname "$0")/../.."
src=assets/src

session() {            # session <file> <command>...   each command is echoed as "$ command", run, then "$ echo $?"
  local file="$1"; shift
  : > "$file"
  local cmd
  for cmd in "$@"; do
    printf '$ %s\n' "$cmd" >> "$file"
    if [ "$cmd" = 'echo $?' ]; then
      printf '%s\n' "$last" >> "$file"
    else
      bash -c "$cmd" >> "$file" 2>&1
      last=$?
    fi
  done
}

rm -rf out stars.json

session "$src/shot-reddit-pull.txt" \
  'node tools/research/reddit-pull/reddit-pull.mjs --sub rust --after 2026-11-12 --max-pages 1 --out out' \
  'echo $?' \
  'wc -c out/*'

session "$src/shot-memory-gate.txt" \
  'node tools/guards/memory-gate/memory-gate.mjs' \
  'echo $?'

# the first run saves the list of stars; the second is the check an agent would repeat on a timer
session "$src/shot-github-stars.txt" \
  'node tools/trackers/github-stars/github-stars.mjs --user antirez --state stars.json' \
  'node tools/trackers/github-stars/github-stars.mjs --user antirez --state stars.json' \
  'echo $?'

rm -rf out stars.json
wc -c "$src"/shot-*.txt
