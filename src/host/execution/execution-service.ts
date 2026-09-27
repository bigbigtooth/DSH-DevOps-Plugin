/**
 * RemoteExecutionService: identity-bound, inspectable remote execution units.
 *
 * Invariants (PLAN S3):
 * - intent is persisted BEFORE dispatch; an identity starts at most once —
 *   repeats with the same identity query the original unit instead
 * - the remote wrapper runs detached (nohup … &), so a lost SSH connection
 *   never equals a lost remote task; results are published by the wrapper
 * - stop requests do not imply stopped; only the recorded stop facts count
 * - unconfirmed outcomes surface as result-unknown for RECONCILE_REQUIRED
 */
import { randomBytes } from 'node:crypto'
import type { ExitResult, StepRecord } from '../../contracts/entities.ts'
import { SCHEMA_VERSION } from '../../contracts/entities.ts'
import type { SshTransport, RemoteCommandResult } from '../adapters/ports.ts'
import type { ClockPort } from '../adapters/ports.ts'
import type { OpsRepository } from '../repository/ops-repository.ts'
import { renderWrapper } from './wrapper.ts'
import { taskDirFor, shq, shqRemotePath } from '../ssh/openssh-transport.ts'
import { sha256 } from '../ssh/private-config.ts'

export interface ExecuteUnitRequest {
  serverId: string
  runId: string
  stepId: string
  attemptId: string
  stage: string
  intent: string
  /** payload script (trusted template output, never raw user text) */
  payload: string
  timeoutMs?: number
  /** poll interval while waiting for the remote result */
  pollIntervalMs?: number
}

export type UnitStatus = 'NOT_STARTED' | 'RUNNING' | 'FINISHED' | 'STOPPED' | 'UNKNOWN'

export interface UnitFact {
  status: UnitStatus
  result: RemoteCommandResult | null
  stopResult: string | null
  token: string
}

export interface ExecuteUnitResult {
  step: StepRecord
  exit: ExitResult
  outputTail: string
  facts: UnitFact
}

export class RemoteExecutionService {
  constructor(
    private readonly transport: SshTransport,
    private readonly repo: OpsRepository,
    private readonly clock: ClockPort,
    private readonly opts: { pollIntervalMs?: number; maxWaitMs?: number } = {},
  ) {}

  private pollInterval(): number {
    return this.opts.pollIntervalMs ?? 1000
  }

  /**
   * Execute one unit. Safe to call twice with the same identity: the second
   * call observes the original unit (idempotent), never starts twice.
   */
  async executeUnit(req: ExecuteUnitRequest): Promise<ExecuteUnitResult> {
    // storage identity = step + attempt: retrying a stage under a NEW attempt
    // is a NEW unit; repeating the SAME identity is idempotent (queried, never
    // re-dispatched).
    const storageStepId = `${req.stepId}:${req.attemptId}`
    const existing = this.repo.getStepRecord(storageStepId)
    if (existing && existing.status !== 'PENDING') {
      // identity already dispatched: query facts, never re-run
      const facts = await this.inspectUnit(req.serverId, req.runId, req.stepId, req.attemptId)
      return this.summarize(existing, facts)
    }
    const now = this.clock.now()
    const intent: StepRecord = {
      schemaVersion: SCHEMA_VERSION,
      runId: req.runId,
      stepId: storageStepId,
      attemptId: req.attemptId,
      stage: req.stage,
      intent: req.intent,
      inputsHash: sha256(req.payload),
      remoteIdentity: taskDirFor(req.runId, req.stepId, req.attemptId),
      status: 'PENDING',
      exitResult: null,
      postcondition: null,
      outputTail: '',
      startedAt: now,
      finishedAt: null,
      evidence: [],
      executor: 'ai',
      scriptVersionId: null,
    }
    await this.repo.putStepRecord(intent)

    const dir = taskDirFor(req.runId, req.stepId, req.attemptId)
    const token = randomBytes(16).toString('hex')
    // upload wrapper + payload + token (task dir is exclusive to this identity)
    await this.transport.writeFile(req.serverId, `${dir}/wrapper.sh`, renderWrapper())
    await this.transport.writeFile(req.serverId, `${dir}/payload.sh`, req.payload)
    await this.transport.writeFile(req.serverId, `${dir}/token`, token)
    await this.repo.putStepRecord({ ...intent, status: 'DISPATCHED' })

    // detached dispatch: the task survives connection loss; wrapper publishes results
    const dispatch = await this.transport.execute({
      serverId: req.serverId,
      runId: req.runId,
      stepId: req.stepId,
      attemptId: req.attemptId,
      command: `mkdir -p ${shqRemotePath(dir)} && nohup sh ${shqRemotePath(`${dir}/wrapper.sh`)} start ${shqRemotePath(dir)} >${shqRemotePath(`${dir}/nohup.out`)} 2>${shqRemotePath(`${dir}/nohup.err`)} & echo DISPATCHED-$!`,
      timeoutMs: 15_000,
    })
    if (dispatch.connectionLost || !dispatch.stdout.includes('DISPATCHED')) {
      // dispatch outcome unknown — DO NOT retry blindly; caller reconciles
      const step: StepRecord = { ...intent, status: 'UNKNOWN', finishedAt: this.clock.now(), outputTail: dispatch.stderr.slice(-500) }
      await this.repo.putStepRecord(step)
      const facts = await this.safeInspect(req.serverId, req.runId, req.stepId, req.attemptId)
      return this.summarize(step, facts)
    }

    const facts = await this.waitUntilFinished(req)
    const step = await this.recordOutcome(intent, facts)
    return this.summarize(step, facts)
  }

  /** Poll the remote unit until finished or the deadline; never mutates remote state. */
  async waitUntilFinished(req: ExecuteUnitRequest): Promise<UnitFact> {
    const deadline = this.clock.now() + (req.timeoutMs ?? this.opts.maxWaitMs ?? 600_000)
    for (;;) {
      const facts = await this.inspectUnit(req.serverId, req.runId, req.stepId, req.attemptId)
      if (facts.status === 'FINISHED' || facts.status === 'STOPPED') return facts
      // NOT_STARTED right after a confirmed dispatch is a startup race, not a
      // fact — keep polling; at the deadline the last facts stand (unknown).
      if (this.clock.now() >= deadline) return facts
      await sleep(this.pollInterval())
    }
  }

  /** Read-only unit status query (reconcile). Returns null when the query itself failed. */
  async safeInspect(serverId: string, runId: string, stepId: string, attemptId: string): Promise<UnitFact> {
    try {
      return await this.inspectUnit(serverId, runId, stepId, attemptId)
    } catch {
      return { status: 'UNKNOWN', result: null, stopResult: null, token: '' }
    }
  }

  async inspectUnit(serverId: string, runId: string, stepId: string, attemptId: string): Promise<UnitFact> {
    const res = await this.transport.inspect(serverId, runId, stepId, attemptId)
    if (res === null || res.connectionLost) {
      return { status: 'UNKNOWN', result: res, stopResult: null, token: '' }
    }
    const statusLine = /__STATUS__ (.+)/.exec(res.stdout)?.[1]?.trim() ?? 'absent'
    const stopResult = /__STOPRESULT__ ?(.*)/.exec(res.stdout)?.[1]?.trim() || null
    if (statusLine === 'absent') {
      return { status: 'NOT_STARTED', result: res, stopResult, token: '' }
    }
    if (statusLine === 'running' || statusLine === 'stopping') {
      return { status: stopResult ? 'STOPPED' : 'RUNNING', result: res, stopResult, token: '' }
    }
    // finished (or stopped): parse the published exit facts
    let exitCode: number | null = null
    let signal: string | null = null
    const exitLine = /__EXIT__ (\d+)/.exec(res.stdout)
    if (exitLine) {
      exitCode = Number(exitLine[1])
    } else {
      signal = /__SIGNAL__ \S+/.test(res.stdout) ? 'SIGTERM' : 'SIGKILL'
    }
    const tailMatch = /__TOKEN__ \S*\n__TAIL__\n?([\s\S]*)$/.exec(res.stdout)
    const outputTail = tailMatch?.[1] ?? ''
    const token = /__TOKEN__ (\S*)/.exec(res.stdout)?.[1] ?? ''
    const result: RemoteCommandResult = {
      exitCode,
      signal,
      stdout: outputTail,
      stderr: res.stderr,
      connectionLost: false,
      truncated: res.truncated,
    }
    // a recorded stop.result wins over the concurrent finished overwrite
    return { status: stopResult ? 'STOPPED' : 'FINISHED', result, stopResult, token }
  }

  /**
   * Stop request: ask the wrapper to terminate, then read the recorded stop
   * facts. The REQUEST does not equal a confirmed stop — callers must check
   * `stopResult` and the unit status afterwards.
   */
  async requestStop(serverId: string, runId: string, stepId: string, attemptId: string): Promise<UnitFact> {
    await this.transport.requestStop(serverId, runId, stepId, attemptId)
    const facts = await this.waitStop(serverId, runId, stepId, attemptId)
    return facts
  }

  async waitStop(serverId: string, runId: string, stepId: string, attemptId: string): Promise<UnitFact> {
    const deadline = this.clock.now() + 90_000
    for (;;) {
      const facts = await this.safeInspect(serverId, runId, stepId, attemptId)
      if (facts.status === 'STOPPED') return facts
      if (this.clock.now() >= deadline) return facts
      await sleep(this.pollInterval())
    }
  }

  private async recordOutcome(intent: StepRecord, facts: UnitFact): Promise<StepRecord> {
    const now = this.clock.now()
    if (facts.status === 'FINISHED' && facts.result && !facts.result.connectionLost) {
      const step: StepRecord = {
        ...intent,
        status: facts.result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED',
        exitResult: {
          kind: facts.result.signal ? 'signalled' : 'exited',
          exitCode: facts.result.exitCode,
          signal: facts.result.signal,
          connectionLost: false,
        },
        postcondition: `exit=${facts.result.exitCode}`,
        outputTail: facts.result.stdout.slice(-2000),
        finishedAt: now,
      }
      await this.repo.putStepRecord(step)
      return step
    }
    if (facts.status === 'STOPPED') {
      const step: StepRecord = {
        ...intent,
        status: 'FAILED',
        exitResult: { kind: 'signalled', exitCode: null, signal: 'SIGTERM', connectionLost: false },
        postcondition: 'stopped',
        outputTail: facts.result?.stdout.slice(-2000) ?? '',
        finishedAt: now,
      }
      await this.repo.putStepRecord(step)
      return step
    }
    // running past deadline, query lost, or dispatch unknown → result unknown
    const step: StepRecord = {
      ...intent,
      status: 'UNKNOWN',
      exitResult: { kind: 'unknown', exitCode: null, signal: null, connectionLost: true },
      postcondition: null,
      outputTail: '',
      finishedAt: now,
    }
    await this.repo.putStepRecord(step)
    return step
  }

  private summarize(step: StepRecord, facts: UnitFact): ExecuteUnitResult {
    let exit: ExitResult
    if (step.exitResult) exit = step.exitResult
    else if (facts.status === 'FINISHED' && facts.result)
      exit = { kind: facts.result.signal ? 'signalled' : 'exited', exitCode: facts.result.exitCode, signal: facts.result.signal, connectionLost: facts.result.connectionLost }
    else exit = { kind: 'unknown', exitCode: null, signal: null, connectionLost: true }
    return {
      step,
      exit,
      outputTail: step.outputTail || facts.result?.stdout.slice(-2000) || '',
      facts,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
