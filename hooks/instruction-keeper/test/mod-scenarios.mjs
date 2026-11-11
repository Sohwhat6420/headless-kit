// Scenarios that drive the real register.ts through the stand-in engine. Each takes the module's `register`.
// mod.test.mjs runs them in-process when Node can strip TypeScript types, or runs this file as a child with
// --experimental-strip-types (it then prints one JSON line per scenario).
import assert from 'node:assert/strict'
import { createEngine } from './fake-engine.mjs'

const SID = 'sess-1'
const T0 = 1_800_000_000_000
const DAY = 86_400_000
const STATE = '/home/t/.claude/headless-kit/instruction-keeper'

const answer = text => () => ({ isAnswered: true, text, usage: {} })
const reads = async ($, n) => {
  const out = []
  for (let i = 0; i < n; i++) out.push(await $.tool.call({ tool: 'Read', file_path: `/tmp/f${i}` }))
  return out
}
const ledgerOf = k => k.store.get(`ledger:${SID}`) ?? []
const openOf = k => k.store.get(`open:${SID}`)

export const scenarios = [
  ['a planted unaddressed instruction is reported once to the tool result and once to the next prompt', async register => {
    const k = createEngine(register, {
      fork: answer('Here: [{"quote":"never touch the database","missing":"the migration edits the database"}]'),
    })
    await k.$.prompt.submit({ text: 'never touch the database' })
    await reads(k.$, 8)
    await k.$.turn.complete()
    assert.equal(openOf(k).items.length, 1)
    assert.equal(openOf(k).ts, T0)
    assert.equal(k.statuses.at(-1), 'instruction-keeper: 1 open')
    assert.match(k.forks[0], /never touch the database/)
    assert.match(k.forks[0], /JSON array, at most 5 items/)
    const first = await k.$.tool.call({ tool: 'Read', file_path: '/tmp/x' })
    assert.match(first.context[0], /^\[instruction-keeper\] Not yet addressed: "never touch the database" \(missing: the migration/)
    assert.equal((await k.$.tool.call({ tool: 'Read', file_path: '/tmp/y' })).context, undefined)
    await k.$.prompt.submit({ text: 'carry on' })
    assert.match(k.promptsSeen.at(-1).context[0], /Not yet addressed/)
    await k.$.prompt.submit({ text: 'and again' })
    assert.equal(k.promptsSeen.at(-1).context, undefined)
  }],

  ['an empty array gives 0 items and clears the status line', async register => {
    const k = createEngine(register)
    await k.$.prompt.submit({ text: 'keep it short' })
    await reads(k.$, 8)
    await k.$.turn.complete()
    assert.deepEqual(openOf(k).items, [])
    assert.equal(k.statuses.at(-1), undefined)
  }],

  ['fewer than 8 tool calls in a turn means no check', async register => {
    const k = createEngine(register)
    await k.$.prompt.submit({ text: 'x' })
    await reads(k.$, 7)
    await k.$.turn.complete()
    assert.equal(k.forks.length, 0)
  }],

  ['25 read-only calls give exactly one delegation nudge, the 26th none', async register => {
    const k = createEngine(register)
    const out = [
      ...(await reads(k.$, 24)),
      await k.$.tool.call({ tool: 'Bash', command: 'git log --oneline' }),
      await k.$.tool.call({ tool: 'Bash', command: 'ls -la' }),
    ]
    assert.equal(out.filter(x => x.context?.some(c => c.startsWith('Delegation check: 25 read-only calls'))).length, 1)
    assert.ok(out[24].context)
    assert.equal(out[25].context, undefined)
  }],

  ['Agent and Workflow calls reset the count; a write-ish Bash call does not count', async register => {
    const k = createEngine(register)
    await reads(k.$, 24)
    await k.$.tool.call({ tool: 'Agent', prompt: 'p' })
    await reads(k.$, 24)
    await k.$.tool.call({ tool: 'Workflow', script: 's' })
    await k.$.tool.call({ tool: 'Bash', command: 'npm run build' })
    const out = await reads(k.$, 24)
    assert.ok(out.every(x => x.context === undefined))
  }],

  ['reset patterns and the threshold come from the config file in the state folder', async register => {
    const k = createEngine(register, {
      files: { [`${STATE}/config.json`]: JSON.stringify({ nudge: { threshold: 3, resetBash: ['my-dispatcher'], text: 'N={count}' } }) },
    })
    await reads(k.$, 2)
    await k.$.tool.call({ tool: 'Bash', command: 'node my-dispatcher.mjs "brief"' })
    const out = await reads(k.$, 3)
    assert.equal(out[0].context, undefined)
    assert.deepEqual(out[2].context, ['N=3'])
  }],

  ['INSTRUCTION_KEEPER_CONFIG names the config file; nudge.enabled false turns the nudge off', async register => {
    const k = createEngine(register, {
      env: { INSTRUCTION_KEEPER_CONFIG: '/etc/ik.json' },
      files: { '/etc/ik.json': JSON.stringify({ nudge: { enabled: false } }) },
    })
    const out = await reads(k.$, 30)
    assert.ok(out.every(x => x.context === undefined))
  }],

  ['a broken config file means the defaults', async register => {
    const k = createEngine(register, { files: { [`${STATE}/config.json`]: '{not json' } })
    const out = await reads(k.$, 25)
    assert.ok(out[24].context?.[0].startsWith('Delegation check: 25'))
  }],

  ['nudges are logged as NDJSON under HEADLESS_KIT_STATE_DIR', async register => {
    const k = createEngine(register, { env: { HEADLESS_KIT_STATE_DIR: '/state/' } })
    await reads(k.$, 50)
    const lines = k.writes['/state/instruction-keeper/nudges.ndjson'].trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(lines, [{ ts: T0, session: SID, count: 25 }, { ts: T0, session: SID, count: 25 }])
  }],

  ['when files cannot be written, the usage record and nudge log go to the store', async register => {
    const k = createEngine(register, { failWrites: true })
    await reads(k.$, 25)
    await k.$.turn.complete()
    assert.equal(k.store.get('nudges').length, 1)
    assert.equal(k.store.get(`usage:${SID}`).contextTokens, 1234)
  }],

  ['subagent tool calls are not counted and do not receive findings', async register => {
    const k = createEngine(register, { fork: answer('[{"quote":"x","missing":"y"}]') })
    await k.$.prompt.submit({ text: 'x' })
    await k.$.tool.call({ tool: 'ExitPlanMode', plan: 'p' }) // the check runs and delivers here
    for (let i = 0; i < 30; i++) {
      const res = await k.$.tool.call({ tool: 'Read', file_path: 'f', agentId: 'a1' })
      assert.equal(res.context, undefined)
    }
  }],

  ['ExitPlanMode checks first and still passes the call on', async register => {
    const k = createEngine(register, { fork: answer('[{"quote":"x","missing":"y"}]') })
    await k.$.prompt.submit({ text: 'x' })
    const res = await k.$.tool.call({ tool: 'ExitPlanMode', plan: 'p' })
    assert.equal(res.text, 'ok')
    assert.equal(k.forks.length, 1)
    assert.match(res.context[0], /Not yet addressed: "x"/)
  }],

  ['secrets in a prompt are stored redacted', async register => {
    const k = createEngine(register)
    await k.$.prompt.submit({ text: 'use sk-ant-abc123 for it\nMY_API_KEY=supersecretvalue\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123\nplain line' })
    assert.equal(ledgerOf(k)[0].text, 'use sk-ant-[REDACTED] for it\nMY_API_KEY=[REDACTED]\ntoken ghp_[REDACTED]\nplain line')
  }],

  ['AskUserQuestion answers are added after the tool ran, one entry per question', async register => {
    const k = createEngine(register, { answers: { 'Which database?': 'Postgres', 'Which port?': '5432' } })
    const res = await k.$.tool.call({ tool: 'AskUserQuestion', questions: [] })
    assert.equal(res.text, 'answered')
    assert.deepEqual(ledgerOf(k).map(x => [x.kind, x.text]), [
      ['answer', 'Q: Which database?\nA: Postgres'],
      ['answer', 'Q: Which port?\nA: 5432'],
    ])
  }],

  ['machine prompts are left out: wrappers, isMeta, non-human origins, /keeper-seed itself', async register => {
    const k = createEngine(register)
    await k.$.prompt.submit({ text: '<task-notification>build done</task-notification>' })
    await k.$.prompt.submit({ text: '  <scheduled-task>tick</scheduled-task>' })
    await k.$.prompt.submit({ text: 'reminder', isMeta: true })
    await k.$.prompt.submit({ text: 'from a peer', origin: { kind: 'peer' } })
    await k.$.prompt.submit({ text: '/keeper-seed ./seed.md' })
    await k.$.prompt.submit({ text: 'from the remote bridge', origin: { kind: 'bridge' } })
    assert.deepEqual(ledgerOf(k).map(x => x.text), ['from the remote bridge'])
  }],

  ['a fork with no JSON array falls back to classify: "something dropped" gives the cold item', async register => {
    const k = createEngine(register, { fork: answer('I think everything is fine.'), classify: 'something dropped', assistant: 'all done!' })
    await k.$.prompt.submit({ text: 'do the thing' })
    await k.$.tool.call({ tool: 'ExitPlanMode', plan: 'p' })
    assert.deepEqual(openOf(k).items, [{ quote: '(cold-cache check)', missing: 'possible dropped instruction: re-read the ledger' }])
    assert.match(k.classified[0].text, /Last assistant message:\nall done!/)
    assert.deepEqual(k.classified[0].labels, ['all addressed', 'something dropped'])
  }],

  ['no verdict at all leaves the stored items as they were', async register => {
    const k = createEngine(register, { fork: () => ({ isAnswered: false, reason: 'x' }), classify: undefined })
    k.store.set(`open:${SID}`, { items: [{ quote: 'old', missing: '' }], ts: 1 })
    await k.$.prompt.submit({ text: 'do the thing' })
    await k.$.tool.call({ tool: 'ExitPlanMode', plan: 'p' })
    assert.deepEqual(openOf(k), { items: [{ quote: 'old', missing: '' }], ts: 1 })
  }],

  ['cost guard: ahead of the line skips the turn-end check, behind it runs, ExitPlanMode always runs', async register => {
    const resets = Math.round((T0 + 3.5 * DAY) / 1000) // half the week gone: the line is at 50
    const usage = pct => JSON.stringify({ rate_limits: { seven_day: { used_percentage: pct, resets_at: resets } } })
    const k = createEngine(register, { env: { INSTRUCTION_KEEPER_USAGE_FILE: '/u.json' }, files: { '/u.json': usage(80) } })
    await k.$.prompt.submit({ text: 'x' })
    await reads(k.$, 8)
    await k.$.turn.complete()
    assert.equal(k.forks.length, 0)
    await k.$.tool.call({ tool: 'ExitPlanMode', plan: 'p' })
    assert.equal(k.forks.length, 1)
    const b = createEngine(register, { env: { INSTRUCTION_KEEPER_USAGE_FILE: '/u.json' }, files: { '/u.json': usage(20) } })
    await b.$.prompt.submit({ text: 'x' })
    await reads(b.$, 8)
    await b.$.turn.complete()
    assert.equal(b.forks.length, 1)
  }],

  ['cost guard is off by default and when the named file is missing', async register => {
    for (const env of [{}, { INSTRUCTION_KEEPER_USAGE_FILE: '/missing.json' }]) {
      const k = createEngine(register, { env })
      await k.$.prompt.submit({ text: 'x' })
      await reads(k.$, 8)
      await k.$.turn.complete()
      assert.equal(k.forks.length, 1)
    }
  }],

  ['the turn-end check is rate limited to one per 10 minutes', async register => {
    const k = createEngine(register)
    await k.$.prompt.submit({ text: 'x' })
    await reads(k.$, 8)
    await k.$.turn.complete()
    await reads(k.$, 8)
    await k.$.turn.complete()
    assert.equal(k.forks.length, 1)
    k.clock.advance(11 * 60_000)
    await reads(k.$, 8)
    await k.$.turn.complete()
    assert.equal(k.forks.length, 2)
  }],

  ['compaction pins the open items and recent entries, is counted, and the next prompt re-checks', async register => {
    const k = createEngine(register, { fork: answer('[{"quote":"keep tabs","missing":"m"}]') })
    await k.$.prompt.submit({ text: 'keep tabs' })
    await k.$.session.compact({ instructions: 'base' })
    assert.match(k.compactInstructions.at(-1), /^base\nKeep these open user instructions verbatim in the summary: \n- keep tabs$/)
    assert.equal(k.store.get(`compactions:${SID}`), 1)
    await k.$.session.compact({ trigger: 'precompute' })
    assert.equal(k.store.get(`compactions:${SID}`), 1)
    await k.$.prompt.submit({ text: 'continue' })
    assert.equal(k.forks.length, 1)
    assert.match(k.promptsSeen.at(-1).context[0], /Not yet addressed: "keep tabs"/)
  }],

  ['turn.complete writes the usage record under the state folder', async register => {
    const k = createEngine(register)
    await k.$.turn.complete()
    assert.deepEqual(JSON.parse(k.writes[`${STATE}/usage/${SID}.json`]), {
      sessionId: SID, ts: T0, contextTokens: 1234, windowSize: 200000, compactions: 0,
    })
  }],

  ['/keeper-seed adds new messages, skips ones already seeded, and explains failures', async register => {
    const md = [
      '# Earlier messages', '',
      '## 1. prompt · 2026-10-19T08:06:57.893Z', '', '````text', 'first line', '', '```js', 'code', '```', '````', '',
      '## 2. mid-turn | 2026-10-19T08:10:00.000Z', '', '````text', 'second', '````', '',
    ].join('\n')
    const k = createEngine(register, { files: { '/tmp/seed.md': md, '/home/t/seed.md': md } })
    await k.$.session.start()
    assert.deepEqual(k.commands, ['keeper-seed'])
    const out = await k.$.command.run({ command: 'keeper-seed', args: '"/tmp/seed.md"' })
    assert.match(out.text, /^Seeded 2 messages/)
    assert.deepEqual(ledgerOf(k).map(x => [x.kind, x.text]), [['seed', 'first line\n\n```js\ncode\n```'], ['seed', 'second']])
    assert.equal(ledgerOf(k)[0].ts, Date.parse('2026-10-19T08:06:57.893Z'))
    assert.match((await k.$.command.run({ command: 'keeper-seed', args: '~/seed.md' })).text, /^Seeded 0 messages/)
    assert.match((await k.$.command.run({ command: 'keeper-seed', args: '' })).text, /^Usage: /)
    assert.match((await k.$.command.run({ command: 'keeper-seed', args: '/nope.md' })).text, /^keeper-seed failed: ENOENT/)
  }],

  ['a prompt typed during a turn is stored as midturn', async register => {
    const k = createEngine(register)
    await k.$.prompt.submit({ text: 'first' })
    await k.$.prompt.submit({ text: 'also do this', turnId: 't1' })
    assert.deepEqual(ledgerOf(k).map(x => x.kind), ['prompt', 'midturn'])
  }],

  ['the ledger is bounded and stale ledgers are swept at session start', async register => {
    const k = createEngine(register)
    for (let i = 0; i < 205; i++) await k.$.prompt.submit({ text: `m${i}` })
    assert.equal(ledgerOf(k).length, 200)
    assert.equal(ledgerOf(k)[0].text, 'm5')
    await k.$.prompt.submit({ text: 'z'.repeat(30_000) })
    assert.ok(ledgerOf(k).at(-1).text.endsWith(' …[truncated]'))
    k.store.set('ledger:old', [{ n: 1, ts: 1, kind: 'prompt', text: 'old' }])
    k.store.set('open:old', { items: [], ts: 1 })
    k.store.set('ledger-index', { old: T0 - 8 * DAY, [SID]: T0 })
    await k.$.session.start()
    assert.equal(k.store.get('ledger:old'), undefined)
    assert.equal(k.store.get('open:old'), undefined)
    assert.equal(ledgerOf(k).length, 200)
  }],

  ['a failing store never blocks: the prompt and the tool call still pass through', async register => {
    const k = createEngine(register, { brokenStore: true })
    await k.$.session.start()
    await k.$.prompt.submit({ text: 'hello' })
    assert.equal(k.promptsSeen.at(-1).text, 'hello')
    assert.equal((await k.$.tool.call({ tool: 'ExitPlanMode', plan: 'p' })).text, 'ok')
    assert.equal((await k.$.turn.complete()).text, '')
    assert.deepEqual(k.skipped, [])
  }],
]

// As a child process: run every scenario and print one JSON line each.
if (process.argv[2] === '--run') {
  const { register } = await import('../hooks/register.ts')
  for (const [name, fn] of scenarios) {
    try {
      await fn(register)
      console.log(JSON.stringify({ name, ok: true }))
    } catch (err) {
      console.log(JSON.stringify({ name, ok: false, error: err instanceof Error ? err.stack ?? err.message : String(err) }))
    }
  }
}
