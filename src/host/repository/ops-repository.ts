/**
 * OpsRepository: versioned aggregates over the plugin's domain storage.
 * - per-record schemaVersion with migration + backup; a failed migration
 *   stops write features instead of skipping corrupt records
 * - server occupancy and run checkpoints are atomic record updates
 * - deployment creation is idempotent by requestId
 * - run events carry per-run sequences, clients replay by sequence
 * - 高频可再生观测数据（进程快照/日志片段）写入后按每服务器/每来源条数上限
 *   收敛（另有时间窗口 cleanupExpired）：宿主存储整文件重写，不设上限会把
 *   存储拖到数百 MB、写入拖到秒级
 */
import { z } from 'zod'
import { err, OpsError } from '../../contracts/errors.ts'
import type {
  Alert,
  CredentialRecord,
  DeploymentRun,
  HardwareSample,
  InspectionRun,
  LogFragment,
  LogSource,
  MonitoringPolicy,
  ProcessSnapshot,
  Project,
  RunEvent,
  ScriptVersion,
  Server,
  ServerExecutionState,
  StepRecord,
} from '../../contracts/entities.ts'
import { SCHEMA_VERSION, hardwareSampleSchema as hardwareSampleSchema_ } from '../../contracts/entities.ts'
import type { KvDomain, KvTable } from '../adapters/ports.ts'
import type { ClockPort } from '../adapters/ports.ts'

export const RECORD_NAMES = [
  'servers',
  'credentials',
  'projects',
  'policies',
  'inspectionRuns',
  'processSnapshots',
  'hardwareSamples',
  'logSources',
  'logFragments',
  'alerts',
  'deploymentRuns',
  'stepRecords',
  'scriptVersions',
  'serverExecState',
  'runEvents',
  'requestIndex',
] as const
export type RecordName = (typeof RECORD_NAMES)[number]

/**
 * Every table this repository touches, in the order the storage domain must
 * declare them.
 *
 * The host's `storageDomain.open` builds its table map from the spec's
 * `tables` keys ONLY, and `domain.table(name)` throws "declares no table" for
 * anything absent. Declaring the space with an empty `tables: {}` (as an
 * earlier revision did) therefore made the very first read fail. This is the
 * single source shared by the adapter that opens the domain and the repository
 * that queries it.
 *
 * `backup_*` entries exist because `backup()` writes pre-migration bytes to
 * `backup_<name>`; an undeclared one would throw mid-migration.
 */
export const DOMAIN_TABLE_NAMES: readonly string[] = [
  ...RECORD_NAMES,
  ...RECORD_NAMES.map((name) => `backup_${name}`),
]

/** Wire records: stored as raw JSON so older versions can be read and migrated. */
type RawRecord = { schemaVersion: number } & Record<string, unknown>

export interface Migrator {
  from: number
  to: number
  /** pure record upgrade; throws on records it cannot migrate */
  migrate(record: RawRecord): RawRecord
}

export interface RepositoryOptions {
  domain: KvDomain
  clock: ClockPort
  controllerId: string
  migrations?: Migrator[]
  /** maximum retained history in days for cleanable records */
  retentionDays?: number
}

export class OpsRepository {
  readonly domain: KvDomain
  private readonly clock: ClockPort
  readonly controllerId: string
  private readonly migrations: Migrator[]
  private readonly retentionDays: number
  private _writable = true
  private _loadError: string | null = null

  constructor(opts: RepositoryOptions) {
    this.domain = opts.domain
    this.clock = opts.clock
    this.controllerId = opts.controllerId
    this.migrations = (opts.migrations ?? []).slice().sort((a, b) => a.from - b.from)
    this.retentionDays = opts.retentionDays ?? 30
  }

  /** Load-time migration. Returns number of migrated records. Throws → read-only. */
  async loadAndMigrate(): Promise<number> {
    let migrated = 0
    try {
      for (const name of RECORD_NAMES) {
        const table = this.domain.table<RawRecord>(name)
        for (const [key, raw] of table.entries()) {
          // self-heal: v0.2.0–v0.2.2 wrote hardware samples WITHOUT a
          // schemaVersion, which would otherwise poison the whole repository
          // into read-only. Back the bytes up, drop the record, move on.
          if (name === 'hardwareSamples' && raw && typeof raw === 'object' && typeof (raw as RawRecord).schemaVersion !== 'number') {
            this.backup(name, key, raw)
            await table.delete(key)
            migrated++
            continue
          }
          // self-heal run-event records written before they were versioned: they
          // live alongside the versioned `seq:` cursor in the same table, and an
          // unversioned one would otherwise poison the whole repository into
          // read-only. Backfill the version in place (the event data is intact).
          if (name === 'runEvents' && key.startsWith('evt:') && raw && typeof raw === 'object' && typeof (raw as RawRecord).schemaVersion !== 'number') {
            await table.put(key, { ...(raw as RawRecord), schemaVersion: SCHEMA_VERSION })
            migrated++
            continue
          }
          if (!raw || typeof raw !== 'object' || typeof raw.schemaVersion !== 'number') {
            this.enterReadOnly(`${name}:${key} is not a versioned record`)
            return migrated
          }
          const target = this.migrateRecord(name, key, raw)
          if (target !== raw) {
            await table.put(key, target)
            migrated++
          }
        }
      }
    } catch (e) {
      this.enterReadOnly(e instanceof Error ? e.message : String(e))
    }
    return migrated
  }

  private migrateRecord(name: string, key: string, raw: RawRecord): RawRecord {
    let current = raw
    let changed = false
    for (const m of this.migrations) {
      if (current.schemaVersion === m.from) {
        // keep a backup of the pre-migration bytes before the first upgrade
        this.backup(name, key, current)
        current = m.migrate(current)
        changed = true
      }
    }
    if (current.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `cannot migrate ${name}:${key} from v${current.schemaVersion} to v${SCHEMA_VERSION}`,
      )
    }
    return changed ? current : raw
  }

  private backup(name: string, key: string, record: RawRecord): void {
    const backupTable = this.domain.table<RawRecord>(`backup_${name}`)
    backupTable.put(`${key}@v${record.schemaVersion}`, record)
  }

  private enterReadOnly(reason: string): void {
    this._writable = false
    this._loadError = reason
  }

  get writable(): boolean {
    return this._writable
  }

  get loadError(): string | null {
    return this._loadError
  }

  private assertWritable(): void {
    if (!this._writable) {
      throw err('storage-failed', 'repository', `repository is read-only: ${this._loadError}`)
    }
  }

  private table<T extends RawRecord>(name: RecordName): KvTable<T> {
    return this.domain.table<T>(name)
  }

  /**
   * Atomic read-modify-write that also CREATES the record when it is absent.
   *
   * The backends disagree on how an absent key surfaces: the memory and file
   * adapters reject `update()` with `missing-key: <key>`, but the real DSH
   * host storage throws `domain '...' table '...' has no record '<key>' to
   * update`. Neither the create-vs-update decision nor the recovery can rely
   * on one message shape, so we (1) probe with `get()` to pick the path and
   * (2) treat ANY "no such record" rejection from `update()` as create.
   * A business rejection from `mutate` (e.g. task-occupied) never matches the
   * missing-record pattern and propagates untouched.
   */
  private async mutateOrCreate<T extends RawRecord>(
    name: RecordName,
    key: string,
    create: () => T,
    mutate: (current: T) => T,
  ): Promise<T> {
    const table = this.table<T>(name)
    if (table.get(key) === undefined) {
      const fresh = create()
      await table.put(key, fresh)
      return fresh
    }
    try {
      return await table.update(key, (r) => mutate(r))
    } catch (e) {
      if (isMissingRecordError(e)) {
        const fresh = create()
        await table.put(key, fresh)
        return fresh
      }
      throw e
    }
  }

  // ---------- servers ----------

  async putServer(server: Server): Promise<void> {
    this.assertWritable()
    serverSchema_.parse(server)
    await this.table<RawRecord>('servers').put(server.id, server as unknown as RawRecord)
  }

  getServer(id: string): Server | undefined {
    return this.table<RawRecord>('servers').get(id) as unknown as Server | undefined
  }

  listServers(): Server[] {
    return [...this.table<RawRecord>('servers').entries()]
      .map(([, r]) => r as unknown as Server)
      .sort((a, b) => a.alias.localeCompare(b.alias))
  }

  async updateServer(id: string, fn: (s: Server) => Server): Promise<Server> {
    this.assertWritable()
    const next = await this.table<RawRecord>('servers').update(id, (r) => {
      const s = fn(r as unknown as Server)
      return { ...(s as unknown as RawRecord), revision: (r as unknown as Server).revision + 1, updatedAt: this.clock.now() }
    })
    return next as unknown as Server
  }

  /** Delete a server; fails when projects still reference it. */
  async deleteServer(id: string): Promise<void> {
    this.assertWritable()
    for (const project of this.listProjects()) {
      if (project.targets.some((t) => t.serverId === id)) {
        throw err('conflict', 'repository', `server ${id} is referenced by project ${project.id}; unlink targets first`)
      }
    }
    const exec = this.getServerExecState(id)
    if (exec?.occupiedByRunId && !isTerminalStatus(exec.occupiedByKind)) {
      throw err('task-occupied', 'repository', `server ${id} has an active task; cannot delete`)
    }
    await this.table<RawRecord>('servers').delete(id)
  }

  // ---------- credentials ----------

  async putCredential(record: CredentialRecord): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('credentials').put(record.ref, record as unknown as RawRecord)
  }

  getCredential(ref: string): CredentialRecord | undefined {
    return this.table<RawRecord>('credentials').get(ref) as unknown as CredentialRecord | undefined
  }

  async deleteCredential(ref: string): Promise<boolean> {
    this.assertWritable()
    return this.table<RawRecord>('credentials').delete(ref)
  }

  // ---------- projects ----------

  async putProject(project: Project): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('projects').put(project.id, project as unknown as RawRecord)
  }

  getProject(id: string): Project | undefined {
    return this.table<RawRecord>('projects').get(id) as unknown as Project | undefined
  }

  listProjects(): Project[] {
    return [...this.table<RawRecord>('projects').entries()].map(([, r]) => r as unknown as Project)
  }

  async updateProject(id: string, fn: (p: Project) => Project): Promise<Project> {
    this.assertWritable()
    const next = await this.table<RawRecord>('projects').update(id, (r) => {
      const p = fn(r as unknown as Project)
      return { ...(p as unknown as RawRecord), revision: (r as unknown as Project).revision + 1, updatedAt: this.clock.now() }
    })
    return next as unknown as Project
  }

  async deleteProject(id: string): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('projects').delete(id)
  }

  // ---------- occupancy (server execution state) ----------

  getServerExecState(serverId: string): ServerExecutionState | undefined {
    return this.table<RawRecord>('serverExecState').get(serverId) as unknown as ServerExecutionState | undefined
  }

  /**
   * Acquire exclusive occupancy. Refuses when another run holds the server
   * and the holding record was NOT left by a dead controller awaiting
   * reconcile — occupancy is never auto-released by timeout.
   */
  async acquireServer(serverId: string, runId: string, kind: 'deployment'): Promise<void> {
    this.assertWritable()
    const now = this.clock.now()
    const fresh = (): ServerExecutionState => ({
      schemaVersion: SCHEMA_VERSION,
      serverId,
      occupiedByRunId: runId,
      occupiedByKind: kind,
      controllerId: this.controllerId,
      revision: 1,
      updatedAt: now,
    })
    await this.mutateOrCreate<RawRecord>('serverExecState', serverId, fresh, (r) => {
      const cur = r as unknown as ServerExecutionState | undefined
      if (cur && cur.occupiedByRunId && cur.occupiedByRunId !== runId) {
        throw err(
          'task-occupied',
          'repository',
          `server ${serverId} is occupied by run ${cur.occupiedByRunId}`,
          { details: { occupiedBy: cur.occupiedByRunId } },
        )
      }
      const next: ServerExecutionState = {
        schemaVersion: SCHEMA_VERSION,
        serverId,
        occupiedByRunId: runId,
        occupiedByKind: kind,
        controllerId: this.controllerId,
        revision: (cur?.revision ?? 0) + 1,
        updatedAt: now,
      }
      return next as unknown as RawRecord
    })
  }

  async releaseServer(serverId: string, runId: string): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('serverExecState').update(serverId, (r) => {
      const cur = r as unknown as ServerExecutionState
      if (cur.occupiedByRunId !== runId) {
        throw err('conflict', 'repository', `occupancy of ${serverId} is held by ${cur.occupiedByRunId}, not ${runId}`)
      }
      return {
        ...(cur as unknown as RawRecord),
        occupiedByRunId: null,
        occupiedByKind: 'none',
        revision: cur.revision + 1,
        updatedAt: this.clock.now(),
      }
    })
  }

  // ---------- deployment runs ----------

  /** Idempotent by requestId: repeated calls return the original run. */
  async createDeploymentRun(
    run: DeploymentRun,
  ): Promise<{ run: DeploymentRun; created: boolean }> {
    this.assertWritable()
    const index = this.table<RawRecord>('requestIndex')
    const existing = index.get(run.requestId) as unknown as { runId: string } | undefined
    if (existing) {
      const found = this.getDeploymentRun(existing.runId)
      if (found) return { run: found, created: false }
    }
    await index.put(run.requestId, { schemaVersion: SCHEMA_VERSION, runId: run.runId } as unknown as RawRecord)
    await this.table<RawRecord>('deploymentRuns').put(run.runId, run as unknown as RawRecord)
    return { run, created: true }
  }

  getDeploymentRun(runId: string): DeploymentRun | undefined {
    return this.table<RawRecord>('deploymentRuns').get(runId) as unknown as DeploymentRun | undefined
  }

  findDeploymentRunByRequest(requestId: string): DeploymentRun | undefined {
    const idx = this.table<RawRecord>('requestIndex').get(requestId) as unknown as { runId: string } | undefined
    return idx ? this.getDeploymentRun(idx.runId) : undefined
  }

  async updateDeploymentRun(runId: string, fn: (r: DeploymentRun) => DeploymentRun): Promise<DeploymentRun> {
    this.assertWritable()
    const next = await this.table<RawRecord>('deploymentRuns').update(runId, (r) => {
      const updated = fn(r as unknown as DeploymentRun)
      return { ...(updated as unknown as RawRecord), updatedAt: this.clock.now() }
    })
    return next as unknown as DeploymentRun
  }

  listDeploymentRuns(filter: { projectId?: string } = {}): DeploymentRun[] {
    return [...this.table<RawRecord>('deploymentRuns').entries()]
      .map(([, r]) => r as unknown as DeploymentRun)
      .filter((r) => !filter.projectId || r.projectId === filter.projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Runs that were left unfinished when the process died (recovery scan). */
  listUnfinishedRuns(): DeploymentRun[] {
    return this.listDeploymentRuns().filter((r) => {
      const terminal = r.status === 'SUCCEEDED' || r.status === 'FAILED' || r.status === 'STOPPED'
      return !terminal
    })
  }

  // ---------- step records ----------

  async putStepRecord(step: StepRecord): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('stepRecords').put(step.stepId, step as unknown as RawRecord)
  }

  getStepRecord(stepId: string): StepRecord | undefined {
    return this.table<RawRecord>('stepRecords').get(stepId) as unknown as StepRecord | undefined
  }

  listStepRecords(runId: string): StepRecord[] {
    return [...this.table<RawRecord>('stepRecords').entries()]
      .map(([, r]) => r as unknown as StepRecord)
      .filter((s) => s.runId === runId)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }

  // ---------- run events ----------

  async appendEvent(runId: string, type: string, payload: Record<string, unknown>): Promise<RunEvent> {
    this.assertWritable()
    const seq = await this.mutateOrCreate<{ schemaVersion: number; last: number } & Record<string, unknown>>(
      'runEvents',
      `seq:${runId}`,
      () => ({ schemaVersion: SCHEMA_VERSION, last: 1 }),
      (r) => ({ ...r, last: (r as unknown as { last: number }).last + 1 }),
    )
    const event: RunEvent = {
      runId,
      sequence: (seq as unknown as { last: number }).last,
      timestamp: this.clock.now(),
      type,
      payload,
    }
    // Event records live in the same `runEvents` table as the versioned `seq:`
    // cursor; `loadAndMigrate` rejects ANY unversioned record in a scanned
    // table and flips the repository read-only, which is a fatal boot failure.
    // Store events as versioned records so a replayed/loaded run never poisons
    // the whole repository. The extra field is not part of RunEvent and is
    // stripped by the response schema on the wire.
    await this.table<RawRecord>('runEvents').put(
      `evt:${runId}:${String(event.sequence).padStart(12, '0')}`,
      { schemaVersion: SCHEMA_VERSION, ...event } as unknown as RawRecord,
    )
    return event
  }

  /** Replay events after a sequence (inclusive of afterSequence+1). */
  listEvents(runId: string, afterSequence = 0): RunEvent[] {
    return [...this.table<RawRecord>('runEvents').entries()]
      .map(([k, r]) => ({ key: k, event: r as unknown as RunEvent }))
      .filter(({ key, event }) => key.startsWith(`evt:${runId}:`) && event.sequence > afterSequence)
      .map(({ event }) => event)
      .sort((a, b) => a.sequence - b.sequence)
  }

  // ---------- monitoring records ----------

  async putPolicy(policy: MonitoringPolicy): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('policies').put(policy.id, policy as unknown as RawRecord)
  }

  getPolicy(id: string): MonitoringPolicy | undefined {
    return this.table<RawRecord>('policies').get(id) as unknown as MonitoringPolicy | undefined
  }

  listPolicies(): MonitoringPolicy[] {
    return [...this.table<RawRecord>('policies').entries()].map(([, r]) => r as unknown as MonitoringPolicy)
  }

  async putInspectionRun(run: InspectionRun): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('inspectionRuns').put(run.runId, run as unknown as RawRecord)
  }

  getInspectionRun(runId: string): InspectionRun | undefined {
    return this.table<RawRecord>('inspectionRuns').get(runId) as unknown as InspectionRun | undefined
  }

  listInspectionRuns(filter: { serverId?: string; kind?: string } = {}): InspectionRun[] {
    return [...this.table<RawRecord>('inspectionRuns').entries()]
      .map(([, r]) => r as unknown as InspectionRun)
      .filter((r) => (!filter.serverId || r.serverId === filter.serverId) && (!filter.kind || r.kind === filter.kind))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  async putProcessSnapshot(snapshot: ProcessSnapshot): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('processSnapshots').put(snapshot.snapshotId, snapshot as unknown as RawRecord)
    await this.enforceProcessSnapshotCap(snapshot.serverId)
  }

  /**
   * 写入后把该服务器的快照条数收敛到 MAX_PROCESS_SNAPSHOTS_PER_SERVER 内：
   * 超限时按 collectedAt 最旧优先删除（同刻按 snapshotId 保证确定性）。
   */
  private async enforceProcessSnapshotCap(serverId: string): Promise<void> {
    const table = this.table<RawRecord>('processSnapshots')
    const mine = [...table.entries()]
      .map(([key, r]) => ({ key, s: r as unknown as ProcessSnapshot }))
      .filter(({ s }) => s.serverId === serverId)
      .sort((a, b) => a.s.collectedAt - b.s.collectedAt || a.key.localeCompare(b.key))
    for (let i = 0; i < mine.length - MAX_PROCESS_SNAPSHOTS_PER_SERVER; i++) {
      await table.delete(mine[i]!.key)
    }
  }

  getProcessSnapshot(id: string): ProcessSnapshot | undefined {
    return this.table<RawRecord>('processSnapshots').get(id) as unknown as ProcessSnapshot | undefined
  }

  /** Newest stored snapshot for a server (card aggregation, IMPROVE §4.4). */
  latestProcessSnapshot(serverId: string): ProcessSnapshot | undefined {
    // 单次遍历取最大 collectedAt：此前是全表扫描 + 全量排序，快照表上千条时
    // 每次卡片聚合都在做无谓的 O(n log n) 工作
    let best: ProcessSnapshot | undefined
    for (const [, r] of this.table<RawRecord>('processSnapshots').entries()) {
      const s = r as unknown as ProcessSnapshot
      if (s.serverId !== serverId) continue
      if (!best || s.collectedAt > best.collectedAt) best = s
    }
    return best
  }

  // ---------- hardware samples (trend history, IMPROVE §4.2) ----------

  /**
   * Keyed `${serverId}:${collectedAt}` so a server's samples enumerate in
   * time order. Samples are immutable observations; retention prunes them.
   */
  async putHardwareSample(serverId: string, sample: HardwareSample): Promise<void> {
    this.assertWritable()
    hardwareSampleSchema_.parse(sample)
    // versioned envelope like every other record — a schemaVersion-less write
    // would poison loadAndMigrate and flip the whole repository read-only
    await this.table<RawRecord>('hardwareSamples').put(`${serverId}:${sample.collectedAt}`, { schemaVersion: SCHEMA_VERSION, ...sample, serverId } as unknown as RawRecord)
  }

  listHardwareSamples(serverId: string, sinceMs = 0): HardwareSample[] {
    return [...this.table<RawRecord>('hardwareSamples').entries()]
      .map(([key, r]) => ({ key, sample: r as unknown as (HardwareSample & { serverId?: string }) }))
      .filter(({ key, sample }) => key.startsWith(`${serverId}:`) && (sample.serverId ?? key.slice(0, key.lastIndexOf(':'))) === serverId && sample.collectedAt >= sinceMs)
      .map(({ sample }) => sample)
      .sort((a, b) => a.collectedAt - b.collectedAt)
  }

  async putLogSource(source: LogSource): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('logSources').put(source.sourceId, source as unknown as RawRecord)
  }

  getLogSource(id: string): LogSource | undefined {
    return this.table<RawRecord>('logSources').get(id) as unknown as LogSource | undefined
  }

  listLogSources(filter: { projectId?: string; serverId?: string } = {}): LogSource[] {
    return [...this.table<RawRecord>('logSources').entries()]
      .map(([, r]) => r as unknown as LogSource)
      .filter(
        (s) =>
          (!filter.projectId || s.projectId === filter.projectId) &&
          (!filter.serverId || s.serverId === filter.serverId),
      )
  }

  async updateLogSource(id: string, fn: (s: LogSource) => LogSource): Promise<LogSource> {
    this.assertWritable()
    const next = await this.table<RawRecord>('logSources').update(id, (r) => fn(r as unknown as LogSource) as unknown as RawRecord)
    return next as unknown as LogSource
  }

  async deleteLogSource(id: string): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('logSources').delete(id)
    for (const [fid, f] of this.table<RawRecord>('logFragments').entries()) {
      if ((f as unknown as LogFragment).sourceId === id) await this.table<RawRecord>('logFragments').delete(fid)
    }
  }

  async putLogFragment(fragment: LogFragment): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('logFragments').put(fragment.fragmentId, fragment as unknown as RawRecord)
    await this.enforceLogFragmentCap(fragment.sourceId)
  }

  /**
   * 写入后把该来源的片段条数收敛到 MAX_LOG_FRAGMENTS_PER_SOURCE 内：
   * collectedAt 最旧优先删除（同刻按 fragmentId 保证确定性），
   * listLogFragments 按 startOffset 排序展示，删旧保新不影响阅读连续性。
   */
  private async enforceLogFragmentCap(sourceId: string): Promise<void> {
    const table = this.table<RawRecord>('logFragments')
    const mine = [...table.entries()]
      .map(([key, r]) => ({ key, f: r as unknown as LogFragment }))
      .filter(({ f }) => f.sourceId === sourceId)
      .sort((a, b) => a.f.collectedAt - b.f.collectedAt || a.key.localeCompare(b.key))
    for (let i = 0; i < mine.length - MAX_LOG_FRAGMENTS_PER_SOURCE; i++) {
      await table.delete(mine[i]!.key)
    }
  }

  getLogFragment(id: string): LogFragment | undefined {
    return this.table<RawRecord>('logFragments').get(id) as unknown as LogFragment | undefined
  }

  listLogFragments(sourceId: string): LogFragment[] {
    return [...this.table<RawRecord>('logFragments').entries()]
      .map(([, r]) => r as unknown as LogFragment)
      .filter((f) => f.sourceId === sourceId)
      .sort((a, b) => a.startOffset - b.startOffset)
  }

  async putAlert(alert: Alert): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('alerts').put(alert.alertId, alert as unknown as RawRecord)
  }

  findAlertByDedupe(dedupeKey: string): Alert | undefined {
    for (const [, r] of this.table<RawRecord>('alerts').entries()) {
      const a = r as unknown as Alert
      if (a.dedupeKey === dedupeKey) return a
    }
    return undefined
  }

  listAlerts(filter: { serverId?: string } = {}): Alert[] {
    return [...this.table<RawRecord>('alerts').entries()]
      .map(([, r]) => r as unknown as Alert)
      .filter((a) => !filter.serverId || a.serverId === filter.serverId)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  async putScriptVersion(script: ScriptVersion): Promise<void> {
    this.assertWritable()
    await this.table<RawRecord>('scriptVersions').put(script.scriptVersionId, script as unknown as RawRecord)
  }

  getScriptVersion(id: string): ScriptVersion | undefined {
    return this.table<RawRecord>('scriptVersions').get(id) as unknown as ScriptVersion | undefined
  }

  listScriptVersions(filter: { projectId?: string; targetId?: string } = {}): ScriptVersion[] {
    return [...this.table<RawRecord>('scriptVersions').entries()]
      .map(([, r]) => r as unknown as ScriptVersion)
      .filter(
        (s) =>
          (!filter.projectId || s.projectId === filter.projectId) &&
          (!filter.targetId || s.targetId === filter.targetId),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  // ---------- retention cleanup (S7) ----------

  /**
   * Delete expired cleanable history. Never deletes: configs (servers/
   * credentials/projects/policies), non-terminal runs, or script versions —
   * valid scripts keep their source deployment summaries. Counters of dropped
   * fragments are reported so gaps are visible, not silent.
   */
  async cleanupExpired(): Promise<{ deletedFragments: number; deletedRuns: number; deletedInspections: number; deletedEvents: number; deletedHardwareSamples: number; deletedSnapshots: number }> {
    this.assertWritable()
    const cutoff = this.clock.now() - this.retentionDays * 86_400_000
    const unfinished = new Set(this.listUnfinishedRuns().map((r) => r.runId))
    let deletedFragments = 0
    let deletedEvents = 0
    const events = this.table<RawRecord>('runEvents')
    for (const [key, raw] of events.entries()) {
      const event = raw as unknown as RunEvent
      if (!key.startsWith('evt:')) continue
      if (event.timestamp < cutoff && !unfinished.has(event.runId)) {
        await events.delete(key)
        deletedEvents++
      }
    }
    const fragments = this.table<RawRecord>('logFragments')
    for (const [key, raw] of fragments.entries()) {
      const f = raw as unknown as LogFragment
      if (f.collectedAt < cutoff && (f.analysisState === 'complete' || f.analysisState === 'failed')) {
        await fragments.delete(key)
        deletedFragments++
      }
    }
    // 进程快照与硬件样本同为可再生的观测数据：按保留窗口过期删除。
    // 此前漏掉了 processSnapshots（真实环境 200MB 的直接成因），这里补上。
    const snapshots = this.table<RawRecord>('processSnapshots')
    let deletedSnapshots = 0
    for (const [key, raw] of snapshots.entries()) {
      const s = raw as unknown as ProcessSnapshot
      if (s.collectedAt < cutoff) {
        await snapshots.delete(key)
        deletedSnapshots++
      }
    }
    const inspections = this.table<RawRecord>('inspectionRuns')
    let deletedInspections = 0
    for (const [key, raw] of inspections.entries()) {
      const r = raw as unknown as InspectionRun
      const finished = r.finishedAt ?? Number.MAX_SAFE_INTEGER
      if (finished < cutoff && r.analysisState !== 'running' && r.analysisState !== 'pending') {
        await inspections.delete(key)
        deletedInspections++
      }
    }
    const runs = this.table<RawRecord>('deploymentRuns')
    let deletedRuns = 0
    for (const [key, raw] of runs.entries()) {
      const r = raw as unknown as DeploymentRun
      const finished = r.finishedAt ?? Number.MAX_SAFE_INTEGER
      const terminal = r.status === 'SUCCEEDED' || r.status === 'FAILED' || r.status === 'STOPPED'
      if (terminal && finished < cutoff) {
        await runs.delete(key)
        deletedRuns++
      }
    }
    const hardwareSamples = this.table<RawRecord>('hardwareSamples')
    let deletedHardwareSamples = 0
    for (const [key, raw] of hardwareSamples.entries()) {
      const s = raw as unknown as HardwareSample
      if (s.collectedAt < cutoff) {
        await hardwareSamples.delete(key)
        deletedHardwareSamples++
      }
    }
    return { deletedFragments, deletedRuns, deletedInspections, deletedEvents, deletedHardwareSamples, deletedSnapshots }
  }
}

const isTerminalStatus = (kind: string) => kind === 'none'

/**
 * Does this rejection mean "the record is not there to update"? The memory
 * and file adapters say `missing-key: <key>`; the real DSH host storage says
 * `table '<t>' has no record '<key>' to update`. Both mean the same thing for
 * a create-vs-update decision, so the check is deliberately message-agnostic
 * beyond those two "no record" shapes.
 */
function isMissingRecordError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.message.startsWith('missing-key') || /\bhas no record\b.*to update/.test(e.message) || /\bno record\b.*to update/.test(e.message))
  )
}

const serverSchema_ = z.object({ id: z.string(), revision: z.number().int().min(1) })

/**
 * 进程快照的每服务器条数上限。
 * 动机：宿主存储每次 put 都会全量重写整个存储文件，快照条目没有上限时
 * 会随每次采集线性累积（真实环境已膨胀到 200MB / 4600+ 行），把所有写入
 * 拖到秒级。按条数硬收敛，保证存储体积有界（清理窗口 cleanupExpired 只
 * 管过期时间，兜不住高频采集场景）。
 */
export const MAX_PROCESS_SNAPSHOTS_PER_SERVER = 500

/**
 * 日志片段的每来源条数上限，动机同上（logFragments 曾在 30 天保留窗口内
 * 涨到 100MB+ 且仍会继续增长）。listLogFragments 按 startOffset 排序展示，
 * 删旧保新不影响阅读连续性。
 */
export const MAX_LOG_FRAGMENTS_PER_SOURCE = 300
