/**
 * RPC API contract (channel /dsh-devops). The endpoint registry is the
 * single source for Host validation and Client typing. Response envelopes use
 * the Remote vocabulary: { ok: true, value } | { ok: false, error }.
 */
import { z } from 'zod'
import {
  alertSchema,
  credentialStatusSchema,
  deploymentRunSchema,
  hardwareSampleSchema,
  healthCheckSpecSchema,
  inspectionRunSchema,
  logFragmentSchema,
  logSourceSchema,
  monitoringPolicySchema,
  processEntrySchema,
  processGroupSchema,
  projectSchema,
  runEventSchema,
  scriptVersionSchema,
  serverSchema,
  serviceSpecSchema,
  stepRecordSchema,
} from './entities.ts'

export { RPC_CHANNEL } from './rpc.ts'

/** DTO: server as shown in pages — no secrets, only credential status. */
export const serverDtoSchema = serverSchema.extend({
  credentials: z.array(credentialStatusSchema),
})

const verifyDraftSchema = z.object({
  alias: z.string().min(1).max(120),
  /** raw user input: either structured fields or a parseable `ssh ...` command */
  commandLine: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().optional(),
  authKind: z.enum(['password', 'privatekey', 'privatekey-passphrase']).optional(),
  secret: z.string().optional(),
  jumpHosts: z
    .array(z.object({ host: z.string(), port: z.number().int().default(22), user: z.string(), secret: z.string().optional() }))
    .optional(),
})

/** For project save/update page: the editable shape includes services and health. */
const serviceSpecEditable = serviceSpecSchema
export const projectEditableSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  branch: z.string().min(1),
  targets: z.array(
    z.object({
      serverId: z.string(),
      codeDir: z.string(),
      services: z.array(serviceSpecEditable).default([]),
      gitCredentialRef: z.string().nullable().default(null),
      sudoCredentialRef: z.string().nullable().default(null),
      healthCheck: healthCheckSpecSchema.nullable().default(null),
    }),
  ).min(1),
})
export type ProjectEditable = z.infer<typeof projectEditableSchema>

export const apiEndpoints = {
  // ---- servers ----
  'servers.list': { request: z.object({}).default({}), response: z.array(serverDtoSchema) },
  'servers.get': {
    request: z.object({ serverId: z.string() }),
    response: serverDtoSchema,
  },
  'servers.verify': {
    /** run real login probe with the draft; returns fingerprint for confirmation */
    request: verifyDraftSchema,
    response: z.object({
      ticket: z.string(),
      fingerprint: z.string(),
      capabilities: z.record(z.string(), z.unknown()),
    }),
  },
  'servers.add': {
    request: verifyDraftSchema.extend({ ticket: z.string(), confirmedFingerprint: z.string() }),
    response: serverDtoSchema,
  },
  'servers.update': {
    request: verifyDraftSchema.extend({
      serverId: z.string(),
      ticket: z.string().optional(),
      confirmedFingerprint: z.string().optional(),
    }),
    response: serverDtoSchema,
  },
  'servers.remove': {
    request: z.object({ serverId: z.string() }),
    response: z.object({ removed: z.boolean() }),
  },
  /**
   * Server cards data: latest stored hardware sample + alert counts.
   * Read-only over the repository — never triggers SSH, safe to poll.
   */
  'servers.overview': {
    request: z.object({}).default({}),
    response: z.array(
      z.object({
        server: serverDtoSchema,
        latestSample: hardwareSampleSchema.nullable(),
        lastCollectedAt: z.number().nullable(),
        alertCount: z.object({ critical: z.number(), warning: z.number() }),
      }),
    ),
  },
  // ---- monitoring ----
  'monitoring.hardware': {
    request: z.object({ serverId: z.string() }),
    response: z.object({ sample: hardwareSampleSchema.nullable(), collectedAt: z.number().nullable(), analysisState: z.string() }),
  },
  /** 进程分组视图。宿主侧带 stale-while-revalidate 缓存：普通读立即返回
   * 上次结果并后台刷新；`force: true`（刷新按钮）同步重算。AI 巡检不在
   * 此端点内同步执行——analysis/findings 取最近一次已落库的巡检记录。 */
  'monitoring.processes': {
    request: z.object({ serverId: z.string(), force: z.boolean().default(false) }),
    response: z.object({
      snapshotId: z.string().nullable(),
      collectedAt: z.number().nullable(),
      processes: z.array(processEntrySchema),
      /** classified view over the same processes (IMPROVE §4.3) */
      groups: z.array(processGroupSchema),
      analysisState: z.string(),
      coverage: z.object({ analyzed: z.number(), total: z.number() }),
      findings: inspectionRunSchema.shape.findings,
    }),
  },
  /** stored hardware samples for trend lines; downsampled to ≤300 points */
  'monitoring.history': {
    request: z.object({
      serverId: z.string(),
      rangeMinutes: z.number().int().min(5).max(1440).default(60),
    }),
    response: z.object({ samples: z.array(hardwareSampleSchema) }),
  },
  /** per-service resource view for a project (IMPROVE §4.5). Host-cached: a
   * plain read returns the last snapshot immediately (and nudges a background
   * refresh) so entering the page is instant; `force: true` (the 刷新 button)
   * runs a fresh SSH collection synchronously. */
  'monitoring.projectProcesses': {
    request: z.object({ projectId: z.string(), force: z.boolean().default(false) }),
    response: z.object({
      collectedAt: z.number().nullable(),
      services: z.array(
        z.object({
          spec: serviceSpecSchema,
          processes: z.array(processEntrySchema),
          aggregate: z.object({
            cpuPercent: z.number().nullable(),
            rssBytes: z.number().nullable(),
            ioReadBytesPerSec: z.number().nullable(),
            ioWriteBytesPerSec: z.number().nullable(),
          }),
          status: z.enum(['running', 'stopped', 'unknown']),
        }),
      ),
      unlinked: z.array(processEntrySchema),
      /** reverse-proxy configs (nginx/apache) referencing the project codeDir */
      proxies: z.array(
        z.object({
          server: z.string(),
          configPath: z.string(),
          serverNames: z.array(z.string()),
        }),
      ),
      /** cached `du -s` of the project codeDir (best effort) */
      codeDirBytes: z.number().nullable(),
      /** sum of log source sizes */
      logBytes: z.number().nullable(),
    }),
  },
  /** log visualization feed: sources + level stats + tail lines + alerts (IMPROVE §4.6).
   * `sourceId` narrows everything to one file (live tail preview in the modal). */
  'monitoring.logTail': {
    request: z.object({ projectId: z.string().optional(), serverId: z.string().optional(), sourceId: z.string().optional(), limitLines: z.number().int().min(10).max(1000).default(200) }),
    response: z.object({
      sources: z.array(logSourceSchema),
      alerts: z.array(alertSchema),
      stats: z.array(
        z.object({
          sourceId: z.string(),
          linesPerMinute: z.number().nullable(),
          levelCount: z.object({ error: z.number(), warn: z.number(), info: z.number() }),
        }),
      ),
      tail: z.array(
        z.object({
          sourceId: z.string(),
          line: z.string(),
          level: z.enum(['error', 'warn', 'info']).nullable(),
          at: z.number().nullable(),
        }),
      ),
      /** fresh stat per source: card size/update-time display */
      meta: z.array(
        z.object({
          sourceId: z.string(),
          sizeBytes: z.number().nullable(),
          lastModifiedAt: z.number().nullable(),
        }),
      ),
    }),
  },
  'monitoring.logs': {
    request: z.object({ projectId: z.string().optional(), serverId: z.string().optional() }),
    response: z.object({
      sources: z.array(logSourceSchema),
      alerts: z.array(alertSchema),
      fragments: z.array(logFragmentSchema).optional(),
    }),
  },
  /**
   * Manual discovery sweep (IMPROVE follow-up): scan the project's default log
   * locations on its target (supervisor configs, codeDir/logs, startup scripts)
   * and register/refresh the discovered sources. Triggers bounded SSH.
   */
  'monitoring.discoverLogs': {
    request: z.object({ projectId: z.string() }),
    response: z.object({ registered: z.number().int(), sources: z.array(logSourceSchema) }),
  },
  /** Pin one absolute log path as a monitored source (survives re-discovery). */
  'monitoring.logSourceAdd': {
    request: z.object({ projectId: z.string(), serverId: z.string().optional(), path: z.string().min(1), service: z.string().optional() }),
    response: logSourceSchema,
  },
  'monitoring.logSourceRemove': {
    request: z.object({ sourceId: z.string() }),
    response: z.object({ removed: z.boolean() }),
  },
  'monitoring.inspect': {
    request: z.object({ serverId: z.string(), kind: z.enum(['hardware', 'process', 'logs']) }),
    response: z.object({ runId: z.string() }),
  },
  'monitoring.inspections': {
    request: z.object({ serverId: z.string().optional(), limit: z.number().int().default(50) }),
    response: z.array(inspectionRunSchema),
  },
  'monitoring.alerts': {
    request: z.object({ serverId: z.string().optional() }),
    response: z.array(alertSchema),
  },
  'monitoring.policy.get': {
    request: z.object({ serverId: z.string(), kind: z.enum(['hardware', 'process', 'logs']) }),
    response: monitoringPolicySchema,
  },
  'monitoring.policy.update': {
    request: monitoringPolicySchema,
    response: monitoringPolicySchema,
  },
  // ---- projects ----
  'projects.list': { request: z.object({}).default({}), response: z.array(projectSchema) },
  /**
   * Project cards data: last deployment run, service health, resource
   * aggregates, alert counts. Read-only over the repository — never
   * triggers SSH, safe to poll.
   */
  'projects.overview': {
    request: z.object({}).default({}),
    response: z.array(
      z.object({
        project: projectSchema,
        lastRun: deploymentRunSchema.nullable(),
        serviceHealth: z.object({ running: z.number(), total: z.number() }),
        aggregate: z.object({ cpuPercent: z.number().nullable(), rssBytes: z.number().nullable() }),
        alertCount: z.object({ critical: z.number(), warning: z.number() }),
      }),
    ),
  },
  'projects.save': {
    request: projectEditableSchema.extend({ id: z.string().optional() }),
    response: projectSchema,
  },
  'projects.remove': {
    request: z.object({ projectId: z.string() }),
    response: z.object({ removed: z.boolean() }),
  },
  // ---- deployment ----
  'deploy.create': {
    request: z.object({
      requestId: z.string(),
      projectId: z.string(),
      targetId: z.string(),
      kind: z.enum(['first-deploy', 'update']),
      /**
       * Also execute the pipeline in the background (fire-and-forget, like
       * deploy.redeploy). Without it the run is ONLY created — nothing on the
       * host ever picks up a bare QUEUED run, and its server occupancy is
       * never released, which permanently locks the project's deploy button.
       * UI entry points that mean "deploy now" must pass execute: true.
       */
      execute: z.boolean().default(false),
    }),
    response: deploymentRunSchema,
  },
  /**
   * One-click redeploy from the project services tab: create a run AND execute
   * the lightweight check→pull→restart→verify pipeline in the background.
   * Returns the freshly created run (QUEUED); progress is polled via deploy.get
   * / deploy.list / deploy.events. `targetId` defaults to the first target.
   */
  'deploy.redeploy': {
    request: z.object({ projectId: z.string(), targetId: z.string().optional(), requestId: z.string().optional() }),
    response: deploymentRunSchema,
  },
  'deploy.get': {
    request: z.object({ runId: z.string().optional(), requestId: z.string().optional() }),
    response: deploymentRunSchema.nullable(),
  },
  'deploy.list': {
    request: z.object({ projectId: z.string().optional(), limit: z.number().int().default(50) }),
    response: z.array(deploymentRunSchema),
  },
  'deploy.stop': {
    request: z.object({ runId: z.string() }),
    response: deploymentRunSchema,
  },
  'deploy.reconcile': {
    request: z.object({ runId: z.string() }),
    response: deploymentRunSchema,
  },
  'deploy.steps': {
    request: z.object({ runId: z.string() }),
    response: z.array(stepRecordSchema),
  },
  'deploy.events': {
    request: z.object({ runId: z.string(), afterSequence: z.number().int().default(0) }),
    response: z.array(runEventSchema),
  },
  // ---- scripts ----
  'scripts.list': {
    request: z.object({ projectId: z.string().optional(), targetId: z.string().optional() }),
    response: z.array(scriptVersionSchema),
  },
  'scripts.get': {
    request: z.object({ scriptVersionId: z.string() }),
    response: scriptVersionSchema.nullable(),
  },

  // ---- settings（插件面板内的 AI 模型配置界面） ----
  /** 当前 modelRef + 宿主可用的 provider/model 目录。 */
  'settings.model.get': {
    request: z.object({}).default({}),
    response: z.object({
      modelRef: z.string().nullable(),
      providers: z.array(z.object({ id: z.string(), models: z.array(z.string()) })),
    }),
  },
  /** 保存默认 AI 模型：立即生效（活引用）并尽力持久化（settings 服务在场时）。 */
  'settings.model.set': {
    request: z.object({ modelRef: z.string().nullable() }),
    response: z.object({ saved: z.boolean(), persisted: z.boolean() }),
  },
} as const

export type ApiEndpointName = keyof typeof apiEndpoints
export type ApiEndpoint<K extends ApiEndpointName = ApiEndpointName> = (typeof apiEndpoints)[K]

export type ApiRequest<K extends ApiEndpointName> = z.input<(typeof apiEndpoints)[K]['request']>
export type ApiResponse<K extends ApiEndpointName> = z.output<(typeof apiEndpoints)[K]['response']>

/** Remote-style envelope. */
export type ApiResult<K extends ApiEndpointName> =
  | { ok: true; value: ApiResponse<K> }
  | { ok: false; error: { code: string; message: string; scope: string; retryable: boolean; evidenceRef?: string; details?: Record<string, unknown> } }
