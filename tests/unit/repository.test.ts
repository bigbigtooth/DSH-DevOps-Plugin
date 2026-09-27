import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryStorage, MemoryDomain } from '../../src/host/adapters/memory.ts'
import type { KvDomain, KvTable } from '../../src/host/adapters/ports.ts'
import { OpsRepository, MAX_PROCESS_SNAPSHOTS_PER_SERVER, MAX_LOG_FRAGMENTS_PER_SOURCE, type Migrator } from '../../src/host/repository/ops-repository.ts'
import type { Server, ProcessSnapshot, LogFragment } from '../../src/contracts/entities.ts'
import { SCHEMA_VERSION } from '../../src/contracts/entities.ts'

function makeServer(id: string, over: Partial<Server> = {}): Server {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    revision: 1,
    alias: `srv-${id}`,
    endpoint: 'root@h:22',
    sshOptions: { host: 'h', port: 22, user: 'root', authKind: 'password', jumpHosts: [], extraOptions: {} },
    credentialRefs: ['c1'],
    configHash: 'hash',
    hostFingerprint: 'fp',
    capabilities: { platform: 'unknown', osRelease: '', arch: '', shell: '', probes: {}, probedAt: null },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function makeSnapshot(serverId: string, snapshotId: string, collectedAt: number): ProcessSnapshot {
  return { schemaVersion: SCHEMA_VERSION, snapshotId, serverId, scope: 'all', collectedAt, processes: [], limited: false, limitReason: null }
}

function makeFragment(sourceId: string, fragmentId: string, collectedAt: number): LogFragment {
  return { schemaVersion: SCHEMA_VERSION, fragmentId, sourceId, runId: null, startOffset: 0, endOffset: 1, content: 'x', collectedAt, analysisState: 'complete', analysisError: null, readTruncated: false, gapBeforeBytes: 0 }
}

function makeRepo(domain: KvDomain, opts: Partial<ConstructorParameters<typeof OpsRepository>[0]> = {}): OpsRepository {
  return new OpsRepository({ domain, clock: { now: () => 1000 }, controllerId: 'ctrl-test', ...opts })
}

describe('repository (S1)', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = new MemoryStorage()
  })

  it('persists and lists servers', async () => {
    const repo = makeRepo(await storage.openDomain('dsh-devops'))
    await repo.putServer(makeServer('s1'))
    await repo.putServer(makeServer('s2'))
    expect(repo.listServers().map((s) => s.id)).toEqual(['s1', 's2'])
    expect(repo.getServer('s1')?.alias).toBe('srv-s1')
  })

  it('concurrent update() never loses updates (atomic write chain)', async () => {
    const repo = makeRepo(await storage.openDomain('dsh-devops'))
    await repo.putServer(makeServer('s1'))
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => repo.updateServer('s1', (s) => ({ ...s, alias: `update-${i}` }))),
    )
    const final = repo.getServer('s1')!
    expect(final.revision).toBe(26) // every update landed, none lost
  })

  it('deployment creation is idempotent by requestId', async () => {
    const repo = makeRepo(await storage.openDomain('dsh-devops'))
    const run = {
      schemaVersion: SCHEMA_VERSION,
      runId: 'r1',
      requestId: 'req-1',
      projectId: 'p1',
      targetId: 't1',
      kind: 'update' as const,
      status: 'QUEUED' as const,
      stage: '',
      targetSnapshot: { targetId: 't1', serverId: 's1', codeDir: '/app', repoUrl: 'git@x:y.git', branch: 'main', services: [], healthCheck: null, configRevision: 1 },
      targetCommit: null,
      previousCommit: null,
      attempts: 0,
      repairRounds: 0,
      stopRequested: false,
      healthCheckSnapshot: null,
      remoteExecutionIds: [],
      createdAt: 1,
      updatedAt: 1,
      finishedAt: null,
      failureReason: null,
    }
    const first = await repo.createDeploymentRun(run)
    const second = await repo.createDeploymentRun({ ...run, runId: 'r2' }) // same requestId
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.run.runId).toBe('r1')
  })

  it('occupancy: second acquirer is refused; only the holder releases; no auto-release', async () => {
    const repo = makeRepo(await storage.openDomain('dsh-devops'))
    await repo.acquireServer('s1', 'run-a', 'deployment')
    await expect(repo.acquireServer('s1', 'run-b', 'deployment')).rejects.toThrow(/occupied/)
    await repo.releaseServer('s1', 'run-a')
    await repo.acquireServer('s1', 'run-b', 'deployment')
    // wrong releaser refused
    await expect(repo.releaseServer('s1', 'run-a')).rejects.toThrow(/held by/)
    await repo.releaseServer('s1', 'run-b')
  })

  it('server deletion blocked by project references and active tasks', async () => {
    const repo = makeRepo(await storage.openDomain('dsh-devops'))
    await repo.putServer(makeServer('s1'))
    await repo.acquireServer('s1', 'run-a', 'deployment')
    await expect(repo.deleteServer('s1')).rejects.toThrow(/active task/)
    await repo.releaseServer('s1', 'run-a')
    await repo.putProject({
      schemaVersion: SCHEMA_VERSION, id: 'p1', revision: 1, name: 'p', repoUrl: 'git@x:y.git', branch: 'main',
      targets: [{ schemaVersion: SCHEMA_VERSION, id: 't1', serverId: 's1', codeDir: '/app', services: [], gitCredentialRef: null, sudoCredentialRef: null, healthCheck: null, createdAt: 1, updatedAt: 1 }],
      createdAt: 1, updatedAt: 1,
    })
    await expect(repo.deleteServer('s1')).rejects.toThrow(/referenced by project/)
    await repo.deleteProject('p1')
    await expect(repo.deleteServer('s1')).resolves.toBeUndefined()
  })

  it('run events carry strictly increasing per-run sequences and replay by cursor', async () => {
    const repo = makeRepo(await storage.openDomain('dsh-devops'))
    const e1 = await repo.appendEvent('r1', 'START', {})
    const e2 = await repo.appendEvent('r1', 'STAGE', { stage: 'PULL' })
    const e3 = await repo.appendEvent('r1', 'SUCCEED', {})
    await repo.appendEvent('r2', 'START', {}) // other run
    expect([e1.sequence, e2.sequence, e3.sequence]).toEqual([1, 2, 3])
    expect(repo.listEvents('r1', 1).map((e) => e.type)).toEqual(['STAGE', 'SUCCEED'])
    expect(repo.listEvents('r2')).toHaveLength(1)
  })

  it('run-event records are versioned so a reload never poisons the repository read-only', async () => {
    const domain = await storage.openDomain('dsh-devops')
    const repo = makeRepo(domain)
    await repo.appendEvent('r7', 'START', {})
    await repo.appendEvent('r7', 'STAGE', { stage: 'PULL' })
    // every evt: record must carry a schemaVersion after write
    for (const [k, r] of domain.table('runEvents').entries()) {
      if (k.startsWith('evt:')) expect((r as Record<string, unknown>).schemaVersion).toBe(SCHEMA_VERSION)
    }
    // a fresh repository over the same store loads clean and stays writable
    const repo2 = makeRepo(domain)
    await repo2.loadAndMigrate()
    expect(repo2.writable).toBe(true)
    expect(repo2.listEvents('r7').map((e) => e.type)).toEqual(['START', 'STAGE'])
  })

  it('an unversioned legacy run-event record self-heals on load instead of flipping read-only', async () => {
    const domain = await storage.openDomain('dsh-devops')
    // simulate records written by the pre-fix build (events without schemaVersion)
    await domain.table('runEvents').put('seq:r8', { schemaVersion: SCHEMA_VERSION, last: 1 })
    await domain.table('runEvents').put('evt:r8:000000000001', { runId: 'r8', sequence: 1, timestamp: 1, type: 'START', payload: {} })
    const repo = makeRepo(domain)
    const migrated = await repo.loadAndMigrate()
    expect(repo.writable).toBe(true) // self-healed, not poisoned
    expect(migrated).toBeGreaterThanOrEqual(1)
    const healed = domain.table('runEvents').get('evt:r8:000000000001') as Record<string, unknown>
    expect(healed.schemaVersion).toBe(SCHEMA_VERSION)
    expect(healed.runId).toBe('r8')
    expect(repo.listEvents('r8').map((e) => e.type)).toEqual(['START'])
  })

  it('cleanup keeps configs/scripts/unfinished runs; drops expired cleanable history', async () => {
    const now = 1_800_000_000_000
    let t = now
    const repo = new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock: { now: () => t }, controllerId: 'c', retentionDays: 30 })
    await repo.putInspectionRun({
      schemaVersion: SCHEMA_VERSION, runId: 'old', serverId: 's', kind: 'hardware', snapshotId: null,
      startedAt: now - 40 * 86_400_000, finishedAt: now - 40 * 86_400_000, analysisState: 'complete',
      coverageAnalyzed: 1, coverageTotal: 1, findings: [], evidenceRefs: [], error: null, trigger: 'scheduled',
    })
    await repo.putInspectionRun({
      schemaVersion: SCHEMA_VERSION, runId: 'new', serverId: 's', kind: 'hardware', snapshotId: null,
      startedAt: now, finishedAt: now, analysisState: 'complete', coverageAnalyzed: 1, coverageTotal: 1, findings: [], evidenceRefs: [], error: null, trigger: 'scheduled',
    })
    const script = {
      schemaVersion: SCHEMA_VERSION, scriptVersionId: 'sv1', projectId: 'p', targetId: 't', stage: 'BUILD',
      interpreter: 'sh', workDir: '/app', content: '#!/bin/sh\n', contentHash: 'h', params: [], envRefs: [],
      precondition: '', postcondition: '', status: 'verified' as const,
      validation: { mode: 'test-target' as const, runId: null, validatedAt: now, result: 'passed' as const, failureReason: null },
      sourceDeployment: { runId: 'old-run', commit: 'c0', summary: 's' },
      fingerprints: { branch: 'main', interpreter: 'sh', serviceConfig: '' },
      invalidationReason: null, createdAt: now - 40 * 86_400_000, updatedAt: now - 40 * 86_400_000,
    }
    await repo.putScriptVersion(script) // older than retention — must SURVIVE
    const result = await repo.cleanupExpired()
    expect(result.deletedInspections).toBe(1)
    expect(repo.getInspectionRun('old')).toBeUndefined()
    expect(repo.getInspectionRun('new')).toBeDefined()
    expect(repo.getScriptVersion('sv1')).toBeDefined() // day-31 traceability
  })

  it('cleanupExpired also drops expired process snapshots (deletedSnapshots)', async () => {
    const now = 1_800_000_000_000
    let t = now
    const repo = new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock: { now: () => t }, controllerId: 'c', retentionDays: 30 })
    await repo.putProcessSnapshot(makeSnapshot('s1', 'old_snap', now - 40 * 86_400_000))
    await repo.putProcessSnapshot(makeSnapshot('s1', 'new_snap', now))
    const result = await repo.cleanupExpired()
    expect(result.deletedSnapshots).toBe(1)
    expect(repo.getProcessSnapshot('old_snap')).toBeUndefined()
    expect(repo.getProcessSnapshot('new_snap')).toBeDefined()
  })

  it('process snapshots converge to the per-server cap; oldest dropped first, other servers untouched', async () => {
    const repo = makeRepo(await storage.openDomain('dsh-devops'))
    // 宿主存储整文件重写：无上限时快照表会随采集线性膨胀到数百 MB
    const n = MAX_PROCESS_SNAPSHOTS_PER_SERVER + 3
    for (let i = 0; i < n; i++) {
      await repo.putProcessSnapshot(makeSnapshot('s1', `snap_${String(i).padStart(4, '0')}`, 1000 + i))
    }
    await repo.putProcessSnapshot(makeSnapshot('s2', 'snap_other', 1))
    const newest = `snap_${String(n - 1).padStart(4, '0')}`
    expect(repo.domain.table('processSnapshots').size).toBe(MAX_PROCESS_SNAPSHOTS_PER_SERVER + 1)
    expect(repo.getProcessSnapshot('snap_0000')).toBeUndefined() // 最旧的 3 条被删
    expect(repo.getProcessSnapshot('snap_0002')).toBeUndefined()
    expect(repo.getProcessSnapshot('snap_0003')).toBeDefined() // 上限内的最旧仍在
    expect(repo.getProcessSnapshot(newest)).toBeDefined() // 最新保留
    expect(repo.latestProcessSnapshot('s1')?.snapshotId).toBe(newest)
    expect(repo.getProcessSnapshot('snap_other')).toBeDefined() // 其他服务器不受影响
  })

  it('log fragments converge to the per-source cap; oldest collectedAt wins the cut (ties by fragmentId)', async () => {
    const repo = makeRepo(await storage.openDomain('dsh-devops'))
    const n = MAX_LOG_FRAGMENTS_PER_SOURCE + 2
    for (let i = 0; i < n; i++) {
      await repo.putLogFragment(makeFragment('src1', `f${String(i).padStart(4, '0')}`, 1000 + i))
    }
    await repo.putLogFragment(makeFragment('src2', 'f_other', 1))
    expect(repo.listLogFragments('src1')).toHaveLength(MAX_LOG_FRAGMENTS_PER_SOURCE)
    expect(repo.getLogFragment('f0000')).toBeUndefined() // collectedAt 最旧被删
    expect(repo.getLogFragment('f0001')).toBeUndefined()
    expect(repo.getLogFragment(`f${String(n - 1).padStart(4, '0')}`)).toBeDefined()
    expect(repo.getLogFragment('f_other')).toBeDefined() // 其他来源不受影响

    // collectedAt 全部相同时按 fragmentId 删最旧，保证删减是确定性的
    for (let i = 0; i < MAX_LOG_FRAGMENTS_PER_SOURCE + 2; i++) {
      await repo.putLogFragment(makeFragment('src3', `g${String(i).padStart(4, '0')}`, 7))
    }
    expect(repo.listLogFragments('src3')).toHaveLength(MAX_LOG_FRAGMENTS_PER_SOURCE)
    expect(repo.getLogFragment('g0000')).toBeUndefined()
    expect(repo.getLogFragment('g0001')).toBeUndefined()
    expect(repo.getLogFragment(`g${String(MAX_LOG_FRAGMENTS_PER_SOURCE + 1).padStart(4, '0')}`)).toBeDefined()
  })

  it('migration upgrades records with backup; unmigratable record → read-only, no skipping', async () => {
    const domain = await storage.openDomain('dsh-devops')
    const migrations: Migrator[] = [
      { from: 0, to: SCHEMA_VERSION, migrate: (r) => ({ ...r, schemaVersion: SCHEMA_VERSION, addedField: 'migrated' }) },
    ]
    // seed a pre-v1 record directly
    await domain.table('servers').put('old-srv', { schemaVersion: 0, id: 'old-srv' })
    const repo = new OpsRepository({ domain, clock: { now: () => 1 }, controllerId: 'c', migrations })
    const count = await repo.loadAndMigrate()
    expect(count).toBe(1)
    const migrated = repo.getServer('old-srv') as unknown as Record<string, unknown>
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
    expect(migrated.addedField).toBe('migrated')
    // backup retained
    const backup = domain.table('backup_servers').get('old-srv@v0') as Record<string, unknown> | undefined
    expect(backup?.schemaVersion).toBe(0)
  })

  it('a record beyond the migration chain stops write features', async () => {
    const domain = await storage.openDomain('dsh-devops')
    await domain.table('servers').put('future', { schemaVersion: 99, id: 'future' })
    const repo = new OpsRepository({ domain, clock: { now: () => 1 }, controllerId: 'c' })
    await repo.loadAndMigrate()
    expect(repo.writable).toBe(false)
    expect(repo.loadError).toMatch(/cannot migrate/)
    await expect(repo.putServer(makeServer('x'))).rejects.toThrow(/read-only/)
  })

  it('memory domain serializes writes across tables', async () => {
    const domain: MemoryDomain = (await storage.openDomain('dsh-devops')) as MemoryDomain
    await Promise.all([
      domain.table('servers').put('a', { v: 1 }),
      domain.table('credentials').put('b', { v: 2 }),
      domain.table('servers').put('c', { v: 3 }),
    ])
    expect(domain.table('servers').size).toBe(2)
    expect(domain.table('credentials').size).toBe(1)
    expect(domain.changeCount).toBe(3)
    await domain.close()
    expect(() => domain.table('servers')).toThrow(/closed/)
  })

  it('hardware samples round-trip and a v0.2.x schemaVersion-less sample self-heals instead of poisoning the repo', async () => {
    const domain = await storage.openDomain('dsh-devops')
    // simulate the 0.2.0–0.2.2 bug: an unversioned hardware sample on disk
    await domain.table('hardwareSamples').put('s1:100', {
      cpuPercent: null, cpuWindowMs: 300, cpuCores: 2,
      memoryTotalBytes: null, memoryUsedBytes: null, swapTotalBytes: null, swapUsedBytes: null,
      netRecvBytesPerSec: 2855.0, netSentBytesPerSec: 6072.0,
      mounts: [], collectedAt: 100, unitNotes: '', serverId: 's1',
    })
    const repo = makeRepo(domain)
    const migrated = await repo.loadAndMigrate()
    expect(migrated).toBeGreaterThanOrEqual(1)
    expect(repo.writable).toBe(true) // the poisoned record did NOT flip read-only
    expect(repo.listHardwareSamples('s1')).toHaveLength(0) // dropped

    // new writes are versioned and round-trip
    await repo.putHardwareSample('s1', {
      cpuPercent: 23.4, cpuWindowMs: 300, cpuCores: 8,
      memoryTotalBytes: 16000, memoryUsedBytes: 8000, swapTotalBytes: null, swapUsedBytes: null,
      netRecvBytesPerSec: 1024, netSentBytesPerSec: 512,
      mounts: [{ path: '/', totalBytes: 1000, usedBytes: 100 }],
      collectedAt: 2000, unitNotes: '',
    })
    expect(repo.listHardwareSamples('s1')).toHaveLength(1)
    expect(repo.listHardwareSamples('s1')[0]!.cpuPercent).toBe(23.4)
    expect(repo.listHardwareSamples('s1', 1500)).toHaveLength(1)
    expect(repo.listHardwareSamples('s1', 3000)).toHaveLength(0)
  })
})

/**
 * Reproduce the real DSH host storage contract that broke the deploy button:
 * its tables reject `update()` on an absent key with
 *   domain '<d>' table '<t>' has no record '<k>' to update
 * instead of the memory/file adapter's `missing-key: <k>`. acquireServer and
 * appendEvent must still CREATE the record instead of propagating the error.
 */
class HostLikeTable<V> implements KvTable<V> {
  private map = new Map<string, V>()
  get(key: string): V | undefined {
    return this.map.get(key)
  }
  entries(): IterableIterator<[string, V]> {
    return this.map.entries()
  }
  keys(): IterableIterator<string> {
    return this.map.keys()
  }
  get size(): number {
    return this.map.size
  }
  async put(key: string, value: V): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.map.get(key)
    if (current === undefined) {
      throw new Error(`domain 'dsh_devops' table 'x' has no record '${key}' to update`)
    }
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
}

class HostLikeDomain implements KvDomain {
  private tables = new Map<string, KvTable<unknown>>()
  table<V = unknown>(name: string): KvTable<V> {
    let t = this.tables.get(name)
    if (!t) {
      t = new HostLikeTable<V>()
      this.tables.set(name, t)
    }
    return t as KvTable<V>
  }
  async close(): Promise<void> {}
}

describe('repository robustness to the real host missing-record error (#1)', () => {
  const clock = { now: () => 1000 }

  it('acquireServer creates the exec-state row when update reports host-style missing record', async () => {
    const repo = new OpsRepository({ domain: new HostLikeDomain(), clock, controllerId: 'ctrl' })
    await repo.acquireServer('srv_bcf3ad462514b148', 'run-1', 'deployment')
    expect(repo.getServerExecState('srv_bcf3ad462514b148')?.occupiedByRunId).toBe('run-1')
    // re-acquire by the same run mutates the now-present row (revision bumps)
    await repo.acquireServer('srv_bcf3ad462514b148', 'run-1', 'deployment')
    expect(repo.getServerExecState('srv_bcf3ad462514b148')?.occupiedByRunId).toBe('run-1')
    // a different run is still refused (business rejection is not masked)
    await expect(repo.acquireServer('srv_bcf3ad462514b148', 'run-2', 'deployment')).rejects.toThrow(/occupied/)
  })

  it('appendEvent seeds the sequence cursor and increments it across host-style misses', async () => {
    const repo = new OpsRepository({ domain: new HostLikeDomain(), clock, controllerId: 'ctrl' })
    const e1 = await repo.appendEvent('run-9', 'START', {})
    const e2 = await repo.appendEvent('run-9', 'STAGE', { stage: 'PULL' })
    const e3 = await repo.appendEvent('run-9', 'SUCCEED', {})
    expect([e1.sequence, e2.sequence, e3.sequence]).toEqual([1, 2, 3])
    expect(repo.listEvents('run-9').map((e) => e.type)).toEqual(['START', 'STAGE', 'SUCCEED'])
  })
})
