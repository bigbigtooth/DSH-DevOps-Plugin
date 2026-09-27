/**
 * Deployment orchestration (S8 + S10).
 *
 * State machine from contracts/deployment-state; stage and status independent.
 * - idempotent creation by client requestId; server occupancy acquired first
 * - update pipeline: PRECHECK → PULL (ff-only, commit frozen) → DEPENDENCIES →
 *   BUILD → SERVICE_RESTART → HEALTH_CHECK → LOG_REFRESH
 * - verified scripts run fixed steps; candidates only supervised; everything
 *   else is an AI step — without a model the step FAILS, it never fakes success
 * - repair: max 2 rounds, same frozen commit + original health check; user
 *   stops and git-protection failures never trigger repair
 * - unknown outcomes → RECONCILE_REQUIRED (occupancy kept); reconcile queries
 *   facts before continuing; recovery after restart only observes, never re-runs
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { err } from '../../contracts/errors.ts'
import { nextStatus, canTransition, failOrReconcile, isTerminal } from '../../contracts/deployment-state.ts'
import type { DeploymentRun, DeploymentStatus, StepRecord, TargetSpec, Project } from '../../contracts/entities.ts'
import { SCHEMA_VERSION } from '../../contracts/entities.ts'
import type { SshTransport, AgentBridge, ClockPort } from '../adapters/ports.ts'
import type { OpsRepository } from '../repository/ops-repository.ts'
import type { RemoteExecutionService } from '../execution/execution-service.ts'
import {
  GIT_PRECHECK_SCRIPT,
  parseGitPrecheck,
  buildPullCommand,
  parsePullResult,
  renderHealthCheckScript,
  parseHealthOutput,
  serviceConfigHash,
} from './git-precheck.ts'
import { sha256 } from '../ssh/private-config.ts'
import { extractJson } from '../agents/inspection-service.ts'
import { classifyLine } from '../logs/log-tail.ts'
import type { ScriptService } from '../scripts/script-service.ts'
import type { LogService } from '../logs/log-service.ts'

export interface DeploymentDeps {
  repo: OpsRepository
  clock: ClockPort
  execution: RemoteExecutionService
  transport: SshTransport
  scriptService: ScriptService
  agentBridge: AgentBridge | null
  modelRef: string | null
  logService: LogService | null
  controllerId: string
  repairRounds?: number
  stepTimeoutMs?: number
  pollIntervalMs?: number
}

export class DeploymentService {
  private readonly deps: DeploymentDeps
  private readonly listeners = new Set<(run: DeploymentRun, event: { type: string; payload: Record<string, unknown> }) => void>()

  constructor(deps: DeploymentDeps) {
    this.deps = deps
  }

  /** Subscribe to run events (in-process; clients replay persisted events). */
  onEvent(fn: (run: DeploymentRun, event: { type: string; payload: Record<string, unknown> }) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ---------- creation ----------

  async createRun(requestId: string, project: Project, target: TargetSpec, kind: 'first-deploy' | 'update'): Promise<{ run: DeploymentRun; created: boolean }> {
    const now = this.deps.clock.now()
    const runId = `dep_${now.toString(36)}_${randomBytes(4).toString('hex')}`
    const run: DeploymentRun = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      requestId,
      projectId: project.id,
      targetId: target.id,
      kind,
      status: 'QUEUED',
      stage: '',
      targetSnapshot: {
        targetId: target.id,
        serverId: target.serverId,
        codeDir: target.codeDir,
        repoUrl: project.repoUrl,
        branch: project.branch,
        services: target.services,
        healthCheck: target.healthCheck,
        configRevision: project.revision,
      },
      targetCommit: null,
      previousCommit: null,
      attempts: 0,
      repairRounds: 0,
      stopRequested: false,
      healthCheckSnapshot: null,
      remoteExecutionIds: [],
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      failureReason: null,
    }
    const { run: saved, created } = await this.deps.repo.createDeploymentRun(run)
    if (!created) return { run: saved, created }
    // occupancy BEFORE any remote write. On conflict the just-saved run can
    // never execute (the caller aborts before dispatching) — close it out
    // immediately instead of leaving a zombie QUEUED run that locks the
    // project's deploy UI forever (occupancy is never auto-released).
    try {
      await this.deps.repo.acquireServer(target.serverId, runId, 'deployment')
    } catch (e) {
      const reason = `server occupancy held by another run: ${e instanceof Error ? e.message : String(e)}`
      await this.deps.repo.updateDeploymentRun(runId, (r) => ({ ...r, status: 'FAILED' as const, failureReason: reason, finishedAt: this.deps.clock.now() }))
      await this.deps.repo.appendEvent(runId, 'FAIL', { reason })
      throw e
    }
    return { run: saved, created: true }
  }

  // ---------- event plumbing ----------

  private async transition(run: DeploymentRun, event: Parameters<typeof canTransition>[1], payload: Record<string, unknown> = {}): Promise<DeploymentRun> {
    const status = nextStatus(run.status, event)
    const updated: DeploymentRun = { ...run, status, updatedAt: this.deps.clock.now() }
    if (isTerminal(status)) updated.finishedAt = this.deps.clock.now()
    await this.deps.repo.updateDeploymentRun(run.runId, () => updated)
    await this.deps.repo.appendEvent(run.runId, event, { ...payload, from: run.status, to: status })
    for (const fn of this.listeners) fn(updated, { type: event, payload })
    if (isTerminal(status)) await this.deps.repo.releaseServer(run.targetSnapshot.serverId, run.runId)
    return updated
  }

  // ---------- update pipeline (S10) ----------

  async runUpdate(runId: string): Promise<DeploymentRun> {
    let run = this.requireRun(runId)
    run = await this.transition(run, 'START')
    const target = run.targetSnapshot

    // PRECHECK
    run = await this.setStage(run, 'PRECHECK')
    const precheckPayload = [
      '#!/bin/sh',
      'set -u',
      `DIR=${shq(target.codeDir)}`,
      ...GIT_PRECHECK_SCRIPT.split('\n').slice(2),
      'exit 0',
      '',
    ].join('\n')
    const precheckResult = await this.deps.execution.executeUnit({
      serverId: target.serverId,
      runId: run.runId,
      stepId: `${run.runId}:PRECHECK`,
      attemptId: 'a1',
      stage: 'PRECHECK',
      intent: `run: git precheck in ${target.codeDir}`,
      payload: precheckPayload,
      timeoutMs: this.deps.stepTimeoutMs ?? 600_000,
      pollIntervalMs: this.deps.pollIntervalMs,
    })
    await this.pushExecution(run.runId, `${run.runId}:PRECHECK:a1`)
    run = this.requireRun(runId)
    if (precheckResult.exit.kind === 'unknown') return this.enterReconcile(run, 'PRECHECK')
    const precheck = parseGitPrecheck(precheckResult.outputTail)
    if (!precheck.ok || !precheck.isRepo) {
      return this.fail(run, `git precheck failed: ${precheck.failure ?? 'not a repository'}`)
    }
    if (precheck.dirty) {
      return this.fail(run, `working directory has uncommitted changes: ${precheck.dirtyFiles.slice(0, 3).join(', ')}`)
    }
    if (precheck.localOnlyCommits.length > 0) {
      return this.fail(run, 'branch has local-only commits; refusing to overwrite')
    }
    if (precheck.currentBranch !== target.branch) {
      return this.fail(run, `branch mismatch: on ${precheck.currentBranch}, expected ${target.branch}`)
    }
    if (precheck.remoteUrl && !urlsMatch(precheck.remoteUrl, target.repoUrl)) {
      return this.fail(run, `remote URL mismatch: ${precheck.remoteUrl} vs configured ${target.repoUrl}`)
    }
    run = await this.updateRun(run, { previousCommit: precheck.headCommit })

    // PULL (ff-only) — commit frozen on success
    run = await this.setStage(run, 'PULL')
    const pullResult = await this.deps.execution.executeUnit({
      serverId: target.serverId,
      runId: run.runId,
      stepId: `${run.runId}:PULL`,
      attemptId: 'a1',
      stage: 'PULL',
      intent: `run: ${buildPullCommand(target.branch)} (ff-only)`,
      payload: pullPayload(target.codeDir, target.branch),
      timeoutMs: this.deps.stepTimeoutMs ?? 600_000,
      pollIntervalMs: this.deps.pollIntervalMs,
    })
    await this.pushExecution(run.runId, `${run.runId}:PULL:a1`)
    run = this.requireRun(runId)
    if (pullResult.exit.kind === 'unknown') return this.enterReconcile(run, 'PULL')
    const pull = parsePullResult(pullResult.outputTail)
    if (!pull.ok || !pull.headCommit) {
      const reason = pull.failure ?? 'pull failed'
      if (/fast-forward|diverg/i.test(reason)) return this.fail(run, `git protection: ${reason}`)
      return this.decideRepairOrFail(run, 'PULL', reason)
    }
    run = await this.updateRun(run, { targetCommit: pull.headCommit })
    await this.deps.repo.appendEvent(run.runId, 'COMMIT_FROZEN', { commit: pull.headCommit, previous: run.previousCommit })

    // DEPENDENCIES / BUILD / SERVICE_RESTART — script-or-AI stages;
    // a successful repair re-runs the SAME stage (bounded by repair rounds)
    const stageFlow: Array<{ stage: string; fallbackCommand: () => string | null }> = [
      { stage: 'DEPENDENCIES', fallbackCommand: () => null },
      { stage: 'BUILD', fallbackCommand: () => null },
      { stage: 'SERVICE_RESTART', fallbackCommand: () => buildRestartCommand(target.services) },
    ]
    for (const flow of stageFlow) {
      run = this.requireRun(runId)
      if (run.stopRequested) return this.stopFlow(run)
      let retries = 0
      for (;;) {
        const roundsBefore = this.requireRun(runId).repairRounds
        const stageResult = await this.runStage(run, flow.stage, flow.fallbackCommand())
        run = stageResult.run
        if (run.status !== 'RUNNING') return run
        const roundsAfter = this.requireRun(runId).repairRounds
        if (roundsAfter > roundsBefore) {
          if (++retries > (this.deps.repairRounds ?? 2)) return this.fail(this.requireRun(runId), `repair loop at stage ${flow.stage}`)
          continue // re-run the failed stage after the repair
        }
        break
      }
    }

    // HEALTH_CHECK (original spec, never relaxed)
    run = await this.setStage(run, 'HEALTH_CHECK')
    const health = run.targetSnapshot.healthCheck
    if (!health) {
      return this.fail(run, 'no health check configured; refusing to mark success')
    }
    const healthPayload = renderHealthCheckScript({
      processPattern: health.processNamePattern,
      ports: health.ports,
      httpUrls: health.httpUrls,
      startWaitSeconds: health.startWaitSeconds,
      observeSeconds: health.observeSeconds,
    })
    let healthTries = 0
    for (;;) {
      const roundsBefore = this.requireRun(runId).repairRounds
      const healthAttempt = `a${this.deps.repo.listStepRecords(runId).filter((s) => s.stage === 'HEALTH_CHECK').length + 1}`
      const healthResult = await this.deps.execution.executeUnit({
        serverId: target.serverId,
        runId: run.runId,
        stepId: `${run.runId}:HEALTH_CHECK`,
        attemptId: healthAttempt,
        stage: 'HEALTH_CHECK',
        intent: 'run: health check (process + ports) in target context',
        payload: healthPayload,
        timeoutMs: (health.startWaitSeconds + health.observeSeconds + 30) * 1000,
        pollIntervalMs: this.deps.pollIntervalMs,
      })
      await this.pushExecution(run.runId, `${run.runId}:HEALTH_CHECK:${healthAttempt}`)
      run = this.requireRun(runId)
      if (healthResult.exit.kind === 'unknown') return this.enterReconcile(run, 'HEALTH_CHECK')
      const healthOut = parseHealthOutput(healthResult.outputTail)
      await this.deps.repo.updateDeploymentRun(run.runId, (r) => ({ ...r, healthCheckSnapshot: { facts: healthOut.facts, checkedAt: this.deps.clock.now() } }))
      if (healthResult.step?.status === 'SUCCEEDED' && healthOut.ok) break
      const roundsAfter = this.requireRun(runId).repairRounds
      const repaired = await this.decideRepairOrFail(run, 'HEALTH_CHECK', healthOut.facts.join('; ') || 'health check failed')
      if (repaired.status !== 'RUNNING') return repaired
      if (this.requireRun(runId).repairRounds <= roundsBefore) {
        // no repair was possible — decideRepairOrFail already failed the run
        return this.requireRun(runId)
      }
      if (++healthTries > (this.deps.repairRounds ?? 2)) return this.fail(this.requireRun(runId), 'health check repair loop')
      // re-run the ORIGINAL health check after the repair
    }

    // LOG_REFRESH — independent of deployment success semantics
    run = await this.setStage(run, 'LOG_REFRESH')
    run = await this.updateRun(run, { stage: 'LOG_REFRESH' })
    if (this.deps.logService) {
      try {
        await this.refreshLogSources(run)
      } catch {
        // log monitoring state is recorded independently; never masks deploy success
      }
    }

    run = this.requireRun(runId)
    run = await this.transition(run, 'SUCCEED')
    await this.deps.repo.appendEvent(run.runId, 'DEPLOY_SUCCEEDED', { commit: run.targetCommit })
    return run
  }

  /**
   * Lightweight redeploy (the “一键部署” button): SSH to the target, check
   * whether the tracked branch is behind origin, and ONLY when it is update
   * (ff-only pull) → restart the declared services → verify health AND the
   * project's own log files confirm a clean restart. When the code is already
   * up to date nothing is restarted (an ALREADY_LATEST success).
   *
   * On failure the AI repair loop engages BEFORE the run is declared failed:
   * up to `repairRounds` model-proposed commands (boundary-validated, never
   * worktree-destructive) are executed and the whole pipeline re-runs — safe
   * because every step is idempotent (read-only precheck, ff-only pull).
   * The run FAILS only when AI repair is unavailable (no model), exhausted,
   * or itself unsuccessful — never fakes a success.
   */
  async runRedeploy(runId: string): Promise<DeploymentRun> {
    let run = this.requireRun(runId)
    run = await this.transition(run, 'START')
    for (;;) {
      const outcome = await this.runRedeployAttempt(runId)
      if (outcome.done) return outcome.run

      const cur = this.requireRun(runId)
      if (cur.status !== 'RUNNING') return cur // stopped / reconciled mid-attempt
      if (cur.stopRequested) return this.stopFlow(cur)
      const maxRounds = this.deps.repairRounds ?? 2
      const aiReady = this.deps.agentBridge !== null && this.deps.modelRef !== null
      if (!aiReady || cur.repairRounds >= maxRounds) {
        const why = !aiReady ? '未配置 AI 模型，无法自动修复' : 'AI 自动修复次数已用尽'
        return this.fail(cur, `${outcome.reason}（${why}）`)
      }
      run = await this.transition(cur, 'ENTER_REPAIR', { stage: outcome.stage, reason: outcome.reason })
      await this.deps.repo.updateDeploymentRun(runId, (r) => ({ ...r, repairRounds: r.repairRounds + 1 }))
      const repairCommand = await this.aiRedeployRepairCommand(run, outcome.stage, outcome.reason)
      if (repairCommand === null) {
        return this.fail(this.requireRun(runId), `${outcome.reason}（AI 未能给出有效的修复命令）`)
      }
      const repairResult = await this.deps.execution.executeUnit({
        serverId: run.targetSnapshot.serverId,
        runId: run.runId,
        stepId: `${run.runId}:REPAIR_${run.repairRounds}`,
        attemptId: 'a1',
        stage: 'REPAIR',
        intent: `repair: ${repairCommand}`,
        payload: renderRepairPayload(run.targetSnapshot.codeDir, repairCommand),
        timeoutMs: this.deps.stepTimeoutMs ?? 600_000,
        pollIntervalMs: this.deps.pollIntervalMs,
      })
      await this.pushExecution(run.runId, `${run.runId}:REPAIR_${run.repairRounds}:a1`)
      const afterRepair = this.requireRun(runId)
      if (repairResult.exit.kind === 'unknown') return this.enterReconcile(afterRepair, 'REPAIR')
      if (repairResult.exit.exitCode !== 0) {
        return this.fail(afterRepair, `${outcome.reason}（AI 修复命令执行失败：${repairResult.outputTail.slice(-160)}）`)
      }
      await this.transition(afterRepair, 'RESUME_FROM_REPAIR')
      await this.deps.repo.appendEvent(runId, 'REPAIR_DONE', { round: run.repairRounds })
      // RUNNING again → the pipeline re-runs from PRECHECK
    }
  }

  /** One linear pass of the redeploy pipeline; failures are RETURNED, the
   *  caller decides between AI repair and an honest FAIL. */
  private async runRedeployAttempt(runId: string): Promise<{ done: true; run: DeploymentRun } | { done: false; stage: string; reason: string }> {
    let run = this.requireRun(runId)
    const target = run.targetSnapshot
    // each pipeline PASS needs fresh attempt ids: execution is idempotent by
    // step identity, so a re-run after AI repair with the same id would replay
    // the previous (stale) facts instead of re-collecting them
    const attemptOf = (stage: string): string => `a${this.deps.repo.listStepRecords(runId).filter((s) => s.stage === stage).length + 1}`

    // PRECHECK — read-only git facts including the behind count
    run = await this.setStage(run, 'PRECHECK')
    const precheckPayload = [
      '#!/bin/sh',
      'set -u',
      `DIR=${shq(target.codeDir)}`,
      ...GIT_PRECHECK_SCRIPT.split('\n').slice(2),
      'exit 0',
      '',
    ].join('\n')
    const precheckResult = await this.deps.execution.executeUnit({
      serverId: target.serverId,
      runId: run.runId,
      stepId: `${run.runId}:REDEPLOY_PRECHECK`,
      attemptId: attemptOf('PRECHECK'),
      stage: 'PRECHECK',
      intent: `run: git precheck (behind check) in ${target.codeDir}`,
      payload: precheckPayload,
      timeoutMs: this.deps.stepTimeoutMs ?? 600_000,
      pollIntervalMs: this.deps.pollIntervalMs,
    })
    await this.pushExecution(run.runId, `${run.runId}:REDEPLOY_PRECHECK:a1`)
    run = this.requireRun(runId)
    if (precheckResult.exit.kind === 'unknown') return { done: true, run: await this.enterReconcile(run, 'PRECHECK') }
    const precheck = parseGitPrecheck(precheckResult.outputTail)
    if (!precheck.ok || !precheck.isRepo) {
      return { done: false, stage: 'PRECHECK', reason: `git precheck failed: ${precheck.failure ?? 'not a repository'}` }
    }
    if (precheck.dirty) {
      return { done: false, stage: 'PRECHECK', reason: `working directory has uncommitted changes: ${precheck.dirtyFiles.slice(0, 3).join(', ')}` }
    }
    if (precheck.localOnlyCommits.length > 0) {
      return { done: false, stage: 'PRECHECK', reason: 'branch has local-only commits; refusing to overwrite' }
    }
    if (precheck.currentBranch !== target.branch) {
      return { done: false, stage: 'PRECHECK', reason: `branch mismatch: on ${precheck.currentBranch}, expected ${target.branch}` }
    }
    if (precheck.remoteUrl && !urlsMatch(precheck.remoteUrl, target.repoUrl)) {
      return { done: false, stage: 'PRECHECK', reason: `remote URL mismatch: ${precheck.remoteUrl} vs configured ${target.repoUrl}` }
    }
    run = await this.updateRun(run, { previousCommit: precheck.headCommit })

    // Already latest → nothing to update, do NOT restart (per product decision)
    if (precheck.behind === 0) {
      await this.deps.repo.appendEvent(run.runId, 'ALREADY_LATEST', { commit: precheck.headCommit })
      run = await this.setStage(run, 'ALREADY_LATEST')
      run = this.requireRun(runId)
      return { done: true, run: await this.transition(run, 'SUCCEED') }
    }

    // PULL (ff-only) — freeze the new commit
    run = await this.setStage(run, 'PULL')
    const pullResult = await this.deps.execution.executeUnit({
      serverId: target.serverId,
      runId: run.runId,
      stepId: `${run.runId}:PULL`,
      attemptId: attemptOf('PULL'),
      stage: 'PULL',
      intent: `run: ${buildPullCommand(target.branch)} (ff-only)`,
      payload: pullPayload(target.codeDir, target.branch),
      timeoutMs: this.deps.stepTimeoutMs ?? 600_000,
      pollIntervalMs: this.deps.pollIntervalMs,
    })
    await this.pushExecution(run.runId, `${run.runId}:PULL:a1`)
    run = this.requireRun(runId)
    if (pullResult.exit.kind === 'unknown') return { done: true, run: await this.enterReconcile(run, 'PULL') }
    const pull = parsePullResult(pullResult.outputTail)
    if (!pull.ok || !pull.headCommit) {
      return { done: false, stage: 'PULL', reason: `pull failed: ${pull.failure ?? 'unknown'}` }
    }
    run = await this.updateRun(run, { targetCommit: pull.headCommit })
    await this.deps.repo.appendEvent(run.runId, 'COMMIT_FROZEN', { commit: pull.headCommit, previous: run.previousCommit })

    // capture each active log source's size BEFORE the restart, so the
    // post-restart verification window reads only newly written lines
    const baseline = await this.snapshotLogSizes(run)

    // SERVICE_RESTART — known manager only (no blind AI in this path)
    run = await this.setStage(run, 'SERVICE_RESTART')
    const restartCommand = buildRestartCommand(target.services)
    if (!restartCommand) {
      return { done: false, stage: 'SERVICE_RESTART', reason: '未配置可重启的服务管理器（需 supervisor / systemd / launchd 服务定义）' }
    }
    const restartResult = await this.deps.execution.executeUnit({
      serverId: target.serverId,
      runId: run.runId,
      stepId: `${run.runId}:SERVICE_RESTART`,
      attemptId: attemptOf('SERVICE_RESTART'),
      stage: 'SERVICE_RESTART',
      intent: `run: ${restartCommand}`,
      payload: renderPayloadForCommand(restartCommand),
      timeoutMs: this.deps.stepTimeoutMs ?? 600_000,
      pollIntervalMs: this.deps.pollIntervalMs,
    })
    await this.pushExecution(run.runId, `${run.runId}:SERVICE_RESTART:a1`)
    run = this.requireRun(runId)
    if (restartResult.exit.kind === 'unknown') return { done: true, run: await this.enterReconcile(run, 'SERVICE_RESTART') }
    if (restartResult.exit.exitCode !== 0) {
      return { done: false, stage: 'SERVICE_RESTART', reason: `restart failed (exit ${restartResult.exit.exitCode}): ${restartResult.outputTail.slice(-200)}` }
    }

    // HEALTH_CHECK — the target's spec, or a process-liveness fallback
    run = await this.setStage(run, 'HEALTH_CHECK')
    const health = target.healthCheck
    const processPattern = health?.processNamePattern || target.services[0]?.managerId || target.services[0]?.name || ''
    if (!processPattern) {
      return { done: false, stage: 'HEALTH_CHECK', reason: '未配置健康检查且无服务名可用于进程存活校验，无法确认重启成功' }
    }
    const startWait = health?.startWaitSeconds ?? 60
    const observe = health?.observeSeconds ?? 10
    const healthPayload = renderHealthCheckScript({
      processPattern,
      ports: health?.ports ?? [],
      httpUrls: health?.httpUrls ?? [],
      startWaitSeconds: startWait,
      observeSeconds: observe,
    })
    const healthResult = await this.deps.execution.executeUnit({
      serverId: target.serverId,
      runId: run.runId,
      stepId: `${run.runId}:HEALTH_CHECK`,
      attemptId: attemptOf('HEALTH_CHECK'),
      stage: 'HEALTH_CHECK',
      intent: 'run: health check (process + ports) after restart',
      payload: healthPayload,
      timeoutMs: (startWait + observe + 30) * 1000,
      pollIntervalMs: this.deps.pollIntervalMs,
    })
    await this.pushExecution(run.runId, `${run.runId}:HEALTH_CHECK:a1`)
    run = this.requireRun(runId)
    if (healthResult.exit.kind === 'unknown') return { done: true, run: await this.enterReconcile(run, 'HEALTH_CHECK') }
    const healthOut = parseHealthOutput(healthResult.outputTail)
    await this.deps.repo.updateDeploymentRun(run.runId, (r) => ({ ...r, healthCheckSnapshot: { facts: healthOut.facts, checkedAt: this.deps.clock.now() } }))
    if (healthResult.exit.exitCode !== 0 || !healthOut.ok) {
      return { done: false, stage: 'HEALTH_CHECK', reason: `health check failed after restart: ${healthOut.facts.join('; ') || 'process/ports not healthy'}` }
    }

    // LOG_VERIFY — the project's own logs must show no new error lines
    run = await this.setStage(run, 'LOG_VERIFY')
    const verdict = await this.verifyLogsAfterRestart(run, baseline)
    await this.deps.repo.appendEvent(run.runId, 'LOG_VERIFY', { errorCount: verdict.errorCount, offenders: verdict.offenders })
    if (!verdict.ok) {
      return { done: false, stage: 'LOG_VERIFY', reason: `重启后日志出现 ${verdict.errorCount} 行错误，疑似重启未成功：${verdict.offenders.join('; ')}` }
    }

    // LOG_REFRESH — best-effort discovery/state refresh; never masks success
    if (this.deps.logService) {
      try {
        await this.refreshLogSources(run)
      } catch {
        /* independent */
      }
    }

    run = this.requireRun(runId)
    run = await this.transition(run, 'SUCCEED')
    await this.deps.repo.appendEvent(run.runId, 'REDEPLOY_SUCCEEDED', { commit: run.targetCommit, previous: run.previousCommit })
    return { done: true, run }
  }

  /**
   * AI-proposed repair command for a failed redeploy stage. Boundaries are
   * enforced by validateCommandBoundaries (git escapes, worktree-destructive
   * actions, unrelated services); the pipeline itself stays responsible for
   * pulling code — a repair command never fetches.
   */
  private async aiRedeployRepairCommand(run: DeploymentRun, stage: string, reason: string): Promise<string | null> {
    if (!this.deps.agentBridge || !this.deps.modelRef) return null
    try {
      const result = await this.deps.agentBridge.run(
        {
          sessionId: `${run.runId}:REDEPLOY_REPAIR:${run.repairRounds}`,
          model: this.deps.modelRef,
          maxRequests: 20,
          timeoutMs: 240_000,
          toolNames: [],
          task: [
            `一键部署阶段 ${stage} 失败：${reason}。`,
            `代码目录 ${run.targetSnapshot.codeDir}，分支 ${run.targetSnapshot.branch}，服务 ${JSON.stringify(run.targetSnapshot.services.map((s) => s.name))}。`,
            '只输出 JSON：{"command": "<在目标服务器上执行的 POSIX sh 修复命令>"}。',
            '边界：不改写 git 跟踪源码；不 push；不 reset；不 fetch/pull（管线自身负责拉取）；不做不可逆数据操作；不重启无关服务。',
          ].join('\n'),
        },
        (payload) => {
          const parsed = zCommand.safeParse(extractJson(payload))
          if (!parsed.success) return { ok: false as const, error: 'invalid repair command' }
          const forbidden = validateCommandBoundaries(parsed.data.command, run.targetSnapshot.services.map((s) => s.name))
          if (forbidden) return { ok: false as const, error: forbidden }
          return { ok: true as const, value: parsed.data }
        },
      )
      if (!result.ok) return null
      return (result.payload as { command: string }).command
    } catch {
      return null
    }
  }

  /** Current size (bytes) of each active log source, keyed by sourceId. */
  private async snapshotLogSizes(run: DeploymentRun): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    const serverId = run.targetSnapshot.serverId
    for (const source of this.deps.repo.listLogSources({ projectId: run.projectId, serverId })) {
      if (source.status !== 'active') continue
      const st = await this.deps.transport.stat(serverId, source.path).catch(() => null)
      if (st) map.set(source.sourceId, st.size)
    }
    return map
  }

  /**
   * Read only the bytes appended since `baseline` for each active source and
   * count error-level lines. Rotation/truncation (size shrank) widens the
   * window to the whole current file. Bounded to 256 KiB per source.
   */
  private async verifyLogsAfterRestart(run: DeploymentRun, baseline: Map<string, number>): Promise<{ ok: boolean; errorCount: number; offenders: string[] }> {
    const serverId = run.targetSnapshot.serverId
    let errorCount = 0
    const offenders: string[] = []
    for (const source of this.deps.repo.listLogSources({ projectId: run.projectId, serverId })) {
      if (source.status !== 'active') continue
      const st = await this.deps.transport.stat(serverId, source.path).catch(() => null)
      if (!st) continue
      let offset = baseline.get(source.sourceId) ?? 0
      if (st.size < offset) offset = 0
      if (st.size === offset) continue
      const read = await this.deps.transport
        .readFileRange(serverId, source.path, offset, Math.min(256 * 1024, st.size - offset))
        .catch(() => null)
      if (!read) continue
      for (const line of read.data.split('\n')) {
        if (!line.trim()) continue
        if (classifyLine(line) === 'error') {
          errorCount++
          if (offenders.length < 5) offenders.push(`${source.path}: ${line.trim().slice(0, 120)}`)
        }
      }
    }
    return { ok: errorCount === 0, errorCount, offenders }
  }

  /** One script-or-AI stage. Retries run under a NEW attempt id. */
  private async runStage(run: DeploymentRun, stage: string, fallbackCommand: string | null): Promise<{ run: DeploymentRun }> {
    const target = run.targetSnapshot
    const attempt = this.deps.repo.listStepRecords(run.runId).filter((s) => s.stage === stage).length + 1
    const stepId = `${run.runId}:${stage}`
    const attemptId = `a${attempt}`
    run = await this.setStage(run, stage)
    const script = pickVerifiedScript(this.deps.repo, run.projectId, target.targetId, stage, {
      branch: target.branch,
      interpreter: 'sh',
      serviceConfigHash: serviceConfigHash(target.services),
    })
    let payload: string
    let intent: string
    let scriptVersionId: string | null = null
    if (script) {
      payload = renderPayloadForCommand(script.content.replace(/^#!\/bin\/sh\n?/, '').replace(/^set -eu\n?/, ''))
      intent = `script(${script.scriptVersionId})`
      scriptVersionId = script.scriptVersionId
    } else {
      const aiCommand = await this.aiStepCommand(run, stage)
      if (aiCommand === null) {
        if (fallbackCommand) {
          payload = renderPayloadForCommand(fallbackCommand)
          intent = `run: ${fallbackCommand}`
        } else {
          const failed = await this.fail(run, `no executor for stage ${stage}: no verified script and no model`)
          return { run: failed }
        }
      } else {
        payload = renderPayloadForCommand(aiCommand)
        intent = `ai: ${aiCommand}`
      }
    }
    const result = await this.deps.execution.executeUnit({
      serverId: target.serverId,
      runId: run.runId,
      stepId,
      attemptId,
      stage,
      intent,
      payload,
      timeoutMs: this.deps.stepTimeoutMs ?? 600_000,
      pollIntervalMs: this.deps.pollIntervalMs,
    })
    await this.pushExecution(run.runId, `${stepId}:${attemptId}`)
    let current = this.requireRun(run.runId)
    if (result.exit.kind === 'unknown') return { run: await this.enterReconcile(current, stage) }
    if (result.exit.exitCode !== 0) {
      const reason = `${stage} failed (exit ${result.exit.exitCode}): ${result.outputTail.slice(-200)}`
      return { run: await this.decideRepairOrFail(current, stage, reason) }
    }
    return { run: current }
  }

  /** AI proposes a bounded command for a stage. */
  private async aiStepCommand(run: DeploymentRun, stage: string): Promise<string | null> {
    if (!this.deps.agentBridge || !this.deps.modelRef) return null
    try {
      const result = await this.deps.agentBridge.run(
        {
          sessionId: `${run.runId}:${stage}`,
          model: this.deps.modelRef,
          maxRequests: 20,
          timeoutMs: 240_000,
          toolNames: [],
          task: [
            `项目 ${run.projectId} 目标 ${run.targetSnapshot.targetId} 部署阶段 ${stage}。`,
            `代码目录 ${run.targetSnapshot.codeDir}，提交 ${run.targetCommit ?? 'unknown'}。`,
            '只输出 JSON：{"command": "<在目标服务器 codeDir 内执行的 POSIX sh 命令>"}。',
            '边界：不改写 git 跟踪源码；不 push；不 reset --hard；不触碰无关服务；不做不可逆数据操作。',
          ].join('\n'),
        },
        (payload) => {
          const parsed = zCommand.safeParse(extractJson(payload))
          if (!parsed.success) return { ok: false as const, error: 'invalid command plan' }
          const forbidden = validateCommandBoundaries(parsed.data.command, run.targetSnapshot.services.map((s) => s.name))
          if (forbidden) return { ok: false as const, error: forbidden }
          return { ok: true as const, value: parsed.data }
        },
      )
      if (!result.ok) return null
      return (result.payload as { command: string }).command
    } catch {
      return null
    }
  }

  // ---------- first deploy (S8) ----------

  async runFirstDeploy(runId: string): Promise<DeploymentRun> {
    let run = this.requireRun(runId)
    if (!this.deps.agentBridge || !this.deps.modelRef) {
      await this.deps.repo.appendEvent(run.runId, 'PLAN_REJECTED', { reason: 'no model configured' })
      return this.fail(await this.transition(run, 'START'), 'first AI deploy requires a configured model')
    }
    run = await this.transition(run, 'START')
    run = await this.setStage(run, 'PLAN')
    const plan = await this.aiFirstDeployPlan(run)
    if (plan === null) {
      return this.fail(run, 'AI failed to produce a valid deployment plan')
    }
    // health check must be recorded BEFORE service changes
    await this.deps.repo.updateDeploymentRun(run.runId, (r) => ({ ...r, healthCheckSnapshot: plan.healthCheck }))
    run = this.requireRun(runId)
    await this.deps.repo.appendEvent(run.runId, 'PLAN_ACCEPTED', { steps: plan.steps.length })

    let index = 0
    for (const step of plan.steps) {
      run = this.requireRun(runId)
      if (run.stopRequested) return this.stopFlow(run)
      const stage = step.stage || `STEP_${index + 1}`
      run = await this.setStage(run, stage)
      const stepId = `${run.runId}:${stage}`
      const result = await this.deps.execution.executeUnit({
        serverId: run.targetSnapshot.serverId,
        runId: run.runId,
        stepId,
        attemptId: 'a1',
        stage,
        intent: step.oneShot ? `one-shot: ${step.command}` : `ai: ${step.command}`,
        payload: renderPayloadForCommand(step.command),
        timeoutMs: this.deps.stepTimeoutMs ?? 600_000,
        pollIntervalMs: this.deps.pollIntervalMs,
      })
      await this.pushExecution(run.runId, `${stepId}:a1`)
      run = this.requireRun(runId)
      if (result.exit.kind === 'unknown') return this.enterReconcile(run, stage)
      if (result.exit.exitCode !== 0) {
        const reason = `${stage} failed: ${result.outputTail.slice(-200)}`
        if (step.oneShot) return this.fail(run, reason) // one-shot failures are not auto-repaired
        return this.decideRepairOrFail(run, stage, reason)
      }
      index++
    }
    // final health check re-run (same original standard)
    const hc = run.targetSnapshot.healthCheck
      ? renderHealthCheckScript({
          processPattern: run.targetSnapshot.healthCheck.processNamePattern,
          ports: run.targetSnapshot.healthCheck.ports,
          httpUrls: run.targetSnapshot.healthCheck.httpUrls,
          startWaitSeconds: run.targetSnapshot.healthCheck.startWaitSeconds,
          observeSeconds: run.targetSnapshot.healthCheck.observeSeconds,
        })
      : null
    if (hc) {
      run = await this.setStage(run, 'HEALTH_CHECK')
      const healthResult = await this.deps.execution.executeUnit({
        serverId: run.targetSnapshot.serverId,
        runId: run.runId,
        stepId: `${run.runId}:HEALTH_CHECK`,
        attemptId: 'a1',
        stage: 'HEALTH_CHECK',
        intent: 'run: final health check',
        payload: hc,
        timeoutMs: (run.targetSnapshot.healthCheck!.startWaitSeconds + run.targetSnapshot.healthCheck!.observeSeconds + 30) * 1000,
        pollIntervalMs: this.deps.pollIntervalMs,
      })
      await this.pushExecution(run.runId, `${run.runId}:HEALTH_CHECK:a1`)
      run = this.requireRun(runId)
      if (healthResult.exit.kind === 'unknown') return this.enterReconcile(run, 'HEALTH_CHECK')
      const healthOut = parseHealthOutput(healthResult.outputTail)
      if (!healthOut.ok) return this.decideRepairOrFail(run, 'HEALTH_CHECK', healthOut.facts.join('; ') || 'health check failed')
    }
    if (this.deps.logService) {
      try {
        await this.refreshLogSources(run)
      } catch {
        /* independent */
      }
    }
    run = this.requireRun(runId)
    return this.transition(run, 'SUCCEED')
  }

  private async aiFirstDeployPlan(run: DeploymentRun): Promise<{ steps: Array<{ stage: string; command: string; oneShot: boolean }>; healthCheck: Record<string, unknown> } | null> {
    try {
      const result = await this.deps.agentBridge!.run(
        {
          sessionId: `${run.runId}:PLAN`,
          model: this.deps.modelRef!,
          maxRequests: 20,
          timeoutMs: 240_000,
          toolNames: [],
          task: [
            `为项目 ${run.projectId}（仓库 ${run.targetSnapshot.repoUrl} 分支 ${run.targetSnapshot.branch}）在目标服务器制定首次部署计划。`,
            `代码目录 ${run.targetSnapshot.codeDir}；服务定义 ${JSON.stringify(run.targetSnapshot.services)}。`,
            '只输出 JSON：{"steps": [{"stage": "...", "command": "...", "oneShot": true|false}], "healthCheck": {"processNamePattern": "...", "ports": [], "httpUrls": [], "startWaitSeconds": 120, "observeSeconds": 30}}。',
            '边界：优先项目隔离环境；不改写源码；oneShot=true 用于一次性环境安装/迁移；命令在 codeDir 内执行。',
          ].join('\n'),
        },
        (payload) => {
          const parsed = zPlan.safeParse(extractJson(payload))
          if (!parsed.success) return { ok: false as const, error: 'invalid plan schema' }
          for (const s of parsed.data.steps) {
            const forbidden = validateCommandBoundaries(s.command, run.targetSnapshot.services.map((sv) => sv.name))
            if (forbidden) return { ok: false as const, error: `plan step out of bounds: ${forbidden}` }
          }
          if (!parsed.data.healthCheck.processNamePattern) return { ok: false as const, error: 'health check requires a process pattern' }
          return { ok: true as const, value: parsed.data }
        },
      )
      if (!result.ok) return null
      return result.payload as { steps: Array<{ stage: string; command: string; oneShot: boolean }>; healthCheck: Record<string, unknown> }
    } catch {
      return null
    }
  }

  // ---------- repair ----------

  private async decideRepairOrFail(run: DeploymentRun, stage: string, reason: string): Promise<DeploymentRun> {
    // git protections and user stops never trigger repair
    if (run.stopRequested) return this.stopFlow(run)
    if (/git protection|local-only|uncommitted|branch mismatch|URL mismatch|not a repository|directory/.test(reason)) {
      return this.fail(run, reason)
    }
    const maxRounds = this.deps.repairRounds ?? 2
    if (run.repairRounds >= maxRounds || !this.deps.agentBridge || !this.deps.modelRef) {
      return this.fail(run, `${reason}; repair limit reached or no model`)
    }
    run = await this.transition(run, 'ENTER_REPAIR', { stage, reason })
    await this.deps.repo.updateDeploymentRun(run.runId, (r) => ({ ...r, repairRounds: r.repairRounds + 1, failureReason: reason }))
    const repairCommand = await this.aiRepairCommand(run, stage, reason)
    if (repairCommand === null) {
      return this.fail(this.requireRun(run.runId), `${reason}; repair unavailable`)
    }
    const repairResult = await this.deps.execution.executeUnit({
      serverId: run.targetSnapshot.serverId,
      runId: run.runId,
      stepId: `${run.runId}:REPAIR_${run.repairRounds}`,
      attemptId: 'a1',
      stage: 'REPAIR',
      intent: `repair: ${repairCommand}`,
      payload: renderPayloadForCommand(repairCommand),
      timeoutMs: this.deps.stepTimeoutMs ?? 600_000,
      pollIntervalMs: this.deps.pollIntervalMs,
    })
    await this.pushExecution(run.runId, `${run.runId}:REPAIR_${run.repairRounds}:a1`)
    let current = this.requireRun(run.runId)
    if (repairResult.exit.kind === 'unknown') return this.enterReconcile(current, 'REPAIR')
    if (repairResult.exit.exitCode !== 0) {
      return this.fail(current, `repair failed: ${repairResult.outputTail.slice(-200)}`)
    }
    current = await this.transition(current, 'RESUME_FROM_REPAIR')
    await this.deps.repo.appendEvent(run.runId, 'REPAIR_DONE', { round: run.repairRounds })
    return current
  }

  private async aiRepairCommand(run: DeploymentRun, stage: string, reason: string): Promise<string | null> {
    try {
      const result = await this.deps.agentBridge!.run(
        {
          sessionId: `${run.runId}:REPAIR:${run.repairRounds}`,
          model: this.deps.modelRef!,
          maxRequests: 20,
          timeoutMs: 240_000,
          toolNames: [],
          task: [
            `部署阶段 ${stage} 失败：${reason}。提交 ${run.targetCommit ?? 'unknown'} 保持不变（禁止拉取新代码）。`,
            '只输出 JSON：{"command": "<修复命令>"}。边界：可调整当前服务运行配置、补齐已声明依赖、重试临时失败；不改写跟踪源码、不处理 git 分叉、不做不可逆数据变更。',
          ].join('\n'),
        },
        (payload) => {
          const parsed = zCommand.safeParse(extractJson(payload))
          if (!parsed.success) return { ok: false as const, error: 'invalid repair plan' }
          const forbidden = validateCommandBoundaries(parsed.data.command, run.targetSnapshot.services.map((s) => s.name))
          if (forbidden) return { ok: false as const, error: forbidden }
          return { ok: true as const, value: parsed.data }
        },
      )
      if (!result.ok) return null
      return (result.payload as { command: string }).command
    } catch {
      return null
    }
  }

  // ---------- stop / reconcile / recovery ----------

  async requestStop(runId: string): Promise<DeploymentRun> {
    let run = this.requireRun(runId)
    if (isTerminal(run.status)) return run
    run = await this.transition(run, 'REQUEST_STOP')
    await this.deps.repo.updateDeploymentRun(run.runId, () => ({ ...this.requireRun(runId), stopRequested: true }))
    // freeze orchestration, then cancel current remote unit
    const lastExecution = run.remoteExecutionIds.at(-1)
    if (lastExecution) {
      const [serverId, runIdStepAttempt] = [run.targetSnapshot.serverId, lastExecution]
      void runIdStepAttempt
      const stepId = lastExecution.split(':')[1] ?? ''
      const attemptId = lastExecution.split(':')[2] ?? 'a1'
      const facts = await this.deps.execution.requestStop(serverId, run.runId, stepId, attemptId)
      if (facts.status === 'STOPPED') {
        return this.transition(this.requireRun(runId), 'CONFIRM_STOPPED')
      }
      return this.enterReconcile(this.requireRun(runId), 'STOP')
    }
    return this.transition(this.requireRun(runId), 'CONFIRM_STOPPED')
  }

  async enterReconcile(run: DeploymentRun, stage: string): Promise<DeploymentRun> {
    const updated = await this.transition(run, 'ENTER_RECONCILE', { stage })
    return updated
  }

  /** Query facts for every unknown step; returns the reconciled run + facts. */
  async reconcile(runId: string): Promise<{ run: DeploymentRun; facts: Array<{ stepId: string; status: string }> }> {
    const run = this.requireRun(runId)
    const facts: Array<{ stepId: string; status: string }> = []
    for (const execId of run.remoteExecutionIds) {
      const [, stepId, attemptId] = execId.split(':')
      const fact = await this.deps.execution.safeInspect(run.targetSnapshot.serverId, run.runId, stepId ?? '', attemptId ?? 'a1')
      facts.push({ stepId: stepId ?? '', status: fact.status })
    }
    const allKnown = facts.every((f) => f.status === 'FINISHED' || f.status === 'STOPPED' || f.status === 'NOT_STARTED')
    if (allKnown && facts.length > 0) {
      const anyRunningStill = facts.some((f) => f.status === 'FINISHED' && !f.stepId.includes('HEALTH'))
      void anyRunningStill
      // facts known: user decides continue or archive; run stays RECONCILE_REQUIRED
    }
    return { run: this.requireRun(runId), facts }
  }

  /** User decision after reconcile: continue the original task. */
  async resolveContinue(runId: string): Promise<DeploymentRun> {
    const run = this.requireRun(runId)
    return this.transition(run, 'RESOLVE_RECONCILE_CONTINUE')
  }

  /** User decision after reconcile: archive (close as failed). */
  async resolveArchive(runId: string): Promise<DeploymentRun> {
    const run = this.requireRun(runId)
    const closed = await this.transition(run, 'RESOLVE_RECONCILE_ARCHIVE')
    await this.deps.repo.releaseServer(run.targetSnapshot.serverId, run.runId).catch(() => undefined)
    return closed
  }

  /**
   * Recovery scan after Host/plugin restart: only queries facts. Running
   * remote tasks are surfaced for observation; nothing is re-dispatched and
   * no agent write round is resumed.
   */
  async recover(): Promise<Array<{ runId: string; status: DeploymentStatus; observation: string }>> {
    const results: Array<{ runId: string; status: DeploymentStatus; observation: string }> = []
    for (const run of this.deps.repo.listUnfinishedRuns()) {
      if (run.status === 'RECONCILE_REQUIRED') {
        results.push({ runId: run.runId, status: run.status, observation: 'awaiting reconcile' })
        continue
      }
      const lastExecution = run.remoteExecutionIds.at(-1)
      if (!lastExecution) {
        results.push({ runId: run.runId, status: run.status, observation: 'no dispatched steps; resumable by user' })
        continue
      }
      const [, stepId, attemptId] = lastExecution.split(':')
      const fact = await this.deps.execution.safeInspect(run.targetSnapshot.serverId, run.runId, stepId ?? '', attemptId ?? 'a1')
      if (fact.status === 'RUNNING') {
        results.push({ runId: run.runId, status: run.status, observation: `remote step ${stepId} still running; observe only` })
      } else if (fact.status === 'UNKNOWN') {
        await this.enterReconcile(run, 'RECOVERY')
        results.push({ runId: run.runId, status: 'RECONCILE_REQUIRED', observation: 'remote outcome unknown' })
      } else {
        results.push({ runId: run.runId, status: run.status, observation: `last step finished (${fact.status}); resumable by user` })
      }
    }
    return results
  }

  // ---------- helpers ----------

  private requireRun(runId: string): DeploymentRun {
    const run = this.deps.repo.getDeploymentRun(runId)
    if (!run) throw err('not-found', 'deployment', `run ${runId} not found`)
    return run
  }

  private async updateRun(run: DeploymentRun, patch: Partial<DeploymentRun>): Promise<DeploymentRun> {
    return this.deps.repo.updateDeploymentRun(run.runId, (r) => ({ ...r, ...patch }))
  }

  private async setStage(run: DeploymentRun, stage: string): Promise<DeploymentRun> {
    if (run.stage === stage) return run
    await this.deps.repo.appendEvent(run.runId, 'STAGE', { stage })
    return this.updateRun(run, { stage })
  }

  private async fail(run: DeploymentRun, reason: string): Promise<DeploymentRun> {
    const unknown = this.deps.repo.listStepRecords(run.runId).filter((s) => s.status === 'UNKNOWN').length
    const event = failOrReconcile(unknown)
    await this.transition(run, event, { reason })
    await this.deps.repo.updateDeploymentRun(run.runId, (r) => ({ ...r, failureReason: reason }))
    return this.requireRun(run.runId)
  }

  private async stopFlow(run: DeploymentRun): Promise<DeploymentRun> {
    return this.requestStop(run.runId)
  }

  private async pushExecution(runId: string, execId: string): Promise<void> {
    await this.deps.repo.updateDeploymentRun(runId, (r) => ({ ...r, remoteExecutionIds: [...r.remoteExecutionIds, execId] }))
  }

  private async refreshLogSources(run: DeploymentRun): Promise<void> {
    const svc = this.deps.logService
    if (!svc) return
    const sources = this.deps.repo.listLogSources({ projectId: run.projectId })
    for (const source of sources) {
      await svc.checkSource(source, this.deps.repo.getPolicy(`${source.serverId}:logs`) ?? null)
    }
  }
}

// ---------- module helpers ----------

const zCommand = z.object({ command: z.string().min(1) })
const zPlan = z.object({
  steps: z.array(z.object({ stage: z.string(), command: z.string().min(1), oneShot: z.boolean().default(false) })).min(1),
  healthCheck: z.object({
    processNamePattern: z.string().min(1),
    ports: z.array(z.number()).default([]),
    httpUrls: z.array(z.string()).default([]),
    startWaitSeconds: z.number().default(120),
    observeSeconds: z.number().default(30),
  }),
})

/** Command boundary validation for AI-proposed commands. */
export function validateCommandBoundaries(command: string, serviceNames: string[]): string | null {
  const lowered = command.toLowerCase()
  if (/\bgit\s+push\b/.test(lowered)) return 'git push is not allowed'
  if (/\bgit\s+reset\s+--hard\b/.test(lowered)) return 'git reset --hard is not allowed'
  if (/\bgit\s+fetch\b|\bgit\s+pull\b/.test(lowered)) return 'code updates are frozen to the recorded commit'
  // worktree-destructive git actions discard local work; the SAFE equivalent
  // (git stash push) stays allowed so AI can still clear a dirty tree reversibly
  if (/\bgit\s+(?:checkout\s+(?:--|\.)|restore\b|clean\b|reset\b|stash\s+(?:drop|clear)\b)/.test(lowered)) {
    return 'worktree-destructive git action'
  }
  if (/\brm\s+-rf?\s+(?:--\s+)?\/(?:\s|$)/.test(lowered)) return 'destructive filesystem action'
  if (/\bmkfs\b|\bdd\s+.*of=\/dev\//.test(lowered)) return 'destructive device action'
  if (/\breboot\b|\bshutdown\b|\bhalt\b/.test(lowered)) return 'system power action'
  // unrelated service managers: systemctl/supervisorctl on names outside the target spec
  const svcMatch = /(?:systemctl|supervisorctl)\s+(?:restart|stop|start)\s+([^\s;&|]+)/g
  for (const m of lowered.matchAll(svcMatch)) {
    const name = (m[1] ?? '').replace(/^["']|["']$/g, '')
    if (name && name !== 'all' && !serviceNames.some((s) => s.toLowerCase() === name)) {
      return `unrelated service ${name} is out of scope`
    }
  }
  return null
}

function pickVerifiedScript(repo: OpsRepository, projectId: string, targetId: string, stage: string, ctx: { branch: string; interpreter: string; serviceConfigHash: string }): { content: string; scriptVersionId: string } | null {
  const scripts = repo.listScriptVersions({ projectId, targetId }).filter((s) => s.stage === stage && s.status === 'verified')
  const usable = scripts.find((s) => (!s.fingerprints.branch || s.fingerprints.branch === ctx.branch) && (!s.fingerprints.serviceConfig || s.fingerprints.serviceConfig === ctx.serviceConfigHash))
  if (!usable) return null
  return { content: usable.content, scriptVersionId: usable.scriptVersionId }
}

function hasVerifiedScript(repo: OpsRepository, projectId: string, targetId: string, stage: string): boolean {
  return repo.listScriptVersions({ projectId, targetId }).some((s) => s.stage === stage && s.status === 'verified')
}

function buildRestartCommand(services: Array<{ name: string; manager: string; managerId: string }>): string | null {
  if (!services.length) return null
  const parts: string[] = []
  for (const s of services) {
    const id = s.managerId || s.name
    if (s.manager === 'supervisor') parts.push(`supervisorctl restart ${id}`)
    else if (s.manager === 'systemd') parts.push(`systemctl restart ${id}`)
    else if (s.manager === 'launchd') parts.push(`launchctl kickstart -k system/${id}`)
    else return null // unknown manager → needs an AI step, not a blind command
  }
  return parts.join(' && ')
}

function renderPayloadForCommand(command: string): string {
  return `#!/bin/sh\nset -eu\n${command}\n`
}

/** AI repair commands run FROM the target codeDir — the model is told the
 *  directory but its command must not have to repeat the cd itself. */
function renderRepairPayload(codeDir: string, command: string): string {
  return `#!/bin/sh\nset -eu\ncd ${shq(codeDir)}\n${command}\n`
}

function pullPayload(codeDir: string, branch: string): string {
  return [
    '#!/bin/sh',
    'set -eu',
    `cd ${shq(codeDir)}`,
    buildPullCommand(branch),
    '',
  ].join('\n')
}

function urlsMatch(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/')
  return norm(a) === norm(b)
}

function shq(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`
}

function runId0(stepId: string): string {
  return stepId.split(':')[0]!
}
