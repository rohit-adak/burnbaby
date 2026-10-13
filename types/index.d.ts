export type Step = {
  at: number
  model: string
  input: number
  output: number
  read: number
  write: number
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Cat = { name: string; tokens: number }

export type Tally = {
  requests: number
  byKind: Record<string, { usd: number; tokens: number; requests: number }>
  byModel: Record<string, { usd: number; requests: number }>
  byType: { input: [number, number]; output: [number, number]; read: [number, number]; write: [number, number] }
}

export type Goal = {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  workMs: number
  activeSince?: number
  estMs?: number
}

export type Turn = {
  sid: number
  at: number
  ask: string
  ms: number
  usd: number
  tools: number
  edits: string[]
  goals: string[]
}

export type AlertRule = { on: boolean; at: number }
export type AlertCfg = { session: AlertRule; weekly: AlertRule; context: AlertRule; cost: AlertRule; cold: AlertRule }

export type Ttl = 'unknown' | '5m' | '1h'

declare module 'claude-code' {
  interface PluginState {
    'burnbaby': {
      steps: Step[]
      limits: Limit[]
      ctxTokens: number
      ctxWindow: number
      ctxPercent: number
      costUsd: number
      cats: Cat[]
      now: number
      startedAt: number
      lastStepAt: number
      ttl: Ttl
      model: string
      activity: { kind: string; n: number }
      frame: number
      goals: Goal[]
      alertCfg: AlertCfg
      fired: string[]
      dismissed: string[]
      planning: boolean
      draft: Turn | null
      journal: Turn[]
      turnAt: number
      tally: Tally
      isHard: boolean
      modSpend: { warmups: number; compacts: number; tokens: number; usd: number }
    }
  }
}
