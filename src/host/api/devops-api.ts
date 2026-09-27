/**
 * Transport-independent API dispatcher: validates every request/response
 * against the shared contract and maps errors to the Remote-style envelope.
 * The DSH connection adapter and the tests both drive this one function.
 */
import { apiEndpoints, type ApiEndpointName } from '../../contracts/api.ts'
import { OpsError, type OpsErrorShape } from '../../contracts/errors.ts'
import type { ServerService } from '../servers/server-service.ts'
import type { OpsRepository } from '../repository/ops-repository.ts'
import type { HardwareCollector, ProcessCollector, ResourceProbe } from '../probes/collector.ts'
import type { InspectionService } from '../agents/inspection-service.ts'
import type { LogService } from '../logs/log-service.ts'
import { buildLogTailView } from '../logs/log-tail.ts'
import { candidatesFromProcessCommands } from '../logs/discovery.ts'
import { classifyProcesses } from '../probes/classify.ts'
import { defaultPolicy as sharedDefaultPolicy } from '../scheduler/policy-defaults.ts'
import type { DeploymentService } from '../deployment/deployment-service.ts'
import type { ScriptService } from '../scripts/script-service.ts'
import type { ModelPort } from '../adapters/ports.ts'
import type { Server, TargetSpec, Project } from '../../contracts/entities.ts'
import { SCHEMA_VERSION } from '../../contracts/entities.ts'
import { newId } from '../../contracts/ids.ts'
import { projectEditableSchema } from '../../contracts/api.ts'

export interface DevOpsServices {
  repo: OpsRepository
  servers: ServerService
  hardware: HardwareCollector
  processes: ProcessCollector
  resources: ResourceProbe
  inspection: InspectionService
  logs: LogService
  deployment: DeploymentService
  scripts: ScriptService
  model: ModelPort
  /** 宿主桥接：AI 模型（modelRef）的实时读写与 provider/model 目录枚举。 */
  settingsBridge?: {
    getModelRef(): string | null
    setModelRef(ref: string | null): Promise<{ persisted: boolean }>
    listModelChoices(): Promise<string[]>
  }
}

export type ApiDispatcher = (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>

export function createApiDispatcher(svc: DevOpsServices): ApiDispatcher {
  return async (endpoint: string, payload: unknown): Promise<unknown> => {
    const spec = (apiEndpoints as Record<string, { request: { parse(input: unknown): unknown }; response: { parse(input: unknown): unknown } }>)[endpoint]
    if (!spec) {
      throw new OpsError({ code: 'not-found', message: `unknown endpoint ${endpoint}`, scope: 'api', retryable: false })
    }
    const args = spec.request.parse(payload ?? {})
    const value = await dispatch(svc, endpoint, args as never)
    return spec.response.parse(value)
  }
}

/** Envelope wrapper for connection adapters: never throws across the wire. */
export function createApiHandler(svc: DevOpsServices) {
  const dispatcher = createApiDispatcher(svc)
  return async (endpoint: string, payload: unknown, _signal?: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false; error: OpsErrorShape }> => {
    try {
      const value = await dispatcher(endpoint, payload)
      return { ok: true, value }
    } catch (e) {
      return { ok: false, error: wireError(e) }
    }
  }
}

/**
 * The browser Connection client (`dsh-client-connection` parseConnectionResponse)
 * REQUIRES error.details to be a record — an error without it fails envelope
 * parsing and surfaces as `carrier: invalid server-response result`, hiding the
 * real message. `details` is therefore always present on the wire.
 */
function wireError(e: unknown): OpsErrorShape {
  if (OpsError.is(e)) {
    const shape = e.toJSON()
    return shape.details ? shape : { ...shape, details: {} }
  }
  return {
    code: 'internal',
    message: e instanceof Error ? e.message : String(e),
    scope: 'api',
    retryable: false,
    details: {},
  }
}

async function dispatch(svc: DevOpsServices, endpoint: string, args: any): Promise<unknown> {
  const repo = svc.repo
  switch (endpoint as ApiEndpointName) {
    // ---------- servers ----------
    case 'servers.list': {
      return repo.listServers().map((s) => serverDto(s, repo))
    }
    case 'servers.get': {
      const s = repo.getServer(args.serverId)
      if (!s) throw new OpsError({ code: 'not-found', message: 'server not found', scope: 'api', retryable: false })
      return serverDto(s, repo)
    }
    case 'servers.verify': {
      return svc.servers.verify(args)
    }
    case 'servers.add': {
      const server = await svc.servers.addFromTicket(args, args.ticket, args.confirmedFingerprint)
      return serverDto(server, repo)
    }
    case 'servers.update': {
      const server = await svc.servers.updateServer(args.serverId, args, args.ticket ?? null, args.confirmedFingerprint ?? null)
      return serverDto(server, repo)
    }
    case 'servers.remove': {
      await svc.servers.removeServer(args.serverId)
      return { removed: true }
    }
    case 'servers.overview': {
      // read-only over the repository: card polling never triggers SSH
      return repo.listServers().map((server) => {
        const samples = repo.listHardwareSamples(server.id)
        const alerts = repo.listAlerts({ serverId: server.id })
        return {
          server: serverDto(server, repo),
          latestSample: samples.at(-1) ?? null,
          lastCollectedAt: samples.at(-1)?.collectedAt ?? null,
          alertCount: {
            critical: alerts.filter((a) => a.severity === 'critical').length,
            warning: alerts.filter((a) => a.severity === 'warning').length,
          },
        }
      })
    }
    // ---------- monitoring ----------
    case 'monitoring.hardware': {
      const server = requireServer(repo, args.serverId)
      const run = repo.listInspectionRuns({ serverId: args.serverId, kind: 'hardware' })[0]
      // 采集前回填系统探测：老数据落库是 unknown，借一次只读 probe 补齐，
      // 之后卡片右上角就能显示真实 OS 名+版本号
      const caps = await svc.servers.ensureProbedCapabilities(args.serverId).catch(() => null)
      const platform = caps?.platform ?? ((server.capabilities.platform as 'linux' | 'macos' | 'unknown') ?? 'unknown')
      try {
        const { sample } = await svc.hardware.collect(args.serverId, platform)
        await svc.repo.putHardwareSample(args.serverId, sample)
        return { sample, collectedAt: sample.collectedAt, analysisState: 'complete' }
      } catch (e) {
        return {
          sample: null,
          collectedAt: run?.startedAt ?? null,
          analysisState: e instanceof OpsError && e.code === 'model-unavailable' ? 'unavailable' : 'failed',
        }
      }
    }
    case 'monitoring.processes': {
      return await getCachedServerProcesses(svc, args.serverId, args.force === true)
    }
    case 'monitoring.history': {
      requireServer(repo, args.serverId)
      const since = Date.now() - args.rangeMinutes * 60_000
      const samples = repo.listHardwareSamples(args.serverId, since)
      return { samples: downsampleHardware(samples, 300) }
    }
    case 'monitoring.logs': {
      const sources = repo.listLogSources({ projectId: args.projectId, serverId: args.serverId })
      const alerts = repo.listAlerts({ serverId: args.serverId })
      return { sources, alerts }
    }
    case 'monitoring.discoverLogs': {
      const project = requireProject(repo, args.projectId)
      const target = project.targets[0]
      if (!target) throw new OpsError({ code: 'not-found', message: 'project has no target', scope: 'api', retryable: false })
      const { registered, sources } = await svc.logs.discoverProject({ projectId: project.id, serverId: target.serverId, codeDir: target.codeDir })
      return { registered, sources }
    }
    case 'monitoring.logSourceAdd': {
      const project = requireProject(repo, args.projectId)
      const serverId = args.serverId ?? project.targets[0]?.serverId
      if (!serverId) throw new OpsError({ code: 'not-found', message: 'project has no target server', scope: 'api', retryable: false })
      return await svc.logs.addManual({ projectId: project.id, serverId, path: args.path, service: args.service })
    }
    case 'monitoring.logSourceRemove': {
      await repo.deleteLogSource(args.sourceId)
      return { removed: true }
    }
    case 'monitoring.logTail': {
      const all = repo.listLogSources({ projectId: args.projectId, serverId: args.serverId })
      const sources = args.sourceId ? all.filter((s) => s.sourceId === args.sourceId) : all
      const now = Date.now()
      const fragmentsBySource = new Map<string, ReturnType<OpsRepository['listLogFragments']>>()
      for (const source of sources) {
        fragmentsBySource.set(source.sourceId, repo.listLogFragments(source.sourceId))
      }
      const { stats, tail } = buildLogTailView(sources, fragmentsBySource, now, args.limitLines)
      // fresh stat for the card display + live preview (bounded to the filtered set)
      const meta: Array<{ sourceId: string; sizeBytes: number | null; lastModifiedAt: number | null }> = []
      for (const source of sources.slice(0, 20)) {
        if (source.status !== 'active') {
          meta.push({ sourceId: source.sourceId, sizeBytes: source.sizeBytes, lastModifiedAt: source.lastModifiedAt })
          continue
        }
        const st = await svc.resources.statPath(source.serverId, source.path).catch(() => null)
        meta.push({ sourceId: source.sourceId, sizeBytes: st?.size ?? source.sizeBytes, lastModifiedAt: st?.mtimeMs ?? source.lastModifiedAt })
      }
      return { sources, alerts: repo.listAlerts({ serverId: args.serverId }), stats, tail, meta }
    }
    case 'monitoring.projectProcesses': {
      return await getCachedProjectProcesses(svc, args.projectId, args.force === true)
    }
    case 'monitoring.inspect': {
      const server = requireServer(repo, args.serverId)
      void server
      if (args.kind === 'hardware') {
        const platform = (server.capabilities.platform as 'linux' | 'macos' | 'unknown') ?? 'unknown'
        const now = Date.now()
        const { sample } = await svc.hardware.collect(args.serverId, platform)
        await svc.repo.putHardwareSample(args.serverId, sample)
        const runId = `ins_h_${now.toString(36)}`
        await repo.putInspectionRun({
          schemaVersion: SCHEMA_VERSION,
          runId,
          serverId: args.serverId,
          kind: 'hardware',
          snapshotId: null,
          startedAt: now,
          finishedAt: now,
          analysisState: 'complete',
          coverageAnalyzed: 1,
          coverageTotal: 1,
          findings: [],
          evidenceRefs: [JSON.stringify(sample).slice(0, 100)],
          error: null,
          trigger: 'manual',
        })
        return { runId }
      }
      if (args.kind === 'process') {
        const platform = (server.capabilities.platform as 'linux' | 'macos' | 'unknown') ?? 'unknown'
        const snapshot = await svc.processes.collect(args.serverId, 'all', null, platform)
        const policy = repo.getPolicy(`${args.serverId}:process`) ?? null
        const run = await svc.inspection.runInspection(args.serverId, snapshot, policy, 'manual')
        return { runId: run.runId }
      }
      // logs: check all sources of the server
      const sources = repo.listLogSources({ serverId: args.serverId })
      const runIds: string[] = []
      for (const source of sources) {
        const result = await svc.logs.checkSource(source, repo.getPolicy(`${args.serverId}:logs`) ?? null)
        runIds.push(result.runId)
      }
      return { runId: runIds[0] ?? `logs_empty_${Date.now().toString(36)}` }
    }
    case 'monitoring.inspections': {
      return repo.listInspectionRuns({ serverId: args.serverId }).slice(0, args.limit)
    }
    case 'monitoring.alerts': {
      return repo.listAlerts({ serverId: args.serverId })
    }
    case 'monitoring.policy.get': {
      const id = `${args.serverId}:${args.kind}`
      const existing = repo.getPolicy(id)
      if (existing) return existing
      const policy = defaultPolicy(args.serverId, args.kind)
      await repo.putPolicy(policy)
      return policy
    }
    case 'monitoring.policy.update': {
      await repo.putPolicy(args)
      return args
    }
    // ---------- projects ----------
    case 'projects.list': {
      return repo.listProjects()
    }
    case 'projects.overview': {
      // read-only: cards aggregate repo state; service health uses the latest stored snapshot.
      // Mirrors computeProjectProcesses so the card agrees with the 服务 tab:
      // cwd-prefix membership (the old private-only classifier excluded code
      // under /opt & friends — system-path prefixes — and showed 0/N), plus
      // the 进程 fallback when a target registers no services (projects from
      // the plain create form have empty services and used to show 0/0).
      return repo.listProjects().map((project) => {
        const runs = repo.listDeploymentRuns({ projectId: project.id })
        const lastRun = runs[0] ?? null
        let running = 0
        let total = 0
        const aggregate = { cpuPercent: null as number | null, rssBytes: null as number | null }
        for (const target of project.targets) {
          const snapshot = repo.latestProcessSnapshot(target.serverId)
          if (!snapshot) continue
          const dir = target.codeDir.endsWith('/') ? target.codeDir : target.codeDir + '/'
          const members = snapshot.processes.filter((p) => p.cwd !== null && (p.cwd === target.codeDir || p.cwd.startsWith(dir)))
          const specs = target.services.length ? target.services : [{ name: '进程', manager: 'unknown' as const, managerId: '' }]
          for (const spec of specs) {
            total++
            if (members.some((p) => matchService(p, spec.name, spec.managerId))) running++
          }
          const sumCpu = members.reduce((a, p) => a + (p.cpuPercent ?? 0), 0)
          const sumRss = members.reduce((a, p) => a + (p.rssBytes ?? 0), 0)
          aggregate.cpuPercent = sumCpu > 0 ? sumCpu : aggregate.cpuPercent
          aggregate.rssBytes = sumRss > 0 ? sumRss : aggregate.rssBytes
        }
        const alerts = repo.listAlerts().filter((a) => a.projectId === project.id)
        return {
          project,
          lastRun,
          serviceHealth: { running, total },
          aggregate,
          alertCount: {
            critical: alerts.filter((a) => a.severity === 'critical').length,
            warning: alerts.filter((a) => a.severity === 'warning').length,
          },
        }
      })
    }
    case 'projects.save': {
      const editable = projectEditableSchema.parse(args)
      const now = Date.now()
      const existing = args.id ? repo.getProject(args.id) : undefined
      const targets: TargetSpec[] = editable.targets.map((t) => ({
        schemaVersion: SCHEMA_VERSION,
        id: newId('tgt'),
        serverId: t.serverId,
        codeDir: t.codeDir,
        services: t.services,
        gitCredentialRef: t.gitCredentialRef,
        sudoCredentialRef: t.sudoCredentialRef,
        healthCheck: t.healthCheck,
        createdAt: now,
        updatedAt: now,
      }))
      const project: Project = existing
        ? {
            ...existing,
            revision: existing.revision + 1,
            name: editable.name,
            repoUrl: editable.repoUrl,
            branch: editable.branch,
            targets,
            updatedAt: now,
          }
        : {
            schemaVersion: SCHEMA_VERSION,
            id: newId('prj'),
            revision: 1,
            name: editable.name,
            repoUrl: editable.repoUrl,
            branch: editable.branch,
            targets,
            createdAt: now,
            updatedAt: now,
          }
      await repo.putProject(project)
      return project
    }
    case 'projects.remove': {
      await repo.deleteProject(args.projectId)
      return { removed: true }
    }
    // ---------- deployment ----------
    case 'deploy.create': {
      const project = requireProject(repo, args.projectId)
      const target = project.targets.find((t) => t.id === args.targetId)
      if (!target) throw new OpsError({ code: 'not-found', message: 'target not found', scope: 'api', retryable: false })
      const { run, created } = await svc.deployment.createRun(args.requestId, project, target, args.kind)
      // execute: the run is dispatched fire-and-forget exactly like
      // deploy.redeploy; progress flows through deploy.get/list/events.
      // Without it the run is a bare record nothing will ever execute.
      if (created && args.execute) {
        const pipeline = args.kind === 'first-deploy' ? svc.deployment.runFirstDeploy(run.runId) : svc.deployment.runUpdate(run.runId)
        void pipeline.catch(() => undefined)
      }
      return run
    }
    case 'deploy.redeploy': {
      const project = requireProject(repo, args.projectId)
      const target = args.targetId ? project.targets.find((t) => t.id === args.targetId) : project.targets[0]
      if (!target) throw new OpsError({ code: 'not-found', message: 'target not found', scope: 'api', retryable: false })
      const requestId = args.requestId ?? `redeploy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const { run, created } = await svc.deployment.createRun(requestId, project, target, 'update')
      // fire-and-forget: the browser never blocks on multi-minute SSH; it polls
      // deploy.list / deploy.get / deploy.events for stage + outcome
      if (created) void svc.deployment.runRedeploy(run.runId).catch(() => undefined)
      return run
    }
    case 'deploy.get': {
      const run = args.runId ? repo.getDeploymentRun(args.runId) : args.requestId ? repo.findDeploymentRunByRequest(args.requestId) : undefined
      return run ?? null
    }
    case 'deploy.list': {
      return repo.listDeploymentRuns({ projectId: args.projectId }).slice(0, args.limit)
    }
    case 'deploy.stop': {
      return svc.deployment.requestStop(args.runId)
    }
    case 'deploy.reconcile': {
      const { run } = await svc.deployment.reconcile(args.runId)
      return run
    }
    case 'deploy.steps': {
      return repo.listStepRecords(args.runId)
    }
    case 'deploy.events': {
      return repo.listEvents(args.runId, args.afterSequence)
    }
    // ---------- scripts ----------
    case 'scripts.list': {
      return repo.listScriptVersions({ projectId: args.projectId, targetId: args.targetId })
    }
    case 'scripts.get': {
      return repo.getScriptVersion(args.scriptVersionId) ?? null
    }
    // ---------- settings（面板内 AI 模型配置） ----------
    case 'settings.model.get': {
      if (!svc.settingsBridge) {
        return { modelRef: null, providers: [] }
      }
      const modelRef = svc.settingsBridge.getModelRef()
      const choices = await svc.settingsBridge.listModelChoices()
      // 把 `provider/model` 选项折叠回 provider → models 目录，供级联下拉
      const providers = new Map<string, string[]>()
      for (const choice of choices) {
        const slash = choice.indexOf('/')
        if (slash <= 0) continue
        const provider = choice.slice(0, slash)
        const model = choice.slice(slash + 1)
        const list = providers.get(provider) ?? []
        list.push(model)
        providers.set(provider, list)
      }
      return {
        modelRef,
        providers: [...providers.entries()].map(([id, models]) => ({ id, models })),
      }
    }
    case 'settings.model.set': {
      if (!svc.settingsBridge) {
        throw new OpsError({ code: 'not-found', message: 'settings bridge unavailable', scope: 'api', retryable: false })
      }
      const ref = typeof args.modelRef === 'string' && args.modelRef.trim() ? args.modelRef.trim() : null
      const { persisted } = await svc.settingsBridge.setModelRef(ref)
      return { saved: true, persisted }
    }
    default:
      throw new OpsError({ code: 'not-found', message: `unknown endpoint ${endpoint}`, scope: 'api', retryable: false })
  }
}

function requireServer(repo: OpsRepository, serverId: string): Server {
  const s = repo.getServer(serverId)
  if (!s) throw new OpsError({ code: 'not-found', scope: 'api', message: `server ${serverId} not found`, retryable: false })
  return s
}

// ---------- overview/history helpers (IMPROVE §4/§5) ----------

/** Keep at most `maxPoints` samples by taking the last value inside each time bucket. */
export function downsampleHardware(samples: Array<{ collectedAt: number } & Record<string, unknown>>, maxPoints: number): Array<{ collectedAt: number } & Record<string, unknown>> {
  if (samples.length <= maxPoints) return samples
  const first = samples[0]!.collectedAt
  const last = samples[samples.length - 1]!.collectedAt
  // +1 span so the bucket count never exceeds maxPoints at the boundary
  const bucketMs = Math.max(1, Math.ceil((last - first + 1) / maxPoints))
  const buckets = new Map<number, (typeof samples)[number]>()
  for (const s of samples) {
    buckets.set(Math.floor(s.collectedAt / bucketMs), s) // later sample overwrites
  }
  return [...buckets.values()].sort((a, b) => a.collectedAt - b.collectedAt)
}

/** A process belongs to a service when managerId, spec name or process name matches. */
function matchService(p: { name: string; command: string; cwd: string | null }, specName: string, managerId: string): boolean {
  const id = managerId || specName
  if (!id) return false
  if (p.name === id) return true
  if (p.command.includes(id)) return true
  // supervisor program dirs look like /etc/supervisor/conf.d/<program>.conf or cwd .../<program>
  if (p.cwd && (p.cwd.endsWith(`/${id}`) || p.cwd.includes(`/${id}/`))) return true
  return false
}

function aggregateProcesses(processes: Array<{ cpuPercent: number | null; rssBytes: number | null; ioReadBytesPerSec: number | null; ioWriteBytesPerSec: number | null }>): { cpuPercent: number | null; rssBytes: number | null; ioReadBytesPerSec: number | null; ioWriteBytesPerSec: number | null } {
  if (processes.length === 0) return { cpuPercent: null, rssBytes: null, ioReadBytesPerSec: null, ioWriteBytesPerSec: null }
  const sum = (get: (i: number) => number | null): number | null => {
    let any = false
    let total = 0
    for (let i = 0; i < processes.length; i++) {
      const v = get(i)
      if (v !== null) {
        any = true
        total += v
      }
    }
    return any ? total : null
  }
  return {
    cpuPercent: sum((i) => processes[i]!.cpuPercent),
    rssBytes: sum((i) => processes[i]!.rssBytes),
    ioReadBytesPerSec: sum((i) => processes[i]!.ioReadBytesPerSec),
    ioWriteBytesPerSec: sum((i) => processes[i]!.ioWriteBytesPerSec),
  }
}

/** `du` results are cached for 5 minutes so card polling never repeats it. */
const DU_CACHE_TTL_MS = 5 * 60_000
const duCache = new Map<string, { bytes: number; at: number }>()
function getDuCache(path: string): number | null {
  const hit = duCache.get(path)
  if (hit && Date.now() - hit.at < DU_CACHE_TTL_MS) return hit.bytes
  return null
}
function setDuCache(path: string, bytes: number): void {
  duCache.set(path, { bytes, at: Date.now() })
}

/**
 * Project services view: last computed snapshot per project so entering the
 * page is instant instead of waiting on a fresh SSH round-trip. A plain read
 * returns the cached snapshot immediately and, when none is already in flight,
 * kicks a background refresh that the next poll picks up; `force` (the 刷新
 * button) computes synchronously. The stored snapshot NEVER expires — a failed
 * background refresh simply leaves the last good view in place (its own
 * `collectedAt` is shown, so the age is honest).
 */
const projectProcessesCache = new Map<string, { resp: unknown; at: number }>()
const projectProcessesRefreshing = new Set<string>()

async function getCachedProjectProcesses(svc: DevOpsServices, projectId: string, force: boolean): Promise<unknown> {
  const cached = projectProcessesCache.get(projectId)
  if (force) {
    const resp = await computeProjectProcesses(svc, projectId)
    projectProcessesCache.set(projectId, { resp, at: Date.now() })
    return resp
  }
  if (cached) {
    if (!projectProcessesRefreshing.has(projectId)) {
      projectProcessesRefreshing.add(projectId)
      void computeProjectProcesses(svc, projectId)
        .then((resp) => projectProcessesCache.set(projectId, { resp, at: Date.now() }))
        .catch(() => undefined)
        .finally(() => projectProcessesRefreshing.delete(projectId))
    }
    return cached.resp
  }
  const resp = await computeProjectProcesses(svc, projectId)
  projectProcessesCache.set(projectId, { resp, at: Date.now() })
  return resp
}

async function computeProjectProcesses(svc: DevOpsServices, projectId: string): Promise<unknown> {
  const repo = svc.repo
  const project = requireProject(repo, projectId)
  const primary = project.targets[0]
  if (!primary) throw new OpsError({ code: 'not-found', message: 'project has no target', scope: 'api', retryable: false })
  const server = requireServer(repo, primary.serverId)
  const platform = (server.capabilities.platform as 'linux' | 'macos' | 'unknown') ?? 'unknown'
  const snapshot = await svc.processes.collect(primary.serverId, 'all', null, platform)

  const codeDirs = project.targets.map((t) => t.codeDir)
  const inProject = (p: { cwd: string | null }): boolean => {
    const c = p.cwd
    return c !== null && codeDirs.some((dir) => c === dir || c.startsWith(dir.endsWith('/') ? dir : dir + '/'))
  }
  const projectProcesses = snapshot.processes.filter((p) => inProject(p))

  // per-process IO rates for project processes only (bounded)
  const ioRates = await svc.resources.collectProcessIoRates(primary.serverId, projectProcesses.map((p) => p.pid))
  for (const p of projectProcesses) {
    const io = ioRates.get(p.pid)
    if (io) {
      p.ioReadBytesPerSec = io.readBytesPerSec
      p.ioWriteBytesPerSec = io.writeBytesPerSec
    }
  }

  const services = project.targets.flatMap((target) =>
    (target.services.length ? target.services : [{ name: '进程', manager: 'unknown' as const, managerId: '' }]).map((spec) => {
      const members = projectProcesses.filter((p) => matchService(p, spec.name, spec.managerId))
      const aggregate = aggregateProcesses(members)
      return {
        spec,
        processes: members,
        aggregate: {
          cpuPercent: aggregate.cpuPercent,
          rssBytes: aggregate.rssBytes,
          ioReadBytesPerSec: aggregate.ioReadBytesPerSec,
          ioWriteBytesPerSec: aggregate.ioWriteBytesPerSec,
        },
        status: members.length > 0 ? ('running' as const) : ('stopped' as const),
      }
    }),
  )
  const unlinked = projectProcesses.filter((p) => !services.some((s) => s.processes.includes(p)))

  // log files referenced by the project's own launch commands (IMPROVE 二轮 R3):
  // upsert them as log sources so the scheduler reads them like any other source
  const logCandidates = candidatesFromProcessCommands(projectProcesses.map((p) => p.command)).slice(0, 10)
  for (const path of logCandidates) {
    const st = await svc.resources.statPath(primary.serverId, path)
    const service = `cmdline:${path.split('/').at(-1) ?? 'log'}`
    const sourceId = `log_${primary.serverId}_${service}_${path.replaceAll('/', '_')}`.slice(0, 120)
    const existing = repo.getLogSource(sourceId)
    await repo.putLogSource(existing
      ? { ...existing, status: st ? 'active' : 'missing', sizeBytes: st?.size ?? existing.sizeBytes, lastModifiedAt: st?.mtimeMs ?? existing.lastModifiedAt }
      : {
          schemaVersion: SCHEMA_VERSION,
          sourceId,
          projectId,
          serverId: primary.serverId,
          service,
          configOrigin: 'process-cmdline',
          path,
          fileIdentity: null,
          status: st ? 'active' : 'missing',
          statusReason: st ? '' : 'referenced by a launch command but not readable',
          fingerprint: '',
          discoveredAt: Date.now(),
          readCursor: 0,
          generation: 0,
          truncatedAtDiscovery: false,
          userDefined: false,
          ignored: false,
          sizeBytes: st?.size ?? null,
          lastModifiedAt: st?.mtimeMs ?? null,
        })
  }

  // reverse proxies (nginx/apache) pointing at the project
  const duCache = getDuCache(primary.codeDir)
  const codeDirBytes = duCache ?? await svc.resources.measurePathBytes(primary.serverId, primary.codeDir)
  if (duCache === null && codeDirBytes !== null) setDuCache(primary.codeDir, codeDirBytes)
  const proxies = await svc.resources.detectReverseProxies(primary.serverId, primary.codeDir)
  const logSources = repo.listLogSources({ projectId })
  const logBytes = logSources.some((s) => s.sizeBytes !== null) ? logSources.reduce((a, s) => a + (s.sizeBytes ?? 0), 0) : null
  return { collectedAt: snapshot.collectedAt, services, unlinked, proxies, codeDirBytes, logBytes }
}

function requireProject(repo: OpsRepository, projectId: string): Project {
  const p = repo.getProject(projectId)
  if (!p) throw new OpsError({ code: 'not-found', message: `project ${projectId} not found`, scope: 'api', retryable: false })
  return p
}

/**
 * 服务器进程页视图：与 getCachedProjectProcesses 同款的 stale-while-revalidate
 * 缓存（模块级 Map，永不失效，后台刷新去重）。数据读取路径**绝不同步执行 AI
 * 巡检**——此前在这里同步跑 `runInspection`（每个 batch 模型调用超时 240s），
 * 模型端 429/503 时一个纯数据接口会挂起数分钟甚至整体报错，页面表现为
 * “进程列表无法加载”。AI 结论改为读调度器每 5 分钟落库的最近一条巡检记录；
 * 用户手动巡检走 `monitoring.inspect`，不受本缓存影响。
 */
const serverProcessesCache = new Map<string, { resp: unknown; at: number }>()
const serverProcessesRefreshing = new Set<string>()

async function getCachedServerProcesses(svc: DevOpsServices, serverId: string, force: boolean): Promise<unknown> {
  const cached = serverProcessesCache.get(serverId)
  if (force) {
    // 刷新按钮：同步重算并更新缓存
    const resp = await computeServerProcesses(svc, serverId)
    serverProcessesCache.set(serverId, { resp, at: Date.now() })
    return resp
  }
  if (cached) {
    // 缓存命中：立即返回旧值；无在途刷新时后台重算（失败静默保留旧值）
    if (!serverProcessesRefreshing.has(serverId)) {
      serverProcessesRefreshing.add(serverId)
      void computeServerProcesses(svc, serverId)
        .then((resp) => serverProcessesCache.set(serverId, { resp, at: Date.now() }))
        .catch(() => undefined)
        .finally(() => serverProcessesRefreshing.delete(serverId))
    }
    return cached.resp
  }
  const resp = await computeServerProcesses(svc, serverId)
  serverProcessesCache.set(serverId, { resp, at: Date.now() })
  return resp
}

async function computeServerProcesses(svc: DevOpsServices, serverId: string): Promise<unknown> {
  const repo = svc.repo
  const server = requireServer(repo, serverId)
  const platform = (server.capabilities.platform as 'linux' | 'macos' | 'unknown') ?? 'unknown'
  const snapshot = await svc.processes.collect(serverId, 'all', null, platform)
  const groups = classifyProcesses(snapshot.processes, {
    codeDirs: repo.listProjects().flatMap((p) => p.targets.map((t) => ({ projectId: p.id, codeDir: t.codeDir }))),
    groupingRules: repo.getPolicy(`${serverId}:process`)?.groupingRules ?? [],
  })
  // AI 结论取最近一条**已落库**的进程巡检记录（snapshotId 不必匹配本次采集）。
  // 说明：本路径不调用 svc.model——模型可用性只影响调度器落库记录的内容，
  // 任何模型侧异常（resolve/network/超时）都不可能再让这个数据接口失败；
  // 落库记录的 analysisState（如 'unavailable'）会被如实透出。
  const lastRun = repo.listInspectionRuns({ serverId, kind: 'process' })[0]
  const analysisState = lastRun?.analysisState ?? 'pending'
  const coverage = { analyzed: lastRun?.coverageAnalyzed ?? 0, total: lastRun?.coverageTotal ?? snapshot.processes.length }
  const findings = lastRun?.findings ?? []
  return {
    snapshotId: snapshot.snapshotId,
    collectedAt: snapshot.collectedAt,
    processes: snapshot.processes,
    groups,
    analysisState,
    coverage,
    findings,
    platform,
  }
}

function serverDto(server: Server, repo: OpsRepository) {
  return {
    ...server,
    credentials: server.credentialRefs.map((ref) => {
      const record = repo.getCredential(ref)
      return {
        ref,
        kind: record?.kind ?? 'ssh-password',
        configured: record !== undefined,
        keyVersion: record?.keyVersion ?? 0,
        updatedAt: record?.updatedAt ?? 0,
        error: null,
      }
    }),
  }
}

function defaultPolicy(serverId: string, kind: 'hardware' | 'process' | 'logs') {
  return sharedDefaultPolicy(serverId, kind, Date.now())
}
