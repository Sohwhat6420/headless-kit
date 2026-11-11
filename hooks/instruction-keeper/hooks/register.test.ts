// Tests against Claude Code's own mod test kit. Run from this plugin's folder: claude plugin test
// (The Node suite in ../test runs the same scenarios through a small stand-in engine, with no Claude Code.)
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'

const SID = 'sess-1'
const T0 = 1_800_000_000_000
const STATE = '/home/t/.claude/headless-kit/instruction-keeper'

type Rig = {
  statuses: (string | undefined)[]
  writes: Record<string, string>
  forks: string[]
  promptsSeen: { text: string; context?: readonly string[] }[]
  store: Map<string, unknown>
  clock: MockClock
  compactInstructions: (string | undefined)[]
}

type RigOptions = {
  fork?: () => unknown
  files?: Record<string, string>
  env?: Record<string, string>
  answers?: Record<string, string>
  assistant?: string
  classify?: string | undefined
}

const val = (value: unknown): never => ({ value }) as never

const rig = (on: On, o: RigOptions = {}): Rig => {
  const clock = mock.clock(on, { now: T0 })
  const r: Rig = { statuses: [], writes: {}, forks: [], promptsSeen: [], store: new Map(), clock, compactInstructions: [] }
  mock.env(on, { HOME: '/home/t', ...(o.env ?? {}) })
  // The engine hands fs.* an absolute host path (C:\home\t\x on Windows), so files are keyed by the posix spelling.
  const posix = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')
  on('store.get', (_$, e) => val(r.store.get(e.key)))
  on('store.set', (_$, e) => {
    r.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return val(undefined)
  })
  on('store.delete', (_$, e) => {
    r.store.delete(e.key)
    return val(undefined)
  })
  on('store.keys', () => val([...r.store.keys()]))
  on('session.id', () => val(SID))
  on('session.usage', () => val({ startedAt: 0, context: { tokens: 1234, window: 200000 }, rateLimits: [] }))
  on('session.messages', () => val([{ role: 'assistant', text: o.assistant ?? 'done', toolUses: [] }]))
  on('fs.read', (_$, e) => {
    const f = o.files?.[posix(e.path)]
    return f === undefined ? ({ deny: 'ENOENT' } as never) : val(f)
  })
  on('fs.write', (_$, e) => {
    r.writes[posix(e.path)] = e.text
    return val(undefined)
  })
  on('ui.status', (_$, e) => {
    r.statuses.push(e.text)
    return val(undefined)
  })
  on('command.register', (_$, e) => val({ command: e.name }))
  on('model.fork', (_$, e) => {
    r.forks.push(e.prompt)
    return val((o.fork ?? (() => ({ isAnswered: true, text: '[]', usage: {} })))())
  })
  on('model.classify', () => val(o.classify))
  on('prompt.submit', (_$, e) => {
    r.promptsSeen.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.compact', (_$, e) => {
    r.compactInstructions.push(e.instructions)
    return { messages: [{ role: 'assistant', text: 'summary', toolUses: [] }] } as never
  })
  on('tool.call', (_$, e) =>
    e.tool === 'AskUserQuestion'
      ? { result: { questions: [], answers: o.answers ?? {} }, text: 'answered' }
      : { result: 'ok', text: 'ok' },
  )
  return r
}

const say = ($: any, text: string, extra: object = {}): Promise<any> =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra })
const turnEnd = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
const reads = async ($: any, n: number): Promise<any[]> => {
  const out = []
  for (let i = 0; i < n; i++) out.push(await $.tool.call({ tool: 'Read', file_path: `/tmp/f${i}` }))
  return out
}
type Ledger = { kind: string; text: string }[]
const ledgerOf = (r: Rig): Ledger => (r.store.get(`ledger:${SID}`) as Ledger | undefined) ?? []

test('a planted unaddressed instruction gives one open item and "1 open"', async ($, on) => {
  const r = rig(on, {
    fork: () => ({
      isAnswered: true,
      text: 'Here: [{"quote":"never touch the database","missing":"the migration edits the database"}]',
      usage: {},
    }),
  })
  await say($, 'never touch the database')
  await reads($, 8)
  await $.turn.complete(turnEnd)
  const open = r.store.get(`open:${SID}`) as { items: { quote: string }[]; ts: number }
  expect(open.items).toHaveLength(1)
  expect(open.items[0]?.quote).toBe('never touch the database')
  expect(r.statuses.at(-1)).toBe('instruction-keeper: 1 open')
  expect(r.forks[0]).toContain('never touch the database')
  const next = (await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })) as { context?: string[] }
  expect(next.context?.[0]).toContain('[instruction-keeper] Not yet addressed: "never touch the database"')
  const again = (await $.tool.call({ tool: 'Read', file_path: '/tmp/y' })) as { context?: string[] }
  expect(again.context).toBeUndefined()
})

test('an empty array gives 0 items and clears the status', async ($, on) => {
  const r = rig(on)
  await say($, 'keep it short')
  await reads($, 8)
  await $.turn.complete(turnEnd)
  expect((r.store.get(`open:${SID}`) as { items: unknown[] }).items).toHaveLength(0)
  expect(r.statuses.at(-1)).toBeUndefined()
})

test('25 read-only calls give exactly one nudge, the 26th none', async ($, on) => {
  rig(on)
  const out = [
    ...(await reads($, 24)),
    await $.tool.call({ tool: 'Bash', command: 'git log --oneline' }),
    await $.tool.call({ tool: 'Bash', command: 'ls -la' }),
  ] as { context?: string[] }[]
  expect(out.filter(x => x.context?.some(c => c.startsWith('Delegation check: 25 read-only calls')))).toHaveLength(1)
  expect(out[24]?.context?.[0]).toContain('Hand the rest to a subagent')
  expect(out[25]?.context).toBeUndefined()
})

test('an Agent call resets the nudge count', async ($, on) => {
  rig(on)
  await reads($, 24)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'x' } as never)
  const out = (await reads($, 24)) as { context?: string[] }[]
  expect(out.every(x => x.context === undefined)).toBe(true)
})

test('a configured Bash reset pattern resets the count', async ($, on) => {
  rig(on, { files: { [`${STATE}/config.json`]: JSON.stringify({ nudge: { resetBash: ['my-dispatcher'] } }) } })
  await reads($, 24)
  await $.tool.call({ tool: 'Bash', command: 'node my-dispatcher.mjs "brief"' })
  const out = (await reads($, 24)) as { context?: string[] }[]
  expect(out.every(x => x.context === undefined)).toBe(true)
})

test('nudges are logged as NDJSON under the state folder', async ($, on) => {
  const r = rig(on)
  await reads($, 25)
  expect(JSON.parse((r.writes[`${STATE}/nudges.ndjson`] ?? '').trim())).toEqual({ ts: T0, session: SID, count: 25 })
})

test('ExitPlanMode passes through next(e) and checks first', async ($, on) => {
  const r = rig(on, { fork: () => ({ isAnswered: true, text: '[{"quote":"x","missing":"y"}]', usage: {} }) })
  await say($, 'x')
  const res = (await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)) as { text?: string; context?: string[] }
  expect(res.text).toBe('ok')
  expect(r.forks).toHaveLength(1)
  expect(res.context?.[0]).toContain('Not yet addressed')
})

test('a secret in a prompt is stored redacted', async ($, on) => {
  const r = rig(on)
  await say($, 'use sk-ant-abc123 for it\nMY_API_KEY=supersecretvalue\nplain line')
  expect(ledgerOf(r)[0]?.text).toBe('use sk-ant-[REDACTED] for it\nMY_API_KEY=[REDACTED]\nplain line')
})

test('AskUserQuestion answers are appended after next', async ($, on) => {
  const r = rig(on, { answers: { 'Which database?': 'Postgres' } })
  const res = (await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which database?', header: 'DB', options: [], multiSelect: false }],
  } as never)) as { text?: string }
  expect(res.text).toBe('answered')
  expect(ledgerOf(r)[0]).toMatchObject({ kind: 'answer', text: 'Q: Which database?\nA: Postgres' })
})

test('a task-notification prompt is not stored', async ($, on) => {
  const r = rig(on)
  await say($, '<task-notification>build done</task-notification>')
  expect(ledgerOf(r)).toHaveLength(0)
})

test('a failed fork falls back to classify; "something dropped" gives one cold item', async ($, on) => {
  const r = rig(on, { fork: () => ({ isAnswered: false, reason: 'nothing-to-fork' }), classify: 'something dropped' })
  await say($, 'do the thing')
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  expect((r.store.get(`open:${SID}`) as { items: unknown[] }).items).toEqual([
    { quote: '(cold-cache check)', missing: 'possible dropped instruction: re-read the ledger' },
  ])
})

test('the cost guard stops the turn-complete check when ahead of the line', async ($, on) => {
  const resets = Math.round((T0 + 3.5 * 86_400_000) / 1000) // half the week gone: the line is at 50
  const r = rig(on, {
    env: { INSTRUCTION_KEEPER_USAGE_FILE: '/home/t/usage.json' },
    files: { '/home/t/usage.json': JSON.stringify({ rate_limits: { seven_day: { used_percentage: 80, resets_at: resets } } }) },
  })
  await say($, 'x')
  await reads($, 8)
  await $.turn.complete(turnEnd)
  expect(r.forks).toHaveLength(0)
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  expect(r.forks).toHaveLength(1)
})

test('the turn-complete check is rate limited to one per 10 minutes', async ($, on) => {
  const r = rig(on)
  await say($, 'x')
  await reads($, 8)
  await $.turn.complete(turnEnd)
  await reads($, 8)
  await $.turn.complete(turnEnd)
  expect(r.forks).toHaveLength(1)
  await r.clock.advance(11 * 60_000)
  await reads($, 8)
  await $.turn.complete(turnEnd)
  expect(r.forks).toHaveLength(2)
})

test('compaction is pinned, counted, and the next prompt re-checks', async ($, on) => {
  const r = rig(on, { fork: () => ({ isAnswered: true, text: '[{"quote":"keep tabs","missing":"m"}]', usage: {} }) })
  await say($, 'keep tabs')
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'keep tabs', toolUses: [] }], instructions: 'base' } as never)
  expect(r.compactInstructions.at(-1)).toContain('base\nKeep these open user instructions verbatim in the summary:')
  expect(r.store.get(`compactions:${SID}`)).toBe(1)
  await say($, 'continue')
  expect(r.forks).toHaveLength(1)
  expect(r.promptsSeen.at(-1)?.context?.[0]).toContain('Not yet addressed: "keep tabs"')
})

test('turn.complete writes the usage record under the state folder', async ($, on) => {
  const r = rig(on)
  await $.turn.complete(turnEnd)
  expect(JSON.parse(r.writes[`${STATE}/usage/${SID}.json`] ?? '{}')).toEqual({
    sessionId: SID,
    ts: T0,
    contextTokens: 1234,
    windowSize: 200000,
    compactions: 0,
  })
})

test('/keeper-seed seeds the ledger from a seed file', async ($, on) => {
  const md = [
    '# Earlier messages',
    '',
    '## 1. prompt · 2026-10-19T08:06:57.893Z',
    '',
    '````text',
    'first line',
    '',
    '```js',
    'code',
    '```',
    '````',
    '',
    '## 2. mid-turn · 2026-10-19T08:10:00.000Z',
    '',
    '````text',
    'second',
    '````',
    '',
  ].join('\n')
  const r = rig(on, { files: { '/tmp/seed.md': md } })
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  const out = await $.command.run({ command: 'keeper-seed', args: '/tmp/seed.md', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(out.text).toContain('Seeded 2 messages')
  expect(ledgerOf(r).map(x => x.text)).toEqual(['first line\n\n```js\ncode\n```', 'second'])
})

test('a prompt typed during a turn is stored as midturn', async ($, on) => {
  const r = rig(on)
  await say($, 'first')
  await say($, 'also do this', { turnId: 't1' })
  expect(ledgerOf(r).map(x => x.kind)).toEqual(['prompt', 'midturn'])
})
