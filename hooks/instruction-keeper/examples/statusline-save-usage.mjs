#!/usr/bin/env node
// Optional feeder for instruction-keeper's cost guard. Use it as (or call it from) your Claude Code status line:
// it reads the status line JSON on stdin, saves its rate_limits block to the usage file, and prints one short line.
//   settings.json: { "statusLine": { "type": "command", "command": "node /abs/path/to/statusline-save-usage.mjs" } }
// The usage file is INSTRUCTION_KEEPER_USAGE_FILE, else <HEADLESS_KIT_STATE_DIR or ~/.claude/headless-kit>/usage.json.
// Point the mod at the same file (the same env var, or costGuard.usageFile in its config). Fails quietly.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const target =
  process.env.INSTRUCTION_KEEPER_USAGE_FILE ||
  join(process.env.HEADLESS_KIT_STATE_DIR || join(homedir(), '.claude', 'headless-kit'), 'usage.json')

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => (raw += d))
process.stdin.on('end', () => {
  let line = ''
  try {
    const rl = JSON.parse(raw)?.rate_limits
    if (rl && typeof rl === 'object') {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, JSON.stringify({ rate_limits: rl, saved_at: Date.now() }))
      const w = rl.seven_day
      if (typeof w?.used_percentage === 'number') line = `7d ${Math.round(w.used_percentage)}% used`
    }
  } catch {
    // fail quietly: a status line must never break the session
  }
  process.stdout.write(line + '\n')
})
