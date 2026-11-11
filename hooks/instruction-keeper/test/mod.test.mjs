// The mod itself (hooks/register.ts) driven through the stand-in engine in fake-engine.mjs.
// register.ts is TypeScript, so this needs Node's type stripping: built in from Node 22.18 / 23.6, behind
// --experimental-strip-types from 22.6. Older Node skips this file (core.test.mjs still runs everywhere).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scenarios } from './mod-scenarios.mjs'

const [major, minor] = process.versions.node.split('.').map(Number)
const inProcess = Boolean(process.features?.typescript)
const viaFlag = !inProcess && (major > 22 || (major === 22 && minor >= 6))

if (inProcess) {
  const { register } = await import('../hooks/register.ts')
  for (const [name, fn] of scenarios) test(`mod: ${name}`, () => fn(register))
} else if (viaFlag) {
  const script = fileURLToPath(new URL('./mod-scenarios.mjs', import.meta.url))
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, '--run'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  const rows = (r.stdout ?? '').split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
  test('mod: the scenario runner started', () => {
    assert.equal(r.status, 0, r.stderr)
    assert.equal(rows.length, scenarios.length, r.stderr)
  })
  for (const row of rows) {
    test(`mod: ${row.name}`, () => assert.ok(row.ok, row.error))
  }
} else {
  test('mod: register.ts scenarios', { skip: `Node ${process.versions.node} cannot strip TypeScript types (needs 22.6+)` }, () => {})
}
