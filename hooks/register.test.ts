import { test, expect } from 'claude-code/testing'

import { addTally, advancePlan, analyze, cheaperTier, parsePlan, overRules, applyGoals, summarize, goalForecast, barSegs, burn, costParts, inferTtl, limitView, nextCost } from './register'
import type { Snapshot } from './register'

const MIN = 60_000
const base: Snapshot = {
  now: 10 * 60 * MIN,
  steps: [],
  limits: [],
  ctxTokens: 20_000,
  ctxWindow: 200_000,
  ctxPercent: 10,
  cats: [],
  lastStepAt: 0,
  ttl: 'unknown',
  model: 'claude-sonnet-5-5',
}

test('time marker sits at the elapsed share of the window', () => {
  const resetsAt = new Date(10 * 60 * MIN + 2.5 * 60 * MIN).toISOString()
  const v = limitView({ kind: 'five_hour', percentUsed: 80, resetsAt }, 10 * 60 * MIN)
  expect(Math.round(v.time ?? -1)).toBe(50)
  expect(Math.round(v.ahead)).toBe(30)
  const segs = barSegs(80, v.time, 10)
  expect(segs.map(s => s.text).join('').length).toBe(10)
  expect(segs.find(s => s.kind === 'used')?.text).toBe('█████')
  expect(segs.find(s => s.kind === 'over')?.text).toBe('███')
  const under = barSegs(20, 50, 10)
  expect(under.map(s => s.kind)).toEqual(['used', 'budget', 'rest'])
})

test('quiet session reports nothing abnormal', () => {
  expect(analyze(base)[0].level).toBe('ok')
})

test('opus burning ahead of pace suggests sonnet and flags context', () => {
  const resetsAt = new Date(base.now + 4 * 60 * MIN).toISOString()
  const found = analyze({
    ...base,
    model: 'claude-opus-5-5',
    ctxPercent: 70,
    limits: [{ kind: 'five_hour', percentUsed: 70, resetsAt }],
  })
  expect(found.some(f => f.action === 'cheaper')).toBe(true)
  expect(found.some(f => f.action === 'compact')).toBe(true)
})

test('cache miss and lapse are flagged, ttl is learned from a long gap', () => {
  const miss = analyze({
    ...base,
    steps: [{ at: 1, model: 'm', input: 100, output: 50, read: 1000, write: 60_000 }],
  })
  expect(miss.some(f => f.title.startsWith('Cache miss'))).toBe(true)

  const warm = analyze({ ...base, ctxTokens: 80_000, lastStepAt: base.now - 4.5 * MIN })
  expect(warm.some(f => f.action === 'warm')).toBe(true)

  const hit = { at: 2, model: 'm', input: 100, output: 50, read: 90_000, write: 500 }
  expect(inferTtl('unknown', 30 * MIN, hit)).toBe('1h')
  expect(inferTtl('unknown', 30 * MIN, { ...hit, read: 0, write: 90_000 })).toBe('5m')
  expect(inferTtl('1h', 2 * MIN, hit)).toBe('1h')
})

test('cold cache costs the write price, warm the read price', () => {
  const c = nextCost('claude-opus-5-5', 1_000_000, '1h')
  expect(Math.round(c.warm * 100)).toBe(20)
  expect(Math.round(c.cold * 100)).toBe(800)
  expect(Math.round(nextCost("claude-sonnet-5-5", 1_000_000, "5m").cold * 100)).toBe(250)
})

test('burn rate compares limit used to time gone and projects run-out', () => {
  const at = 10 * 60 * MIN
  const resetsAt = new Date(at + 2.5 * 60 * MIN).toISOString()
  const l = { kind: 'five_hour', percentUsed: 80, resetsAt }
  const b = burn(limitView(l, at), l)
  expect(Math.round((b.rate ?? 0) * 10)).toBe(16)
  expect(Math.round((b.outIn ?? 0) / MIN)).toBe(38)
})

test('tally splits a request by activity and by what it paid for', () => {
  const parts = costParts('claude-opus-5-5', { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }, '1h')
  const t = addTally({ requests: 0, byKind: {}, byModel: {}, byType: { input: [0, 0], output: [0, 0], read: [0, 0], write: [0, 0] } }, 'shell', 'claude-opus-5-5', parts)
  expect(t.requests).toBe(1)
  expect(Math.round(t.byType.read[1] * 100)).toBe(20)
  expect(Math.round(t.byKind.shell.usd * 1000)).toBe(224)
})

test('goal working time and the forecast for what is left', () => {
  let g = applyGoals([], [{ id: 'a', text: 'a', status: 'in_progress' }, { id: 'b', text: 'b', status: 'pending' }], 0, true)
  g = applyGoals(g, [{ id: 'a', text: 'a', status: 'completed' }, { id: 'b', text: 'b', status: 'in_progress' }], 4 * MIN, true)
  expect(g[0].workMs).toBe(4 * MIN)
  const fc = goalForecast(g, 5 * MIN)
  expect(fc.avg).toBe(4 * MIN)
  expect(fc.next).toBe(3 * MIN)
  expect(fc.left).toBe(3 * MIN)
})

test('a journey sums asks, work time, goals, files and spend', () => {
  const turn = (at: number, edits: string[], goals: string[]) => ({ sid: 1, at, ask: 'x', ms: 2 * MIN, usd: 0.5, tools: 3, edits, goals })
  const sum = summarize([turn(0, ['a.ts'], ['g1']), turn(10 * MIN, ['a.ts', 'b.ts'], [])])
  expect(sum.asks).toBe(2)
  expect(sum.ms).toBe(4 * MIN)
  expect(sum.files).toEqual(['a.ts', 'b.ts'])
  expect(sum.goals).toEqual(['g1'])
  expect(sum.usd).toBe(1)
})

test('a user alert fires only when its reading passes the limit', () => {
  const cfg = {
    session: { on: true, at: 80 },
    weekly: { on: true, at: 10 },
    context: { on: false, at: 5 },
    cost: { on: true, at: 20 },
    cold: { on: false, at: 2 },
  }
  const found = overRules(cfg, { ...base, limits: [{ kind: 'seven_day', percentUsed: 16 }] }, 5)
  expect(found.length).toBe(1)
  expect(found[0].title.startsWith('Weekly limit 16%')).toBe(true)
})

test('a quick plan parses and moves along with elapsed time', () => {
  const steps = parsePlan('sure {"steps":[{"t":"Sketch scenes","m":2},{"t":"Write HTML","m":4}]}')
  expect(steps.length).toBe(2)
  const g = steps.map((st, n) => ({ id: `plan:${n}`, text: st.t, status: 'pending' as const, workMs: 0, estMs: st.m * MIN }))
  const moved = advancePlan(g, 3 * MIN)
  expect(moved[0].status).toBe('completed')
  expect(moved[1].status).toBe('in_progress')
  expect(goalForecast(moved, 0).left).toBe(3 * MIN)
})

test('the cheaper model steps down one tier from whatever is running', () => {
  expect(cheaperTier('claude-fable-5-1')?.id).toBe('opus')
  expect(cheaperTier('claude-opus-5-5')?.id).toBe('sonnet')
  expect(cheaperTier('claude-sonnet-5-5')?.id).toBe('haiku')
  expect(cheaperTier('claude-haiku-5-5')).toBeUndefined()
  expect(analyze({ ...base, model: 'claude-haiku-5-5' }).some(f => f.action === 'cheaper')).toBe(false)
})
