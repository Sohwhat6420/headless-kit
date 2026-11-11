// A small stand-in for Claude Code's mod engine, enough to drive register.ts from plain Node.
// It mirrors the documented behaviour the mod relies on: hooks run in registration order as middleware,
// a matcher filters on event fields, events are frozen, and a hook that throws before calling next is
// skipped (fail open), while one that throws after next keeps next's result.
// What it does NOT reproduce: tiers, time limits, real models, real files. Only $ calls the mod makes exist.

const deepFreeze = v => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze(v[k])
  }
  return v
}
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const matches = (m, e) => m === undefined || Object.entries(m).every(([k, v]) => e?.[k] === v)

/**
 * createEngine(register, opts) -> { $, store, files, writes, statuses, forks, classified, promptsSeen,
 *   compactInstructions, commands, skipped, clock }
 * `$` here is the TEST's side: $.prompt.submit(e), $.tool.call(e), $.turn.complete(e), $.session.start(e),
 * $.session.compact(e), $.command.run(e) raise those events through the mod's hooks.
 */
export const createEngine = (register, opts = {}) => {
  const t = { now: opts.now ?? 1_800_000_000_000 }
  const r = {
    store: new Map(Object.entries(opts.store ?? {})),
    files: { ...(opts.files ?? {}) },
    writes: {},
    statuses: [],
    forks: [],
    classified: [],
    promptsSeen: [],
    compactInstructions: [],
    commands: [],
    skipped: [],
  }
  const env = { HOME: '/home/t', ...(opts.env ?? {}) }
  const sid = opts.sessionId ?? 'sess-1'
  const fork = opts.fork ?? (() => ({ isAnswered: true, text: '[]', usage: {} }))

  // The mods API a hook receives.
  const api = {
    env: { get: async k => env[k] },
    clock: { now: async () => t.now },
    store: {
      get: async k => {
        if (opts.brokenStore) throw new Error('store unavailable')
        return clone(r.store.get(k))
      },
      set: async (k, v) => void r.store.set(k, clone(v)),
      delete: async k => void r.store.delete(k),
      keys: async () => [...r.store.keys()],
    },
    fs: {
      read: async p => {
        if (!(p in r.files)) throw new Error(`ENOENT: ${p}`)
        return r.files[p]
      },
      write: async (p, text) => {
        if (opts.failWrites) throw new Error('EACCES')
        r.files[p] = text
        r.writes[p] = text
      },
    },
    ui: { status: text => void r.statuses.push(text) },
    model: {
      fork: async ({ prompt }) => {
        r.forks.push(prompt)
        return fork(prompt)
      },
      classify: async (text, labels) => {
        r.classified.push({ text, labels })
        return opts.classify
      },
    },
    session: {
      id: async () => sid,
      messages: async () => [{ role: 'assistant', text: opts.assistant ?? 'done', toolUses: [] }],
      usage: async () => ({ startedAt: 0, context: { tokens: 1234, window: 200000 }, rateLimits: [] }),
    },
    command: {
      register: async c => {
        r.commands.push(c.name)
        return { command: c.name }
      },
    },
  }
  Object.freeze(api)

  // What Claude Code itself answers once every hook has passed the event on.
  const core = {
    'prompt.submit': e => {
      r.promptsSeen.push({ text: e.text, context: e.context })
      return { text: e.text, context: e.context }
    },
    'tool.call': e =>
      e.tool === 'AskUserQuestion' ? { result: { questions: [], answers: opts.answers ?? {} }, text: 'answered' } : { result: 'ok', text: 'ok' },
    'turn.complete': () => ({ text: '' }),
    'session.start': e => ({ cwd: e.cwd }),
    'session.compact': e => {
      r.compactInstructions.push(e.instructions)
      return { messages: [{ role: 'assistant', text: 'summary', toolUses: [] }] }
    },
    'command.run': () => ({ text: 'unknown command' }),
    ...(opts.core ?? {}),
  }

  const hooks = []
  const on = (name, a, b) => {
    const [matcher, fn] = typeof a === 'function' ? [undefined, a] : [a, b]
    hooks.push({ name, matcher, fn })
    return { catch: () => undefined }
  }
  register(on, {})

  const raise = async (name, event) => {
    const list = hooks.filter(h => h.name === name && matches(h.matcher, event))
    const run = async (i, e) => {
      deepFreeze(e)
      if (i === list.length) return core[name](e)
      let called = false
      let result
      const next = async x => {
        called = true
        result = await run(i + 1, x)
        return result
      }
      try {
        return await list[i].fn(api, e, next)
      } catch (err) {
        r.skipped.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
        return called ? result : run(i + 1, e)
      }
    }
    return run(0, event)
  }

  const $ = {
    prompt: { submit: e => raise('prompt.submit', { wait: false, origin: { kind: 'composer' }, ...e }) },
    tool: { call: e => raise('tool.call', e) },
    turn: { complete: (e = {}) => raise('turn.complete', { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', ...e }) },
    session: {
      start: (e = {}) => raise('session.start', { cwd: '/tmp', surface: null, isInteractive: false, ...e }),
      compact: e => raise('session.compact', { trigger: 'manual', messages: [], ...e }),
    },
    command: { run: e => raise('command.run', { origin: { kind: 'composer' }, ...e }) },
  }

  return { $, ...r, clock: { now: () => t.now, advance: ms => void (t.now += ms) } }
}
