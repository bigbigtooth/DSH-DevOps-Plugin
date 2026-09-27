/**
 * dsh-devops — DSH 远程监控与运维插件（Host 入口）。
 *
 * apply(ctx, config) 组装：私有 Vault、SSH 传输、执行/巡检/日志/调度/部署
 * 服务、带认证的 /dsh-devops 通道。全部副作用经 ctx.effect 注册，卸载
 * 即清理；加载期对数据目录做单控制器排他。
 */
import { z } from 'zod'
import schema from 'schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SCHEMA_VERSION } from './contracts/entities.ts'
import { RPC_CHANNEL } from './contracts/rpc.ts'
import { OpsRepository } from './host/repository/ops-repository.ts'
import { Vault, MemoryKeyProvider, FileKeyProvider } from './host/vault/vault.ts'
import { OpenSshTransport } from './host/ssh/openssh-transport.ts'
import { ServerService } from './host/servers/server-service.ts'
import { HardwareCollector, ProcessCollector, ResourceProbe } from './host/probes/collector.ts'
import { InspectionService } from './host/agents/inspection-service.ts'
import { LogService } from './host/logs/log-service.ts'
import { SchedulerService } from './host/scheduler/scheduler.ts'
import { ScriptService } from './host/scripts/script-service.ts'
import { RemoteExecutionService } from './host/execution/execution-service.ts'
import { DeploymentService } from './host/deployment/deployment-service.ts'
import { createApiHandler, type DevOpsServices } from './host/api/devops-api.ts'
import { buildRuntime, ControllerLock, safeLogger, type HostRuntime } from './host/adapters/dsh/runtime.ts'
import { buildModelSectionSchema, enumerateModelChoices, type SettingsFace, type SchemasteryLike } from './host/adapters/dsh/model-settings.ts'
import type { StoragePort } from './host/adapters/ports.ts'
import { spawnPortFromNode } from './host/adapters/spawn.ts'

export const name = 'dsh-devops'

/**
 * The loader forwards a row's `config` verbatim, and a patch row that omits
 * `config` reaches the plugin as `undefined` — NOT as `{}`. A bare
 * `z.object()` rejects that with "expected object, received undefined", so
 * the whole tree fails to boot for a plugin installed with no configuration.
 * `.default({})` makes an absent config mean "all defaults", which is what
 * every other DSH bundle row relies on.
 */
export const Config = z
  .object({
    /** plugin private data dir (keys, storage fallback, ssh configs) */
    dataDir: z.string().default(join(homedir(), '.dsh-devops')),
    /** model ref for AI inspection/deploy steps; empty = disabled (never faked) */
    modelRef: z.string().nullable().default(null),
    /** inspection input budget per batch (tokens, approx) */
    batchBudgetTokens: z.number().int().min(1000).default(8000),
    /** scheduling tick interval (ms) */
    schedulerTickMs: z.number().int().min(500).default(5000),
    /** scheduler jitter across servers (seconds) */
    schedulerJitterSeconds: z.number().int().min(0).default(5),
    /** default intervals (seconds) */
    hardwareIntervalSeconds: z.number().int().min(10).default(60),
    processIntervalSeconds: z.number().int().min(10).default(300),
    logsIntervalSeconds: z.number().int().min(10).default(300),
    /** history retention (days) */
    retentionDays: z.number().int().min(1).default(30),
  })
  // `prefault` (not `default`) so an absent config is PARSED from `{}` and every
  // inner default still applies; `.default({})` would short-circuit and hand the
  // caller an unparsed empty object.
  .prefault({})

/**
 * Deliberately EMPTY. Every host service this plugin touches
 * (storageDomain, agents) is read through `ctx.get(name)` inside
 * the runtime adapter, which returns `undefined` when the service is absent
 * and drives the documented degraded path. Declaring them here would make the
 * plugin wait for them and change a working degraded boot into a hang.
 * RPC registration uses a child fiber injecting connection and webServer.
 */
export const inject: string[] = []


export async function apply(
  ctx: Context,
  config?: (Partial<z.output<typeof Config>> & { controllerId?: string }) | undefined,
): Promise<void> {
  const raw = config ?? {}
  // Host logger access is guarded: reading an undeclared service property can
  // throw in strict loader compositions — fall back to console, NEVER throw.
  const logger = safeLogger(ctx)
  // Availability over loudness: ANY initialization failure disables this
  // plugin instance (with the error logged) instead of refusing the host's
  // whole plugin tree. A DSH deployment must always boot.
  let cleanupLock: ControllerLock | null = null
  try {
    await applyInner(ctx, raw, logger, (lock: ControllerLock) => {
      cleanupLock = lock
    })
  } catch (e) {
    logger.error(`[dsh-devops] DISABLED after initialization error: ${e instanceof Error ? e.message : String(e)}`)
    ;(cleanupLock as ControllerLock | null)?.release()
  }
}

async function applyInner(
  ctx: Context,
  raw: Partial<z.output<typeof Config>> & { controllerId?: string },
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void },
  registerLock: (lock: ControllerLock) => void,
): Promise<void> {
  const full = Config.parse(raw)
  const runtime: HostRuntime = buildRuntime(ctx, {
    dataDir: full.dataDir,
    // getter 而非快照：设置页改动 modelRef 后，runtime 的 model.resolve 立即读到新值
    get modelRef() {
      return full.modelRef
    },
  })
  for (const d of runtime.degraded) logger.warn(`[dsh-devops] ${d}`)

  // single active controller per data dir (S1): a second instance does NOT
  // mount business services (and never breaks the host tree) — it disables
  // itself loudly while the first controller keeps ownership. The RPC channel
  // is still registered with a conflict reporter so the browser shows the
  // actionable reason instead of cryptic transport failures (HTTP 405).
  const lock = new ControllerLock(full.dataDir, raw.controllerId ?? runtime.controllerId)
  registerLock(lock)
  try {
    lock.acquire()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger.warn(`[dsh-devops] DISABLED: ${message}`)
    try {
      await runtime.registerRpc(RPC_CHANNEL, async () => ({
        ok: false as const,
        error: {
          code: 'controller-conflict',
          message: `另一个 dsh web 实例正在管理本插件（数据目录锁被占用：${message}）。请关闭另一个 dsh web 进程后刷新本页。/ Another dsh web instance owns the plugin data dir; close it and reload.`,
          scope: 'lifecycle',
          retryable: false,
          details: {},
        },
      }))
    } catch {
      // channel registration itself unavailable — nothing more we can do
    }
    return
  }

  const domain = await runtime.storage.openDomain('dsh-devops')
  const repo = new OpsRepository({
    domain,
    clock: { now: () => Date.now() },
    controllerId: runtime.controllerId,
    retentionDays: full.retentionDays,
  })
  const migrated = await repo.loadAndMigrate()
  if (migrated > 0) logger.info(`[dsh-devops] migrated ${migrated} record(s)`)
  if (!repo.writable) {
    logger.error(`[dsh-devops] repository read-only: ${repo.loadError}`)
  }

  // vault + transport + services
  const vault = new Vault(
    process.env.DSH_DEVOPS_KEY_FILE
      ? new FileKeyProvider(
          (p) => import('node:fs').then((fs) => fs.readFileSync(p)),
          async (p, data) => {
            const fs = await import('node:fs')
            fs.writeFileSync(p, data, { mode: 0o600 })
          },
          process.env.DSH_DEVOPS_KEY_FILE,
        )
      : new MemoryKeyProvider(),
  )
  const transport = new OpenSshTransport({
    workDir: join(full.dataDir, 'ssh'),
    resolveSecrets: (serverId) => resolveSecrets(repo, vault, serverId),
  })
  const execution = new RemoteExecutionService(transport, repo, { now: () => Date.now() }, { pollIntervalMs: 1000 })
  const scriptService = new ScriptService(repo, { now: () => Date.now() }, spawnPortFromNode())
  const inspection = new InspectionService({
    agentBridge: runtime.agentBridge as import('./host/adapters/ports.ts').AgentBridge | null,
    repo,
    clock: { now: () => Date.now() },
    get modelRef() {
      return full.modelRef
    },
    batchBudgetTokens: full.batchBudgetTokens,
  })
  const logService = new LogService({
    transport,
    repo,
    clock: { now: () => Date.now() },
    agentBridge: runtime.agentBridge,
    get modelRef() {
      return full.modelRef
    },
    logger,
  })
  const hardware = new HardwareCollector(transport, { now: () => Date.now() })
  const processes = new ProcessCollector(transport, repo, { now: () => Date.now() })
  const servers = new ServerService(repo, transport, vault, { now: () => Date.now() })

  // scheduler (host-owned; browsers cannot affect it)
  const runKind = (kind: 'hardware' | 'process' | 'logs') => async (serverId: string, trigger: 'manual' | 'scheduled'): Promise<string> => {
    const runId = `ins_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const startedAt = Date.now()
    void (async () => {
      try {
        if (kind === 'hardware') {
          // 采集前回填系统探测（仅对从未探测成功过的服务器发起一次 probe）
          const caps = await servers.ensureProbedCapabilities(serverId).catch(() => null)
          const platform = caps?.platform ?? 'unknown'
          const { sample } = await hardware.collect(serverId, platform)
          await repo.putHardwareSample(serverId, sample)
          await repo.putInspectionRun({
            schemaVersion: SCHEMA_VERSION,
            runId,
            serverId,
            kind,
            snapshotId: null,
            startedAt,
            finishedAt: Date.now(),
            analysisState: 'complete',
            coverageAnalyzed: 1,
            coverageTotal: 1,
            findings: [],
            evidenceRefs: [],
            error: null,
            trigger,
          })
        } else if (kind === 'process') {
          const server = repo.getServer(serverId)
          const platform = (server?.capabilities.platform as 'linux' | 'macos' | 'unknown') ?? 'unknown'
          const snapshot = await processes.collect(serverId, 'all', null, platform)
          const run = await inspection.runInspection(serverId, snapshot, repo.getPolicy(`${serverId}:process`) ?? null, trigger)
          await repo.putInspectionRun({ ...run, trigger })
        } else {
          for (const source of repo.listLogSources({ serverId })) {
            await logService.checkSource(source, repo.getPolicy(`${serverId}:logs`) ?? null)
          }
          await repo.putInspectionRun({
            schemaVersion: SCHEMA_VERSION,
            runId,
            serverId,
            kind,
            snapshotId: null,
            startedAt,
            finishedAt: Date.now(),
            analysisState: 'complete',
            coverageAnalyzed: 0,
            coverageTotal: 0,
            findings: [],
            evidenceRefs: [],
            error: null,
            trigger,
          })
        }
      } catch (e) {
        await repo.putInspectionRun({
          schemaVersion: SCHEMA_VERSION,
          runId,
          serverId,
          kind,
          snapshotId: null,
          startedAt,
          finishedAt: Date.now(),
          analysisState: 'failed',
          coverageAnalyzed: 0,
          coverageTotal: 0,
          findings: [],
          evidenceRefs: [],
          error: e instanceof Error ? e.message : String(e),
          trigger,
        })
      }
    })()
    return runId
  }

  const deployment = new DeploymentService({
    repo,
    clock: { now: () => Date.now() },
    execution,
    transport,
    scriptService,
    agentBridge: runtime.agentBridge,
    get modelRef() {
      return full.modelRef
    },
    logService,
    controllerId: runtime.controllerId,
    pollIntervalMs: 1000,
  })

  const scheduler = new SchedulerService({
    repo,
    clock: { now: () => Date.now() },
    timers: { setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    } },
    jitterSeconds: full.schedulerJitterSeconds,
    defaultIntervals: {
      hardware: full.hardwareIntervalSeconds,
      process: full.processIntervalSeconds,
      logs: full.logsIntervalSeconds,
    },
    runners: {
      hardware: runKind('hardware'),
      process: runKind('process'),
      logs: runKind('logs'),
    },
  })
  scheduler.start(full.schedulerTickMs)

  // recovery scan: only observes, never re-dispatches
  void deployment.recover().then((results) => {
    for (const r of results) logger.info(`[dsh-devops] recovery: ${r.runId} ${r.observation}`)
  })

  // rpc channel
  const services: DevOpsServices = {
    repo,
    servers,
    hardware,
    processes,
    resources: new ResourceProbe(transport),
    inspection,
    logs: logService,
    deployment,
    scripts: scriptService,
    model: runtime.model,
    settingsBridge: {
      getModelRef: () => full.modelRef,
      setModelRef: async (ref) => {
        full.modelRef = ref
        // 尽力持久化到 settings 用户层（installSection 注册的 namespace），
        // 重启后经 onChange 恢复为生效值；settings 服务缺席时仅本会话生效。
        const settings = settingsRef.current
        if (settings && typeof settings.update === 'function') {
          try {
            await settings.update('dsh-devops-ai', { modelRef: ref })
            return { persisted: true }
          } catch (e) {
            logger.warn(`[dsh-devops] AI 模型持久化失败（仅本会话生效）：${e instanceof Error ? e.message : String(e)}`)
            return { persisted: false }
          }
        }
        return { persisted: false }
      },
      listModelChoices: () => enumerateModelChoices(runtime.llm),
    },
  }
  const handler = createApiHandler(services)
  await runtime.registerRpc(RPC_CHANNEL, handler)

  // ---- 设置页：AI 模型配置 ----
  // 数据面：与宿主 dsh-agent-default-model 相同的 installSection 契约（设置
  // 服务的用户层持久化选择，重启后仍是生效值）。UI 面：本版本宿主设置页对
  // 第三方区块没有通用渲染，因此面板内另设「AI 模型」界面，经 RPC
  // settings.model.get/set 读写同一个 full.modelRef（活引用，改完即生效）。
  const modelChoices = await enumerateModelChoices(runtime.llm)
  let readModelSection: () => unknown = () => ({ modelRef: full.modelRef })
  const settingsRef: { current: { update(ns: string, patch: Record<string, unknown>): Promise<void> } | null } = { current: null }
  const modelSchema = buildModelSectionSchema(schema as unknown as SchemasteryLike, modelChoices, full.modelRef)
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = (settingsCtx as unknown as { settings?: SettingsFace & { update?(ns: string, patch: Record<string, unknown>): Promise<void> } }).settings
    if (!settings || typeof settings.installSection !== 'function') {
      logger.warn('[dsh-devops] settings 服务不可用：AI 模型请经 cordis patch 配置 modelRef')
      return
    }
    settingsRef.current = settings as { update(ns: string, patch: Record<string, unknown>): Promise<void> }
    settings.installSection(ctx, 'dsh-devops-ai', modelSchema, { modelRef: full.modelRef }, {
      setSource: (source) => {
        readModelSection = source as () => unknown
      },
      onChange: () => {
        const value = readModelSection() as { modelRef?: string | null } | null
        const ref = typeof value?.modelRef === 'string' && value.modelRef.trim() ? value.modelRef.trim() : null
        if (ref !== full.modelRef) {
          full.modelRef = ref
          logger.info(`[dsh-devops] AI 模型已切换为 ${ref ?? '（未配置）'}`)
        }
      },
    })
  })

  // effect ownership: everything above reverses on unload
  ctx.effect(() => () => {
    scheduler.stop()
    lock.release()
    void domain.close()
  })

  logger.info('[dsh-devops] plugin active')
}

async function resolveSecrets(
  repo: OpsRepository,
  vault: Vault,
  serverId: string,
): Promise<{ targetSecret: string | null; jumpSecrets: Array<string | null> }> {
  const server = repo.getServer(serverId)
  if (!server) return { targetSecret: null, jumpSecrets: [] }
  const jumpSecrets: Array<string | null> = []
  for (const jump of server.sshOptions.jumpHosts) {
    jumpSecrets.push(await decryptRef(repo, vault, jump.credentialRef))
  }
  const targetSecret = await decryptRef(repo, vault, server.credentialRefs[0] ?? null)
  return { targetSecret, jumpSecrets }
}

async function decryptRef(repo: OpsRepository, vault: Vault, ref: string | null): Promise<string | null> {
  if (!ref) return null
  const record = repo.getCredential(ref)
  if (!record) return null
  try {
    return await vault.decrypt(record.encryptedValue)
  } catch {
    return null
  }
}

export type { StoragePort }
