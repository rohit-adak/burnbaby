import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AlertCfg, Cat, Goal, Limit, Step, Tally, Ttl, Turn } from '../types'

const PANE = 'burnbaby'
const MIN = 60_000
const HOUR = 60 * MIN
const WINDOWS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }
const LABELS: Record<string, string> = { five_hour: 'Session (5h)', seven_day: 'Weekly (7d)' }

const steps = atom({ plugin: 'burnbaby', key: 'steps' } as const, [])
const limits = atom({ plugin: 'burnbaby', key: 'limits' } as const, [])
const ctxTokens = atom({ plugin: 'burnbaby', key: 'ctxTokens' } as const, 0)
const ctxWindow = atom({ plugin: 'burnbaby', key: 'ctxWindow' } as const, 0)
const ctxPercent = atom({ plugin: 'burnbaby', key: 'ctxPercent' } as const, 0)
const costUsd = atom({ plugin: 'burnbaby', key: 'costUsd' } as const, 0)
const cats = atom({ plugin: 'burnbaby', key: 'cats' } as const, [])
const now = atom({ plugin: 'burnbaby', key: 'now' } as const, 0)
const startedAt = atom({ plugin: 'burnbaby', key: 'startedAt' } as const, 0)
const lastStepAt = atom({ plugin: 'burnbaby', key: 'lastStepAt' } as const, 0)
const ttl = atom({ plugin: 'burnbaby', key: 'ttl' } as const, 'unknown')
const model = atom({ plugin: 'burnbaby', key: 'model' } as const, '')
const modSpend = atom({ plugin: 'burnbaby', key: 'modSpend' } as const, { warmups: 0, compacts: 0, tokens: 0, usd: 0 })
const isHard = atom({ plugin: 'burnbaby', key: 'isHard' } as const, false)
const EMPTY_TALLY: Tally = {
  requests: 0,
  byKind: {},
  byModel: {},
  byType: { input: [0, 0], output: [0, 0], read: [0, 0], write: [0, 0] },
}
const tally = atom({ plugin: 'burnbaby', key: 'tally' } as const, EMPTY_TALLY)
const isDemo = atom({ plugin: 'burnbaby', key: 'isDemo' } as const, false)
const goals = atom({ plugin: 'burnbaby', key: 'goals' } as const, [] as Goal[])
const turnAt = atom({ plugin: 'burnbaby', key: 'turnAt' } as const, 0)
const draft = atom({ plugin: 'burnbaby', key: 'draft' } as const, null as Turn | null)
const journal = atom({ plugin: 'burnbaby', key: 'journal' } as const, [] as Turn[])
const DEFAULT_ALERTS: AlertCfg = {
  session: { on: true, at: 80 },
  weekly: { on: true, at: 70 },
  context: { on: true, at: 70 },
  cost: { on: false, at: 20 },
  cold: { on: false, at: 2 },
}
const alertCfg = atom({ plugin: 'burnbaby', key: 'alertCfg' } as const, DEFAULT_ALERTS)
const fired = atom({ plugin: 'burnbaby', key: 'fired' } as const, [] as string[])
const planning = atom({ plugin: 'burnbaby', key: 'planning' } as const, false)
const dismissed = atom({ plugin: 'burnbaby', key: 'dismissed' } as const, [] as string[])
const frame = atom({ plugin: 'burnbaby', key: 'frame' } as const, 0)
const activity = atom({ plugin: 'burnbaby', key: 'activity' } as const, { kind: 'idle', n: 0 })

export type Level = 'bad' | 'warn' | 'info' | 'ok'
export type Action = 'compact' | 'sonnet' | 'warm'
export type Finding = { level: Level; title: string; detail: string; action?: Action }

export type Snapshot = {
  now: number
  steps: Step[]
  limits: Limit[]
  ctxTokens: number
  ctxWindow: number
  ctxPercent: number
  cats: Cat[]
  lastStepAt: number
  ttl: Ttl
  model: string
}

export const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n))

export const fmtDur = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / MIN))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export const fmtTok = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export type LimitView = {
  label: string
  used: number
  time?: number
  resetIn?: number
  ahead: number
}

export const limitView = (l: Limit, at: number): LimitView => {
  const win = WINDOWS[l.kind]
  const reset = l.resetsAt ? new Date(l.resetsAt).getTime() : undefined
  const time =
    win !== undefined && reset !== undefined && !Number.isNaN(reset)
      ? clamp(((at - (reset - win)) / win) * 100)
      : undefined
  const resetIn = reset !== undefined && !Number.isNaN(reset) ? reset - at : undefined

  return {
    label: LABELS[l.kind] ?? l.kind,
    used: l.percentUsed,
    time,
    resetIn,
    ahead: time === undefined ? 0 : l.percentUsed - time,
  }
}

export type Seg = { text: string; kind: 'used' | 'over' | 'budget' | 'rest' }

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// Solid blocks are limit used (smooth to 1/8 cell); the shaded run is what the clock
// has already "paid for" in this window. Use spilling past the shade is over pace.
export const barSegs = (used: number, time: number | undefined, width: number): Seg[] => {
  const u = (clamp(used) / 100) * width
  const t = time === undefined ? 0 : (clamp(time) / 100) * width
  const out: Seg[] = []
  const push = (text: string, kind: Seg['kind']) => {
    const prev = out[out.length - 1]
    if (prev && prev.kind === kind) prev.text += text
    else out.push({ text, kind })
  }
  for (let i = 0; i < width; i += 1) {
    const isOver = time !== undefined && i + 0.5 > t
    if (i + 1 <= u) push('█', isOver ? 'over' : 'used')
    else if (i < u) push(EIGHTHS[Math.max(1, Math.round((u - i) * 8))] ?? '▌', isOver ? 'over' : 'used')
    else if (i + 0.5 <= t) push('░', 'budget')
    else push('·', 'rest')
  }

  return out
}

export const segColor = (kind: Seg['kind'], c: string): string =>
  kind === 'used' ? c : kind === 'over' ? 'error' : kind === 'budget' ? 'subtle' : 'inactive'

export const pace = (v: LimitView): string =>
  v.time === undefined ? '' : v.ahead >= 1 ? `▲${Math.round(v.ahead)} over pace` : `▼${Math.round(-v.ahead)} under`

// API list prices per million input tokens (base, cache read), cached 2026-10-06.
const PRICES: [RegExp, number, number][] = [
  [/fable|mythos/i, 10, 0.25],
  [/opus/i, 4, 0.2],
  [/sonnet/i, 2, 0.2],
  [/haiku/i, 0.1, 0.01],
]

// What re-sending the current context costs on the next message: read from cache
// while warm, re-written at the cache-write price (1.25x for 5m, 2x for 1h) once cold.
export const nextCost = (model: string, tokens: number, ttl: Ttl): { warm: number; cold: number } => {
  const [, base, readP] = PRICES.find(([re]) => re.test(model)) ?? [/./, 4, 0.2]
  const write = ttl === '5m' ? 1.25 : 2

  return { warm: (tokens * readP) / 1e6, cold: (tokens * base * write) / 1e6 }
}

// What one model call cost at API list prices (output priced at 5x input).
export const callCost = (model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, ttl: Ttl): number => {
  const [, base, readP] = PRICES.find(([re]) => re.test(model)) ?? [/./, 4, 0.2]
  const write = ttl === '5m' ? 1.25 : 2

  return (u.input_tokens * base + u.output_tokens * base * 5 + u.cache_read_input_tokens * readP + u.cache_creation_input_tokens * base * write) / 1e6
}

// One request's cost split by what it paid for: [tokens, usd] per part.
export const costParts = (model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, ttl: Ttl) => {
  const [, base, readP] = PRICES.find(([re]) => re.test(model)) ?? [/./, 4, 0.2]
  const write = ttl === '5m' ? 1.25 : 2

  return {
    input: [u.input_tokens, (u.input_tokens * base) / 1e6] as [number, number],
    output: [u.output_tokens, (u.output_tokens * base * 5) / 1e6] as [number, number],
    read: [u.cache_read_input_tokens, (u.cache_read_input_tokens * readP) / 1e6] as [number, number],
    write: [u.cache_creation_input_tokens, (u.cache_creation_input_tokens * base * write) / 1e6] as [number, number],
  }
}

export const addTally = (t: Tally, kind: string, model: string, parts: ReturnType<typeof costParts>): Tally => {
  const usdAll = parts.input[1] + parts.output[1] + parts.read[1] + parts.write[1]
  const tokAll = parts.input[0] + parts.output[0] + parts.read[0] + parts.write[0]
  const k = t.byKind[kind] ?? { usd: 0, tokens: 0, requests: 0 }
  const m = t.byModel[model] ?? { usd: 0, requests: 0 }
  const add = (a: [number, number], b: [number, number]): [number, number] => [a[0] + b[0], a[1] + b[1]]

  return {
    requests: t.requests + 1,
    byKind: { ...t.byKind, [kind]: { usd: k.usd + usdAll, tokens: k.tokens + tokAll, requests: k.requests + 1 } },
    byModel: { ...t.byModel, [model]: { usd: m.usd + usdAll, requests: m.requests + 1 } },
    byType: {
      input: add(t.byType.input, parts.input),
      output: add(t.byType.output, parts.output),
      read: add(t.byType.read, parts.read),
      write: add(t.byType.write, parts.write),
    },
  }
}

const usd = (n: number) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

// How fast a window is being spent relative to the clock, and where that rate leads.
export const burn = (v: LimitView, l: Limit): { rate?: number; outIn?: number } => {
  const win = WINDOWS[l.kind]
  if (v.time === undefined || win === undefined || v.time <= 0) return {}
  const rate = v.used / v.time
  const elapsed = (v.time / 100) * win
  const perMs = v.used / elapsed
  const outIn = perMs > 0 ? (100 - v.used) / perMs : undefined

  return { rate, outIn: outIn !== undefined && v.resetIn !== undefined && outIn < v.resetIn ? outIn : undefined }
}

// The mascot's wardrobe: one set of outfits per kind of work, rotated on every change.
const WARDROBE: Record<string, [string, string][]> = {
  idle: [['💤', 'silk pajamas'], ['☕', 'cozy cardigan'], ['🧖', 'spa robe']],
  thinking: [['🎀', 'thinking bow'], ['💭', 'dreamy scarf'], ['🌙', 'midnight velvet']],
  shell: [['🎧', 'hacker hoodie'], ['🕶️', 'neon shades'], ['⚡', 'cyber jacket']],
  edit: [['🎨', 'painter beret'], ['✂️', 'tailor apron'], ['🖋️', 'poet blazer']],
  read: [['🔍', 'detective coat'], ['🎩', 'monocle & top hat'], ['📚', 'library tweed']],
  web: [['🌍', 'explorer hat'], ['🧭', 'safari vest'], ['✈️', 'jet-set scarf']],
  agents: [['👑', 'boss tiara'], ['💼', 'power suit'], ['💎', 'diamond gown']],
  mcp: [['🔌', 'gadget belt'], ['🛰️', 'space suit'], ['🧩', 'patchwork dress']],
  compact: [['🧳', 'travel capsule'], ['📦', 'minimalist linen'], ['🪄', 'magic cape']],
}

export const activityOf = (tool: string): string =>
  /^(Bash|PowerShell|Monitor)$/.test(tool) ? 'shell'
    : /^(Edit|Write|NotebookEdit)$/.test(tool) ? 'edit'
    : /^(Read|Grep|Glob)$/.test(tool) ? 'read'
    : /^(WebSearch|WebFetch)$/.test(tool) ? 'web'
    : /^(Agent|Workflow|SendMessage)$/.test(tool) ? 'agents'
    : tool.startsWith('mcp__') ? 'mcp'
    : 'thinking'

export const outfit = (a: { kind: string; n: number }): [string, string] => {
  const set = WARDROBE[a.kind] ?? WARDROBE.thinking
  return set[a.n % set.length]
}

// The baby mascot sits on the bar's floor and blinks; while nothing needs attention
// he breaks into a smile now and then.
const BLINKS = 'cccccccccbcccccccccccbcb'
const HAPPY = 'ccccccbcccsssssscccccbcbccccssssss'
const FOCUS = 'ffffffffffffffffbffffffffffff'
export type Mood = 'calm' | 'happy' | 'working'
export const eyesFor = (n: number, mood: Mood = 'calm'): string => {
  const seq = mood === 'working' ? FOCUS : mood === 'happy' ? HAPPY : BLINKS
  const f = seq[n % seq.length]

  return f === 'b' ? ' ─ ─ ' : f === 's' ? ' ^ ^ ' : f === 'f' ? ' ▄ ▄ ' : ' ● ● '
}

// Working time per goal counts only while Claude is mid-turn on it.
type GoalPatch = { id: string; text: string; status: Goal['status'] }

export const moveGoal = (g: Goal, status: Goal['status'], at: number, isTurn: boolean): Goal => {
  if (g.status === status) return g
  const banked = g.activeSince !== undefined ? g.workMs + (at - g.activeSince) : g.workMs
  if (status === 'in_progress') return { ...g, status, workMs: banked, activeSince: isTurn ? at : undefined }

  return { ...g, status, workMs: banked, activeSince: undefined }
}

export const applyGoals = (prev: Goal[], next: GoalPatch[], at: number, isTurn: boolean): Goal[] =>
  next.map(n => {
    const old = prev.find(g => g.id === n.id) ?? { id: n.id, text: n.text, status: 'pending' as const, workMs: 0 }
    return { ...moveGoal(old, n.status, at, isTurn), text: n.text }
  })

export const workOf = (g: Goal, at: number): number => g.workMs + (g.activeSince !== undefined ? at - g.activeSince : 0)

// Estimates from the goals already achieved: their average working time.
export const goalForecast = (list: Goal[], at: number) => {
  const done = list.filter(g => g.status === 'completed')
  const avg = done.length > 0 ? done.reduce((n, g) => n + g.workMs, 0) / done.length : undefined
  const doing = list.filter(g => g.status === 'in_progress')
  const todo = list.filter(g => g.status === 'pending')
  const est = (g: Goal) => g.estMs ?? avg
  const open = [...doing, ...todo]
  const isKnown = open.every(g => est(g) !== undefined)
  const left = !isKnown || open.length === 0 && avg === undefined ? undefined : open.reduce((n, g) => n + Math.max(0, (est(g) ?? 0) - workOf(g, at)), 0)
  const first = open[0]
  const next = first === undefined || est(first) === undefined ? undefined : Math.max(0, (est(first) ?? 0) - workOf(first, at))

  return { avg, left, next, spent: list.reduce((n, g) => n + workOf(g, at), 0) }
}

// A quick plan for any ask: steps with minute estimates, from a small model.
export const parsePlan = (text: string): { t: string; m: number }[] => {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return []
  try {
    const j = JSON.parse(m[0]) as { steps?: { t?: unknown; m?: unknown }[] }
    return (j.steps ?? [])
      .filter(st => typeof st.t === 'string' && st.t.trim() !== '')
      .slice(0, 8)
      .map(st => ({ t: String(st.t).trim().slice(0, 80), m: clamp(Number(st.m) || 1, 0.25, 240) }))
  } catch {
    return []
  }
}

export const isPlan = (list: Goal[]) => list.length > 0 && list.every(g => g.id.startsWith('plan:'))

export const advancePlan = (list: Goal[], elapsed: number): Goal[] => {
  let start = 0
  return list.map((g, n) => {
    const est = g.estMs ?? 0
    const end = start + est
    const isLast = n === list.length - 1
    const st = start
    start = end
    if (elapsed >= end && !isLast) return { ...g, status: 'completed' as const, workMs: est, activeSince: undefined }
    if (elapsed >= st) return { ...g, status: 'in_progress' as const, workMs: elapsed - st, activeSince: undefined }
    return { ...g, status: 'pending' as const, workMs: 0, activeSince: undefined }
  })
}

export const fmtSpan = (ms: number): string => {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return sec % 60 === 0 ? `${m}m` : `${m}m ${sec % 60}s`
  return fmtDur(ms)
}

// The journal: one record per turn, kept for 14 days in the store under one key per day.
const DAY = 24 * HOUR
const JOURNAL_DAYS = 14
const pad2 = (n: number) => `${n}`.padStart(2, '0')
export const dayKey = (at: number): string => {
  const d = new Date(at)
  return `journal:${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
export const clock = (at: number): string => {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const startOfDay = (at: number): number => {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export type Period = 'session' | 'today' | 'week'

export const summarize = (turns: Turn[]) => {
  const files = new Set(turns.flatMap(x => x.edits))
  const goalsDone = turns.flatMap(x => x.goals)

  return {
    asks: turns.length,
    ms: turns.reduce((n, x) => n + x.ms, 0),
    usd: turns.reduce((n, x) => n + x.usd, 0),
    tools: turns.reduce((n, x) => n + x.tools, 0),
    files: [...files],
    goals: goalsDone,
    from: turns.length > 0 ? turns[0].at : 0,
    to: turns.length > 0 ? turns[turns.length - 1].at + turns[turns.length - 1].ms : 0,
  }
}

const shortPath = (path: string): string => path.split(/[\\/]/).slice(-2).join('/')

// User-set alert thresholds: each rule names a reading and the value that trips it.
export type RuleKey = keyof AlertCfg
export const RULES: { key: RuleKey; name: string; unit: '%' | '$'; step: number; min: number; max: number }[] = [
  { key: 'session', name: 'Session limit', unit: '%', step: 5, min: 5, max: 100 },
  { key: 'weekly', name: 'Weekly limit', unit: '%', step: 5, min: 5, max: 100 },
  { key: 'context', name: 'Context full', unit: '%', step: 5, min: 5, max: 100 },
  { key: 'cost', name: 'Session spend', unit: '$', step: 5, min: 1, max: 500 },
  { key: 'cold', name: 'Cold-cache message', unit: '$', step: 0.5, min: 0.5, max: 50 },
]

export const readingOf = (key: RuleKey, s: Snapshot, cost: number): number | undefined => {
  if (key === 'session') return s.limits.find(l => l.kind === 'five_hour')?.percentUsed
  if (key === 'weekly') return s.limits.find(l => l.kind === 'seven_day')?.percentUsed
  if (key === 'context') return s.ctxPercent
  if (key === 'cost') return cost
  return nextCost(s.model, s.ctxTokens, s.ttl).cold
}

export const fmtRule = (unit: '%' | '$', n: number): string => (unit === '$' ? `$${n % 1 === 0 ? n : n.toFixed(2)}` : `${Math.round(n)}%`)

// A dismissed alert stays hidden until its problem clears, then re-arms.
export const findingKey = (f: Finding): string => f.title.replace(/[\d.,$%]+/g, '#')
export const unseen = (list: Finding[], gone: string[]): Finding[] => list.filter(f => !gone.includes(findingKey(f)))

export const overRules = (cfg: AlertCfg, s: Snapshot, cost: number): Finding[] =>
  RULES.flatMap(r => {
    const rule = cfg[r.key]
    const v = readingOf(r.key, s, cost)
    if (!rule.on || v === undefined || v < rule.at) return []
    const action: Action | undefined = r.key === 'context' || r.key === 'cold' ? 'compact' : r.key === 'cost' ? undefined : 'sonnet'

    return [{
      level: 'bad' as Level,
      title: `${r.name} ${fmtRule(r.unit, v)} · over your ${fmtRule(r.unit, rule.at)} alert`,
      detail: `You asked to be told when ${r.name.toLowerCase()} passes ${fmtRule(r.unit, rule.at)}. Change it under More › Alerts.`,
      action,
    }]
  })

export const hitRatio = (list: Step[]): number => {
  const total = list.reduce((s, x) => s + x.read + x.write + x.input, 0)

  return total === 0 ? 1 : list.reduce((s, x) => s + x.read, 0) / total
}

export const inferTtl = (prev: Ttl, gap: number, step: Step): Ttl => {
  const total = step.read + step.write + step.input
  if (gap <= 6 * MIN || total < 20_000) return prev

  return step.read / total > 0.5 ? '1h' : '5m'
}

export const analyze = (s: Snapshot): Finding[] => {
  const out: Finding[] = []
  const isOpus = /opus/i.test(s.model)
  const views = s.limits.map(l => ({ l, v: limitView(l, s.now) }))
  const session = views.find(x => x.l.kind === 'five_hour')?.v
  const week = views.find(x => x.l.kind === 'seven_day')?.v

  if (s.ctxPercent >= 85) {
    out.push({
      level: 'bad',
      title: `Context ${s.ctxPercent}% full`,
      detail: `${fmtTok(s.ctxTokens)} tokens ride every turn. Compact now, or /clear if the task changed.`,
      action: 'compact',
    })
  } else if (s.ctxPercent >= 60) {
    out.push({
      level: 'warn',
      title: `Context ${s.ctxPercent}% full`,
      detail: `${fmtTok(s.ctxTokens)} tokens re-read each turn. Compact before it climbs further.`,
      action: 'compact',
    })
  }

  for (const [v, name, gap] of [[session, 'Session', 15], [week, 'Weekly', 10]] as const) {
    if (v && v.time !== undefined && v.ahead >= gap) {
      out.push({
        level: v.ahead >= gap * 2 ? 'bad' : 'warn',
        title: `${name} limit burning ahead of the clock`,
        detail: `${Math.round(v.used)}% used but only ${Math.round(v.time)}% of the window has passed.`,
        action: isOpus ? 'sonnet' : 'compact',
      })
    }
  }

  if (isOpus && ((session?.used ?? 0) >= 50 || (week?.used ?? 0) >= 60)) {
    out.push({
      level: 'warn',
      title: 'Opus is on while limits are filling',
      detail: 'Opus drains limits faster. Sonnet handles routine edits and reads fine.',
      action: 'sonnet',
    })
  }

  const last = s.steps[s.steps.length - 1]
  if (last) {
    const total = last.read + last.write + last.input
    if (total > 30_000 && last.write > last.read) {
      out.push({
        level: 'bad',
        title: 'Cache miss on the last request',
        detail: `${fmtTok(last.write)} tokens re-written at the higher cache-write price. Something changed early in the prompt, or the cache lapsed.`,
      })
    }
  }

  const recent = s.steps.slice(-10)
  if (recent.length >= 4 && hitRatio(recent) < 0.7) {
    out.push({
      level: 'warn',
      title: `Cache hit rate ${Math.round(hitRatio(recent) * 100)}%`,
      detail: 'Normal is 90%+. Avoid switching models, editing instructions or reconnecting MCP servers mid-session.',
    })
  }

  const idle = s.lastStepAt > 0 ? s.now - s.lastStepAt : 0
  const isBig = s.ctxTokens >= 50_000
  if (isBig && idle > 0) {
    if (s.ttl === '1h' && idle >= 50 * MIN && idle < HOUR) {
      out.push({
        level: 'warn',
        title: 'Cache about to lapse (1h)',
        detail: `Idle ${fmtDur(idle)}. A warm-up keeps it alive, or compact first if you are done with the old context.`,
        action: 'warm',
      })
    } else if (s.ttl !== '1h' && idle >= 4 * MIN && idle < 5 * MIN) {
      out.push({
        level: 'warn',
        title: 'Cache about to lapse (5m)',
        detail: `Idle ${fmtDur(idle)}. Warm it now or the next message re-writes ${fmtTok(s.ctxTokens)} tokens.`,
        action: 'warm',
      })
    } else if ((s.ttl === '1h' && idle >= HOUR) || (s.ttl === '5m' && idle >= 5 * MIN)) {
      out.push({
        level: 'warn',
        title: 'Cache is cold',
        detail: `Idle ${fmtDur(idle)}. Your next message pays full price for ${fmtTok(s.ctxTokens)} tokens. Compact first to shrink it.`,
        action: 'compact',
      })
    }
  }

  const heavy = s.steps.slice(-5)
  if (heavy.length >= 3) {
    const avg = heavy.reduce((n, x) => n + x.output, 0) / heavy.length
    if (avg > 4000) {
      out.push({
        level: 'info',
        title: `Heavy output: ~${fmtTok(Math.round(avg))} tokens per step`,
        detail: 'Long answers or extended thinking. Ask for shorter replies or lower the effort.',
      })
    }
  }

  const size = s.ctxWindow > 0 ? s.ctxWindow : 1
  for (const c of s.cats) {
    if (/free space|autocompact/i.test(c.name)) continue
    if (c.tokens / size >= 0.15) {
      const isTools = /mcp|tool|skill/i.test(c.name)
      out.push({
        level: 'info',
        title: `${c.name} uses ${fmtTok(c.tokens)} tokens`,
        detail: isTools ? 'Disable MCP servers and skills you are not using.' : 'A large share of the window.',
        action: isTools ? undefined : 'compact',
      })
    }
  }

  if (out.length === 0) {
    out.push({ level: 'ok', title: 'Nothing abnormal', detail: 'Context, cache and limit pace look normal.' })
  }
  const rank: Record<Level, number> = { bad: 0, warn: 1, info: 2, ok: 3 }

  return out.sort((a, b) => rank[a.level] - rank[b.level])
}

// Plain-text form for surfaces that do not draw the band (Remote Control, mobile).
export const summaryText = (s: Snapshot, cost: number): string => {
  const lines = s.limits.map(l => {
    const v = limitView(l, s.now)
    const bar = barSegs(v.used, v.time, 20).map(x => x.text).join('')
    const reset = v.resetIn !== undefined ? ` · resets ${fmtDur(v.resetIn)}` : ''
    return `${LABELS[l.kind] ?? l.kind}  ${bar}  ${Math.round(v.used)}%  ${pace(v)}${reset}`
  })
  const hit = Math.round(hitRatio(s.steps.slice(-10)) * 100)
  const idle = s.lastStepAt > 0 ? s.now - s.lastStepAt : 0
  lines.push(`Context ${s.ctxPercent}% (${fmtTok(s.ctxTokens)}/${fmtTok(s.ctxWindow)}) · cache ${hit}% hit · idle ${fmtDur(idle)} · $${cost.toFixed(2)} · ${s.model || '?'}`)
  const nc = nextCost(s.model, s.ctxTokens, s.ttl)
  lines.push(`Next message: ${usd(nc.warm)} while cache is warm vs ${usd(nc.cold)} if it goes cold (API list price)`)
  for (const f of analyze(s)) lines.push(`${levelMark[f.level]} ${f.title}: ${f.detail}`)
  return lines.join('\n')
}

const FIXES: Record<Action, string> = {
  compact: 'Press Compact below (or type /compact). It summarizes the history so every later turn re-sends far less.',
  sonnet: 'Press Use Sonnet below (or type /model sonnet). Sonnet costs about half of Opus per token and spends limits slower.',
  warm: 'Press Warm cache below before you step away. It keeps the cache alive so your next message stays cheap.',
}

const DEMO: Finding[] = [
  {
    level: 'bad',
    title: 'Context 87% full (sample)',
    detail: 'This is a sample alert. 870k tokens would ride along with every message.',
    action: 'compact',
  },
  {
    level: 'warn',
    title: 'Weekly limit burning ahead of the clock (sample)',
    detail: 'This is a sample alert. 34% used but only 12% of the week has passed.',
    action: 'sonnet',
  },
]

const colorFor = (v: LimitView): string =>
  v.used >= 90 || v.ahead >= 20 ? 'error' : v.used >= 70 || v.ahead >= 8 ? 'warning' : 'success'

const levelColor: Record<Level, string> = { bad: 'error', warn: 'warning', info: 'suggestion', ok: 'success' }
const levelMark: Record<Level, string> = { bad: '✖', warn: '▲', info: '●', ok: '✔' }

async function refresh($: EngineInterface) {
  const at = await $.clock.now()
  const u = await $.session.usage()
  await update($, now, () => at)
  await update($, limits, () => u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })))
  await update($, ctxWindow, () => u.context.window)
  await update($, ctxTokens, () => u.context.tokens ?? 0)
  await update($, ctxPercent, () => u.context.percent ?? 0)
  await update($, costUsd, () => u.cost?.usd ?? 0)
  try {
    const m = await $.session.model()
    await update($, model, () => m)
  } catch {
    // keep the model blank; the finding rules skip Opus checks then
  }
  await checkAlerts($)
}

async function checkAlerts($: EngineInterface) {
  const cfg = await read($, alertCfg)
  const snap = await snapOf($)
  const cost = await read($, costUsd)
  const over = RULES.filter(r => {
    const v = readingOf(r.key, snap, cost)
    return cfg[r.key].on && v !== undefined && v >= cfg[r.key].at
  })
  const was = await read($, fired)
  for (const r of over) {
    if (!was.includes(r.key)) $.ui.toast(`⚠ ${r.name} passed your ${fmtRule(r.unit, cfg[r.key].at)} alert (now ${fmtRule(r.unit, readingOf(r.key, snap, cost) ?? 0)})`)
  }
  await update($, fired, () => over.map(r => r.key))
  const live = [...overRules(cfg, snap, cost), ...analyze(snap).filter(f => f.level === 'bad' || f.level === 'warn')].map(findingKey)
  await update($, dismissed, d => (d.every(k => live.includes(k)) ? d : d.filter(k => live.includes(k))))
}

async function planAsk($: EngineInterface, ask: string) {
  await update($, planning, () => true)
  const r = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 400,
    timeoutMs: 15_000,
    system: 'You estimate coding-assistant work. Reply with JSON only.',
    prompt: `A user just asked an AI coding assistant (Claude Code) this:

<ask>${ask}</ask>

If it is a task to carry out, list 2-6 short steps the assistant will take, each with the minutes it will take the assistant (not a human). If it is only a question or chat, return no steps.
Reply exactly: {"steps":[{"t":"step in under 8 words","m":2}]}`,
  })
  await update($, planning, () => false)
  const u = r.usage
  await update($, modSpend, x => ({
    ...x,
    tokens: x.tokens + u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
    usd: x.usd + callCost('claude-haiku-5-5', u, '5m'),
  }))
  if (!r.isAnswered) return
  const steps = parsePlan(r.text)
  if (steps.length === 0) return
  const list = await read($, goals)
  // Claude's own task list wins; a plan only fills an empty or old plan list.
  if (list.length > 0 && !isPlan(list) && list.some(g => g.status !== 'completed')) return
  await update($, goals, () => steps.map((st, n) => ({ id: `plan:${n}`, text: st.t, status: 'pending' as const, workMs: 0, estMs: st.m * MIN })))
  await stepPlan($)
}

async function stepPlan($: EngineInterface) {
  const list = await read($, goals)
  const at0 = await read($, turnAt)
  if (!isPlan(list) || at0 === 0) return
  const at = await $.clock.now()
  await update($, goals, l => (isPlan(l) ? advancePlan(l, at - at0) : l))
}

async function snapOf($: EngineInterface): Promise<Snapshot> {
  return {
    now: (await read($, now)) || (await $.clock.now()),
    steps: await read($, steps),
    limits: await read($, limits),
    ctxTokens: await read($, ctxTokens),
    ctxWindow: await read($, ctxWindow),
    ctxPercent: await read($, ctxPercent),
    cats: await read($, cats),
    lastStepAt: await read($, lastStepAt),
    ttl: await read($, ttl),
    model: await read($, model),
  }
}

async function setRule($: EngineInterface, key: RuleKey, fn: (r: { on: boolean; at: number }) => { on: boolean; at: number }) {
  await update($, alertCfg, c => ({ ...c, [key]: fn(c[key]) }))
  await $.store.set('alertCfg', await read($, alertCfg))
  await checkAlerts($)
}


async function compact($: EngineInterface) {
  $.ui.toast('Compacting…')
  const r = await $.session.compact()
  const m = await read($, model)
  const t = await read($, ttl)
  const u = 'usage' in r ? r.usage : undefined
  await update($, modSpend, x => ({
    ...x,
    compacts: x.compacts + 1,
    tokens: x.tokens + (u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0),
    usd: x.usd + (u ? callCost(m, u, t) : 0),
  }))
  await refresh($)
  $.ui.toast('Compacted.')
}

async function sonnet($: EngineInterface) {
  try {
    await $.command.run({ command: 'model', args: 'sonnet' })
    await refresh($)
    $.ui.toast('Switched to Sonnet. The next message re-writes the cache once.')
  } catch {
    $.ui.toast('Could not switch for you. Type /model sonnet.')
  }
}

async function warm($: EngineInterface) {
  const r = await $.model.fork({ prompt: 'Reply with the single word: ok' })
  const m = await read($, model)
  const t = await read($, ttl)
  const u = r.usage
  await update($, modSpend, x => ({
    ...x,
    warmups: x.warmups + 1,
    tokens: x.tokens + u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
    usd: x.usd + callCost(m, u, t),
  }))
  if (r.isAnswered) {
    const at = await $.clock.now()
    await update($, lastStepAt, () => at)
    $.ui.toast(`Cache warmed: ${fmtTok(r.usage.cache_read_input_tokens)} read, ${fmtTok(r.usage.cache_creation_input_tokens)} re-written.`)
  } else {
    $.ui.toast('Nothing to warm yet.')
  }
}

async function loadTurns($: EngineInterface, period: Period, sid: number, at: number): Promise<Turn[]> {
  const days = period === 'week' ? 7 : 1
  const out: Turn[] = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const rows = (await $.store.get(dayKey(at - i * DAY))) as Turn[] | undefined
    if (Array.isArray(rows)) out.push(...rows)
  }
  const live = await read($, journal)
  for (const row of live) if (!out.some(o => o.at === row.at && o.sid === row.sid)) out.push(row)
  const since = period === 'week' ? startOfDay(at) - 6 * DAY : startOfDay(at)
  const list = out.filter(x => (period === 'session' ? x.sid === sid : x.at >= since)).sort((a, b) => a.at - b.at)

  return list
}

async function saveTurn($: EngineInterface, turn: Turn) {
  const key = dayKey(turn.at)
  const rows = ((await $.store.get(key)) as Turn[] | undefined) ?? []
  await $.store.set(key, [...rows, turn].slice(-500))
  for (const k of await $.store.keys()) {
    if (k.startsWith('journal:') && k < dayKey(turn.at - JOURNAL_DAYS * DAY)) await $.store.delete(k)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('alertCfg')) as Partial<AlertCfg> | undefined
    if (saved && typeof saved === 'object') await update($, alertCfg, c => ({ ...c, ...saved }))
    await $.command.register({ name: 'meter', description: 'Open the usage meter pane (/meter focus shows the hard-thinking mascot)', argumentHint: '[focus|alert]' })
    const at = await $.clock.now()
    await update($, startedAt, () => at)
    await refresh($)
    $.clock.every(15_000, () => refresh($))
    $.clock.every(500, () => update($, frame, n => n + 1))
    $.clock.every(2_000, () => stepPlan($))

    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    if (e.args.trim() === 'alert') {
      await update($, isDemo, () => true)
      $.clock.after(30_000, () => update($, isDemo, () => false))

      return { text: 'Showing a sample alert for 30 seconds. Click it in the band to see the fix panel.' }
    }
    if (e.args.trim() === 'focus') {
      await update($, activity, a => ({ kind: 'thinking', n: a.n + 1 }))
      await update($, isHard, () => true)
      $.clock.after(15_000, async () => {
        await update($, isHard, () => false)
        await update($, activity, a => ({ kind: 'idle', n: a.n + 1 }))
      })

      return { text: 'Mascot is in focus mode for 15 seconds.' }
    }
    await refresh($)
    void $.ui.open({ id: PANE, title: 'More' })
    const at = await read($, now)
    const snap: Snapshot = {
      now: at,
      steps: await read($, steps),
      limits: await read($, limits),
      ctxTokens: await read($, ctxTokens),
      ctxWindow: await read($, ctxWindow),
      ctxPercent: await read($, ctxPercent),
      cats: await read($, cats),
      lastStepAt: await read($, lastStepAt),
      ttl: await read($, ttl),
      model: await read($, model),
    }

    return { text: summaryText(snap, await read($, costUsd)) }
  })

  on('turn.step', async function* ($, e, next) {
    const isMax = e.effort === 'xhigh' || e.effort === 'max'
    if (isMax && !e.agentId) await update($, isHard, () => true)
    const r = yield* next(e)
    // A long reply with little visible text is the model thinking hard.
    if (!e.agentId && r.usage && r.usage.output_tokens > 3000 && r.answer.length * 0.25 < r.usage.output_tokens * 0.5) {
      await update($, isHard, () => true)
    }
    if (r.usage) {
      const at = await $.clock.now()
      const prev = await read($, lastStepAt)
      const step: Step = {
        at,
        model: r.usage.model,
        input: r.usage.input_tokens,
        output: r.usage.output_tokens,
        read: r.usage.cache_read_input_tokens,
        write: r.usage.cache_creation_input_tokens,
      }
      const kind = e.agentId ? 'agents' : (await read($, activity)).kind
      const parts = costParts(r.usage.model, r.usage, await read($, ttl))
      await update($, tally, t => addTally(t, kind === 'idle' ? 'thinking' : kind, r.usage?.model ?? '?', parts))
      if (prev > 0) await update($, ttl, t => inferTtl(t, at - prev, step))
      await update($, steps, list => [...list, step].slice(-60))
      await update($, lastStepAt, () => at)
    }

    return r
  })

  on('session.measure', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = (e.origin as { kind?: string } | undefined)?.kind
    if (kind === 'composer' || kind === 'bridge') {
      const at = await $.clock.now()
      const sid = (await $.session.usage()).startedAt
      const usd = (await $.session.usage()).cost?.usd ?? 0
      await update($, draft, () => ({ sid, at, ask: e.text.replace(/\s+/g, ' ').trim().slice(0, 160), ms: 0, usd, tools: 0, edits: [], goals: [] }))
      const ask = e.text.trim()
      if (!ask.startsWith('/') && ask.split(/\s+/).length >= 4) $.clock.after(1, () => planAsk($, ask.slice(0, 2000)))
    }

    return next(e)
  })

  on('tool.call', { tool: /^(Edit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const r = await next(e)
    const path = 'file_path' in e ? String(e.file_path) : 'notebook_path' in e ? String(e.notebook_path) : ''
    if (path && !r.deny && !r.isError) {
      await update($, draft, d => (d && !d.edits.includes(path) ? { ...d, edits: [...d.edits, path] } : d))
    }

    return r
  })

  // Goals follow Claude's own task list: TodoWrite replaces it, TaskCreate/TaskUpdate edit it.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny && !r.isError) {
      const at = await $.clock.now()
      const isTurn = (await read($, turnAt)) > 0
      const before = await read($, goals)
      await update($, goals, list => applyGoals(list, e.todos.map(td => ({ id: td.content, text: td.content, status: td.status })), at, isTurn))
      const fresh = e.todos.filter(td => td.status === 'completed' && !before.some(g => g.id === td.content && g.status === 'completed'))
      if (fresh.length > 0) await update($, draft, d => (d ? { ...d, goals: [...d.goals, ...fresh.map(f => f.content)] } : d))
    }

    return r
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    const task = r.result?.task
    if (task) await update($, goals, list => [...list.filter(g => g.id !== task.id), { id: task.id, text: e.subject, status: 'pending', workMs: 0 }])

    return r
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    if (r.result?.success) {
      const at = await $.clock.now()
      const isTurn = (await read($, turnAt)) > 0
      const status = e.status
      await update($, goals, list =>
        status === 'deleted'
          ? list.filter(g => g.id !== e.taskId)
          : list.map(g => (g.id === e.taskId ? { ...moveGoal(g, status ?? g.status, at, isTurn), text: e.subject ?? g.text } : g)),
      )
      const hit = (await read($, goals)).find(g => g.id === e.taskId)
      if (status === 'completed' && hit) await update($, draft, d => (d ? { ...d, goals: [...d.goals, hit.text] } : d))
    }

    return r
  })

  on('tool.call', async ($, e, next) => {
    await update($, draft, d => (d ? { ...d, tools: d.tools + 1 } : d))
    const kind = activityOf(e.tool)
    await update($, activity, a => (a.kind === kind ? a : { kind, n: a.n + 1 }))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, activity, a => ({ kind: 'thinking', n: a.n + 1 }))
    const at = await $.clock.now()
    await update($, turnAt, () => at)
    await update($, goals, list => list.map(g => (g.status === 'in_progress' && g.activeSince === undefined ? { ...g, activeSince: at } : g)))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, activity, a => ({ kind: 'idle', n: a.n + 1 }))
    await update($, isHard, () => false)
    const done = await $.clock.now()
    const d = await read($, draft)
    if (d) {
      const spentNow = (await $.session.usage()).cost?.usd ?? d.usd
      const turn: Turn = { ...d, ms: done - d.at, usd: Math.max(0, spentNow - d.usd) }
      await update($, journal, list => [...list, turn].slice(-300))
      await update($, draft, () => null)
      await saveTurn($, turn)
    }
    const at0 = await read($, turnAt)
    await update($, goals, l => (isPlan(l) && at0 > 0 ? (() => {
      const spent = done - at0
      const est = l.reduce((n, g) => n + (g.estMs ?? 0), 0) || 1
      return l.map(g => ({ ...g, status: 'completed' as const, workMs: Math.round(((g.estMs ?? 0) / est) * spent), activeSince: undefined }))
    })() : l))
    await update($, turnAt, () => 0)
    await update($, goals, list =>
      list.map(g => (g.activeSince !== undefined ? { ...g, workMs: g.workMs + (done - g.activeSince), activeSince: undefined } : g)),
    )
    try {
      const u = await $.session.usage({ breakdown: 'summary' })
      const rows = (u.context.breakdown?.categories ?? []).map(c => ({ name: c.name, tokens: c.tokens }))
      await update($, cats, () => rows.sort((a, b) => b.tokens - a.tokens).slice(0, 6))
    } catch {
      // the breakdown is optional; the rest of the meter still draws
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const at = (await read($, now)) || (await $.clock.now())
    const snap: Snapshot = {
      now: at,
      steps: await read($, steps),
      limits: await read($, limits),
      ctxTokens: await read($, ctxTokens),
      ctxWindow: await read($, ctxWindow),
      ctxPercent: await read($, ctxPercent),
      cats: await read($, cats),
      lastStepAt: await read($, lastStepAt),
      ttl: await read($, ttl),
      model: await read($, model),
    }
    const cost = await read($, costUsd)
    const t = await read($, tally)
    const spend = await read($, modSpend)
    const usage = await $.session.usage()
    const cfg = await read($, alertCfg)
    const firing = await read($, fired)
    const cols = e.props.bodyColumns ?? 120
    const isTwo = cols >= 110
    const half = isTwo ? Math.floor((cols - 8) / 2) : cols - 4
    const BAR = clamp(half - 50, 8, 20)
    const all = analyze(snap)
    const issues = all.filter(f => f.level === 'bad' || f.level === 'warn')
    const notes = all.filter(f => f.level === 'info')
    const actions = new Set(issues.map(f => f.action))
    const recent = snap.steps.slice(-10)
    const hit = Math.round(hitRatio(recent) * 100)
    const idle = snap.lastStepAt > 0 ? at - snap.lastStepAt : 0
    const nc = nextCost(snap.model, snap.ctxTokens, snap.ttl)
    const total = t.byType.input[1] + t.byType.output[1] + t.byType.read[1] + t.byType.write[1]
    const [, , readP] = PRICES.find(([re]) => re.test(snap.model)) ?? [/./, 4, 0.2]
    const ctxC = snap.ctxPercent >= 85 ? 'error' : snap.ctxPercent >= 60 ? 'warning' : 'success'
    const hitC = recent.length === 0 ? 'inactive' : hit >= 85 ? 'success' : hit >= 70 ? 'warning' : 'error'
    const NAMES: Record<string, string> = {
      thinking: 'Thinking & replies',
      shell: 'Shell commands',
      edit: 'Editing files',
      read: 'Reading code',
      web: 'Web',
      agents: 'Subagents',
      mcp: 'MCP tools',
      compact: 'Compacting',
    }

    const line = (pct: number, color: string, w = BAR) => {
      const f = Math.max(Math.round((clamp(pct) / 100) * w), pct > 0 ? 1 : 0)
      return (
        <Text>
          <Text color={color}>{'━'.repeat(f)}</Text>
          <Text color="inactive">{'─'.repeat(w - f)}</Text>
        </Text>
      )
    }
    const head = (title: string, hint?: string) => (
      <Text>
        <Text bold color="claude">{title.toUpperCase()}</Text>
        {hint && <Text dimColor>   {hint}</Text>}
      </Text>
    )
    const kv = (k: string, v: any) => (
      <Text wrap="truncate-end">
        <Text dimColor>{`  ${k}`.padEnd(16)}</Text>
        {v}
      </Text>
    )
    const share = (name: string, part: number, value: string, extra: string, color: string) => (
      <Text wrap="truncate-end">
        <Text>{`  ${name}`.padEnd(22)}</Text>
        {line(total > 0 ? (part / total) * 100 : 0, color, 16)}
        <Text bold>{`${total > 0 ? Math.round((part / total) * 100) : 0}%`.padStart(5)}</Text>
        <Text>{value.padStart(8)}</Text>
        <Text dimColor>  {extra}</Text>
      </Text>
    )

    return (
      <Box flexDirection="column" backgroundColor="#1c2128" paddingX={2} paddingY={1} flexGrow={1}>
      <Box flexDirection={isTwo ? 'row' : 'column'}>
      <Box flexDirection="column" width={half} marginRight={isTwo ? 4 : 0}>
        {head('Pace', 'what the bars above do not show')}
        {snap.limits.length === 0 && <Text dimColor>  Appears after the first reply.</Text>}
        {snap.limits.map(l => {
          const v = limitView(l, at)
          const win = WINDOWS[l.kind]
          if (v.time === undefined || v.resetIn === undefined || win === undefined) return null
          const b = burn(v, l)
          const unit = l.kind === 'seven_day' ? 24 * HOUR : HOUR
          const u = l.kind === 'seven_day' ? 'day' : 'h'
          const elapsed = (v.time / 100) * win
          const per = elapsed > 0 ? (v.used / elapsed) * unit : 0
          const allowed = v.resetIn > 0 ? ((100 - v.used) / v.resetIn) * unit : 0
          const atReset = clamp(v.used + (per / unit) * v.resetIn, 0, 999)
          const pc = per > allowed ? 'error' : per > (100 / win) * unit ? 'warning' : 'success'

          return (
            <Box flexDirection="column" marginTop={1}>
              <Text wrap="truncate-end">
                <Text bold>{`  ${l.kind === 'five_hour' ? 'Session' : l.kind === 'seven_day' ? 'Weekly' : l.kind}`.padEnd(11)}</Text>
                <Text dimColor>you use </Text>
                <Text bold color={pc}>{per.toFixed(1)}%/{u}</Text>
                <Text dimColor>   safe max </Text>
                <Text bold>{allowed.toFixed(1)}%/{u}</Text>
              </Text>
              <Text wrap="truncate-end">
                {'           '}
                {b.outIn !== undefined ? (
                  <Text color="error" bold>runs out in {fmtDur(b.outIn)}, {fmtDur(v.resetIn - b.outIn)} before the reset</Text>
                ) : (
                  <Text color="success">on course for ~{Math.round(atReset)}% at the reset</Text>
                )}
              </Text>
            </Box>
          )
        })}

        <Box flexDirection="column" marginTop={1}>
          {head('This session')}
          {kv('Context', <Text><Text color={ctxC} bold>{snap.ctxPercent}%</Text><Text dimColor>  {fmtTok(snap.ctxTokens)} of {fmtTok(snap.ctxWindow)}</Text></Text>)}
          {kv('Cache', <Text><Text color={hitC} bold>{recent.length === 0 ? '—' : `${hit}% reused`}</Text><Text dimColor>  idle {fmtDur(idle)} · life {snap.ttl === 'unknown' ? '1h (assumed)' : snap.ttl}</Text></Text>)}
          {kv('Next message', <Text><Text color="success" bold>{usd(nc.warm)}</Text><Text dimColor> warm   </Text><Text color="warning" bold>{usd(nc.cold)}</Text><Text dimColor> cold</Text></Text>)}
          {kv('Spent', <Text><Text bold>${cost.toFixed(2)}</Text><Text dimColor>  over {fmtDur(at - usage.startedAt)} · {snap.model.replace(/^claude-/, '') || '?'}</Text></Text>)}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {head(issues.length > 0 ? `Needs you (${issues.length})` : 'Health')}
          {issues.length === 0 && <Text color="success">  ✔ Nothing needs fixing</Text>}
          {issues.map(f => (
            <Box flexDirection="column">
              <Text bold color={levelColor[f.level]} wrap="truncate-end">{`  ${levelMark[f.level]} ${f.title}`}</Text>
              <Text dimColor wrap="truncate-end">{`    ${f.detail}`}</Text>
            </Box>
          ))}
          {notes.map(f => (
            <Text dimColor wrap="truncate-end">{`  · ${f.title}`}</Text>
          ))}
          <Box marginTop={1}>
            <Text>  </Text>
            <Button key="compact" label="Compact" hotkey="c" variant={actions.has('compact') ? 'primary' : undefined} onPress={() => compact($)} />
            <Text>  </Text>
            <Button key="sonnet" label="Use Sonnet" hotkey="s" variant={actions.has('sonnet') ? 'primary' : undefined} onPress={() => sonnet($)} />
            <Text>  </Text>
            <Button key="warm" label="Warm cache" hotkey="w" variant={actions.has('warm') ? 'primary' : undefined} onPress={() => warm($)} />
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {head('Alerts', 'tell me when a reading passes my limit')}
          {RULES.map(r => {
            const rule = cfg[r.key]
            const v = readingOf(r.key, snap, cost)
            const isOver = firing.includes(r.key)
            const clampAt = (n: number) => Math.min(r.max, Math.max(r.min, Math.round(n * 100) / 100))

            return (
              <Box>
                <Button key={`al-on-${r.key}`} plain onPress={() => setRule($, r.key, x => ({ ...x, on: !x.on }))}>
                  <Text color={rule.on ? 'success' : 'inactive'}>{rule.on ? '  ◉ ' : '  ○ '}</Text>
                  <Text dimColor={!rule.on}>{r.name.padEnd(20)}</Text>
                </Button>
                <Button key={`al-dn-${r.key}`} plain label="−" onPress={() => setRule($, r.key, x => ({ ...x, at: clampAt(x.at - r.step) }))} />
                <Text bold color={rule.on ? 'text' : 'inactive'}>{` ${fmtRule(r.unit, rule.at)} `.padStart(8)}</Text>
                <Button key={`al-up-${r.key}`} plain label="+" onPress={() => setRule($, r.key, x => ({ ...x, at: clampAt(x.at + r.step) }))} />
                <Text dimColor>{`   now ${v === undefined ? '—' : fmtRule(r.unit, v)}`}</Text>
                {isOver && <Text color="error" bold>   ⚠ over</Text>}
              </Box>
            )
          })}
          <Text dimColor>  ◉ on / ○ off · press − + to move the limit · you get a toast the moment one is crossed</Text>
        </Box>

      </Box>
      <Box flexDirection="column" width={half}>
        <Box flexDirection="column" marginTop={isTwo ? 0 : 1}>
          {head('Where it went', t.requests > 0 ? `${usd(total)} · ${t.requests} requests since the meter loaded` : 'starts with the next reply')}
          {t.requests > 0 && (
            <Box flexDirection="column">
              <Text dimColor>  by activity</Text>
              {Object.entries(t.byKind)
                .sort((a, b) => b[1].usd - a[1].usd)
                .map(([k, v]) => share(NAMES[k] ?? k, v.usd, usd(v.usd), `${v.requests} req`, 'claude'))}
              <Text dimColor>  by kind of token</Text>
              {share('Cache reads', t.byType.read[1], usd(t.byType.read[1]), `${fmtTok(t.byType.read[0])} tok · cheap`, 'success')}
              {share('Cache writes', t.byType.write[1], usd(t.byType.write[1]), `${fmtTok(t.byType.write[0])} tok · misses`, 'warning')}
              {share('Fresh input', t.byType.input[1], usd(t.byType.input[1]), `${fmtTok(t.byType.input[0])} tok`, 'suggestion')}
              {share('Output', t.byType.output[1], usd(t.byType.output[1]), `${fmtTok(t.byType.output[0])} tok · writing & thinking`, 'claude')}
            </Box>
          )}
        </Box>

        {snap.cats.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {head('Re-sent every message', 'what the context is made of')}
            {snap.cats
              .filter(c => !/free space|autocompact/i.test(c.name))
              .map(c => (
                <Text wrap="truncate-end">
                  <Text>{`  ${c.name}`.padEnd(26)}</Text>
                  {line(snap.ctxTokens > 0 ? (c.tokens / Math.max(snap.ctxTokens, 1)) * 100 : 0, /deferred/i.test(c.name) ? 'inactive' : 'suggestion', 12)}
                  <Text bold>{fmtTok(c.tokens).padStart(7)}</Text>
                  <Text dimColor>{/deferred/i.test(c.name) ? '   loaded on demand' : `   ${usd((c.tokens * readP) / 1e6)} / message`}</Text>
                </Text>
              ))}
          </Box>
        )}

      </Box>
      </Box>
        <Box marginTop={1}>
          <Text dimColor>The meter's own calls: {spend.usd > 0 ? `${usd(spend.usd)} (${spend.warmups} warm-ups)` : 'free'} · prices are API list rates, output at 5× input</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: /^pace-/ }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const kind = String(e.requestId).replace(/^pace-/, '')
    const at = (await read($, now)) || (await $.clock.now())
    const l = (await read($, limits)).find(x => x.kind === kind)
    const win = WINDOWS[kind]
    const name = kind === 'five_hour' ? 'Session (5h)' : kind === 'seven_day' ? 'Weekly (7d)' : kind
    if (!l || win === undefined) return <Text dimColor>No reading for {name} yet. It appears after the next reply.</Text>
    const v = limitView(l, at)
    if (v.time === undefined || v.resetIn === undefined) return <Text dimColor>{name}: {Math.round(v.used)}% used. No reset time reported, so pace can't be worked out.</Text>
    const b = burn(v, l)
    const rate = b.rate ?? 0
    const elapsed = (v.time / 100) * win
    const unit = kind === 'seven_day' ? 24 * HOUR : HOUR
    const unitName = kind === 'seven_day' ? 'day' : 'hour'
    const perUnit = elapsed > 0 ? (v.used / elapsed) * unit : 0
    const even = (100 / win) * unit
    const atReset = clamp(v.used + (perUnit / unit) * v.resetIn, 0, 999)
    const allowed = v.resetIn > 0 ? ((100 - v.used) / v.resetIn) * unit : 0
    const c = rate >= 1.5 ? 'error' : rate > 1 ? 'warning' : 'success'
    const W = clamp((e.props.bodyColumns ?? 60) - 22, 10, 40)
    const bar = (pct: number, color: string) => {
      const f = Math.round((clamp(pct) / 100) * W)
      return <Text><Text color={color}>{'█'.repeat(f)}</Text><Text color="inactive">{'░'.repeat(W - f)}</Text></Text>
    }
    const verdict =
      rate > 1 ? `You are spending ${rate.toFixed(1)}× faster than the clock.` : `You are spending at ${rate.toFixed(1)}× the even rate, inside your budget.`

    return (
      <Box flexDirection="column">
        <Text bold color={c}>{rate.toFixed(1)}× pace</Text>
        <Text>{verdict}</Text>

        <Box flexDirection="column" marginTop={1}>
          <Text>Limit used   {bar(v.used, c)} {Math.round(v.used)}%</Text>
          <Text>Time gone    {bar(v.time, 'subtle')} {Math.round(v.time)}%</Text>
          <Text dimColor>Pace = limit used ÷ time gone = {Math.round(v.used)} ÷ {Math.round(v.time)} = {rate.toFixed(1)}×. 1.0× would land exactly on 100% at the reset.</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Rate</Text>
          <Text>  You use     <Text color={c} bold>{perUnit.toFixed(1)}%</Text> per {unitName}</Text>
          <Text>  Even pace   {even.toFixed(1)}% per {unitName}</Text>
          <Text>  To stay inside the limit, use at most <Text bold>{allowed.toFixed(1)}%</Text> per {unitName} from now.</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Where this leads</Text>
          <Text>  Window started {fmtDur(elapsed)} ago, resets in {fmtDur(v.resetIn)}.</Text>
          {b.outIn !== undefined ? (
            <Text color="error">  At this rate you hit 100% in {fmtDur(b.outIn)}, {fmtDur(v.resetIn - b.outIn)} before the reset.</Text>
          ) : (
            <Text color="success">  At this rate you reach about {Math.round(atReset)}% by the reset. You won't run out.</Text>
          )}
          {v.time < 15 && <Text dimColor>  The window is young ({Math.round(v.time)}% gone), so this rate can still swing a lot.</Text>}
        </Box>

        {rate > 1 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>To slow down</Text>
            <Text>  • Switch routine work to Sonnet (/model sonnet).</Text>
            <Text>  • Compact or /clear long sessions so each turn re-sends less.</Text>
            <Text>  • Avoid long idle gaps that let the cache go cold.</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'cache' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const at = (await read($, now)) || (await $.clock.now())
    const list = await read($, steps)
    const t = await read($, ttl)
    const tokens = await read($, ctxTokens)
    const m = await read($, model)
    const last = await read($, lastStepAt)
    const ttlMs = t === '5m' ? 5 * MIN : HOUR
    const idle = last > 0 ? at - last : 0
    const left = ttlMs - idle
    const isCold = last > 0 && left <= 0
    const nc = nextCost(m, tokens, t)
    const recent = list.slice(-10)
    const hit = Math.round(hitRatio(recent) * 100)
    const misses = list.filter(x => x.read + x.write + x.input > 30_000 && x.write > x.read).length
    const W = clamp((e.props.bodyColumns ?? 60) - 30, 10, 30)
    const ratio = nc.warm > 0 ? Math.round(nc.cold / nc.warm) : 0
    const status = isCold ? 'Cold' : last === 0 ? 'Not started' : 'Warm'
    const sc = isCold ? 'error' : last === 0 ? 'inactive' : left < ttlMs * 0.2 ? 'warning' : 'success'
    const lifeFill = last === 0 ? 0 : Math.round((clamp((left / ttlMs) * 100) / 100) * W)

    return (
      <Box flexDirection="column">
        <Text bold color={sc}>{status}</Text>
        <Text>
          {isCold
            ? `Idle ${fmtDur(idle)}, past the ${t === '5m' ? '5-minute' : '1-hour'} cache life. Your next message re-sends everything at full price.`
            : last === 0
              ? 'No reply yet this session.'
              : `Stays warm for ${fmtDur(left)} more if you send nothing. Every message resets that timer.`}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          <Text>Life left   <Text color={sc}>{'█'.repeat(lifeFill)}</Text><Text color="inactive">{'░'.repeat(W - lifeFill)}</Text> {last === 0 ? '—' : isCold ? 'expired' : fmtDur(left)}</Text>
          <Text dimColor>Cache life {t === 'unknown' ? '1h (assumed; learned after your first long idle gap)' : t === '5m' ? '5 minutes (learned from this session)' : '1 hour (learned from this session)'}</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Next message</Text>
          <Text>  While warm  <Text color="success" bold>{usd(nc.warm)}</Text><Text dimColor>  {fmtTok(tokens)} tokens read from cache</Text></Text>
          <Text>  Once cold   <Text color={isCold ? 'error' : 'warning'} bold>{usd(nc.cold)}</Text><Text dimColor>  {fmtTok(tokens)} tokens written again at {t === '5m' ? '1.25×' : '2×'} input price</Text></Text>
          {ratio > 1 && <Text dimColor>  Going cold makes that message about {ratio}× more expensive. Prices are API list rates for {m.replace(/^claude-/, '') || 'this model'}.</Text>}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Hit rate</Text>
          <Text>  <Text color={hit >= 85 ? 'success' : hit >= 70 ? 'warning' : 'error'} bold>{recent.length === 0 ? '—' : `${hit}%`}</Text> of input served from cache over the last {recent.length} requests <Text dimColor>(normal is 90%+)</Text></Text>
          <Text>  {recent.map(x => {
            const r = hitRatio([x])
            return <Text color={r >= 0.85 ? 'success' : r >= 0.5 ? 'warning' : 'error'}>{r >= 0.85 ? '▇' : r >= 0.5 ? '▄' : '▁'}</Text>
          })}<Text dimColor>  each bar is one request, tall = reused</Text></Text>
          <Text dimColor>  {misses === 0 ? 'No cache misses this session.' : `${misses} cache miss${misses > 1 ? 'es' : ''} this session (a model switch, edited instructions or an MCP reconnect break the cache).`}</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>What to do</Text>
          {isCold
            ? <Text>  Compact first, so the cold re-send is smaller. Then carry on.</Text>
            : <Text>  Keep messages coming within {fmtDur(Math.max(left, 0))}, or warm the cache before you step away.</Text>}
          <Text>  Don't switch models or reconnect MCP servers mid-session.</Text>
        </Box>

        <Box marginTop={1}>
          <Button key="cache-warm-now" label="Warm cache" variant={!isCold && left < ttlMs * 0.2 ? 'primary' : undefined} onPress={() => warm($)} />
          <Text> </Text>
          <Button key="cache-compact" label="Compact" variant={isCold ? 'primary' : undefined} onPress={() => compact($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'mod-cost' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const x = await read($, modSpend)
    const row = (what: string, cost: string, why: string, c = 'success') => (
      <Box flexDirection="column" marginBottom={1}>
        <Text><Text bold>{what}</Text>  <Text color={c} bold>{cost}</Text></Text>
        <Text dimColor>  {why}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold color={x.usd > 0 ? 'warning' : 'success'}>{x.usd > 0 ? `${usd(x.usd)} this session` : 'Free so far'}</Text>
        <Text dimColor>Everything the meter and its mascot have cost you, at API list prices.</Text>
        <Box flexDirection="column" marginTop={1}>
          {row('Your prompts', '0 tokens', 'The meter adds nothing to what Claude reads, so your cache and turns are untouched.')}
          {row('Mascot and bars', '0 tokens', 'The blinking and the redraws happen on your machine only (about twice a second).')}
          {row('Usage readings', '0 tokens', 'Limits, context and cost are read from the session every 15s for free.')}
          {row('Warm-ups', x.warmups === 0 ? 'none yet' : `${x.warmups} · ${usd(x.usd)}`, 'Each Warm cache press asks Claude one tiny question over your context: cheap while warm, full price if already cold.', x.warmups === 0 ? 'success' : 'warning')}
          {row('Compacts from the meter', x.compacts === 0 ? 'none yet' : `${x.compacts}`, 'Compacting costs one summary call, but makes every message after it cheaper.', x.compacts === 0 ? 'success' : 'warning')}
        </Box>
        <Text dimColor>Tokens used by the meter's own calls: {fmtTok(x.tokens)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'issues' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const at = (await read($, now)) || (await $.clock.now())
    const snap: Snapshot = {
      now: at,
      steps: await read($, steps),
      limits: await read($, limits),
      ctxTokens: await read($, ctxTokens),
      ctxWindow: await read($, ctxWindow),
      ctxPercent: await read($, ctxPercent),
      cats: await read($, cats),
      lastStepAt: await read($, lastStepAt),
      ttl: await read($, ttl),
      model: await read($, model),
    }
    const list = unseen([...((await read($, isDemo)) ? DEMO : []), ...overRules(await read($, alertCfg), snap, await read($, costUsd)), ...analyze(snap).filter(f => f.level === 'bad' || f.level === 'warn')], await read($, dismissed))
    const run = (a: Action) => (a === 'compact' ? compact($) : a === 'sonnet' ? sonnet($) : warm($))
    const label: Record<Action, string> = { compact: 'Compact now', sonnet: 'Use Sonnet', warm: 'Warm cache' }

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold color="success">Nothing needs fixing</Text>
          <Text dimColor>Everything is back to normal. This panel can be closed.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {list.length > 1 && (
          <Box marginBottom={1}>
            <Button key="dis-all" label="Dismiss all" onPress={() => update($, dismissed, d => [...d, ...list.map(findingKey)])} />
          </Box>
        )}
        {list.map((f, n) => (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="black" backgroundColor={levelColor[f.level]}>{` ${n + 1}. ${f.level === 'bad' ? 'URGENT' : 'WARNING'} `}</Text>
            <Text bold color={levelColor[f.level]}>{f.title}</Text>
            <Text><Text bold>What's wrong  </Text>{f.detail}</Text>
            <Text><Text bold>How to fix    </Text>{f.action ? FIXES[f.action] : 'Nothing to press: keep it in mind as you work, and it clears by itself.'}</Text>
            {f.action && (
              <Box marginTop={1}>
                <Button key={`fix-${n}`} label={label[f.action]} variant="primary" autoFocus={n === 0 ? true : undefined} onPress={() => run(f.action as Action)} />
                <Text>  </Text>
                <Button key={`dis-${n}`} label="Dismiss" onPress={() => update($, dismissed, d => [...d, findingKey(f)])} />
              </Box>
            )}
            {!f.action && (
              <Box marginTop={1}>
                <Button key={`dis-${n}`} label="Dismiss" onPress={() => update($, dismissed, d => [...d, findingKey(f)])} />
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'goals' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, goals)
    const at = (await read($, now)) || (await $.clock.now())
    const fc = goalForecast(list, at)
    const done = list.filter(g => g.status === 'completed')
    const doing = list.filter(g => g.status === 'in_progress')
    const todo = list.filter(g => g.status === 'pending')
    const W = clamp((e.props.bodyColumns ?? 60) - 20, 10, 40)
    const f = list.length > 0 ? Math.round((done.length / list.length) * W) : 0
    const item = (g: Goal, mark: string, color: string, isDim = false) => (
      <Text wrap="truncate-end">
        <Text color={color}>{`  ${mark} `}</Text>
        <Text dimColor={isDim} strikethrough={g.status === 'completed'}>{g.text}</Text>
        {g.status === 'completed' && <Text color="success">{`   took ${fmtSpan(g.workMs)}`}</Text>}
        {g.status === 'in_progress' && (
          <Text color="warning">
            {`   ${fmtSpan(workOf(g, at))} so far`}
            {fc.avg !== undefined && (workOf(g, at) < fc.avg ? ` · ~${fmtSpan(fc.avg - workOf(g, at))} left` : ' · taking longer than usual')}
          </Text>
        )}
        {g.status === 'pending' && fc.avg !== undefined && <Text dimColor>{`   ~${fmtSpan(fc.avg)}`}</Text>}
      </Text>
    )

    const periods = (
      <Box marginBottom={1}>
        <Text dimColor>Journey  </Text>
        <Button key="j-session" label="This session" onPress={() => $.ui.open({ id: 'journey-session', title: 'This session' })} />
        <Text> </Text>
        <Button key="j-today" label="Today" onPress={() => $.ui.open({ id: 'journey-today', title: 'Today' })} />
        <Text> </Text>
        <Button key="j-week" label="This week" onPress={() => $.ui.open({ id: 'journey-week', title: 'This week' })} />
      </Box>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column" backgroundColor="#1c2128" paddingX={2} paddingY={1} flexGrow={1}>
          {periods}
          <Text bold color="claude">NO GOALS YET</Text>
          <Text dimColor>Goals appear when Claude plans work as a task list. Ask for a multi-step task and they show up here.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" backgroundColor="#1c2128" paddingX={2} paddingY={1} flexGrow={1}>
        {periods}
        <Text>
          <Text bold color="claude">GOALS  </Text>
          <Text color="success">{'━'.repeat(f)}</Text>
          <Text color="inactive">{'─'.repeat(W - f)}</Text>
          <Text bold>  {done.length}/{list.length} achieved</Text>
        </Text>
        <Text>
          <Text dimColor>Worked </Text>
          <Text bold>{fmtSpan(fc.spent)}</Text>
          {fc.avg !== undefined && <Text dimColor>   ·   about </Text>}
          {fc.avg !== undefined && <Text bold>{fmtSpan(fc.avg)}</Text>}
          {fc.avg !== undefined && <Text dimColor> per goal</Text>}
          {fc.left !== undefined && fc.left > 0 && <Text dimColor>   ·   </Text>}
          {fc.left !== undefined && fc.left > 0 && <Text bold color="warning">~{fmtSpan(fc.left)} to go</Text>}
          {fc.avg === undefined && <Text dimColor>   ·   estimates start once the first goal is achieved</Text>}
        </Text>
        <Text dimColor>Working time counts only while Claude is busy on a goal, not while waiting for you.</Text>
        {doing.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="warning">IN PROGRESS</Text>
            {doing.map(g => item(g, '▶', 'warning'))}
          </Box>
        )}
        {todo.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>TO ACHIEVE</Text>
            {todo.slice(0, 10).map(g => item(g, '○', 'inactive'))}
            {todo.length > 10 && <Text dimColor>{`    and ${todo.length - 10} more`}</Text>}
          </Box>
        )}
        {done.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="success">ACHIEVED</Text>
            {done.slice(-8).reverse().map(g => item(g, '✔', 'success', true))}
            {done.length > 8 && <Text dimColor>{`    and ${done.length - 8} earlier`}</Text>}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: /^journey-/ }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const period = String(e.requestId).replace(/^journey-/, '') as Period
    const at = (await read($, now)) || (await $.clock.now())
    const sid = (await $.session.usage()).startedAt
    const turns = await loadTurns($, period, sid, at)
    const sum = summarize(turns)
    const name = period === 'session' ? 'THIS SESSION' : period === 'today' ? 'TODAY' : 'THIS WEEK'
    const box = (body: any) => (
      <Box flexDirection="column" backgroundColor="#1c2128" paddingX={2} paddingY={1} flexGrow={1}>
        {body}
      </Box>
    )

    if (turns.length === 0) {
      return box(
        <Box flexDirection="column">
          <Text bold color="claude">{name}</Text>
          <Text dimColor>No journey recorded yet. Every message you send from now on is added here.</Text>
        </Box>,
      )
    }

    const stat = (value: string, label: string, color = 'text') => (
      <Text>
        <Text bold color={color}>{value}</Text>
        <Text dimColor> {label}     </Text>
      </Text>
    )
    const byDay = new Map<string, Turn[]>()
    for (const x of turns) {
      const k = dayKey(x.at).replace('journal:', '')
      byDay.set(k, [...(byDay.get(k) ?? []), x])
    }
    const room = Math.max(6, (e.viewport?.rows ?? 30) - 12)
    const shown = turns.slice(-room)

    return box(
      <Box flexDirection="column">
        <Text>
          <Text bold color="claude">{name}</Text>
          <Text dimColor>   {clock(sum.from)} → {clock(sum.to)}{period === 'week' ? ` · ${byDay.size} days` : ''}</Text>
        </Text>
        <Box marginTop={1}>
          {stat(`${sum.asks}`, sum.asks === 1 ? 'ask' : 'asks')}
          {stat(fmtSpan(sum.ms), 'of Claude working')}
          {stat(`${sum.goals.length}`, sum.goals.length === 1 ? 'goal achieved' : 'goals achieved', 'success')}
          {stat(`${sum.files.length}`, sum.files.length === 1 ? 'file changed' : 'files changed')}
          {stat(usd(sum.usd), 'spent', 'warning')}
        </Box>

        {sum.goals.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="success">ACHIEVED</Text>
            {sum.goals.slice(-6).map(g => <Text wrap="truncate-end"><Text color="success">  ✔ </Text>{g}</Text>)}
            {sum.goals.length > 6 && <Text dimColor>{`    and ${sum.goals.length - 6} more`}</Text>}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>THE JOURNEY</Text>
          {turns.length > shown.length && <Text dimColor>{`  … ${turns.length - shown.length} earlier asks`}</Text>}
          {shown.map((x, n) => {
            const prevDay = n > 0 ? dayKey(shown[n - 1].at) : ''
            const isNewDay = period === 'week' && dayKey(x.at) !== prevDay

            return (
              <Box flexDirection="column">
                {isNewDay && <Text color="claude">{`  ${dayKey(x.at).replace('journal:', '')}`}</Text>}
                <Text wrap="truncate-end">
                  <Text dimColor>{`  ${clock(x.at)}  `}</Text>
                  <Text>{x.ask || '(no text)'}</Text>
                </Text>
                <Text wrap="truncate-end" dimColor>
                  {`         ${fmtSpan(x.ms)} · ${x.tools} tool${x.tools === 1 ? '' : 's'} · ${usd(x.usd)}`}
                  {x.edits.length > 0 ? ` · ✎ ${x.edits.map(shortPath).slice(0, 3).join(', ')}${x.edits.length > 3 ? ` +${x.edits.length - 3}` : ''}` : ''}
                  {x.goals.length > 0 ? <Text color="success">{` · ✔ ${x.goals.length}`}</Text> : ''}
                </Text>
              </Box>
            )
          })}
        </Box>

        {sum.files.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>FILES CHANGED</Text>
            <Text wrap="truncate-end" dimColor>{`  ${sum.files.map(shortPath).slice(0, 12).join('  ·  ')}${sum.files.length > 12 ? `  +${sum.files.length - 12}` : ''}`}</Text>
          </Box>
        )}
      </Box>,
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const at = (await read($, now)) || (await $.clock.now())
    const list = await read($, limits)
    const snap: Snapshot = {
      now: at,
      steps: await read($, steps),
      limits: list,
      ctxTokens: await read($, ctxTokens),
      ctxWindow: await read($, ctxWindow),
      ctxPercent: await read($, ctxPercent),
      cats: await read($, cats),
      lastStepAt: await read($, lastStepAt),
      ttl: await read($, ttl),
      model: await read($, model),
    }
    const findings = unseen([...((await read($, isDemo)) ? DEMO : []), ...overRules(await read($, alertCfg), snap, await read($, costUsd)), ...analyze(snap).filter(f => f.level === 'bad' || f.level === 'warn')], await read($, dismissed))
    const top = findings[0]
    const hit = Math.round(hitRatio(snap.steps.slice(-10)) * 100)
    const ctxC = snap.ctxPercent >= 85 ? 'error' : snap.ctxPercent >= 60 ? 'warning' : 'success'
    const hitC = snap.steps.length === 0 ? 'inactive' : hit >= 85 ? 'success' : hit >= 70 ? 'warning' : 'error'
    const nc = nextCost(snap.model, snap.ctxTokens, snap.ttl)
    const W = 8
    const paceWord = (v: LimitView): [string, string] =>
      v.time === undefined ? ['', 'subtle']
        : v.ahead >= 10 ? ['too fast', 'error']
        : v.ahead >= 3 ? ['a bit fast', 'warning']
        : ['on track', 'success']
    const sep = <Text color="inactive"> · </Text>
    const ttlMs = snap.ttl === '5m' ? 5 * MIN : HOUR
    const idle = snap.lastStepAt > 0 ? at - snap.lastStepAt : 0
    const left = ttlMs - idle
    const isCold = snap.lastStepAt > 0 && left <= 0
    const last0 = snap.lastStepAt === 0
    const isWorking = (await read($, activity)).kind !== 'idle'
    const isStraining = isWorking && (await read($, isHard))
    // Breathing: in and out every two seconds; faster while straining.
    const isIn = Math.floor((await read($, frame)) / (isStraining ? 2 : 4)) % 2 === 0
    const mascot = eyesFor(await read($, frame), isStraining ? 'working' : isWorking ? 'calm' : findings.length === 0 ? 'happy' : 'calm')
    const goalList = await read($, goals)
    const done = goalList.filter(g => g.status === 'completed').length
    const fc = goalForecast(goalList, at)
    const isPlanning = await read($, planning)
    // Always 5 dots, each a fifth of the goals.
    const slots = 5
    const filled = goalList.length === 0 ? 0 : done === goalList.length ? slots : Math.min(slots - 1, Math.floor((done / goalList.length) * slots))
    const dots = [filled, slots - filled]
    const spend = await read($, modSpend)
    const sc = isCold ? 'error' : last0 ? 'inactive' : left < ttlMs * 0.2 ? 'warning' : 'success'
    const byKind = (k: string) => list.find(l => l.kind === k)

    const limitRow = (label: string, l: Limit | undefined) => {
      if (!l) return <Text dimColor>{label}shows after the first reply</Text>
      const v = limitView(l, at)
      const c = colorFor(v)
      const fill = Math.max(Math.round((clamp(v.used) / 100) * W), v.used > 0 ? 1 : 0)
      const [word, wc] = paceWord(v)

      return (
        <Box>
        <Text>
          <Text bold>{label}</Text>
          <Text color={c}>{'━'.repeat(fill)}</Text>
          <Text color="inactive">{'─'.repeat(W - fill)}</Text>
          <Text bold color={c}>  {`${Math.round(v.used)}%`.padStart(4)}</Text>
          {word && <Text>{sep}</Text>}
        </Text>
        {word && (
          <Button key={`pace-${l.kind}`} plain onPress={() => $.ui.open({ id: `pace-${l.kind}`, title: `${label.trim()} pace` })}>
            <Text color={wc} underline>{word}</Text>
          </Button>
        )}
        <Text wrap="truncate-end">
          {v.resetIn !== undefined && <Text>{sep}<Text dimColor>resets in {fmtDur(v.resetIn)}</Text></Text>}
        </Text>
        </Box>
      )
    }

    return (
      <Box backgroundColor="#232a33" paddingX={2} flexGrow={1} alignItems="center">
        <Box flexDirection="column" flexShrink={0} marginRight={4}>
          {limitRow('Session  ', byKind('five_hour'))}
          {limitRow('Weekly   ', byKind('seven_day'))}
        </Box>
        <Box flexDirection="column" flexShrink={1} minWidth={20} marginRight={3}>
          <Box>
            <Button key="cache-warm" plain onPress={() => $.ui.open({ id: 'cache', title: 'Cache' })}>
              <Text bold underline color={sc}>{last0 ? '⏳ Cache starts after first reply' : isCold ? '🧊 Cache is cold' : '🔥 Cache is warm'}</Text>
            </Button>
            <Text wrap="truncate-end">
              {!last0 && !isCold && <Text dimColor> for {fmtDur(left)}</Text>}
              {!last0 && <Text dimColor> · next message </Text>}
              {!last0 && <Text bold color={isCold ? 'error' : 'success'}>{usd(isCold ? nc.cold : nc.warm)}</Text>}
            </Text>
          </Box>
          <Box>
            {!last0 && (
              <Button key="cache-cold" plain onPress={() => $.ui.open({ id: 'cache', title: 'Cache' })}>
                <Text underline color={isCold ? 'subtle' : 'warning'}>{isCold ? 'Was' : 'If it goes cold'}</Text>
              </Button>
            )}
            <Text wrap="truncate-end">
              {!last0 && <Text dimColor>{isCold ? ' ' : ' · next message '}</Text>}
              {!last0 && <Text color={isCold ? 'success' : 'warning'}>{usd(isCold ? nc.warm : nc.cold)}</Text>}
              {!last0 && isCold && <Text dimColor> while warm · compact first</Text>}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          <Text>
            <Text bold>Context  </Text>
            <Text color={ctxC}>{snap.ctxPercent}%</Text>
          </Text>
          <Button key="details" plain label="More ›" onPress={() => $.ui.open({ id: PANE, title: 'More' })} />
        </Box>
        {top && (
          <Box flexDirection="column" flexShrink={0} marginLeft={4}>
            <Button key="alert-top" plain onPress={() => $.ui.open({ id: 'issues', title: 'What needs fixing', focus: true })}>
              <Text bold color="black" backgroundColor={levelColor[top.level]}>
                {` ${isIn ? '⚠' : ' '}  ${findings.length === 1 ? '1 THING NEEDS YOU' : `${findings.length} THINGS NEED YOU`}  `}
              </Text>
            </Button>
            <Button key="alert-sub" plain onPress={() => $.ui.open({ id: 'issues', title: 'What needs fixing', focus: true })}>
              <Text bold color={levelColor[top.level]} underline>{` ${top.title} · fix it ›`}</Text>
            </Button>
          </Box>
        )}
        <Box flexGrow={1} minWidth={4} />
        <Box flexDirection="column" flexShrink={0} marginRight={2}>
          {isStraining ? (
            <Text><Text color="claude" backgroundColor="white">▀▀▀▀▀</Text><Text color="white">{isIn ? '▚' : '▞'}</Text></Text>
          ) : (
            <Text color="claude">{isIn ? '▗▄▄▄▖ ' : ' ▃▃▃  '}</Text>
          )}
          <Text color="claude" inverse>{mascot}</Text>
        </Box>
        {true && (
          <Box flexDirection="column" flexShrink={0} marginRight={1}>
            {goalList.length === 0 ? (
              <Button key="goals" plain onPress={() => $.ui.open({ id: 'goals', title: 'Session goals' })}>
                <Text>
                  <Text>🎯 </Text>
                  <Text color="inactive">○○○○○</Text>
                  <Text bold> 0/0</Text>
                  {isPlanning && <Text dimColor> planning…</Text>}
                </Text>
              </Button>
            ) : goalList.length > 0 ? (
              <Button key="goals" plain onPress={() => $.ui.open({ id: 'goals', title: 'Session goals' })}>
                <Text>
                  <Text>🎯 </Text>
                  <Text color={done === goalList.length ? 'success' : 'claude'}>{'●'.repeat(dots[0])}</Text>
                  <Text color="inactive">{'○'.repeat(dots[1])}</Text>
                  <Text bold> {done}/{goalList.length}</Text>
                  {fc.left !== undefined && done < goalList.length && <Text dimColor> · ~{fmtSpan(fc.left)} left</Text>}
                </Text>
              </Button>
            ) : (
              <Text> </Text>
            )}
            {spend.usd > 0 && (
              <Button key="mod-cost" plain onPress={() => $.ui.open({ id: 'mod-cost', title: 'What the meter costs' })}>
                <Text dimColor>⛽ </Text><Text dimColor underline>{usd(spend.usd)}</Text>
              </Button>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
