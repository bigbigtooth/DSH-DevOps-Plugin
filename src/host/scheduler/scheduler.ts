/**
 * Scheduler (S7): a recoverable Host service — the browser is only a viewer.
 * - one persistent schedule per server+kind; config frozen while a task runs
 * - single-flight: a running task plus at most ONE pending trigger; manual
 *   requests merge into the existing task instead of queueing duplicates
 * - restart restores future schedule points; missed periods are NEVER
 *   replayed (no catch-up storm)
 * - inter-server jitter + a global AI concurrency limit
 */
import type { ClockPort, TimerPort } from '../adapters/ports.ts'
import type { OpsRepository } from '../repository/ops-repository.ts'
import { defaultPolicy, POLICY_KINDS } from './policy-defaults.ts'

export type CheckKind = 'hardware' | 'process' | 'logs'

export interface SchedulerDeps {
  repo: OpsRepository
  clock: ClockPort
  timers: TimerPort
  jitterSeconds?: number
  aiConcurrency?: number
  defaultIntervals?: Partial<Record<CheckKind, number>>
  runners: {
    hardware: (serverId: string, trigger: 'manual' | 'scheduled') => Promise<string>
    process: (serverId: string, trigger: 'manual' | 'scheduled') => Promise<string>
    logs: (serverId: string, trigger: 'manual' | 'scheduled') => Promise<string>
  }
}

export interface RunningTask {
  serverId: string
  kind: CheckKind
  runId: string
  startedAt: number
  pendingTrigger: boolean
}

export class SchedulerService {
  private readonly deps: SchedulerDeps
  private readonly running = new Map<string, RunningTask>() // key serverId:kind
  private readonly aiSlots: boolean[] = []
  private tickTimerDispose: (() => void) | null = null
  private tickIntervalMs: number | null = null

  constructor(deps: SchedulerDeps) {
    this.deps = deps
    const n = deps.aiConcurrency ?? 2
    for (let i = 0; i < n; i++) this.aiSlots.push(false)
  }

  private key(serverId: string, kind: CheckKind): string {
    return `${serverId}:${kind}`
  }

  defaultInterval(kind: CheckKind): number {
    const defaults: Record<CheckKind, number> = { hardware: 60, process: 300, logs: 300 }
    return this.deps.defaultIntervals?.[kind] ?? defaults[kind]!
  }

  /** Start the periodic tick: recurring — each pass schedules the next one. */
  start(intervalMs = 5000): void {
    if (this.tickTimerDispose) return
    this.tickIntervalMs = intervalMs
    const loop = (): void => {
      void this.tick().finally(() => {
        // stop() nulled the dispose handle — do not reschedule after stop
        if (this.tickTimerDispose === null) return
        const t = this.deps.timers.setTimeout(loop, intervalMs)
        this.tickTimerDispose = () => {
          t()
          this.tickTimerDispose = null
          this.tickIntervalMs = null
        }
      })
    }
    const t = this.deps.timers.setTimeout(loop, intervalMs)
    this.tickTimerDispose = () => {
      t()
      this.tickTimerDispose = null
      this.tickIntervalMs = null
    }
  }

  stop(): void {
    this.tickTimerDispose?.()
    this.tickTimerDispose = null
  }

  get isRunning(): boolean {
    return this.tickTimerDispose !== null
  }

  /** One scheduling pass. Deterministic — tests drive it via ManualClock. */
  async tick(): Promise<Array<{ runId: string; serverId: string; kind: CheckKind }>> {
    const now = this.deps.clock.now()
    const started: Array<{ runId: string; serverId: string; kind: CheckKind }> = []
    await this.ensurePolicies(now)
    for (const policy of this.deps.repo.listPolicies()) {
      if (!policy.enabled) continue
      const k = this.key(policy.serverId, policy.kind)
      const task = this.running.get(k)
      if (task) {
        if (task.pendingTrigger) continue
        // coalesce: one pending trigger max, config stays frozen
        task.pendingTrigger = true
        continue
      }
      if (policy.nextRunAt === null || policy.nextRunAt > now) continue
      // launch; next schedule point = now + interval + jitter (missed periods skipped)
      const runId = await this.launch(policy.serverId, policy.kind, 'scheduled')
      if (runId) {
        started.push({ runId, serverId: policy.serverId, kind: policy.kind })
        const intervalMs = policy.intervalSeconds * 1000
        const jitterMs = Math.floor(Math.random() * (this.deps.jitterSeconds ?? 5) * 1000)
        const next = now + intervalMs + jitterMs
        await this.deps.repo.putPolicy({ ...policy, nextRunAt: next })
      }
    }
    return started
  }

  /**
   * Self-healing schedule bootstrap: every server gets a policy per kind even
   * if it was added through a path that never created one (or its policies
   * were wiped). First run is scheduled one interval out, never immediately.
   */
  private async ensurePolicies(now: number): Promise<void> {
    try {
      for (const server of this.deps.repo.listServers()) {
        for (const kind of POLICY_KINDS) {
          const id = `${server.id}:${kind}`
          if (this.deps.repo.getPolicy(id)) continue
          const interval = this.defaultInterval(kind)
          const policy = defaultPolicy(server.id, kind, now, interval)
          policy.nextRunAt = now + interval * 1000
          await this.deps.repo.putPolicy(policy)
        }
      }
    } catch {
      // a read-only repository must not crash the tick; next tick retries
    }
  }

  private async launch(serverId: string, kind: CheckKind, trigger: 'manual' | 'scheduled'): Promise<string | null> {
    const k = this.key(serverId, kind)
    const existing = this.running.get(k)
    if (existing) {
      if (trigger === 'manual') return existing.runId // merge into running task
      existing.pendingTrigger = true
      return existing.runId
    }
    const runId = await this.deps.runners[kind](serverId, trigger)
    this.running.set(k, { serverId, kind, runId, startedAt: this.deps.clock.now(), pendingTrigger: false })
    // release on completion
    void Promise.resolve()
      .then(() => this.waitRunCompletion(runId))
      .finally(() => {
        const task = this.running.get(k)
        if (task && task.runId === runId) {
          if (task.pendingTrigger) {
            // start the coalesced follow-up
            this.running.delete(k)
            void this.deps.runners[kind](serverId, 'scheduled').then((rid) => {
              this.running.set(k, { serverId, kind, runId: rid, startedAt: this.deps.clock.now(), pendingTrigger: false })
              return this.waitRunCompletion(rid)
            })
          } else {
            this.running.delete(k)
          }
        }
      })
    return runId
  }

  private async waitRunCompletion(runId: string): Promise<void> {
    // completion = run record reaches a final analysis state
    for (;;) {
      const run = this.deps.repo.getInspectionRun(runId)
      if (!run) return
      if (run.analysisState !== 'running' && run.analysisState !== 'pending') return
      await new Promise<void>((resolve) => {
        const t = this.deps.timers.setTimeout(resolve, 200)
        void t
      })
      // safety: bounded wait
      if (this.deps.clock.now() - (this.running.get(`${run.serverId}:${run.kind}`)?.startedAt ?? this.deps.clock.now()) > 3_600_000) return
    }
  }

  /** Manual trigger: returns the existing/merged task id, or a fresh run. */
  async triggerManual(serverId: string, kind: CheckKind): Promise<{ runId: string; merged: boolean }> {
    const k = this.key(serverId, kind)
    const existing = this.running.get(k)
    if (existing) return { runId: existing.runId, merged: true }
    const runId = await this.deps.runners[kind](serverId, 'manual')
    return { runId, merged: false }
  }

  /** Global AI concurrency gate. */
  async withAiSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (!this.aiSlots.some((s) => !s)) {
      await new Promise<void>((r) => setTimeout(r, 25))
    }
    const idx = this.aiSlots.findIndex((s) => !s)
    this.aiSlots[idx] = true
    try {
      return await fn()
    } finally {
      this.aiSlots[idx] = false
    }
  }

  snapshotRunning(): RunningTask[] {
    return [...this.running.values()]
  }
}
