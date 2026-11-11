// instruction-keeper: a Claude Code mod that keeps a verbatim ledger of what the user asked for and checks,
// now and then, that the work has not dropped any of it. The pure logic is in core.mjs; this file is the glue
// to the mods API. Every handler is wrapped in try/catch and always passes the event on: it never blocks.
import type { EngineInterface, Register } from 'claude-code'
import {
  CLASSIFY_LABELS,
  LIMITS,
  STORE_PREFIXES,
  appendEntries,
  checkPrompt,
  classifyCall,
  classifyText,
  expandHome,
  finding,
  isHumanPrompt,
  isWrapper,
  itemsFromFork,
  itemsFromLabel,
  aheadOfLine,
  nudgeStep,
  nudgeText,
  paths,
  pinText,
  promptKind,
  resolveConfig,
  seedRows,
  shouldCheckAtTurnEnd,
  staleSessions,
  stateDir,
  statusText,
  touchIndex,
} from './core.mjs'

type Kind = 'prompt' | 'midturn' | 'answer' | 'seed'
type Entry = { n: number; ts: number; kind: Kind; text: string }
type Item = { quote: string; missing: string }
type Open = { items: Item[]; ts: number }
type Config = ReturnType<typeof resolveConfig>
type Dollar = EngineInterface

// State that is not in the store lives here and resets when the module reloads.
type State = {
  turnCalls: number
  readCalls: number
  lastCheck: number
  justCompacted: boolean
  pendingTool: string | undefined
  pendingPrompt: string | undefined
  commandRegistered: boolean
  config: Config | undefined
  chain: Promise<unknown>
}

const newState = (): State => ({
  turnCalls: 0,
  readCalls: 0,
  lastCheck: 0,
  justCompacted: false,
  pendingTool: undefined,
  pendingPrompt: undefined,
  commandRegistered: false,
  config: undefined,
  chain: Promise.resolve(),
})

// Store writes run one at a time, so two hooks never interleave a read-modify-write.
const serial = <T>(s: State, fn: () => Promise<T>): Promise<T> => {
  const p = s.chain.then(fn, fn)
  s.chain = p.then(
    () => undefined,
    () => undefined,
  )
  return p
}

// ------------------------------------------------------------------ environment and config

const home = async ($: Dollar): Promise<string | undefined> =>
  (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))

const dirOf = async ($: Dollar): Promise<string | undefined> =>
  stateDir(await home($), await $.env.get('HEADLESS_KIT_STATE_DIR'))

// The config file: INSTRUCTION_KEEPER_CONFIG, else <state dir>/instruction-keeper/config.json.
// Missing or unreadable means the defaults. Read once per module load.
const config = async ($: Dollar, s: State): Promise<Config> => {
  if (s.config !== undefined) return s.config
  let raw: unknown = {}
  try {
    const named = await $.env.get('INSTRUCTION_KEEPER_CONFIG')
    const p = named !== undefined && named !== '' ? expandHome(named, await home($)) : paths(await dirOf($), 'x')?.config
    if (p !== undefined) raw = JSON.parse(await $.fs.read(p))
  } catch {
    raw = {}
  }
  let usageFile = ''
  try {
    usageFile = expandHome((await $.env.get('INSTRUCTION_KEEPER_USAGE_FILE')) ?? '', await home($))
  } catch {
    usageFile = ''
  }
  const c = resolveConfig(raw, { usageFile })
  if (c.costGuard.usageFile !== '') c.costGuard.usageFile = expandHome(c.costGuard.usageFile, await home($))
  s.config = c
  return c
}

// ------------------------------------------------------------------ ledger store

const addEntries = (
  $: Dollar,
  s: State,
  sid: string,
  items: readonly { kind: Kind; text: string; ts?: number }[],
  cfg: Config,
): Promise<number> =>
  serial(s, async () => {
    const now = await $.clock.now()
    const key = `ledger:${sid}`
    const kept = appendEntries(await $.store.get(key), items, now, { redact: cfg.ledger.redact })
    await $.store.set(key, kept)
    const { index, drop } = touchIndex(await $.store.get('ledger-index'), sid, now)
    for (const old of drop) await $.store.delete(`ledger:${old}`)
    await $.store.set('ledger-index', index)
    return kept.length
  })

const readLedger = async ($: Dollar, sid: string): Promise<Entry[]> => {
  const v = await $.store.get(`ledger:${sid}`)
  return Array.isArray(v) ? (v as Entry[]) : []
}

// Ledgers untouched for 7 days go, with their open items, compaction counts and usage fallbacks.
const sweep = ($: Dollar, s: State): Promise<void> =>
  serial(s, async () => {
    const now = await $.clock.now()
    const raw = await $.store.get('ledger-index')
    const stale = staleSessions(raw, now)
    if (stale.length === 0) return
    const index = { ...(raw as Record<string, number>) }
    for (const sid of stale) {
      delete index[sid]
      for (const k of STORE_PREFIXES) await $.store.delete(`${k}:${sid}`)
    }
    await $.store.set('ledger-index', index)
  })

const showStatus = ($: Dollar, n: number): void => {
  $.ui.status(statusText(n))
}

// ------------------------------------------------------------------ the check

// The cost guard: true only when a usage file is configured, readable and ahead of the straight line.
const ahead = async ($: Dollar, cfg: Config): Promise<boolean> => {
  if (cfg.costGuard.usageFile === '') return false
  try {
    const raw = await $.fs.read(cfg.costGuard.usageFile)
    return aheadOfLine(raw, await $.clock.now(), cfg.costGuard) === true
  } catch {
    return false // missing or unreadable: the normal cadence
  }
}

const runCheck = async ($: Dollar, s: State, sid: string, cfg: Config): Promise<void> => {
  const ledger = (await readLedger($, sid)).slice(-LIMITS.maxEntries)
  if (ledger.length === 0) return
  s.lastCheck = await $.clock.now()

  // First: a fork over the current conversation (cheap, from the prompt cache), answering in JSON.
  let items: Item[] | undefined
  try {
    const r = await $.model.fork({ prompt: checkPrompt(ledger, cfg.check.maxItems) })
    items = itemsFromFork(r, cfg.check.maxItems)
  } catch {
    // fall through to the cold-cache check
  }

  // Fallback: a two-label classify over the last entries and the last assistant message.
  if (items === undefined) {
    try {
      const msgs = await $.session.messages()
      const last = Array.isArray(msgs) ? [...msgs].reverse().find(m => m.role === 'assistant') : undefined
      const label = await $.model.classify(classifyText(ledger, last?.text ?? ''), [...CLASSIFY_LABELS])
      items = itemsFromLabel(label)
    } catch {
      // no verdict: leave what is stored as it is
    }
  }
  if (items === undefined) return

  const open: Open = { items, ts: await $.clock.now() }
  await $.store.set(`open:${sid}`, open)
  showStatus($, items.length)
  const note = items.length > 0 ? finding(items) : undefined
  s.pendingTool = note
  s.pendingPrompt = note
}

// Runs the check; never throws.
const check = async ($: Dollar, s: State): Promise<void> => {
  try {
    await runCheck($, s, await $.session.id(), await config($, s))
  } catch {
    // never block
  }
}

const ensureCommand = async ($: Dollar, s: State): Promise<void> => {
  if (s.commandRegistered) return
  s.commandRegistered = true
  try {
    await $.command.register({
      name: 'keeper-seed',
      description: 'Add earlier messages to the instruction ledger from a seed file',
      argumentHint: '<path to seed .md file>',
    })
  } catch {
    s.commandRegistered = false
  }
}

// ------------------------------------------------------------------ records

const writeUsage = async ($: Dollar, sid: string, cfg: Config): Promise<void> => {
  if (!cfg.records.usage) return
  const u = await $.session.usage()
  const record = {
    sessionId: sid,
    ts: await $.clock.now(),
    contextTokens: u?.context?.tokens ?? 0,
    windowSize: u?.context?.window,
    compactions: Number((await $.store.get(`compactions:${sid}`)) ?? 0),
  }
  try {
    const p = paths(await dirOf($), sid)
    if (p === undefined) throw new Error('no state folder')
    await $.fs.write(p.usage, JSON.stringify(record))
  } catch {
    await $.store.set(`usage:${sid}`, record)
  }
}

const logNudge = ($: Dollar, s: State, count: number, cfg: Config): Promise<void> =>
  serial(s, async () => {
    if (!cfg.records.nudges) return
    try {
      const sid = await $.session.id()
      const row = { ts: await $.clock.now(), session: sid, count }
      try {
        const p = paths(await dirOf($), sid)
        if (p === undefined) throw new Error('no state folder')
        const prev = await $.fs.read(p.nudges).catch(() => '')
        await $.fs.write(p.nudges, prev + JSON.stringify(row) + '\n')
      } catch {
        const old = await $.store.get('nudges')
        await $.store.set('nudges', [...(Array.isArray(old) ? old : []), row].slice(-100))
      }
    } catch {
      // never block
    }
  })

// ------------------------------------------------------------------ register

export const register: Register = on => {
  const s = newState()

  on('session.start', async ($, e, next) => {
    try {
      await ensureCommand($, s)
      await sweep($, s)
      const open = (await $.store.get(`open:${await $.session.id()}`)) as Open | undefined
      if (open?.items?.length) showStatus($, open.items.length)
    } catch {
      // never block
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    let out = e
    try {
      await ensureCommand($, s)
      const cfg = await config($, s)
      const sid = await $.session.id()
      const human = isHumanPrompt(e, cfg.ledger.ignorePrefixes)
      if (human && !e.text.trimStart().startsWith('/keeper-seed')) {
        await addEntries($, s, sid, [{ kind: promptKind(e), text: e.text }], cfg)
      }
      if (s.justCompacted && !isWrapper(e.text, cfg.ledger.ignorePrefixes)) {
        s.justCompacted = false
        await runCheck($, s, sid, cfg) // after a compaction: ignores the rate limit and the cost guard
      }
      if (human && s.pendingPrompt !== undefined && e.command === undefined) {
        out = { ...e, context: [...(e.context ?? []), s.pendingPrompt] }
        s.pendingPrompt = undefined
      }
    } catch {
      // never block
    }
    return next(out)
  })

  // The generic tool hook counts calls, nudges and delivers findings. It is registered first, so it wraps the
  // tool hooks below and sees their final result.
  on('tool.call', async ($, e, next) => {
    const notes: string[] = []
    try {
      if (e.agentId === undefined) {
        s.turnCalls++
        const cfg = await config($, s)
        if (cfg.nudge.enabled) {
          const cmd = (e as { command?: unknown }).command
          const step = nudgeStep(s.readCalls, classifyCall(String(e.tool), cmd, cfg.nudge), cfg.nudge.threshold)
          s.readCalls = step.count
          if (step.nudge) {
            notes.push(nudgeText(cfg.nudge.text, cfg.nudge.threshold))
            await logNudge($, s, cfg.nudge.threshold, cfg)
          }
        }
      }
    } catch {
      // never block
    }
    const ran = await next(e)
    try {
      if (s.pendingTool !== undefined && e.agentId === undefined) {
        notes.push(s.pendingTool)
        s.pendingTool = undefined
      }
      if (notes.length > 0 && ran.deny === undefined && ran.isError !== true) {
        return { ...ran, context: [...(ran.context ?? []), ...notes] }
      }
    } catch {
      // never block
    }
    return ran
  })

  // The user's answers to AskUserQuestion are instructions too: one entry per question, after the tool ran.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      if (ran.deny === undefined && ran.isError !== true) {
        const res = ran.result as { answers?: Record<string, unknown>; response?: unknown } | undefined
        const rows: { kind: Kind; text: string }[] = []
        for (const [q, a] of Object.entries(res?.answers ?? {})) {
          rows.push({ kind: 'answer', text: `Q: ${q}\nA: ${typeof a === 'string' ? a : JSON.stringify(a)}` })
        }
        if (typeof res?.response === 'string' && res.response.trim() !== '') {
          rows.push({ kind: 'answer', text: res.response })
        }
        if (rows.length > 0) await addEntries($, s, await $.session.id(), rows, await config($, s))
      }
    } catch {
      // never block
    }
    return ran
  })

  // Before a plan reaches the user: ignores the rate limit and the cost guard, and always passes the call on.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    await check($, s)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    const calls = s.turnCalls
    s.turnCalls = 0
    try {
      const cfg = await config($, s)
      const sid = await $.session.id()
      await writeUsage($, sid, cfg)
      const now = await $.clock.now()
      if (calls >= cfg.check.minToolCalls && now - s.lastCheck >= cfg.check.rateLimitMs) {
        const isAhead = await ahead($, cfg)
        if (shouldCheckAtTurnEnd({ calls, now, lastCheck: s.lastCheck, ahead: isAhead }, cfg.check)) {
          await runCheck($, s, sid, cfg)
        }
      }
    } catch {
      // never block
    }
    return r
  })

  // Pin the open items and the latest instructions into the compaction summary, then count the compaction.
  on('session.compact', async ($, e, next) => {
    let out = e
    if (e.agentId === undefined) {
      try {
        const sid = await $.session.id()
        const open = (await $.store.get(`open:${sid}`)) as Open | undefined
        const pin = pinText(open, await readLedger($, sid))
        if (pin !== '') out = { ...e, instructions: (e.instructions ?? '') + pin }
      } catch {
        // never block
      }
    }
    const r = await next(out)
    try {
      if (e.agentId === undefined && e.trigger !== 'precompute' && r.skip === undefined) {
        const k = `compactions:${await $.session.id()}`
        await $.store.set(k, Number((await $.store.get(k)) ?? 0) + 1)
        s.justCompacted = true
      }
    } catch {
      // never block
    }
    return r
  })

  on('command.run', { command: 'keeper-seed' }, async ($, e) => {
    try {
      const arg = e.args.trim().replace(/^["']|["']$/g, '')
      if (arg === '') return { text: 'Usage: /keeper-seed <path to seed .md file>' }
      const md = await $.fs.read(expandHome(arg, await home($)))
      const cfg = await config($, s)
      const sid = await $.session.id()
      const rows = seedRows(md, await readLedger($, sid), cfg.ledger.redact)
      if (rows.length === 0) return { text: 'Seeded 0 messages (nothing new found in that file).' }
      const kept = await addEntries($, s, sid, rows, cfg)
      return { text: `Seeded ${rows.length} messages into the ledger (${kept} entries kept after limits).` }
    } catch (err) {
      return { text: `keeper-seed failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
