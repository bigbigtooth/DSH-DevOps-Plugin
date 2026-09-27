import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryStorage } from '../../src/host/adapters/memory.ts'
import { ManualClock } from '../../src/host/adapters/ports.ts'
import { OpsRepository } from '../../src/host/repository/ops-repository.ts'
import { createApiDispatcher, type DevOpsServices } from '../../src/host/api/devops-api.ts'
import { ServerService } from '../../src/host/servers/server-service.ts'
import { HardwareCollector } from '../../src/host/probes/collector.ts'
import { ProcessCollector, ResourceProbe } from '../../src/host/probes/collector.ts'
import { InspectionService } from '../../src/host/agents/inspection-service.ts'
import { LogService } from '../../src/host/logs/log-service.ts'
import { ScriptService } from '../../src/host/scripts/script-service.ts'
import { DeploymentService } from '../../src/host/deployment/deployment-service.ts'
import { Vault, MemoryKeyProvider } from '../../src/host/vault/vault.ts'
import type { SshTransport, RemoteCommandResult } from '../../src/host/adapters/ports.ts'

const MAC_PS = `  501     1 root   20480   0.5 Tue Sep 16 09:10:00 2026 S /usr/sbin/syslogd
  742   501 alice 512000  210.0 Tue Sep 16 09:12:30 2026 R /usr/local/bin/node server.js
`

class ApiFakeTransport implements Partial<SshTransport> {
  async verify(): Promise<never> {
    throw new Error('not used')
  }
  async probe() {
    return { platform: 'linux' as const, osRelease: 'Ubuntu', arch: 'x86_64', shell: '/bin/sh', tools: {} }
  }
  async execute(req: { command: string }): Promise<RemoteCommandResult> {
    if (/ps -eo/.test(req.command)) {
      return { exitCode: 0, signal: null, stdout: MAC_PS, stderr: '', connectionLost: false, truncated: false }
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '', connectionLost: false, truncated: false }
  }
  async readFileRange(serverId: string, path: string, offset: number, maxBytes: number) {
    return { data: '', eof: true, fileSize: 0, identity: 'i' }
  }
  async stat() {
    return null
  }
  async listDir() {
    return []
  }
  async writeFile() {}
  async inspect() {
    return null
  }
  async requestStop() {}
}

async function makeSut() {
  const storage = new MemoryStorage()
  const clock = new ManualClock()
  const repo = new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock, controllerId: 'c' })
  const vault = new Vault(new MemoryKeyProvider())
  const transport = new ApiFakeTransport()
  const servers = new ServerService(repo, transport as unknown as SshTransport, vault, clock)
  const hardware = new HardwareCollector(transport as unknown as SshTransport, clock)
  const processes = new ProcessCollector(transport as unknown as SshTransport, repo, clock)
  const inspection = new InspectionService({ agentBridge: null, repo, clock, modelRef: null })
  const logs = new LogService({ transport: transport as unknown as SshTransport, repo, clock, agentBridge: null, modelRef: null })
  const scripts = new ScriptService(repo, clock, null)
  const deployment = new DeploymentService({
    repo, clock,
    execution: { executeUnit: async () => { throw new Error('no') } } as never,
    transport: transport as unknown as SshTransport,
    scriptService: scripts,
    agentBridge: null,
    modelRef: null,
    logService: null,
    controllerId: 'c',
  })
  const svc: DevOpsServices = {
    repo, servers, hardware, processes, resources: new ResourceProbe(transport as unknown as SshTransport), inspection, logs, deployment, scripts,
    model: { resolve: async () => null },
  }
  return { repo, svc, dispatcher: createApiDispatcher(svc) }
}

describe('api dispatcher (S11 contract)', () => {
  let sut: Awaited<ReturnType<typeof makeSut>>
  beforeEach(async () => {
    sut = await makeSut()
  })

  it('unknown endpoint → not-found', async () => {
    await expect(sut.dispatcher('nope/nope', {})).rejects.toThrow(/unknown endpoint/)
  })

  it('request schema violations fail loudly (no partial execution)', async () => {
    await expect(sut.dispatcher('servers.get', {})).rejects.toThrow()
    await expect(sut.dispatcher('deploy.create', { requestId: 'x' })).rejects.toThrow()
  })

  it('empty list responses are explicit empty arrays, not errors', async () => {
    const servers = await sut.dispatcher('servers.list', {})
    expect(servers).toEqual([])
    const projects = await sut.dispatcher('projects.list', {})
    expect(projects).toEqual([])
  })

  it('process page read never triggers AI: pending state without stored runs', async () => {
    // seed a server
    const { repo, svc } = sut
    await repo.putServer({
      schemaVersion: 1, id: 's1', revision: 1, alias: 'web', endpoint: 'r@h:22',
      sshOptions: { host: 'h', port: 22, user: 'r', authKind: 'password', jumpHosts: [], extraOptions: {} },
      credentialRefs: [], configHash: 'h', hostFingerprint: 'fp',
      capabilities: { platform: 'linux', osRelease: 'U', arch: 'x', shell: 'sh', probes: {}, probedAt: 1 },
      createdAt: 1, updatedAt: 1,
    })
    // 模型端 429/503 曾让这个数据读取接口同步等待 AI 巡检（每 batch 超时 240s）
    // 而挂起数分钟——现在数据读取路径绝不允许触碰 inspection
    let inspectionCalls = 0
    const origRun = svc.inspection.runInspection.bind(svc.inspection)
    svc.inspection.runInspection = (async (...args: Parameters<typeof origRun>) => {
      inspectionCalls++
      return origRun(...args)
    }) as unknown as typeof svc.inspection.runInspection
    const result = (await sut.dispatcher('monitoring.processes', { serverId: 's1' })) as { analysisState: string; processes: unknown[]; coverage: { analyzed: number; total: number }; findings: unknown[] }
    expect(result.processes).toHaveLength(2)
    expect(result.analysisState).toBe('pending') // 没有落库巡检记录：如实报 pending
    expect(result.coverage).toEqual({ analyzed: 0, total: 2 })
    expect(result.findings).toEqual([])
    expect(inspectionCalls).toBe(0) // 普通读不触发 AI
  })

  it('process page surfaces the latest stored process inspection run (findings/coverage)', async () => {
    const { repo } = sut
    await repo.putServer({
      schemaVersion: 1, id: 's2', revision: 1, alias: 'web2', endpoint: 'r@h:22',
      sshOptions: { host: 'h', port: 22, user: 'r', authKind: 'password', jumpHosts: [], extraOptions: {} },
      credentialRefs: [], configHash: 'h', hostFingerprint: 'fp',
      capabilities: { platform: 'linux', osRelease: 'U', arch: 'x', shell: 'sh', probes: {}, probedAt: 1 },
      createdAt: 1, updatedAt: 1,
    })
    // 两条落库巡检记录：调度器每 5 分钟落一条，页面应取最近一条（snapshotId 不必匹配）
    await repo.putInspectionRun({
      schemaVersion: 1, runId: 'ins_old', serverId: 's2', kind: 'process', snapshotId: 'snap_old',
      startedAt: 100, finishedAt: 200, analysisState: 'partial', coverageAnalyzed: 1, coverageTotal: 2,
      findings: [{ processStartTokens: ['tok-old'], severity: 'info', summary: '旧', evidence: 'e', suggestion: 's' }],
      evidenceRefs: [], error: null, trigger: 'scheduled',
    })
    const latest = {
      schemaVersion: 1, runId: 'ins_new', serverId: 's2', kind: 'process' as const, snapshotId: 'snap_new',
      startedAt: 900, finishedAt: 950, analysisState: 'partial' as const, coverageAnalyzed: 1, coverageTotal: 2,
      findings: [{ processStartTokens: ['tok-x'], severity: 'warning' as const, summary: '内存偏高', evidence: 'rss=512MB', suggestion: '重启' }],
      evidenceRefs: ['snap_new'], error: null, trigger: 'scheduled' as const,
    }
    await repo.putInspectionRun(latest)
    const result = (await sut.dispatcher('monitoring.processes', { serverId: 's2' })) as { analysisState: string; coverage: { analyzed: number; total: number }; findings: Array<{ summary: string }> }
    expect(result.analysisState).toBe('partial')
    expect(result.coverage).toEqual({ analyzed: 1, total: 2 })
    expect(result.findings.map((f) => f.summary)).toEqual(['内存偏高']) // 最近一条，不是更旧的
  })

  it('monitoring.processes caches the page and recomputes on force (stale-while-revalidate)', async () => {
    const { repo, svc } = sut
    await repo.putServer({
      schemaVersion: 1, id: 's3', revision: 1, alias: 'web3', endpoint: 'r@h:22',
      sshOptions: { host: 'h', port: 22, user: 'r', authKind: 'password', jumpHosts: [], extraOptions: {} },
      credentialRefs: [], configHash: 'h', hostFingerprint: 'fp',
      capabilities: { platform: 'linux', osRelease: 'U', arch: 'x', shell: 'sh', probes: {}, probedAt: 1 },
      createdAt: 1, updatedAt: 1,
    })
    // 给每次采集打单调递增的 collectedAt，用于区分“缓存命中”与“同步重算”
    let counter = 0
    let collectCalls = 0
    const orig = svc.processes.collect.bind(svc.processes)
    svc.processes.collect = (async (...args: Parameters<typeof orig>) => {
      collectCalls++
      const snap = await orig(...args)
      return { ...snap, collectedAt: ++counter }
    }) as unknown as typeof svc.processes.collect
    const flush = async () => {
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    }

    // 首次（无缓存）+ force → 同步重算
    const r1 = (await sut.dispatcher('monitoring.processes', { serverId: 's3', force: true })) as { collectedAt: number }
    expect(r1.collectedAt).toBe(1)
    expect(collectCalls).toBe(1)

    // 缓存命中：立即返回旧值（同一 stamp），证明响应没有等待重新采集；
    // 后台重算在返回前就已并发启动，计数在 flush 后统一核对
    const r2 = (await sut.dispatcher('monitoring.processes', { serverId: 's3', force: false })) as { collectedAt: number }
    expect(r2.collectedAt).toBe(1)
    // 后台重算恰好去重为一次，完成后下一次读取拿到新 stamp
    await flush()
    expect(collectCalls).toBe(2)
    const r3 = (await sut.dispatcher('monitoring.processes', { serverId: 's3', force: false })) as { collectedAt: number }
    expect(r3.collectedAt).toBe(2)
    await flush()
  })

  it('project save → idempotent deploy creation via API', async () => {
    const { repo } = sut
    await repo.putServer({
      schemaVersion: 1, id: 's1', revision: 1, alias: 'web', endpoint: 'r@h:22',
      sshOptions: { host: 'h', port: 22, user: 'r', authKind: 'password', jumpHosts: [], extraOptions: {} },
      credentialRefs: [], configHash: 'h', hostFingerprint: 'fp',
      capabilities: { platform: 'linux', osRelease: 'U', arch: 'x', shell: 'sh', probes: {}, probedAt: 1 },
      createdAt: 1, updatedAt: 1,
    })
    const project = (await sut.dispatcher('projects.save', {
      name: 'shop', repoUrl: 'git@x:y.git', branch: 'main',
      targets: [{ serverId: 's1', codeDir: '/app' }],
    })) as { id: string; targets: Array<{ id: string }> }
    const run1 = (await sut.dispatcher('deploy.create', { requestId: 'req-1', projectId: project.id, targetId: project.targets[0]!.id, kind: 'update' })) as { runId: string }
    const run2 = (await sut.dispatcher('deploy.create', { requestId: 'req-1', projectId: project.id, targetId: project.targets[0]!.id, kind: 'update' })) as { runId: string }
    expect(run1.runId).toBe(run2.runId) // idempotent by client requestId
    // occupancy acquired on create
    expect(repo.getServerExecState('s1')?.occupiedByRunId).toBe(run1.runId)
    // stop from the API releases through the stop path
    await sut.dispatcher('deploy.stop', { runId: run1.runId })
    expect(repo.getDeploymentRun(run1.runId)?.status).toBe('STOPPED')
  })

  it('deploy.redeploy returns a freshly created run (progress runs in background)', async () => {
    const { repo } = sut
    await repo.putServer({
      schemaVersion: 1, id: 's1', revision: 1, alias: 'web', endpoint: 'r@h:22',
      sshOptions: { host: 'h', port: 22, user: 'r', authKind: 'password', jumpHosts: [], extraOptions: {} },
      credentialRefs: [], configHash: 'h', hostFingerprint: 'fp',
      capabilities: { platform: 'linux', osRelease: 'U', arch: 'x', shell: 'sh', probes: {}, probedAt: 1 },
      createdAt: 1, updatedAt: 1,
    })
    const project = (await sut.dispatcher('projects.save', {
      name: 'shop', repoUrl: 'git@x:y.git', branch: 'main', targets: [{ serverId: 's1', codeDir: '/app' }],
    })) as { id: string }
    const run = (await sut.dispatcher('deploy.redeploy', { projectId: project.id })) as { runId: string; status: string; kind: string }
    expect(run.runId).toBeTruthy()
    expect(run.kind).toBe('update')
    // occupancy acquired immediately so a second click cannot double-deploy
    expect(sut.repo.getServerExecState('s1')?.occupiedByRunId).toBe(run.runId)
  })

  it('monitoring.logSourceAdd / discoverLogs / logSourceRemove round-trip', async () => {
    const { repo } = sut
    await repo.putServer({
      schemaVersion: 1, id: 's1', revision: 1, alias: 'web', endpoint: 'r@h:22',
      sshOptions: { host: 'h', port: 22, user: 'r', authKind: 'password', jumpHosts: [], extraOptions: {} },
      credentialRefs: [], configHash: 'h', hostFingerprint: 'fp',
      capabilities: { platform: 'linux', osRelease: 'U', arch: 'x', shell: 'sh', probes: {}, probedAt: 1 },
      createdAt: 1, updatedAt: 1,
    })
    const project = (await sut.dispatcher('projects.save', {
      name: 'shop', repoUrl: 'git@x:y.git', branch: 'main', targets: [{ serverId: 's1', codeDir: '/app' }],
    })) as { id: string }
    const added = (await sut.dispatcher('monitoring.logSourceAdd', { projectId: project.id, path: '/var/log/app/x.log' })) as { sourceId: string; userDefined: boolean; status: string }
    expect(added.userDefined).toBe(true)
    expect(added.status).toBe('missing') // fake transport stat → null
    const discovered = (await sut.dispatcher('monitoring.discoverLogs', { projectId: project.id })) as { registered: number; sources: unknown[] }
    expect(discovered.sources).toBeInstanceOf(Array)
    await sut.dispatcher('monitoring.logSourceRemove', { sourceId: added.sourceId })
    expect(repo.getLogSource(added.sourceId)).toBeUndefined()
  })

  it('monitoring.projectProcesses caches the snapshot and recomputes on force (#3)', async () => {
    const { repo, svc } = sut
    await repo.putServer({
      schemaVersion: 1, id: 's1', revision: 1, alias: 'web', endpoint: 'r@h:22',
      sshOptions: { host: 'h', port: 22, user: 'r', authKind: 'password', jumpHosts: [], extraOptions: {} },
      credentialRefs: [], configHash: 'h', hostFingerprint: 'fp',
      capabilities: { platform: 'linux', osRelease: 'U', arch: 'x', shell: 'sh', probes: {}, probedAt: 1 },
      createdAt: 1, updatedAt: 1,
    })
    const project = (await sut.dispatcher('projects.save', {
      name: 'proc-cache', repoUrl: 'git@x:y.git', branch: 'main', targets: [{ serverId: 's1', codeDir: '/app' }],
    })) as { id: string }
    // stamp each collect with a monotonically increasing collectedAt so a served-
    // from-cache response (older stamp) is distinguishable from a fresh recompute.
    let counter = 0
    const orig = svc.processes.collect.bind(svc.processes)
    svc.processes.collect = (async (...args: Parameters<typeof orig>) => {
      const snap = await orig(...args)
      return { ...snap, collectedAt: ++counter }
    }) as unknown as typeof svc.processes.collect

    // first call forces a synchronous compute → the newest stamp
    const r1 = (await sut.dispatcher('monitoring.projectProcesses', { projectId: project.id, force: true })) as { collectedAt: number }
    expect(r1.collectedAt).toBe(1)

    // non-force with a populated cache → served immediately from cache (SAME stamp),
    // proving the request did not block on a fresh collect of newer data
    const r2 = (await sut.dispatcher('monitoring.projectProcesses', { projectId: project.id, force: false })) as { collectedAt: number }
    expect(r2.collectedAt).toBe(1)

    // force → recomputes synchronously → strictly newer stamp than the cached one
    const r3 = (await sut.dispatcher('monitoring.projectProcesses', { projectId: project.id, force: true })) as { collectedAt: number }
    expect(r3.collectedAt).toBeGreaterThan(r1.collectedAt)
  })
})
