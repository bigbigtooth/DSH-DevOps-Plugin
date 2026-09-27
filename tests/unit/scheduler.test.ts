import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryStorage } from '../../src/host/adapters/memory.ts'
import { ManualClock, systemTimers } from '../../src/host/adapters/ports.ts'
import { OpsRepository } from '../../src/host/repository/ops-repository.ts'
import { SchedulerService, type CheckKind } from '../../src/host/scheduler/scheduler.ts'
import { SCHEMA_VERSION } from '../../src/contracts/entities.ts'

async function makePolicy(repo: OpsRepository, serverId: string, kind: CheckKind, interval = 300, nextRunAt: number | null = null): Promise<void> {
  await repo.putPolicy({
    schemaVersion: SCHEMA_VERSION,
    id: `${serverId}:${kind}`,
    serverId,
    kind,
    enabled: true,
    intervalSeconds: interval,
    modelRef: null,
    focusProcessesVersion: 1,
    focusProcesses: [],
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
    scope: 'all',
    naturalLanguageVersion: 1,
    naturalLanguage: '',
    nextRunAt,
    updatedAt: 1,
  })
}

describe('scheduler (S7)', () => {
  let repo: OpsRepository
  let clock: ManualClock
  let runs: Array<{ serverId: string; kind: CheckKind; trigger: string }>

  beforeEach(async () => {
    const storage = new MemoryStorage()
    repo = new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock: { now: () => clock.now() }, controllerId: 'c' })
    clock = new ManualClock()
    runs = []
  })

  function makeScheduler(): SchedulerService {
    return new SchedulerService({
      repo,
      clock,
      timers: { setTimeout: (fn, ms) => clock.setTimeout(fn, ms) },
      jitterSeconds: 0,
      runners: {
        hardware: async (serverId, trigger) => {
          runs.push({ serverId, kind: 'hardware', trigger })
          const runId = `hw-${runs.length}`
          await repo.putInspectionRun({
            schemaVersion: SCHEMA_VERSION, runId, serverId, kind: 'hardware', snapshotId: null,
            startedAt: clock.now(), finishedAt: clock.now(), analysisState: 'complete',
            coverageAnalyzed: 1, coverageTotal: 1, findings: [], evidenceRefs: [], error: null, trigger,
          })
          return runId
        },
        process: async () => {
          throw new Error('not used')
        },
        logs: async () => {
          throw new Error('not used')
        },
      },
    })
  }

  it('fires when due and advances the schedule without replaying missed periods', async () => {
    const t0 = clock.now()
    await makePolicy(repo, 's1', 'hardware', 60, t0 + 1000)
    const sched = makeScheduler()
    clock.advance(999)
    expect(await sched.tick()).toHaveLength(0)
    clock.advance(1)
    const started = await sched.tick()
    expect(started).toHaveLength(1)
    const nextRunAt = repo.getPolicy('s1:hardware')!.nextRunAt!
    expect(nextRunAt).toBeGreaterThanOrEqual(t0 + 1000 + 60_000)
    // restart scenario: nextRunAt far in the past (host was down) — exactly ONE run, not a storm
    const stale = repo.getPolicy('s1:hardware')!
    await repo.putPolicy({ ...stale, nextRunAt: 1 }) // missed many periods
    runs.length = 0
    const caught = await sched.tick()
    expect(caught).toHaveLength(1) // no catch-up storm
    const after = repo.getPolicy('s1:hardware')!.nextRunAt!
    expect(after).toBeGreaterThan(clock.now()) // scheduled in the future again
  })

  it('single-flight: running task coalesces at most one pending trigger; manual merges', async () => {
    await makePolicy(repo, 's1', 'hardware', 60, 1000)
    // a runner that never finishes until released
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let seq = 0
    const sched = new SchedulerService({
      repo,
      clock,
      timers: systemTimers,
      jitterSeconds: 0,
      runners: {
        hardware: async (serverId, trigger) => {
          seq++
          const runId = `hw-${seq}-${trigger}`
          await repo.putInspectionRun({
            schemaVersion: SCHEMA_VERSION, runId, serverId, kind: 'hardware', snapshotId: null,
            startedAt: clock.now(), finishedAt: null, analysisState: 'running',
            coverageAnalyzed: 0, coverageTotal: 0, findings: [], evidenceRefs: [], error: null, trigger,
          })
          // completion happens asynchronously, like a real runner
          void (async () => {
            await gate
            await repo.putInspectionRun({
              schemaVersion: SCHEMA_VERSION, runId, serverId, kind: 'hardware', snapshotId: null,
              startedAt: clock.now(), finishedAt: clock.now(), analysisState: 'complete',
              coverageAnalyzed: 1, coverageTotal: 1, findings: [], evidenceRefs: [], error: null, trigger,
            })
          })()
          return runId
        },
        process: async () => 'x',
        logs: async () => 'y',
      },
    })
    const first = await sched.tick()
    expect(first).toHaveLength(1)
    const manual = await sched.triggerManual('s1', 'hardware')
    expect(manual.merged).toBe(true)
    expect(manual.runId).toBe(first[0]!.runId)
    release()
    // allow the chained coalesced follow-up to drain (poll-based completion)
    await new Promise((r) => setTimeout(r, 900))
    expect(sched.snapshotRunning()).toHaveLength(0)
  })

  it('AI concurrency gate caps parallel inspection calls', async () => {
    const sched = makeScheduler()
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 5 }, () =>
        sched.withAiSlot(async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 10))
          active--
        }),
      ),
    )
    expect(peak).toBe(2)
  })

  it('start() ticks repeatedly, auto-creates missing policies, and launches when due (IMPROVE)', async () => {
    // minimal server record; putServer validates id+revision
    await repo.putServer({ id: 's1', revision: 1 } as never)
    let hwRuns = 0
    const sched = new SchedulerService({
      repo,
      clock: { now: () => Date.now() }, // real clock: schedule points are wall-clock
      timers: systemTimers,
      jitterSeconds: 0,
      defaultIntervals: { hardware: 1, process: 300, logs: 300 },
      runners: {
        hardware: async (serverId, trigger) => {
          hwRuns++
          const runId = `hw-${hwRuns}`
          await repo.putInspectionRun({
            schemaVersion: SCHEMA_VERSION, runId, serverId, kind: 'hardware', snapshotId: null,
            startedAt: Date.now(), finishedAt: Date.now(), analysisState: 'complete',
            coverageAnalyzed: 1, coverageTotal: 1, findings: [], evidenceRefs: [], error: null, trigger,
          })
          return runId
        },
        process: async () => 'p',
        logs: async () => 'l',
      },
    })
    sched.start(200)
    await new Promise((r) => setTimeout(r, 2600))
    sched.stop()
    // policies were auto-created for the server (they did not exist before)
    expect(repo.getPolicy('s1:hardware')!.enabled).toBe(true)
    expect(repo.getPolicy('s1:process')!.enabled).toBe(true)
    expect(repo.getPolicy('s1:logs')!.enabled).toBe(true)
    expect(hwRuns).toBeGreaterThanOrEqual(1)
    // stop() really stops: the count stays flat
    const after = hwRuns
    await new Promise((r) => setTimeout(r, 700))
    expect(hwRuns).toBe(after)
  })
})
