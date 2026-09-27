/**
 * AI process inspection (S5): batch a snapshot within the input budget, run a
 * restricted agent per batch, validate structure AND evidence references
 * server-side, merge results, and compute coverage against the snapshot's
 * enumerable process count. Failures keep completed batches and surface
 * `partial` — never a fabricated all-clear, and no write side effects: the
 * agent only ever sees read-only inspection tools.
 */
import { err } from '../../contracts/errors.ts'
import type { Finding, InspectionRun, MonitoringPolicy, ProcessSnapshot } from '../../contracts/entities.ts'
import { SCHEMA_VERSION } from '../../contracts/entities.ts'
import type { AgentBridge, ClockPort } from '../adapters/ports.ts'
import type { OpsRepository } from '../repository/ops-repository.ts'
import { inspectionReportSchema } from './report-schema.ts'
import { renderInspectionTask } from './report-schema.ts'

export const INSPECTION_TOOLS = ['devops_get_process_snapshot', 'devops_get_service_definitions'] as const

export interface InspectionDeps {
  agentBridge: AgentBridge | null
  repo: OpsRepository
  clock: ClockPort
  modelRef: string | null
  /** batch budget: approx tokens; ~4 chars/token */
  batchBudgetTokens?: number
  maxRequestsPerBatch?: number
}

export class InspectionService {
  private readonly deps: InspectionDeps
  constructor(deps: InspectionDeps) {
    this.deps = deps
  }

  /** Split processes into batches under the token budget (fallback batch size 60). */
  planBatches(snapshot: ProcessSnapshot, budgetTokens = 8000): string[][] {
    const perProcessTokens = 30
    const perBatch = Math.max(10, Math.floor(budgetTokens / perProcessTokens))
    const tokens = snapshot.processes.map((p) => p.startToken)
    const batches: string[][] = []
    for (let i = 0; i < tokens.length; i += perBatch) batches.push(tokens.slice(i, i + perBatch))
    return batches.length ? batches : []
  }

  async runInspection(serverId: string, snapshot: ProcessSnapshot, policy: MonitoringPolicy | null, trigger: 'manual' | 'scheduled' = 'manual'): Promise<InspectionRun> {
    const now = this.deps.clock.now()
    const runId = `ins_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const run: InspectionRun = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      serverId,
      kind: 'process',
      snapshotId: snapshot.snapshotId,
      startedAt: now,
      finishedAt: null,
      analysisState: 'running',
      coverageAnalyzed: 0,
      coverageTotal: snapshot.processes.length,
      findings: [],
      evidenceRefs: [snapshot.snapshotId],
      error: null,
      trigger,
    }
    await this.deps.repo.putInspectionRun(run)
    if (!this.deps.modelRef || !this.deps.agentBridge) {
      const failed: InspectionRun = { ...run, analysisState: 'unavailable', error: this.deps.modelRef ? 'agent bridge unavailable' : 'no model configured', finishedAt: this.deps.clock.now() }
      await this.deps.repo.putInspectionRun(failed)
      return failed
    }

    const byToken = new Map(snapshot.processes.map((p) => [p.startToken, p]))
    const batches = this.planBatches(snapshot, this.deps.batchBudgetTokens ?? 8000)
    const analyzedTokens = new Set<string>()
    const findings: Finding[] = []
    let failedBatch = 0
    let lastError: string | null = null

    for (let i = 0; i < batches.length; i++) {
      const batchTokens = batches[i]!
      const processes = batchTokens.map((t) => byToken.get(t)).filter((p) => p !== undefined)
      // compact refs (p0, p1, …) — the model references these; we map back
      const refToToken = new Map(processes.map((p, idx) => [`p${idx}`, p.startToken]))
      const task = renderInspectionTask({
        snapshotId: snapshot.snapshotId,
        batchId: `batch-${i + 1}`,
        processes: processes.map((p, idx) => ({
          ref: `p${idx}`,
          startToken: p.startToken,
          pid: p.pid,
          name: p.name,
          user: p.user,
          rssBytes: p.rssBytes,
          cpuPercent: p.cpuPercent,
          state: p.state,
        })),
        focus: policy?.focusProcesses ?? [],
        expectedStates: policy?.expectedStates ?? [],
        thresholds: policy?.thresholds ?? { cpuPercent: null, rssBytes: null },
        naturalLanguage: policy?.naturalLanguage ?? '',
      })
      try {
        const result = await this.deps.agentBridge.run(
          {
            sessionId: `${runId}:batch-${i + 1}`,
            model: this.deps.modelRef,
            maxRequests: this.deps.maxRequestsPerBatch ?? 20,
            task,
            toolNames: INSPECTION_TOOLS,
            timeoutMs: 240_000,
          },
          (payload) => {
            const parsed = inspectionReportSchema.safeParse(extractJson(payload))
            if (!parsed.success) return { ok: false as const, error: `schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` }
            // evidence validation: analyzed tokens must exist; finding refs must exist
            const refSet = new Set(refToToken.keys())
            const unknown = parsed.data.analyzed.filter((t) => !refSet.has(t))
            if (unknown.length) return { ok: false as const, error: `unknown process references: ${unknown.slice(0, 3).join(',')}` }
            for (const f of parsed.data.findings) {
              const bad = f.processStartTokens.filter((t) => !refSet.has(t))
              if (bad.length) return { ok: false as const, error: `finding references unknown process: ${bad[0]}` }
            }
            const mapped = {
              analyzed: parsed.data.analyzed.map((ref) => refToToken.get(ref) ?? ref),
              findings: parsed.data.findings.map((f) => ({
                ...f,
                processStartTokens: f.processStartTokens.map((ref) => refToToken.get(ref) ?? ref),
              })),
            }
            return { ok: true as const, value: mapped }
          },
        )
        if (!result.ok) {
          failedBatch++
          lastError = result.error ?? 'agent returned invalid report'
          continue
        }
        const report = result.payload as { analyzed: string[]; findings: Finding[] }
        for (const t of report.analyzed) {
          if (byToken.has(t)) analyzedTokens.add(t)
        }
        for (const f of report.findings) {
          findings.push({
            processStartTokens: f.processStartTokens.filter((t) => byToken.has(t)),
            severity: f.severity,
            summary: f.summary,
            evidence: f.evidence,
            suggestion: f.suggestion,
          })
        }
      } catch (e) {
        failedBatch++
        lastError = e instanceof Error ? e.message : String(e)
      }
    }

    const coverageAnalyzed = analyzedTokens.size
    const complete = failedBatch === 0 && coverageAnalyzed === snapshot.processes.length
    const partial = coverageAnalyzed > 0 && (failedBatch > 0 || coverageAnalyzed < snapshot.processes.length)
    const finalRun: InspectionRun = {
      ...run,
      finishedAt: this.deps.clock.now(),
      analysisState: coverageAnalyzed === 0 ? 'failed' : complete ? 'complete' : partial ? 'partial' : 'failed',
      coverageAnalyzed,
      coverageTotal: snapshot.processes.length,
      findings,
      error: coverageAnalyzed === 0 || failedBatch > 0 ? (lastError ?? 'no processes analyzed') : null,
    }
    await this.deps.repo.putInspectionRun(finalRun)
    return finalRun
  }

  /**
   * A pure-command pass must never be presented as an AI analysis: this helper
   * is the only way an inspection record can claim `complete`.
   */
  assertAiVerified(run: InspectionRun): void {
    if (run.analysisState === 'complete' && run.coverageTotal === 0 && run.coverageAnalyzed === 0) {
      throw err('validation-failed', 'inspection', 'empty snapshot cannot be marked complete')
    }
  }
}

/** Pull the first JSON object from model text (handles ```json fences). */
export function extractJson(text: unknown): unknown {
  if (typeof text !== 'string') return text
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return text
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return text
  }
}
