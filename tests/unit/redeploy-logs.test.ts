/**
 * Focused coverage for the two service-tab follow-ups:
 * - redeploy pipeline (lightweight check→pull→restart→verify) decision points
 * - log source discovery + manual pin (default paths, user-defined survival)
 * Deterministic stubs (no real SSH): the execution service and transport are
 * scripted per stage.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryStorage } from '../../src/host/adapters/memory.ts'
import { ManualClock } from '../../src/host/adapters/ports.ts'
import { OpsRepository } from '../../src/host/repository/ops-repository.ts'
import { DeploymentService } from '../../src/host/deployment/deployment-service.ts'
import { ScriptService } from '../../src/host/scripts/script-service.ts'
import { LogService } from '../../src/host/logs/log-service.ts'
import { parseGitPrecheck } from '../../src/host/deployment/git-precheck.ts'
import { logDirSearchPaths, looksLikeLogFile } from '../../src/host/logs/discovery.ts'
import type { SshTransport, RemoteCommandResult, RemoteFileInfo } from '../../src/host/adapters/ports.ts'
import type { ExecuteUnitResult } from '../../src/host/execution/execution-service.ts'
import { SCHEMA_VERSION } from '../../src/contracts/entities.ts'
import type { DeploymentRun, Project, TargetSpec } from '../../src/contracts/entities.ts'

// ---------- execution stub: scripted per stage ----------

interface StageScript {
  behind?: number
  pullCommit?: string
  restartExit?: number
  healthOk?: boolean
}

function exited(stdout: string, exitCode = 0): ExecuteUnitResult {
  return {
    step: { status: exitCode === 0 ? 'SUCCEEDED' : 'FAILED' } as never,
    exit: { kind: 'exited', exitCode, signal: null, connectionLost: false } as never,
    outputTail: stdout,
    facts: { status: 'FINISHED', result: null, stopResult: null, token: 't' } as never,
  }
}

function stubExecution(script: StageScript) {
  const calls: string[] = []
  return {
    calls,
    executeUnit: async (req: { stage: string }): Promise<ExecuteUnitResult> => {
      calls.push(req.stage)
      switch (req.stage) {
        case 'PRECHECK': {
          const behind = script.behind ?? 0
          const lines = ['__BRANCH__ main', '__HEAD__ c0ffee', '__REMOTE__ git@x:y.git', `__BEHIND__ ${behind}`]
          if (behind === 0) lines.push('__BEHIND__ 0')
          return exited(lines.join('\n'))
        }
        case 'PULL':
          return exited(`__PULLED__ ${script.pullCommit ?? 'deadbeef'}`)
        case 'SERVICE_RESTART':
          return exited('restarted', script.restartExit ?? 0)
        case 'HEALTH_CHECK':
          return exited(script.healthOk === false ? '__HEALTH__ process-missing' : '__HEALTH__ ok\n__HEALTH__ ok', script.healthOk === false ? 1 : 0)
        default:
          return exited('')
      }
    },
    requestStop: async () => ({ status: 'STOPPED' } as never),
    safeInspect: async () => ({ status: 'FINISHED' } as never),
  }
}

// ---------- transport stub: stateful stat + scripted log content ----------

function stubTransport(logData: string) {
  const statCalls = new Map<string, number>()
  return {
    stat: async (serverId: string, path: string): Promise<RemoteFileInfo | null> => {
      const n = (statCalls.get(path) ?? 0) + 1
      statCalls.set(path, n)
      // first call = pre-restart baseline (size 0); second = post-restart (has content)
      const size = n === 1 ? 0 : Buffer.byteLength(logData, 'utf8')
      return { path, size, mtimeMs: 1, identity: `i${n}` }
    },
    readFileRange: async (): Promise<{ data: string; eof: boolean; fileSize: number; identity: string }> => ({ data: logData, eof: true, fileSize: Buffer.byteLength(logData, 'utf8'), identity: 'i' }),
    execute: async (): Promise<RemoteCommandResult> => ({ exitCode: 0, signal: null, stdout: '', stderr: '', connectionLost: false, truncated: false }),
    listDir: async (): Promise<Array<{ name: string; isDir: boolean }>> => [],
  }
}

function makeEntities(manager: 'supervisor' | 'process'): { project: Project; target: TargetSpec } {
  const target: TargetSpec = {
    schemaVersion: SCHEMA_VERSION, id: 'tgt1', serverId: 'srv', codeDir: '/app',
    services: [{ name: 'web', manager, managerId: 'web' }],
    gitCredentialRef: null, sudoCredentialRef: null,
    healthCheck: { processNamePattern: 'web', ports: [], httpUrls: [], startWaitSeconds: 5, observeSeconds: 0 },
    createdAt: 1, updatedAt: 1,
  }
  const project: Project = {
    schemaVersion: SCHEMA_VERSION, id: 'p1', revision: 1, name: 'shop', repoUrl: 'git@x:y.git', branch: 'main',
    targets: [target], createdAt: 1, updatedAt: 1,
  }
  return { project, target }
}

let repo: OpsRepository
let clock: ManualClock

beforeEach(async () => {
  const storage = new MemoryStorage()
  clock = new ManualClock()
  repo = new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock, controllerId: 'c' })
})

function makeDeployment(execution: unknown, transport: unknown, logService: LogService | null): DeploymentService {
  return new DeploymentService({
    repo,
    clock,
    execution: execution as never,
    transport: transport as never,
    scriptService: new ScriptService(repo, clock, null),
    agentBridge: null,
    modelRef: null,
    logService,
    controllerId: 'c',
    pollIntervalMs: 1,
  })
}

async function seedActiveLogSource(): Promise<void> {
  await repo.putLogSource({
    schemaVersion: SCHEMA_VERSION, sourceId: 'log_srv_web_app_log', projectId: 'p1', serverId: 'srv',
    service: 'web', configOrigin: 'test', path: '/app/logs/app.log', fileIdentity: 'i', status: 'active',
    statusReason: '', fingerprint: '', discoveredAt: 1, readCursor: 0, generation: 0, truncatedAtDiscovery: false,
    userDefined: false, sizeBytes: null, lastModifiedAt: null, ignored: false,
  })
}

describe('parseGitPrecheck exposes behind count', () => {
  it('reads __BEHIND__ into the result', () => {
    const r = parseGitPrecheck('__BRANCH__ main\n__HEAD__ a\n__REMOTE__ u\n__BEHIND__ 4')
    expect(r.ok).toBe(true)
    expect(r.behind).toBe(4)
  })
  it('behind defaults to 0 when the marker is absent', () => {
    const r = parseGitPrecheck('__BRANCH__ main\n__HEAD__ a\n__REMOTE__ u\n__BEHIND__ 0')
    expect(r.behind).toBe(0)
  })
})

describe('discovery default-path helpers', () => {
  it('lists the code-dir log directories', () => {
    expect(logDirSearchPaths('/app')).toEqual(['/app/logs', '/app/log'])
  })
  it('recognizes rotated log filenames', () => {
    expect(looksLikeLogFile('app.log')).toBe(true)
    expect(looksLikeLogFile('app.log.3')).toBe(true)
    expect(looksLikeLogFile('app.txt')).toBe(false)
  })
})

describe('runRedeploy (lightweight update pipeline)', () => {
  it('already latest → succeeds WITHOUT pull or restart', async () => {
    const execution = stubExecution({ behind: 0 })
    const deployment = makeDeployment(execution, stubTransport(''), null)
    const { project, target } = makeEntities('supervisor')
    const { run } = await deployment.createRun('r1', project, target, 'update')
    const final = await deployment.runRedeploy(run.runId)
    expect(final.status).toBe('SUCCEEDED')
    expect(final.stage).toBe('ALREADY_LATEST')
    expect(execution.calls).toEqual(['PRECHECK'])
    expect(final.targetCommit).toBeNull()
  })

  it('behind → pull, restart, health, clean logs → success', async () => {
    await seedActiveLogSource()
    const execution = stubExecution({ behind: 2, pullCommit: 'aaa111' })
    const deployment = makeDeployment(execution, stubTransport('INFO started\nINFO listening'), null)
    const { project, target } = makeEntities('supervisor')
    const { run } = await deployment.createRun('r2', project, target, 'update')
    const final = await deployment.runRedeploy(run.runId)
    expect(final.status).toBe('SUCCEEDED')
    expect(final.targetCommit).toBe('aaa111')
    expect(execution.calls).toEqual(['PRECHECK', 'PULL', 'SERVICE_RESTART', 'HEALTH_CHECK'])
  })

  it('behind but a new ERROR line after restart → FAILED (log verification)', async () => {
    await seedActiveLogSource()
    const execution = stubExecution({ behind: 1 })
    const deployment = makeDeployment(execution, stubTransport('INFO boot\nERROR crash on startup'), null)
    const { project, target } = makeEntities('supervisor')
    const { run } = await deployment.createRun('r3', project, target, 'update')
    const final = await deployment.runRedeploy(run.runId)
    expect(final.status).toBe('FAILED')
    expect(final.failureReason ?? '').toMatch(/重启后日志/)
  })

  it('unknown service manager → refuses to blind-restart', async () => {
    const execution = stubExecution({ behind: 3 })
    const deployment = makeDeployment(execution, stubTransport(''), null)
    const { project, target } = makeEntities('process')
    const { run } = await deployment.createRun('r4', project, target, 'update')
    const final = await deployment.runRedeploy(run.runId)
    expect(final.status).toBe('FAILED')
    expect(final.failureReason ?? '').toMatch(/服务管理器/)
    expect(execution.calls).not.toContain('SERVICE_RESTART')
  })

  it('health check failure → FAILED', async () => {
    const execution = stubExecution({ behind: 1, healthOk: false })
    const deployment = makeDeployment(execution, stubTransport(''), null)
    const { project, target } = makeEntities('supervisor')
    const { run } = await deployment.createRun('r5', project, target, 'update')
    const final: DeploymentRun = await deployment.runRedeploy(run.runId)
    expect(final.status).toBe('FAILED')
    expect(execution.calls).toContain('HEALTH_CHECK')
  })
})

describe('LogService discovery + manual pin', () => {
  function logServiceWith(transport: unknown): LogService {
    return new LogService({ transport: transport as SshTransport, repo, clock, agentBridge: null, modelRef: null })
  }

  it('manual add records a user-defined source (missing file kept as missing)', async () => {
    const transport = { ...stubTransport(''), stat: async () => null }
    const logs = logServiceWith(transport)
    const src = await logs.addManual({ projectId: 'p1', serverId: 'srv', path: '/var/log/app/error.log' })
    expect(src.userDefined).toBe(true)
    expect(src.status).toBe('missing')
    expect(src.service).toBe('manual:error.log')
    expect(repo.getLogSource(src.sourceId)).toBeDefined()
  })

  it('manual add of an unreadable relative path is marked unsupported', async () => {
    const logs = logServiceWith({ ...stubTransport(''), stat: async () => null })
    const src = await logs.addManual({ projectId: 'p1', serverId: 'srv', path: 'logs/relative.log', service: 'app' })
    expect(src.status).toBe('unsupported')
    expect(src.userDefined).toBe(true)
  })

  it('discoverProject registers active sources and never overwrites a manual pin', async () => {
    // pin first so discovery must preserve it
    const logs0 = logServiceWith({ ...stubTransport(''), stat: async (_s: string, p: string) => (p === '/app/logs/pinned.log' ? { path: p, size: 5, mtimeMs: 1, identity: 'i' } : null) })
    const pinned = await logs0.addManual({ projectId: 'p1', serverId: 'srv', path: '/app/logs/pinned.log', service: 'me' })

    const transport = {
      execute: async (): Promise<RemoteCommandResult> => ({ exitCode: 0, signal: null, stdout: '', stderr: '', connectionLost: false, truncated: false }),
      readFileRange: async (_s: string, path: string): Promise<{ data: string; eof: boolean; fileSize: number; identity: string }> => ({ data: '[program:web]\nstdout_logfile=/app/logs/pinned.log\n', eof: true, fileSize: 40, identity: 'x' }),
      stat: async (_s: string, path: string): Promise<RemoteFileInfo | null> => (path.endsWith('.conf') || path === '/app/logs/pinned.log' ? { path, size: 40, mtimeMs: 1, identity: 'i' } : null),
      listDir: async (_s: string, dir: string): Promise<Array<{ name: string; isDir: boolean }>> => (dir === '/app/supervisor/conf.d' ? [{ name: 'web.conf', isDir: false }] : []),
    }
    const logs = logServiceWith(transport)
    const { registered, sources } = await logs.discoverProject({ projectId: 'p1', serverId: 'srv', codeDir: '/app' })
    expect(registered).toBeGreaterThanOrEqual(0)
    // the manual pin survives re-discovery untouched
    const persisted = repo.getLogSource(pinned.sourceId)
    expect(persisted?.userDefined).toBe(true)
    expect(persisted?.configOrigin).toBe('手动登记')
    expect(sources.some((s) => s.sourceId === pinned.sourceId)).toBe(true)
  })
})
