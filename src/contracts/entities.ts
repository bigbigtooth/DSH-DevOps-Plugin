/**
 * Domain record schemas (PLAN §2.3). Zod v4 schemas double as storage-boundary
 * validation and RPC DTO validation. Every persisted record carries schemaVersion.
 */
import { z } from 'zod'

export const SCHEMA_VERSION = 1

// ---------- SSH / Server ----------

export const sshAuthKind = z.enum(['password', 'privatekey', 'privatekey-passphrase'])

export const jumpHostSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1),
  credentialRef: z.string().min(1),
})

export const sshOptionsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1),
  authKind: sshAuthKind,
  jumpHosts: z.array(jumpHostSchema).max(4).default([]),
  /** Extra allow-listed OpenSSH options parsed from a custom command. */
  extraOptions: z.record(z.string(), z.string()).default({}),
})

export const serverCapabilitiesSchema = z.object({
  platform: z.enum(['linux', 'macos', 'unknown']).default('unknown'),
  osRelease: z.string().default(''),
  arch: z.string().default(''),
  shell: z.string().default(''),
  probes: z.record(z.string(), z.enum(['available', 'limited', 'unavailable'])).default({}),
  probedAt: z.number().nullable().default(null),
})

export const serverSchema = z.object({
  schemaVersion: z.number().int(),
  id: z.string().min(1),
  revision: z.number().int().min(1),
  alias: z.string().min(1).max(120),
  endpoint: z.string().min(1),
  sshOptions: sshOptionsSchema,
  credentialRefs: z.array(z.string()).max(8),
  /** SHA-256 of the verified config this record was created from. */
  configHash: z.string().min(1),
  hostFingerprint: z.string().min(1),
  capabilities: serverCapabilitiesSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Server = z.infer<typeof serverSchema>

// ---------- Credential (record; DTO only exposes configured state) ----------

export const credentialKind = z.enum(['ssh-password', 'ssh-passphrase', 'ssh-privatekey', 'git', 'sudo'])
export const credentialRecordSchema = z.object({
  schemaVersion: z.number().int(),
  ref: z.string().min(1),
  kind: credentialKind,
  encryptedValue: z.string().min(1),
  keyVersion: z.number().int().min(1),
  updatedAt: z.number().int(),
})
export type CredentialRecord = z.infer<typeof credentialRecordSchema>

export const credentialStatusSchema = z.object({
  ref: z.string(),
  kind: credentialKind,
  configured: z.boolean(),
  keyVersion: z.number().int(),
  updatedAt: z.number().int(),
  /** unlock failure state, if any */
  error: z.string().nullable().default(null),
})
export type CredentialStatus = z.infer<typeof credentialStatusSchema>

// ---------- Verification ticket (S2) ----------

export const verifyTicketSchema = z.object({
  configHash: z.string(),
  credentialVersions: z.array(z.object({ ref: z.string(), keyVersion: z.number().int() })),
  fingerprint: z.string(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
})
export type VerifyTicket = z.infer<typeof verifyTicketSchema>

// ---------- Project / Target ----------

export const healthCheckSpecSchema = z.object({
  processNamePattern: z.string().min(1),
  ports: z.array(z.number().int().min(1).max(65535)).default([]),
  httpUrls: z.array(z.string()).default([]),
  startWaitSeconds: z.number().int().min(1).default(120),
  observeSeconds: z.number().int().min(0).default(30),
})
export type HealthCheckSpec = z.infer<typeof healthCheckSpecSchema>

export const serviceSpecSchema = z.object({
  name: z.string().min(1),
  /** How the service is managed remotely. */
  manager: z.enum(['supervisor', 'systemd', 'launchd', 'process', 'unknown']).default('unknown'),
  /** Identifier used with the manager (program name, unit, label). */
  managerId: z.string().default(''),
})

export const targetSpecSchema = z.object({
  schemaVersion: z.number().int(),
  id: z.string().min(1),
  serverId: z.string().min(1),
  codeDir: z.string().min(1),
  services: z.array(serviceSpecSchema).default([]),
  gitCredentialRef: z.string().nullable().default(null),
  sudoCredentialRef: z.string().nullable().default(null),
  healthCheck: healthCheckSpecSchema.nullable().default(null),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type TargetSpec = z.infer<typeof targetSpecSchema>

export const projectSchema = z.object({
  schemaVersion: z.number().int(),
  id: z.string().min(1),
  revision: z.number().int().min(1),
  name: z.string().min(1).max(120),
  repoUrl: z.string().min(1),
  branch: z.string().min(1),
  targets: z.array(targetSpecSchema).min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Project = z.infer<typeof projectSchema>

// ---------- Monitoring ----------

export const monitoringPolicySchema = z.object({
  schemaVersion: z.number().int(),
  id: z.string().min(1), // policy id = `${serverId}:${kind}`
  serverId: z.string().min(1),
  kind: z.enum(['hardware', 'process', 'logs']),
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(10),
  modelRef: z.string().nullable().default(null),
  /** v-prefixed independent versions for customizations. */
  focusProcessesVersion: z.number().int().default(1),
  focusProcesses: z.array(z.string()).default([]),
  groupingRulesVersion: z.number().int().default(1),
  groupingRules: z
    .array(z.object({ match: z.string(), project: z.string() }))
    .default([]),
  expectedStatesVersion: z.number().int().default(1),
  expectedStates: z
    .array(z.object({ match: z.string(), expected: z.enum(['running', 'stopped']) }))
    .default([]),
  thresholdsVersion: z.number().int().default(1),
  thresholds: z
    .object({
      cpuPercent: z.number().nullable().default(null),
      rssBytes: z.number().nullable().default(null),
    })
    .default({ cpuPercent: null, rssBytes: null }),
  logIncludeVersion: z.number().int().default(1),
  logInclude: z.array(z.object({ service: z.string(), path: z.string() })).default([]),
  logIgnoreVersion: z.number().int().default(1),
  logIgnore: z.array(z.object({ pathPattern: z.string(), reason: z.string().default('') })).default([]),
  scopeVersion: z.number().int().default(1),
  scope: z.enum(['all', 'focused']).default('all'),
  naturalLanguageVersion: z.number().int().default(1),
  naturalLanguage: z.string().default(''),
  /** persisted schedule state: next trigger (null = unscheduled) */
  nextRunAt: z.number().int().nullable().default(null),
  updatedAt: z.number().int(),
})
export type MonitoringPolicy = z.infer<typeof monitoringPolicySchema>

export const analysisStateSchema = z.enum([
  'pending',
  'unavailable',
  'running',
  'complete',
  'partial',
  'failed',
])

export const hardwareSampleSchema = z.object({
  cpuPercent: z.number().nullable(),
  cpuWindowMs: z.number().nullable(),
  cpuCores: z.number().nullable(),
  memoryTotalBytes: z.number().nullable(),
  memoryUsedBytes: z.number().nullable(),
  swapTotalBytes: z.number().nullable(),
  swapUsedBytes: z.number().nullable(),
  /** aggregate network throughput over the sampling window, excluding loopback */
  netRecvBytesPerSec: z.number().nullable().default(null),
  netSentBytesPerSec: z.number().nullable().default(null),
  mounts: z.array(
    z.object({
      path: z.string(),
      totalBytes: z.number().nullable(),
      usedBytes: z.number().nullable(),
    }),
  ),
  collectedAt: z.number().int(),
  unitNotes: z.string().default('bytes; cpuPercent is whole-machine utilization 0-100'),
})
export type HardwareSample = z.infer<typeof hardwareSampleSchema>

export const processIdentitySchema = z.object({
  pid: z.number().int(),
  /** Boot-stable start identifier (start time on both platforms). */
  startToken: z.string(),
})
export type ProcessIdentity = z.infer<typeof processIdentitySchema>

export const processEntrySchema = z.object({
  pid: z.number().int(),
  name: z.string(),
  user: z.string(),
  rssBytes: z.number().nullable(),
  cpuPercent: z.number().nullable(),
  startedAt: z.number().nullable(),
  elapsedSeconds: z.number().nullable(),
  state: z.string(),
  startToken: z.string(),
  ppid: z.number().nullable().default(null),
  command: z.string().default(''),
  /** working directory at sampling time; null when unreadable (permission/platform) */
  cwd: z.string().nullable().default(null),
  /** per-process IO derived from two /proc/PID/io reads (Linux only); null otherwise */
  ioReadBytesPerSec: z.number().nullable().default(null),
  ioWriteBytesPerSec: z.number().nullable().default(null),
  /** how the process was launched, derived from the ppid ancestor chain:
   * supervisor | pm2 | systemd | launchd | docker | kubernetes | npm | sh-script | direct */
  launchMode: z.string().nullable().default(null),
})
export type ProcessEntry = z.infer<typeof processEntrySchema>

/** Process classification for the server monitoring page (IMPROVE §4.3). */
export const processGroupKindSchema = z.enum(['system', 'common', 'private', 'other'])
export type ProcessGroupKind = z.infer<typeof processGroupKindSchema>

export const processGroupSchema = z.object({
  kind: processGroupKindSchema,
  /** display title: category name, or the cwd path for private services */
  title: z.string(),
  /** cwd shared by all members (private groups only) */
  cwd: z.string().nullable().default(null),
  /** set when the cwd sits inside a project codeDir */
  projectId: z.string().nullable().default(null),
  processes: z.array(processEntrySchema),
})
export type ProcessGroup = z.infer<typeof processGroupSchema>

export const processSnapshotSchema = z.object({
  schemaVersion: z.number().int(),
  snapshotId: z.string().min(1),
  serverId: z.string().min(1),
  scope: z.enum(['all', 'focused']),
  collectedAt: z.number().int(),
  processes: z.array(processEntrySchema),
  limited: z.boolean().default(false),
  limitReason: z.string().nullable().default(null),
})
export type ProcessSnapshot = z.infer<typeof processSnapshotSchema>

export const findingSchema = z.object({
  processStartTokens: z.array(z.string()).default([]),
  severity: z.enum(['info', 'warning', 'critical']),
  summary: z.string(),
  evidence: z.string(),
  suggestion: z.string().default(''),
})
export type Finding = z.infer<typeof findingSchema>

export const inspectionRunSchema = z.object({
  schemaVersion: z.number().int(),
  runId: z.string().min(1),
  serverId: z.string().min(1),
  kind: z.enum(['hardware', 'process', 'logs']),
  snapshotId: z.string().nullable().default(null),
  startedAt: z.number().int(),
  finishedAt: z.number().nullable().default(null),
  /** analysis state — distinct from target health */
  analysisState: analysisStateSchema,
  /** coverage for AI analysis: analyzed / total enumerable */
  coverageAnalyzed: z.number().int().default(0),
  coverageTotal: z.number().int().default(0),
  findings: z.array(findingSchema).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
  trigger: z.enum(['manual', 'scheduled']).default('manual'),
})
export type InspectionRun = z.infer<typeof inspectionRunSchema>

// ---------- Logs ----------

export const logSourceSchema = z.object({
  schemaVersion: z.number().int(),
  sourceId: z.string().min(1),
  projectId: z.string().min(1),
  serverId: z.string().min(1),
  service: z.string().min(1),
  /** config evidence: where this source was discovered from */
  configOrigin: z.string().min(1),
  path: z.string().min(1),
  /** actual file identity (dev+inode on Linux;.birthtime+size on macOS) */
  fileIdentity: z.string().nullable().default(null),
  status: z.enum(['active', 'missing', 'unsupported', 'none']),
  statusReason: z.string().default(''),
  fingerprint: z.string().default(''),
  discoveredAt: z.number().int(),
  /** read cursor (bytes) vs analyzed cursor (fragment id high-water) */
  readCursor: z.number().int().default(0),
  /** generation counter: rotation/truncation bump it */
  generation: z.number().int().default(0),
  truncatedAtDiscovery: z.boolean().default(false),
  /** user-pinned sources survive re-discovery */
  userDefined: z.boolean().default(false),
  ignored: z.boolean().default(false),
  /** last known file size (bytes); null before the first successful stat */
  sizeBytes: z.number().nullable().default(null),
  /** last known file mtime (epoch ms); null before the first successful stat */
  lastModifiedAt: z.number().nullable().default(null),
})
export type LogSource = z.infer<typeof logSourceSchema>

export const logFragmentSchema = z.object({
  schemaVersion: z.number().int(),
  fragmentId: z.string().min(1),
  sourceId: z.string().min(1),
  runId: z.string().nullable().default(null),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
  content: z.string(),
  collectedAt: z.number().int(),
  analysisState: analysisStateSchema,
  analysisError: z.string().nullable().default(null),
  readTruncated: z.boolean().default(false),
  /** gap marker: bytes skipped because they exceeded limits or were lost */
  gapBeforeBytes: z.number().int().default(0),
})
export type LogFragment = z.infer<typeof logFragmentSchema>

export const alertSchema = z.object({
  schemaVersion: z.number().int(),
  alertId: z.string().min(1),
  serverId: z.string().min(1),
  projectId: z.string().nullable().default(null),
  service: z.string().nullable().default(null),
  source: z.enum(['process', 'log', 'hardware', 'deployment']),
  severity: z.enum(['info', 'warning', 'critical']),
  dedupeKey: z.string().min(1),
  summary: z.string(),
  evidenceRef: z.string().nullable().default(null),
  firstSeenAt: z.number().int(),
  lastSeenAt: z.number().int(),
  count: z.number().int().min(1),
  /** during deployments, anomalies tied to a known restart window are annotated */
  deploymentWindow: z.boolean().default(false),
})
export type Alert = z.infer<typeof alertSchema>

// ---------- Deployment ----------

export const deploymentStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'REPAIRING',
  'SUCCEEDED',
  'FAILED',
  'STOPPING',
  'STOPPED',
  'RECONCILE_REQUIRED',
])
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>

export const deploymentKindSchema = z.enum(['first-deploy', 'update'])

export const targetSnapshotSchema = z.object({
  targetId: z.string(),
  serverId: z.string(),
  codeDir: z.string(),
  repoUrl: z.string(),
  branch: z.string(),
  services: z.array(serviceSpecSchema),
  healthCheck: healthCheckSpecSchema.nullable(),
  configRevision: z.number().int(),
})

export const deploymentRunSchema = z.object({
  schemaVersion: z.number().int(),
  runId: z.string().min(1),
  requestId: z.string().min(1),
  projectId: z.string().min(1),
  targetId: z.string().min(1),
  kind: deploymentKindSchema,
  status: deploymentStatusSchema,
  stage: z.string().default(''),
  targetSnapshot: targetSnapshotSchema,
  /** commit frozen after fetch/precheck; repairs never move it */
  targetCommit: z.string().nullable().default(null),
  previousCommit: z.string().nullable().default(null),
  attempts: z.number().int().default(0),
  repairRounds: z.number().int().default(0),
  stopRequested: z.boolean().default(false),
  healthCheckSnapshot: z.record(z.string(), z.unknown()).nullable().default(null),
  remoteExecutionIds: z.array(z.string()).default([]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  finishedAt: z.number().nullable().default(null),
  failureReason: z.string().nullable().default(null),
})
export type DeploymentRun = z.infer<typeof deploymentRunSchema>

export const exitResultSchema = z.object({
  kind: z.enum(['exited', 'signalled', 'unknown']),
  exitCode: z.number().nullable().default(null),
  signal: z.string().nullable().default(null),
  /** true when the transport died before the remote outcome was confirmed */
  connectionLost: z.boolean().default(false),
})
export type ExitResult = z.infer<typeof exitResultSchema>

export const stepRecordSchema = z.object({
  schemaVersion: z.number().int(),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  attemptId: z.string().min(1),
  stage: z.string().min(1),
  /** persisted BEFORE dispatch */
  intent: z.string().min(1),
  inputsHash: z.string().min(1),
  remoteIdentity: z.string().nullable().default(null),
  status: z.enum(['PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SKIPPED']),
  exitResult: exitResultSchema.nullable().default(null),
  postcondition: z.string().nullable().default(null),
  outputTail: z.string().default(''),
  startedAt: z.number().nullable().default(null),
  finishedAt: z.number().nullable().default(null),
  evidence: z.array(z.string()).default([]),
  /** scripted, supervised-candidate or ai */
  executor: z.enum(['script', 'candidate', 'ai']).default('ai'),
  scriptVersionId: z.string().nullable().default(null),
})
export type StepRecord = z.infer<typeof stepRecordSchema>

// ---------- Scripts ----------

export const scriptStatusSchema = z.enum(['candidate', 'verified', 'invalidated'])
export const scriptVersionSchema = z.object({
  schemaVersion: z.number().int(),
  scriptVersionId: z.string().min(1),
  projectId: z.string().min(1),
  targetId: z.string().min(1),
  stage: z.string().min(1),
  interpreter: z.string().default('sh'),
  workDir: z.string().min(1),
  content: z.string().min(1),
  contentHash: z.string().min(1),
  params: z.array(z.string()).default([]),
  envRefs: z.array(z.string()).default([]),
  precondition: z.string().default(''),
  postcondition: z.string().default(''),
  status: scriptStatusSchema,
  validation: z
    .object({
      mode: z.enum(['test-target', 'supervised-deploy']),
      runId: z.string().nullable().default(null),
      validatedAt: z.number().nullable().default(null),
      result: z.enum(['passed', 'failed', 'pending']).default('pending'),
      failureReason: z.string().nullable().default(null),
    })
    .default({ mode: 'test-target', runId: null, validatedAt: null, result: 'pending', failureReason: null }),
  /** from the successful deployment that produced it */
  sourceDeployment: z.object({
    runId: z.string(),
    commit: z.string().nullable().default(null),
    summary: z.string().default(''),
  }),
  fingerprints: z
    .object({
      branch: z.string().default(''),
      interpreter: z.string().default(''),
      serviceConfig: z.string().default(''),
    })
    .default({ branch: '', interpreter: '', serviceConfig: '' }),
  invalidationReason: z.string().nullable().default(null),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type ScriptVersion = z.infer<typeof scriptVersionSchema>

// ---------- Server execution occupancy ----------

export const serverExecutionStateSchema = z.object({
  schemaVersion: z.number().int(),
  serverId: z.string().min(1),
  /** the run occupying the server, if any */
  occupiedByRunId: z.string().nullable().default(null),
  occupiedByKind: z.enum(['deployment', 'none']).default('none'),
  /** controller identity holding the occupancy */
  controllerId: z.string().nullable().default(null),
  revision: z.number().int().default(1),
  updatedAt: z.number().int(),
})
export type ServerExecutionState = z.infer<typeof serverExecutionStateSchema>

// ---------- Events ----------

export const runEventSchema = z.object({
  runId: z.string().min(1),
  sequence: z.number().int().min(1),
  timestamp: z.number().int(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
})
export type RunEvent = z.infer<typeof runEventSchema>
