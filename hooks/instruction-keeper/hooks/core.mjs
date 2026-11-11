// instruction-keeper: the pure logic, with no mods API and no Node.js APIs.
// register.ts (the mod) and the Node tests both import this file. Nothing here takes `$`:
// Claude Code's static analysis refuses a hooks module that passes `$` to an imported function.

export const DAY = 86_400_000
export const TRUNC = ' …[truncated]'

/** Limits that bound the store (4 MiB in all): 8 ledgers x 200,000 chars = 1.6 MB worst case. */
export const LIMITS = Object.freeze({
  maxEntries: 200,
  maxEntryChars: 20_000,
  maxLedgerChars: 200_000,
  maxLedgers: 8,
  promptEntryChars: 2_000,
  staleMs: 7 * DAY,
  pinChars: 500,
  pinEntries: 10,
  classifyEntries: 30,
  lastAssistantChars: 6_000,
})

/** Prompts that start with one of these are machine messages, not the user's words. */
export const WRAPPERS = Object.freeze([
  '<task-notification',
  '<cross-session-message',
  '<scheduled-task',
  '<side-sessions-event',
])

/** Prompt origins that are a person typing (or an SDK client acting for one). */
export const HUMAN_ORIGINS = Object.freeze(['composer', 'bridge', 'sdk'])

export const DEFAULT_READ_ONLY_BASH = '^\\s*(cat|head|tail|ls|grep|rg|find|sed -n|wc|git (log|status|diff|show))(\\s|$)'

export const DEFAULTS = Object.freeze({
  check: { minToolCalls: 8, rateLimitMinutes: 10, maxItems: 5 },
  costGuard: { usageFile: '', window: 'seven_day', windowHours: 168 },
  nudge: {
    enabled: true,
    threshold: 25,
    readTools: ['Read', 'Grep', 'Glob', 'WebFetch'],
    readOnlyBash: DEFAULT_READ_ONLY_BASH,
    resetTools: ['Agent', 'Workflow'],
    resetBash: [],
    text: 'Delegation check: {count} read-only calls in a row in the main conversation. Hand the rest to a subagent, or say in one line why doing it here is better.',
  },
  ledger: { ignorePrefixes: [], redact: [] },
  records: { usage: true, nudges: true },
})

export const CHECK_PROMPT =
  'Which of these user instructions has the work so far not addressed, contradicted or dropped? ' +
  'JSON array, at most {max} items, each {"quote": the user\'s exact words, "missing": what is missing}; [] if none.'

export const COLD_ITEM = Object.freeze({
  quote: '(cold-cache check)',
  missing: 'possible dropped instruction: re-read the ledger',
})

export const CLASSIFY_LABELS = Object.freeze(['all addressed', 'something dropped'])

// ------------------------------------------------------------------ config

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const num = (v, d, min = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d)
const str = (v, d) => (typeof v === 'string' ? v : d)
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const strs = (v, d) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : d)

/** A regex from config, or undefined when it does not compile (a bad pattern is ignored, never thrown). */
export const toRegex = (src, flags = '') => {
  if (typeof src !== 'string' || src === '') return undefined
  try {
    return new RegExp(src, flags)
  } catch {
    return undefined
  }
}

/**
 * Merge a parsed config file (or anything) over the defaults, type by type.
 * `env.usageFile` (from INSTRUCTION_KEEPER_USAGE_FILE) wins over the file's costGuard.usageFile.
 */
export const resolveConfig = (raw, env = {}) => {
  const r = isObj(raw) ? raw : {}
  const c = isObj(r.check) ? r.check : {}
  const g = isObj(r.costGuard) ? r.costGuard : {}
  const n = isObj(r.nudge) ? r.nudge : {}
  const l = isObj(r.ledger) ? r.ledger : {}
  const rec = isObj(r.records) ? r.records : {}
  const D = DEFAULTS
  const readOnlyBash = str(n.readOnlyBash, D.nudge.readOnlyBash)
  return {
    check: {
      minToolCalls: num(c.minToolCalls, D.check.minToolCalls),
      rateLimitMs: num(c.rateLimitMinutes, D.check.rateLimitMinutes) * 60_000,
      maxItems: Math.max(1, Math.floor(num(c.maxItems, D.check.maxItems, 1))),
    },
    costGuard: {
      usageFile: str(env.usageFile, '') || str(g.usageFile, D.costGuard.usageFile),
      window: str(g.window, D.costGuard.window) || D.costGuard.window,
      windowMs: num(g.windowHours, D.costGuard.windowHours, 1) * 3_600_000,
    },
    nudge: {
      enabled: bool(n.enabled, D.nudge.enabled),
      threshold: Math.max(1, Math.floor(num(n.threshold, D.nudge.threshold, 1))),
      readTools: strs(n.readTools, D.nudge.readTools),
      readOnlyBash: toRegex(readOnlyBash) ?? toRegex(DEFAULT_READ_ONLY_BASH),
      resetTools: strs(n.resetTools, D.nudge.resetTools),
      resetBash: strs(n.resetBash, D.nudge.resetBash).map(p => toRegex(p)).filter(Boolean),
      text: str(n.text, D.nudge.text) || D.nudge.text,
    },
    ledger: {
      ignorePrefixes: strs(l.ignorePrefixes, []),
      redact: strs(l.redact, []).map(p => toRegex(p, 'g')).filter(Boolean),
    },
    records: { usage: bool(rec.usage, D.records.usage), nudges: bool(rec.nudges, D.records.nudges) },
  }
}

/** The defaults, resolved once. */
export const BASE = resolveConfig({})

// ------------------------------------------------------------------ paths

const trimSlash = p => p.replace(/[\\/]+$/, '')

/** The state folder: HEADLESS_KIT_STATE_DIR, else <home>/.claude/headless-kit. */
export const stateDir = (home, envDir) => {
  if (typeof envDir === 'string' && envDir.trim() !== '') return trimSlash(envDir.trim())
  if (typeof home !== 'string' || home === '') return undefined
  return `${trimSlash(home)}/.claude/headless-kit`
}

/** A session id made safe to use as a file name. */
export const safeId = sid => String(sid).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown'

export const paths = (dir, sid) =>
  dir === undefined
    ? undefined
    : {
        config: `${dir}/instruction-keeper/config.json`,
        usage: `${dir}/instruction-keeper/usage/${safeId(sid)}.json`,
        nudges: `${dir}/instruction-keeper/nudges.ndjson`,
      }

/** `~`, `~/x` and `~\x` expanded against home. */
export const expandHome = (p, home) => {
  if (typeof home !== 'string' || home === '') return p
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return trimSlash(home) + p.slice(1)
  return p
}

// ------------------------------------------------------------------ ledger text

// Well-known credential shapes. Each keeps its prefix, so the ledger still shows what kind of key was there.
const TOKEN_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]'],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, '$1[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g, '$1[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'AIza[REDACTED]'],
]
// `MY_API_KEY=longvalue`: an upper-case name containing KEY, TOKEN, SECRET or PASSWORD, value of 8+ characters.
const ASSIGNMENT = /^([ \t]*(?:export[ \t]+)?)([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)[ \t]*=[ \t]*\S{8,}/gm

/** Redact secrets before anything is stored. `extra` is a list of global regexes from config. */
export const redact = (text, extra = []) => {
  let out = String(text)
  for (const [re, rep] of TOKEN_PATTERNS) out = out.replace(re, rep)
  out = out.replace(ASSIGNMENT, '$1$2=[REDACTED]')
  for (const re of extra) out = out.replace(re, '[REDACTED]')
  return out
}

export const cut = (s, n) => (s.length > n ? s.slice(0, n) : s)

/** Redact, then cap one entry's length. */
export const clean = (text, extra = [], max = LIMITS.maxEntryChars) => {
  const r = redact(text, extra)
  return r.length > max ? r.slice(0, max) + TRUNC : r
}

export const isWrapper = (text, extraPrefixes = []) => {
  const t = String(text).trimStart()
  return WRAPPERS.some(w => t.startsWith(w)) || extraPrefixes.some(w => w !== '' && t.startsWith(w))
}

/** Whether a prompt.submit event is the user's own words (and so belongs in the ledger). */
export const isHumanPrompt = (e, extraPrefixes = []) => {
  if (e === null || typeof e !== 'object' || typeof e.text !== 'string') return false
  if (e.isMeta) return false
  const origin = e.origin?.kind
  if (origin !== undefined && !HUMAN_ORIGINS.includes(origin)) return false
  return !isWrapper(e.text, extraPrefixes)
}

/** A prompt typed while a turn runs carries turnId: that is what marks it mid-turn. */
export const promptKind = e => (e.turnId !== undefined ? 'midturn' : 'prompt')

/**
 * Append entries to a ledger and apply the limits. Pure: returns a new array.
 * items: [{kind, text, ts?}]; blank texts are skipped; numbering continues from the last entry.
 */
export const appendEntries = (ledger, items, now, opts = {}) => {
  const lim = { ...LIMITS, ...opts }
  const out = Array.isArray(ledger) ? ledger.slice() : []
  let n = out.at(-1)?.n ?? 0
  for (const it of items) {
    if (typeof it?.text !== 'string' || it.text.trim() === '') continue
    out.push({ n: ++n, ts: it.ts ?? now, kind: it.kind, text: clean(it.text, lim.redact ?? [], lim.maxEntryChars) })
  }
  const kept = out.slice(-lim.maxEntries)
  let total = kept.reduce((acc, x) => acc + x.text.length, 0)
  while (kept.length > 1 && total > lim.maxLedgerChars) total -= kept.shift().text.length
  return kept
}

/** Touch `sid` in the ledger index and say which other ledgers to drop (least recently touched first). */
export const touchIndex = (index, sid, now, maxLedgers = LIMITS.maxLedgers) => {
  const next = isObj(index) ? { ...index } : {}
  next[sid] = now
  const drop = []
  const sids = Object.keys(next).sort((a, b) => (next[a] ?? 0) - (next[b] ?? 0))
  while (sids.length > maxLedgers) {
    const old = sids.shift()
    if (old === sid) continue
    delete next[old]
    drop.push(old)
  }
  return { index: next, drop }
}

/** Ledgers untouched for longer than staleMs (or with a nonsense timestamp). */
export const staleSessions = (index, now, staleMs = LIMITS.staleMs) =>
  isObj(index) ? Object.entries(index).filter(([, ts]) => !(typeof ts === 'number' && now - ts <= staleMs)).map(([sid]) => sid) : []

export const STORE_PREFIXES = Object.freeze(['ledger', 'open', 'compactions', 'usage'])

// ------------------------------------------------------------------ the check

/** The prompt sent to $.model.fork: the check question and the numbered ledger, oldest first. */
export const checkPrompt = (ledger, maxItems = DEFAULTS.check.maxItems) => {
  const numbered = ledger
    .map((x, i) => `${i + 1}. [${x.kind}] ${cut(x.text, LIMITS.promptEntryChars)}`)
    .join('\n\n')
  return `${CHECK_PROMPT.replace('{max}', String(maxItems))}\n\nUser instructions, oldest first:\n\n${numbered}`
}

/** The text sent to $.model.classify when the fork gave nothing usable. */
export const classifyText = (ledger, lastAssistant = '') =>
  ledger
    .slice(-LIMITS.classifyEntries)
    .map(x => `[${x.kind}] ${cut(x.text, LIMITS.promptEntryChars)}`)
    .join('\n\n') + `\n\nLast assistant message:\n${cut(String(lastAssistant ?? ''), LIMITS.lastAssistantChars)}`

/** The first JSON array in a reply, or undefined. Brackets inside strings are skipped. */
export const firstJsonArray = text => {
  if (typeof text !== 'string') return undefined
  for (let start = text.indexOf('['); start >= 0; start = text.indexOf('[', start + 1)) {
    let depth = 0
    let inStr = false
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (inStr) {
        if (c === '\\') i++
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === '[') depth++
      else if (c === ']' && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1))
          if (Array.isArray(v)) return v
        } catch {
          // not JSON: try the next '['
        }
        break
      }
    }
  }
  return undefined
}

/** Keep only well-formed {quote, missing} items, at most `max`. */
export const toItems = (arr, max = DEFAULTS.check.maxItems) => {
  const out = []
  for (const x of Array.isArray(arr) ? arr : []) {
    if (x === null || typeof x !== 'object') continue
    if (typeof x.quote !== 'string' || x.quote === '') continue
    out.push({ quote: x.quote, missing: typeof x.missing === 'string' ? x.missing : '' })
    if (out.length === max) break
  }
  return out
}

/** Items from a fork reply ({isAnswered, text}), or undefined when the reply has no usable JSON array. */
export const itemsFromFork = (reply, max) => {
  if (reply === null || reply === undefined || reply.isAnswered !== true) return undefined
  const arr = firstJsonArray(reply.text)
  return arr === undefined ? undefined : toItems(arr, max)
}

/** Items from a classify label, or undefined when the label is neither answer. */
export const itemsFromLabel = label =>
  label === CLASSIFY_LABELS[1] ? [{ ...COLD_ITEM }] : label === CLASSIFY_LABELS[0] ? [] : undefined

export const describeItems = items =>
  items.map(i => `"${i.quote}"${i.missing ? ` (missing: ${i.missing})` : ''}`).join('; ')

/** The line Claude reads, on the next tool result and the next prompt. */
export const finding = items => `[instruction-keeper] Not yet addressed: ${describeItems(items)}`

export const statusText = n => (n > 0 ? `instruction-keeper: ${n} open` : undefined)

// ------------------------------------------------------------------ cadence and cost guard

const toMs = v => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v !== '') {
    if (/^\d+(\.\d+)?$/.test(v)) return toMs(Number(v))
    const p = Date.parse(v)
    return Number.isNaN(p) ? undefined : p
  }
  return undefined
}

/**
 * Whether usage is ahead of the straight line for the window: used% > elapsed share x 100.
 * raw is the usage JSON text. Accepted shapes: {"<window>": {...}} or {"rate_limits": {"<window>": {...}}},
 * with used_percentage (or pct / percentUsed) and resets_at (or resetsAt) as ISO text, unix seconds or ms.
 * Returns undefined when there is no usable reading (then the normal cadence runs).
 */
export const aheadOfLine = (raw, now, opts = {}) => {
  const window = opts.window ?? DEFAULTS.costGuard.window
  const windowMs = opts.windowMs ?? DEFAULTS.costGuard.windowHours * 3_600_000
  try {
    const j = JSON.parse(raw)
    const w = (isObj(j?.[window]) ? j[window] : undefined) ?? (isObj(j?.rate_limits?.[window]) ? j.rate_limits[window] : undefined)
    if (w === undefined) return undefined
    const used = [w.used_percentage, w.pct, w.percentUsed].find(v => typeof v === 'number' && Number.isFinite(v))
    const resets = toMs(w.resets_at ?? w.resetsAt)
    if (used === undefined || resets === undefined) return undefined
    const share = 1 - (resets - now) / windowMs
    if (share < 0 || share > 1) return undefined // stale or nonsense reading
    return used > share * 100
  } catch {
    return undefined
  }
}

/** Whether a turn that just ended earns a check. The ExitPlanMode and post-compaction checks skip this. */
export const shouldCheckAtTurnEnd = ({ calls, now, lastCheck, ahead }, check = BASE.check) =>
  calls >= check.minToolCalls && now - lastCheck >= check.rateLimitMs && ahead !== true

// ------------------------------------------------------------------ delegation nudge

/** 'reset' (a delegation), 'read' (a read-only call) or 'other', for one main-agent tool call. */
export const classifyCall = (tool, command, nudge = BASE.nudge) => {
  const t = String(tool)
  const cmd = typeof command === 'string' ? command : ''
  if (nudge.resetTools.includes(t)) return 'reset'
  if (t === 'Bash' && nudge.resetBash.some(re => re.test(cmd))) return 'reset'
  if (nudge.readTools.includes(t)) return 'read'
  if (t === 'Bash' && nudge.readOnlyBash?.test(cmd)) return 'read'
  return 'other'
}

/** One step of the counter: {count, nudge}. At the threshold the nudge fires once and the count resets. */
export const nudgeStep = (count, kind, threshold) => {
  if (kind === 'reset') return { count: 0, nudge: false }
  if (kind !== 'read') return { count, nudge: false }
  const c = count + 1
  return c >= threshold ? { count: 0, nudge: true } : { count: c, nudge: false }
}

export const nudgeText = (text, count) => text.replace(/\{count\}/g, String(count))

// ------------------------------------------------------------------ compaction pinning

/** The text appended to the compaction instructions, or '' when there is nothing to pin. Duplicates appear once. */
export const pinText = (open, ledger) => {
  const parts = [
    ...(Array.isArray(open?.items) ? open.items : []).map(i => cut(String(i.quote), LIMITS.pinChars)),
    ...(Array.isArray(ledger) ? ledger : []).slice(-LIMITS.pinEntries).map(x => cut(String(x.text), LIMITS.pinChars)),
  ]
  const unique = [...new Set(parts)]
  if (unique.length === 0) return ''
  return '\nKeep these open user instructions verbatim in the summary: ' + unique.map(p => `\n- ${p}`).join('')
}

// ------------------------------------------------------------------ /keeper-seed

/**
 * Parse a seed file: each message is a level-2 heading `## <n>. <kind> · <timestamp>` (the separator may
 * also be `|` or `-`), followed by a fenced block opened with four backticks and `text`. The four-backtick
 * fence lets a message contain ordinary triple-backtick code.
 */
export const parseSeed = md => {
  const src = String(md)
  const heads = [...src.matchAll(/^## (\d+)\. ([\w-]+) [·|-] (\S+)[ \t]*$/gm)]
  const out = []
  heads.forEach((h, i) => {
    const from = (h.index ?? 0) + h[0].length
    const to = heads[i + 1]?.index ?? src.length
    const seg = src.slice(from, to)
    const open = /````text[ \t]*\r?\n/.exec(seg)
    if (!open) return
    const body = seg.slice(open.index + open[0].length)
    const close = /\r?\n````[ \t]*(\r?\n|$)/.exec(body)
    const text = close ? body.slice(0, close.index) : body
    out.push({ kind: h[2] ?? '', ts: h[3] ?? '', text })
  })
  return out
}

/** Seed rows not already in the ledger, ready for appendEntries. */
export const seedRows = (md, ledger, redactExtra = []) => {
  const have = new Set((Array.isArray(ledger) ? ledger : []).filter(x => x.kind === 'seed').map(x => x.text))
  return parseSeed(md)
    .filter(m => !have.has(clean(m.text, redactExtra)))
    .map(m => {
      const ts = Date.parse(m.ts)
      return Number.isNaN(ts) ? { kind: 'seed', text: m.text } : { kind: 'seed', text: m.text, ts }
    })
}
