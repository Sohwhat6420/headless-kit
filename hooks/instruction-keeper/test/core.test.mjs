// The pure logic in hooks/core.mjs. Plain Node 18+, offline, no dependencies.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BASE, LIMITS, TRUNC, aheadOfLine, appendEntries, checkPrompt, classifyCall, classifyText, clean, expandHome,
  finding, firstJsonArray, isHumanPrompt, itemsFromFork, itemsFromLabel, nudgeStep, nudgeText, parseSeed, paths,
  pinText, promptKind, redact, resolveConfig, safeId, seedRows, shouldCheckAtTurnEnd, staleSessions, stateDir,
  statusText, toItems, touchIndex,
} from '../hooks/core.mjs'

const T0 = 1_800_000_000_000
const DAY = 86_400_000

test('redact: known token shapes and NAME=value lines, prefixes kept', () => {
  const src = [
    'key sk-ant-api03-AbC_def-123',
    'openai sk-proj-abcdefghijklmnopqrstuvwxyz',
    'gh ghp_abcdefghijklmnopqrstuvwxyz0123 and github_pat_11ABCDEFG0123456789_abcdefghij',
    'slack xoxb-1234567890-abcdefghij',
    'aws AKIAIOSFODNN7EXAMPLE',
    'export DB_PASSWORD=hunter2hunter2',
    'MY_TOKEN = abcdefgh',
    'SHORT_KEY=abc',
    'lower_key=abcdefghijk',
    'the word sk-learn stays',
  ].join('\n')
  assert.equal(redact(src), [
    'key sk-ant-[REDACTED]',
    'openai sk-[REDACTED]',
    'gh ghp_[REDACTED] and github_pat_[REDACTED]',
    'slack xoxb-[REDACTED]',
    'aws AKIA[REDACTED]',
    'export DB_PASSWORD=[REDACTED]',
    'MY_TOKEN=[REDACTED]',
    'SHORT_KEY=abc',
    'lower_key=abcdefghijk',
    'the word sk-learn stays',
  ].join('\n'))
})

test('redact: extra patterns from config; a bad pattern is ignored, not thrown', () => {
  const cfg = resolveConfig({ ledger: { redact: ['acct-\\d{6}', '(unclosed'] } })
  assert.equal(cfg.ledger.redact.length, 1)
  assert.equal(redact('pay acct-123456 now, acct-654321 later', cfg.ledger.redact), 'pay [REDACTED] now, [REDACTED] later')
})

test('clean: redacts, then caps one entry at 20,000 characters', () => {
  const long = clean('x'.repeat(25_000))
  assert.equal(long.length, LIMITS.maxEntryChars + TRUNC.length)
  assert.ok(long.endsWith(TRUNC))
  assert.equal(clean('short'), 'short')
})

test('isHumanPrompt and promptKind: source filtering', () => {
  assert.equal(isHumanPrompt({ text: 'do it' }), true)
  assert.equal(isHumanPrompt({ text: 'do it', origin: { kind: 'composer' } }), true)
  assert.equal(isHumanPrompt({ text: 'do it', origin: { kind: 'sdk' } }), true)
  assert.equal(isHumanPrompt({ text: 'do it', origin: { kind: 'plugin' } }), false)
  assert.equal(isHumanPrompt({ text: 'do it', isMeta: true }), false)
  assert.equal(isHumanPrompt({ text: '\n<cross-session-message from="x">hi' }), false)
  assert.equal(isHumanPrompt({ text: '[bot] ping' }, ['[bot]']), false)
  assert.equal(isHumanPrompt(null), false)
  assert.equal(isHumanPrompt({ text: 42 }), false)
  assert.equal(promptKind({ text: 'a' }), 'prompt')
  assert.equal(promptKind({ text: 'a', turnId: 't' }), 'midturn')
})

test('appendEntries: numbering, blank skip, entry cap and total-character cap', () => {
  let l = appendEntries([], [{ kind: 'prompt', text: 'a' }, { kind: 'prompt', text: '   ' }, { kind: 'seed', text: 'b', ts: 5 }], T0)
  assert.deepEqual(l, [{ n: 1, ts: T0, kind: 'prompt', text: 'a' }, { n: 2, ts: 5, kind: 'seed', text: 'b' }])
  l = appendEntries(l, [{ kind: 'prompt', text: 'c' }], T0)
  assert.equal(l.at(-1).n, 3)
  const many = appendEntries([], Array.from({ length: 250 }, (_, i) => ({ kind: 'prompt', text: `m${i}` })), T0)
  assert.equal(many.length, 200)
  assert.equal(many[0].text, 'm50')
  const big = appendEntries([], Array.from({ length: 12 }, () => ({ kind: 'prompt', text: 'y'.repeat(19_000) })), T0)
  assert.ok(big.reduce((a, x) => a + x.text.length, 0) <= LIMITS.maxLedgerChars)
  assert.equal(big.length, 10)
  const one = appendEntries([], [{ kind: 'prompt', text: 'z'.repeat(19_000) }], T0, { maxLedgerChars: 10 })
  assert.equal(one.length, 1) // the newest entry always stays
})

test('touchIndex and staleSessions: at most 8 ledgers, 7-day sweep', () => {
  const idx = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`s${i}`, T0 + i]))
  const { index, drop } = touchIndex(idx, 'new', T0 + 100)
  assert.deepEqual(drop, ['s0'])
  assert.equal(Object.keys(index).length, 8)
  assert.equal(index.new, T0 + 100)
  assert.deepEqual(staleSessions({ a: T0 - 8 * DAY, b: T0 - DAY, c: 'x' }, T0), ['a', 'c'])
  assert.deepEqual(staleSessions(null, T0), [])
})

test('firstJsonArray: skips prose, brackets inside strings and broken arrays', () => {
  assert.deepEqual(firstJsonArray('Sure. [not json] then [{"quote":"a [b]","missing":"c"}] tail'), [{ quote: 'a [b]', missing: 'c' }])
  assert.deepEqual(firstJsonArray('```json\n[]\n```'), [])
  assert.deepEqual(firstJsonArray('[{"q":"say \\"hi\\" ]"}]'), [{ q: 'say "hi" ]' }])
  assert.equal(firstJsonArray('no array here'), undefined)
  assert.equal(firstJsonArray(undefined), undefined)
})

test('toItems, itemsFromFork, itemsFromLabel: the JSON contract and its fallback', () => {
  const arr = [{ quote: 'a', missing: 'm' }, { quote: '' }, null, 'x', { quote: 'b', missing: 3 }, { quote: 'c' }]
  assert.deepEqual(toItems(arr, 2), [{ quote: 'a', missing: 'm' }, { quote: 'b', missing: '' }])
  assert.deepEqual(itemsFromFork({ isAnswered: true, text: 'x [{"quote":"q"}]' }, 5), [{ quote: 'q', missing: '' }])
  assert.equal(itemsFromFork({ isAnswered: true, text: 'fine' }, 5), undefined)
  assert.equal(itemsFromFork({ isAnswered: false, reason: 'r' }, 5), undefined)
  assert.equal(itemsFromFork(undefined, 5), undefined)
  assert.equal(itemsFromLabel('something dropped').length, 1)
  assert.deepEqual(itemsFromLabel('all addressed'), [])
  assert.equal(itemsFromLabel(undefined), undefined)
})

test('checkPrompt and classifyText: numbered ledger, entries cut to 2,000 characters', () => {
  const l = [{ kind: 'prompt', text: 'one' }, { kind: 'answer', text: 'w'.repeat(5_000) }]
  const p = checkPrompt(l, 3)
  assert.match(p, /at most 3 items/)
  assert.match(p, /1\. \[prompt\] one/)
  assert.ok(p.includes(`2. [answer] ${'w'.repeat(2_000)}`) && !p.includes('w'.repeat(2_001)))
  assert.match(classifyText(l, 'reply'), /\[prompt\] one[\s\S]*Last assistant message:\nreply$/)
})

test('finding and statusText: the lines Claude and the user see', () => {
  assert.equal(finding([{ quote: 'use tabs', missing: 'spaces used' }, { quote: 'no deps', missing: '' }]),
    '[instruction-keeper] Not yet addressed: "use tabs" (missing: spaces used); "no deps"')
  assert.equal(statusText(2), 'instruction-keeper: 2 open')
  assert.equal(statusText(0), undefined)
})

test('aheadOfLine: the cost guard maths and the shapes it accepts', () => {
  const half = T0 + 3.5 * DAY // half the week gone: the line is at 50%
  assert.equal(aheadOfLine(JSON.stringify({ seven_day: { used_percentage: 51, resets_at: half / 1000 } }), T0), true)
  assert.equal(aheadOfLine(JSON.stringify({ seven_day: { pct: 49, resets_at: String(half / 1000) } }), T0), false)
  assert.equal(aheadOfLine(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 60, resets_at: new Date(half).toISOString() } } }), T0), true)
  assert.equal(aheadOfLine(JSON.stringify({ five_hour: { percentUsed: 30, resetsAt: T0 + 2.5 * 3_600_000 } }), T0, { window: 'five_hour', windowMs: 5 * 3_600_000 }), false)
  assert.equal(aheadOfLine(JSON.stringify({ seven_day: { used_percentage: 99, resets_at: (T0 - DAY) / 1000 } }), T0), undefined) // stale
  assert.equal(aheadOfLine(JSON.stringify({ seven_day: { used_percentage: 99, resets_at: (T0 + 9 * DAY) / 1000 } }), T0), undefined) // nonsense
  assert.equal(aheadOfLine('{nope', T0), undefined)
  assert.equal(aheadOfLine(JSON.stringify({ seven_day: {} }), T0), undefined)
  assert.equal(aheadOfLine('{}', T0), undefined)
})

test('shouldCheckAtTurnEnd: 8 calls, 10-minute rate limit, cost guard', () => {
  const base = { calls: 8, now: T0, lastCheck: 0, ahead: false }
  assert.equal(shouldCheckAtTurnEnd(base), true)
  assert.equal(shouldCheckAtTurnEnd({ ...base, calls: 7 }), false)
  assert.equal(shouldCheckAtTurnEnd({ ...base, lastCheck: T0 - 9 * 60_000 }), false)
  assert.equal(shouldCheckAtTurnEnd({ ...base, lastCheck: T0 - 10 * 60_000 }), true)
  assert.equal(shouldCheckAtTurnEnd({ ...base, ahead: true }), false)
  assert.equal(shouldCheckAtTurnEnd({ ...base, ahead: undefined }), true)
  const c = resolveConfig({ check: { minToolCalls: 2, rateLimitMinutes: 0 } }).check
  assert.equal(shouldCheckAtTurnEnd({ ...base, calls: 2, lastCheck: T0 }, c), true)
})

test('classifyCall and nudgeStep: counting read-only calls, resetting on delegation', () => {
  assert.equal(classifyCall('Read'), 'read')
  assert.equal(classifyCall('Bash', 'git status'), 'read')
  assert.equal(classifyCall('Bash', 'sed -n 1,5p f'), 'read')
  assert.equal(classifyCall('Bash', 'sed -i s/a/b/ f'), 'other')
  assert.equal(classifyCall('Bash', 'catalogue'), 'other')
  assert.equal(classifyCall('Edit'), 'other')
  assert.equal(classifyCall('Agent'), 'reset')
  assert.equal(classifyCall('Workflow'), 'reset')
  const n = resolveConfig({ nudge: { resetTools: ['Task'], resetBash: ['^my-runner\\b'], readTools: ['Read', 'mcp__docs__search'] } }).nudge
  assert.equal(classifyCall('Agent', '', n), 'other')
  assert.equal(classifyCall('Task', '', n), 'reset')
  assert.equal(classifyCall('Bash', 'my-runner go', n), 'reset')
  assert.equal(classifyCall('mcp__docs__search', '', n), 'read')
  let st = { count: 0, nudge: false }
  const fired = []
  for (let i = 0; i < 7; i++) {
    st = nudgeStep(st.count, 'read', 3)
    fired.push(st.nudge)
  }
  assert.deepEqual(fired, [false, false, true, false, false, true, false])
  assert.deepEqual(nudgeStep(2, 'other', 3), { count: 2, nudge: false })
  assert.deepEqual(nudgeStep(2, 'reset', 3), { count: 0, nudge: false })
  assert.equal(nudgeText('{count} calls, {count}!', 25), '25 calls, 25!')
})

test('pinText: open quotes then the last 10 entries, each cut to 500 characters', () => {
  assert.equal(pinText(undefined, []), '')
  const ledger = Array.from({ length: 12 }, (_, i) => ({ text: `e${i}` }))
  const t = pinText({ items: [{ quote: 'q'.repeat(600) }] }, ledger)
  assert.ok(t.startsWith('\nKeep these open user instructions verbatim in the summary: \n- ' + 'q'.repeat(500) + '\n- e2'))
  assert.ok(t.endsWith('\n- e11'))
  assert.ok(!t.includes('e1\n'))
  assert.equal(pinText({ items: [{ quote: 'same' }] }, [{ text: 'same' }]), '\nKeep these open user instructions verbatim in the summary: \n- same')
})

test('parseSeed and seedRows: the seed file format', () => {
  const md = [
    '## 1. prompt · 2026-10-19T08:06:57.893Z', '````text', 'a', '````',
    '## 2. answer | not-a-date', '````text', 'b', '```', 'c', '````',
    '## 3. prompt · 2026-10-19T09:00:00Z', 'no fence here',
    '## 4. prompt - 2026-10-19T10:00:00Z', '````text', 'unterminated',
  ].join('\n')
  assert.deepEqual(parseSeed(md), [
    { kind: 'prompt', ts: '2026-10-19T08:06:57.893Z', text: 'a' },
    { kind: 'answer', ts: 'not-a-date', text: 'b\n```\nc' },
    { kind: 'prompt', ts: '2026-10-19T10:00:00Z', text: 'unterminated' },
  ])
  const rows = seedRows(md, [{ kind: 'seed', text: 'a' }])
  assert.deepEqual(rows, [{ kind: 'seed', text: 'b\n```\nc' }, { kind: 'seed', text: 'unterminated', ts: Date.parse('2026-10-19T10:00:00Z') }])
})

test('resolveConfig: defaults, type checks and the usage-file env override', () => {
  assert.equal(BASE.check.minToolCalls, 8)
  assert.equal(BASE.check.rateLimitMs, 600_000)
  assert.equal(BASE.costGuard.usageFile, '')
  assert.deepEqual(BASE.nudge.resetTools, ['Agent', 'Workflow'])
  assert.deepEqual(BASE.nudge.resetBash, [])
  const c = resolveConfig({ check: { minToolCalls: 'x', maxItems: 0 }, nudge: { threshold: -1, readOnlyBash: '(' }, costGuard: { usageFile: '/a.json' } })
  assert.equal(c.check.minToolCalls, 8)
  assert.equal(c.check.maxItems, 5)
  assert.equal(c.nudge.threshold, 25)
  assert.ok(c.nudge.readOnlyBash.test('ls'))
  assert.equal(c.costGuard.usageFile, '/a.json')
  assert.equal(resolveConfig({ costGuard: { usageFile: '/a.json' } }, { usageFile: '/env.json' }).costGuard.usageFile, '/env.json')
  assert.deepEqual(resolveConfig(null), resolveConfig({}))
  assert.deepEqual(resolveConfig([1, 2]), resolveConfig({}))
})

test('stateDir, paths, safeId, expandHome', () => {
  assert.equal(stateDir('/home/u/'), '/home/u/.claude/headless-kit')
  assert.equal(stateDir('/home/u', ' /srv/kit/ '), '/srv/kit')
  assert.equal(stateDir(undefined), undefined)
  assert.deepEqual(paths('/k', 'a/b:c'), {
    config: '/k/instruction-keeper/config.json',
    usage: '/k/instruction-keeper/usage/a_b_c.json',
    nudges: '/k/instruction-keeper/nudges.ndjson',
  })
  assert.equal(paths(undefined, 's'), undefined)
  assert.equal(safeId(''), 'unknown')
  assert.equal(expandHome('~/x.md', '/home/u/'), '/home/u/x.md')
  assert.equal(expandHome('~', '/home/u'), '/home/u')
  assert.equal(expandHome('/abs.md', '/home/u'), '/abs.md')
  assert.equal(expandHome('~/x', undefined), '~/x')
})
