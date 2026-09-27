import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryStorage } from '../../src/host/adapters/memory.ts'
import { OpsRepository } from '../../src/host/repository/ops-repository.ts'
import { RemoteExecutionService } from '../../src/host/execution/execution-service.ts'
import type { SshTransport, RemoteCommandResult, ClockPort } from '../../src/host/adapters/ports.ts'

interface Behavior {
  on: 'execute' | 'inspect'
  match: RegExp
  result: () => Partial<RemoteCommandResult> | null
}

/** Fake transport with scriptable command outcomes. */
class FakeTransport implements Partial<SshTransport> {
  dispatches: Array<{ command: string; stdin?: string }> = []
  behaviors: Behavior[] = []
  files = new Map<string, string>()
  stopped: string[] = []

  async execute(req: { serverId: string; runId: string; stepId: string; attemptId: string; command: string; stdin?: string }): Promise<RemoteCommandResult> {
    this.dispatches.push({ command: req.command, stdin: req.stdin })
    for (const b of this.behaviors) {
      if (b.on === 'execute' && b.match.test(req.command)) {
        const r = b.result()
        return this.complete(r ?? {})
      }
    }
    return this.complete({})
  }

  private complete(r: Partial<RemoteCommandResult>): RemoteCommandResult {
    return { exitCode: 0, signal: null, stdout: '', stderr: '', connectionLost: false, truncated: false, ...r }
  }

  async writeFile(serverId: string, path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }

  async inspect(serverId: string, runId: string, stepId: string, attemptId: string): Promise<RemoteCommandResult | null> {
    for (const b of this.behaviors) {
      if (b.on === 'inspect' && b.match.test('inspect')) {
        return this.complete(b.result() ?? {})
      }
    }
    return null
  }

  async requestStop(serverId: string, runId: string, stepId: string, attemptId: string): Promise<void> {
    this.stopped.push(`${runId}:${stepId}:${attemptId}`)
  }
}

function fixedClock(): ClockPort {
  let t = 1000
  return { now: () => (t += 10) }
}

async function freshRepo(): Promise<OpsRepository> {
  const storage = new MemoryStorage()
  return new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock: fixedClock(), controllerId: 'c' })
}

const baseReq = {
  serverId: 's1',
  runId: 'run1',
  stepId: 'step1',
  attemptId: 'a1',
  stage: 'BUILD',
  intent: 'run: echo build',
  payload: '#!/bin/sh\necho build\n',
  pollIntervalMs: 1,
}

describe('remote execution service (S3)', () => {
  let repo: OpsRepository
  let transport: FakeTransport
  let svc: RemoteExecutionService

  beforeEach(async () => {
    repo = await freshRepo()
    transport = new FakeTransport()
    svc = new RemoteExecutionService(transport as unknown as SshTransport, repo, fixedClock(), { pollIntervalMs: 1, maxWaitMs: 200 })
  })

  it('persists intent BEFORE dispatch, then dispatches exactly once', async () => {
    // wrapper start dispatch
    transport.behaviors.push({ on: 'execute', match: /nohup/, result: () => ({ stdout: 'DISPATCHED-123' }) })
    transport.behaviors.push({ on: 'execute', match: /cat '.*exitcode'/, result: () => ({ stdout: '0' }) })
    transport.behaviors.push({ on: 'execute', match: /cat '.*token'/, result: () => ({ stdout: 'tok' }) })
    // inspect sees the published result (new fact-file protocol)
    transport.behaviors.push({ on: 'inspect', match: /inspect/, result: () => ({ stdout: '__STATUS__ finished\n__STOPRESULT__\n__EXIT__ 0\n__SIGNAL__\n__TOKEN__ tok\n__TAIL__\nunit-output' }) })

    let stepStatusAtDispatch = 'missing'
    const origExecute = transport.execute.bind(transport)
    transport.execute = async (req) => {
      if (req.command.includes('nohup')) {
        const step = repo.getStepRecord('step1:a1') // storage id = step:attempt
        stepStatusAtDispatch = step ? step.status : 'missing'
      }
      return origExecute(req)
    }

    const result = await svc.executeUnit(baseReq)
    expect(stepStatusAtDispatch).toBe('DISPATCHED') // intent persisted before remote start
    expect(result.exit.kind).toBe('exited')
    expect(result.exit.exitCode).toBe(0)
    expect(result.step.status).toBe('SUCCEEDED')
    // identity repeat inspects the original unit instead of dispatching again
    const dispatchCount = transport.dispatches.filter((d) => d.command.includes('nohup')).length
    expect(dispatchCount).toBe(1)
    await svc.executeUnit(baseReq)
    expect(transport.dispatches.filter((d) => d.command.includes('nohup')).length).toBe(1)
  })

  it('dispatch connection loss → UNKNOWN, never a blind retry', async () => {
    transport.behaviors.push({ on: 'execute', match: /nohup/, result: () => ({ stdout: '', stderr: 'Connection closed', connectionLost: true }) })
    transport.behaviors.push({ on: 'inspect', match: /inspect/, result: () => ({ stdout: '__NO_RESULT__' }) })
    const result = await svc.executeUnit(baseReq)
    expect(result.exit.kind).toBe('unknown')
    expect(result.exit.connectionLost).toBe(true)
    expect(result.step.status).toBe('UNKNOWN')
    // a repeat call inspects instead of dispatching
    const before = transport.dispatches.filter((d) => d.command.includes('nohup')).length
    await svc.executeUnit(baseReq)
    expect(transport.dispatches.filter((d) => d.command.includes('nohup')).length).toBe(before)
  })

  it('poll timeout with running task → result unknown (RECONCILE fuel)', async () => {
    transport.behaviors.push({ on: 'execute', match: /nohup/, result: () => ({ stdout: 'DISPATCHED-1' }) })
    transport.behaviors.push({ on: 'inspect', match: /inspect/, result: () => ({ stdout: '__NO_RESULT__' }) })
    transport.behaviors.push({ on: 'execute', match: /wrapper[\s\S]*status/, result: () => ({ stdout: 'running' }) })
    const result = await svc.executeUnit({ ...baseReq, timeoutMs: 50 })
    expect(result.exit.kind).toBe('unknown')
    expect(result.step.status).toBe('UNKNOWN')
  })

  it('stop request records facts; STOPPED status only from remote confirmation', async () => {
    transport.behaviors.push({ on: 'execute', match: /stop/, result: () => ({ stdout: 'pidAliveBefore=1\nkilled=1\npidAliveAfter=0' }) })
    transport.behaviors.push({ on: 'execute', match: /wrapper\.sh.*status/, result: () => ({ stdout: 'stopped' }) })
    let stopRequested = false
    const origRequestStop = transport.requestStop.bind(transport)
    transport.requestStop = async (...args) => {
      stopRequested = true
      await origRequestStop(...args)
    }
    transport.inspect = async () => {
      if (stopRequested) return { exitCode: 0, signal: null, stdout: '__STATUS__ stopped\n__STOPRESULT__ pidAliveBefore=1 killed=1 pidAliveAfter=0\n__TOKEN__ tok', stderr: '', connectionLost: false, truncated: false }
      return { exitCode: 0, signal: null, stdout: '__STATUS__ running\n__STOPRESULT__\n', stderr: '', connectionLost: false, truncated: false }
    }
    const facts = await svc.requestStop('s1', 'run1', 'step1', 'a1')
    expect(transport.stopped).toEqual(['run1:step1:a1'])
    expect(facts.status).toBe('STOPPED')
  })
})
