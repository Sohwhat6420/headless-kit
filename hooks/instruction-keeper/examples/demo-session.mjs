#!/usr/bin/env node
// A scripted session fed through the real hooks/register.ts by the stand-in engine in test/fake-engine.mjs.
// Offline: the "model" is a scripted reply, nothing is sent anywhere, nothing is written outside memory.
//   node examples/demo-session.mjs          (Node 22.6+; re-runs itself with --experimental-strip-types if needed)
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node examples/demo-session.mjs\nRuns a scripted, offline session through the instruction-keeper mod and prints what it kept and said.')
  process.exit(0)
}

if (!process.features?.typescript && !process.execArgv.includes('--experimental-strip-types')) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    windowsHide: true,
  })
  process.exit(r.status ?? 1)
}

const { createEngine } = await import('../test/fake-engine.mjs')
const { register } = await import('../hooks/register.ts')

// The scripted check: the "model" notices the second instruction was dropped.
const fork = () => ({
  isAnswered: true,
  usage: {},
  text: 'Looking at the work so far:\n[{"quote":"keep the public API unchanged","missing":"parseConfig() was renamed to loadConfig()"}]',
})
const k = createEngine(register, { fork, answers: { 'Which test runner?': 'node:test, no new dependencies' } })
const { $ } = k
const show = (label, v) => console.log(`${label.padEnd(14)}${v}`)

console.log('# 1. the user types; a machine message arrives; Claude asks a question')
await $.prompt.submit({ text: 'refactor config.js into smaller functions' })
await $.prompt.submit({ text: 'keep the public API unchanged', turnId: 't1' })
await $.prompt.submit({ text: 'staging creds for the smoke test:\nexport STAGING_DB_PASSWORD=correct-horse-battery\nkey sk-ant-api03-Xy7_example' })
await $.prompt.submit({ text: '<task-notification>lint finished</task-notification>' })
await $.tool.call({ tool: 'AskUserQuestion', questions: [] })

console.log('# 2. the ledger (verbatim, redacted, machine messages left out)')
for (const x of k.store.get('ledger:sess-1')) show(`  ${x.n}. ${x.kind}`, x.text.replace(/\n/g, ' / '))

console.log('# 3. a busy turn: 8 tool calls, then the turn ends and the check runs')
for (let i = 0; i < 8; i++) await $.tool.call({ tool: i % 2 ? 'Edit' : 'Read', file_path: `src/config${i}.js` })
await $.turn.complete()
show('  status line', k.statuses.at(-1))

console.log('# 4. what Claude reads on its next tool result')
const next = await $.tool.call({ tool: 'Read', file_path: 'src/config.js' })
console.log(`  ${next.context[0]}`)

console.log('# 5. the context gets compacted: the summary is told to keep these verbatim')
await $.session.compact({ instructions: '' })
console.log(k.compactInstructions.at(-1).split('\n').filter(Boolean).map(l => `  ${l}`).join('\n'))
