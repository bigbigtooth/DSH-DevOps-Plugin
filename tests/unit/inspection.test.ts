import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryStorage } from '../../src/host/adapters/memory.ts'
import { OpsRepository } from '../../src/host/repository/ops-repository.ts'
import { InspectionService } from '../../src/host/agents/inspection-service.ts'
import type { AgentBridge, ClockPort, StructuredAgentResult } from '../../src/host/adapters/ports.ts'
import type { ProcessSnapshot } from '../../src/contracts/entities.ts'
import { SCHEMA_VERSION } from '../../src/contracts/entities.ts'

function fixedClock(): ClockPort {
  let t = 1000
  return { now: () => (t += 10) }
}

function makeSnapshot(n: number): ProcessSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: 'snap1',
    serverId: 's1',
    scope: 'all',
    collectedAt: 1,
    limited: false,
    limitReason: null,
    processes: Array.from({ length: n }, (_, i) => ({
      pid: i + 1,
      name: `proc${i}`,
      user: 'u',
      rssBytes: 1000 + i,
      cpuPercent: i % 3,
      startedAt: null,
      elapsedSeconds: null,
      state: i === 0 ? 'Z' : 'S',
      startToken: `tok-${i}`,
      ppid: null,
      command: `/bin/proc${i}`,
      cwd: `/srv/proc${i}`,
      ioReadBytesPerSec: null,
      ioWriteBytesPerSec: null,
      launchMode: null,
    })),
  }
}

function policy(over: Partial<Parameters<InspectionService['runInspection']>[2]> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 's1:process',
    serverId: 's1',
    kind: 'process' as const,
    enabled: true,
    intervalSeconds: 300,
    modelRef: null,
    focusProcessesVersion: 1,
    focusProcesses: [] as string[],
    groupingRulesVersion: 1,
    groupingRules: [],
    expectedStatesVersion: 1,
    expectedStates: [],
    thresholdsVersion: 1,
    thresholds: { cpuPercent: null, rssBytes: null },
    logIncludeVersion: 1,
    logInclude: [],
    logIgnoreVersion: 1,
    logIgnore: [],
    scopeVersion: 1,
    scope: 'all' as const,
    naturalLanguageVersion: 1,
    naturalLanguage: '',
    nextRunAt: null,
    updatedAt: 1,
    ...over,
  }
}

class FakeAgentBridge implements AgentBridge {
  calls = 0
  lastTask = ''
  /** produce (task) → raw model text */
  constructor(public respond: (task: string, call: number) => string) {}
  async run(spec: { task: string }, validate: (payload: unknown) => { ok: true; value: unknown } | { ok: false; error: string }): Promise<StructuredAgentResult> {
    this.calls++
    this.lastTask = spec.task
    const raw = this.respond(spec.task, this.calls)
    const start = raw.indexOf('{')
    const parsed = validate(JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1)))
    if (!parsed.ok) return { ok: false, payload: null, rawText: raw, requestCount: 1, error: parsed.error }
    return { ok: true, payload: parsed.value, rawText: raw, requestCount: 1 }
  }
  async cancel(): Promise<void> {}
}

async function freshRepo(): Promise<OpsRepository> {
  const storage = new MemoryStorage()
  return new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock: fixedClock(), controllerId: 'c' })
}

describe('AI process inspection (S5)', () => {
  let repo: OpsRepository
  beforeEach(async () => {
    repo = await freshRepo()
  })

  it('full coverage of a normal snapshot → complete + zero findings', async () => {
    const agent = new FakeAgentBridge((task) => {
      const tokens = [...task.matchAll(/^- (p\d+) \|/gm)].map((m) => m[1]!)
      return JSON.stringify({ analyzed: tokens, findings: [] })
    })
    const svc = new InspectionService({ agentBridge: agent, repo, clock: fixedClock(), modelRef: 'deepseek/chat', batchBudgetTokens: 8000 })
    const run = await svc.runInspection('s1', makeSnapshot(50), null)
    expect(run.analysisState).toBe('complete')
    expect(run.coverageAnalyzed).toBe(50)
    expect(run.coverageTotal).toBe(50)
  })

  it('batches large snapshots under the token budget with per-batch identity lists', async () => {
    const agent = new FakeAgentBridge((task) => {
      const tokens = [...task.matchAll(/^- (p\d+) \|/gm)].map((m) => m[1]!)
      return JSON.stringify({ analyzed: tokens, findings: [] })
    })
    const svc = new InspectionService({ agentBridge: agent, repo, clock: fixedClock(), modelRef: 'deepseek/chat', batchBudgetTokens: 8000 })
    const run = await svc.runInspection('s1', makeSnapshot(400), null)
    expect(run.analysisState).toBe('complete')
    expect(agent.calls).toBeGreaterThanOrEqual(2)
  })

  it('custom policy (focus/expected/thresholds/NL) reaches the agent task', async () => {
    let seenTask = ''
    const agent = new FakeAgentBridge((task) => {
      seenTask = task
      const tokens = [...task.matchAll(/^- (p\d+) \|/gm)].map((m) => m[1]!)
      return JSON.stringify({ analyzed: tokens, findings: [] })
    })
    const svc = new InspectionService({ agentBridge: agent, repo, clock: fixedClock(), modelRef: 'deepseek/chat' })
    await svc.runInspection('s1', makeSnapshot(5), policy({
      focusProcesses: ['nginx'],
      expectedStates: [{ match: 'nginx', expected: 'running' }],
      thresholds: { cpuPercent: 80, rssBytes: 104857600 },
      naturalLanguage: '留意挖矿进程',
    }))
    expect(seenTask).toContain('nginx')
    expect(seenTask).toContain('80%')
    expect(seenTask).toContain('挖矿')
  })

  it('model-claimed all-clear does NOT count as coverage — fabricated tokens are rejected', async () => {
    const agent = new FakeAgentBridge(() => JSON.stringify({ analyzed: ['tok-0', 'tok-1', 'FABRICATED-TOKEN'], findings: [] }))
    const svc = new InspectionService({ agentBridge: agent, repo, clock: fixedClock(), modelRef: 'deepseek/chat' })
    const run = await svc.runInspection('s1', makeSnapshot(10), null)
    expect(run.analysisState).toBe('failed')
    expect(run.coverageAnalyzed).toBe(0)
    expect(run.error).toMatch(/unknown process references|no processes analyzed/)
  })

  it('schema-violating output fails the batch but keeps others (partial)', async () => {
    let call = 0
    const agent = new FakeAgentBridge((task) => {
      call++
      const tokens = [...task.matchAll(/^- (p\d+) \|/gm)].map((m) => m[1]!)
      if (call === 1) return 'this is not json at all'
      return JSON.stringify({ analyzed: tokens, findings: [] })
    })
    const svc = new InspectionService({ agentBridge: agent, repo, clock: fixedClock(), modelRef: 'deepseek/chat', batchBudgetTokens: 1000 })
    const run = await svc.runInspection('s1', makeSnapshot(400), null) // several batches; first batch's output invalid
    expect(run.analysisState).toBe('partial')
    expect(run.coverageAnalyzed).toBeGreaterThan(0)
    expect(run.coverageAnalyzed).toBeLessThan(400)
    expect(run.error).toBeTruthy()
  })

  it('findings referencing unknown processes are rejected server-side', async () => {
    const agent = new FakeAgentBridge((task) => {
      const tokens = [...task.matchAll(/^- (p\d+) \|/gm)].map((m) => m[1]!)
      return JSON.stringify({
        analyzed: tokens,
        findings: [{ processStartTokens: ['p-NOPE'], severity: 'critical', summary: 'x', evidence: 'y' }],
      })
    })
    const svc = new InspectionService({ agentBridge: agent, repo, clock: fixedClock(), modelRef: 'deepseek/chat' })
    const run = await svc.runInspection('s1', makeSnapshot(10), null)
    expect(run.analysisState).toBe('failed')
  })

  it('no model → analysisState unavailable, snapshot data still preserved', async () => {
    const agent = new FakeAgentBridge(() => JSON.stringify({ analyzed: [], findings: [] }))
    const svc = new InspectionService({ agentBridge: agent, repo, clock: fixedClock(), modelRef: null })
    const snapshot = makeSnapshot(5)
    await repo.putProcessSnapshot(snapshot)
    const run = await svc.runInspection('s1', snapshot, null)
    expect(run.analysisState).toBe('unavailable')
    expect(agent.calls).toBe(0)
    // the full list is still there for display
    expect(repo.getProcessSnapshot('snap1')!.processes).toHaveLength(5)
  })
})
