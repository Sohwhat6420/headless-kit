// The files in examples/: the config resolves cleanly, the seed parses, and the status-line feeder
// writes a usage file the cost guard can read (and stays quiet on bad input).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { aheadOfLine, parseSeed, resolveConfig } from '../hooks/core.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ex = f => path.join(here, '..', 'examples', f)

test('examples/config.example.json resolves with every pattern compiled', () => {
  const raw = JSON.parse(fs.readFileSync(ex('config.example.json'), 'utf8'))
  const c = resolveConfig(raw)
  assert.equal(c.nudge.resetBash.length, raw.nudge.resetBash.length)
  assert.equal(c.ledger.redact.length, raw.ledger.redact.length)
  assert.ok(c.nudge.resetBash[0].test('node my-dispatcher.mjs x'))
})

test('examples/seed.example.md parses into two messages, code fence kept', () => {
  const m = parseSeed(fs.readFileSync(ex('seed.example.md'), 'utf8'))
  assert.equal(m.length, 2)
  assert.match(m[1].text, /```js\nimport \{ parseConfig \}/)
})

const feed = (stdin, file) =>
  spawnSync(process.execPath, [ex('statusline-save-usage.mjs')], {
    input: stdin,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, INSTRUCTION_KEEPER_USAGE_FILE: file },
  })

test('statusline-save-usage.mjs saves rate_limits in a shape aheadOfLine reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-'))
  const file = path.join(dir, 'sub', 'usage.json')
  const now = Date.now()
  const resets = Math.round((now + 3.5 * 86_400_000) / 1000)
  const r = feed(JSON.stringify({ model: {}, rate_limits: { seven_day: { used_percentage: 80.4, resets_at: resets } } }), file)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '7d 80% used\n')
  assert.equal(aheadOfLine(fs.readFileSync(file, 'utf8'), now), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('statusline-save-usage.mjs: bad or missing input prints an empty line and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-'))
  const file = path.join(dir, 'usage.json')
  for (const input of ['not json', '{}', '']) {
    const r = feed(input, file)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '\n')
  }
  assert.equal(fs.existsSync(file), false)
  fs.rmSync(dir, { recursive: true, force: true })
})
