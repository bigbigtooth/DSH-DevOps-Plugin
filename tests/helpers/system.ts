/**
 * E2E system assembly: real service stack over the fake-ssh transport,
 * exposed both as an API dispatcher (for client-model e2e) and directly
 * (for Host-internal operations like retention cleanup).
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeSsh, fakeSshEnv, type FakeSshSetup } from './fake-ssh.ts'
import { OpenSshTransport } from '../../src/host/ssh/openssh-transport.ts'
import { renderPrivateConfig } from '../../src/host/ssh/private-config.ts'
import { OpsRepository } from '../../src/host/repository/ops-repository.ts'
import { MemoryStorage } from '../../src/host/adapters/memory.ts'
import { ManualClock, type AgentBridge, type StructuredAgentResult } from '../../src/host/adapters/ports.ts'
import { Vault, MemoryKeyProvider } from '../../src/host/vault/vault.ts'
import { ServerService } from '../../src/host/servers/server-service.ts'
import { HardwareCollector, ProcessCollector, ResourceProbe } from '../../src/host/probes/collector.ts'
import { InspectionService } from '../../src/host/agents/inspection-service.ts'
import { LogService } from '../../src/host/logs/log-service.ts'
import { ScriptService } from '../../src/host/scripts/script-service.ts'
import { RemoteExecutionService } from '../../src/host/execution/execution-service.ts'
import { DeploymentService } from '../../src/host/deployment/deployment-service.ts'
import { createApiHandler, type DevOpsServices } from '../../src/host/api/devops-api.ts'
import { OpsClient, type ConnectionFace } from '../../src/client/model.ts'

export const ALWAYS_UP_PROCESS = 'launchd' // present on every macOS "remote"

export interface SystemUnderTest {
  rootDir: string
  serverId: string
  svc: DevOpsServices
  client: OpsClient
  repo: OpsRepository
  clock: ManualClock
  transport: OpenSshTransport
  setAgent(agent: AgentBridge | null): void
  setModelRef(modelRef: string | null): void
  /** switch the simulated transport into post-auth connection-drop mode */
  setDrop(on: boolean): void
  /** simulate a host key change on the pinned target */
  setRotated(on: boolean): void
  password: string
}

export interface SystemOptions {
  modelRef?: string | null
  agent?: AgentBridge | null
}

export async function buildSystem(opts: SystemOptions = {}): Promise<SystemUnderTest> {
  const setup: FakeSshSetup = installFakeSsh()
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-e2e-work-'))
  const clock = new ManualClock()
  const envRef = fakeSshEnv(setup)
  const transport = new OpenSshTransport({
    workDir,
    resolveSecrets: async () => ({ targetSecret: setup.password, jumpSecrets: [] }),
    spawnEnv: envRef,
    probeTimeoutMs: 15_000,
  })
  const serverId = 'e2e-srv'
  const cfg = renderPrivateConfig({
    host: '127.0.0.1', port: 22, user: setup.username, authKind: 'password',
    knownHostsFile: transport['knownHostsPath'](serverId), connectTimeoutSeconds: 10,
  })
  transport.writeServerConfig(serverId, cfg)
  const first = await transport.verify({
    host: '127.0.0.1', port: 22, user: setup.username,
    authKind: 'password', secret: setup.password, acceptUnknownFingerprint: true, timeoutMs: 20000,
  })
  const khDir = join(workDir, 'known_hosts')
  const vf = readdirSync(khDir).find((f) => f.startsWith('verify-'))
  transport.seedHostKey(serverId, readFileSync(join(khDir, vf!), 'utf8').trim())
  void first

  const storage = new MemoryStorage()
  const repo = new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock, controllerId: 'e2e-ctrl' })
  const vault = new Vault(new MemoryKeyProvider())
  const servers = new ServerService(repo, transport, vault, clock)
  const hardware = new HardwareCollector(transport, clock)
  const processes = new ProcessCollector(transport, repo, clock)
  let inspection = new InspectionService({ agentBridge: opts.agent ?? null, repo, clock, modelRef: opts.modelRef ?? null })
  let logService = new LogService({ transport, repo, clock, agentBridge: opts.agent ?? null, modelRef: opts.modelRef ?? null })
  const scriptService = new ScriptService(repo, clock, null)
  const execution = new RemoteExecutionService(transport, repo, clock, { pollIntervalMs: 50 })
  let currentAgent: AgentBridge | null = opts.agent ?? null
  let currentModelRef: string | null = opts.modelRef ?? null
  let deployment = newDeployment()

  function newDeployment(): DeploymentService {
    return new DeploymentService({
      repo,
      clock,
      execution,
      transport,
      scriptService,
      agentBridge: currentAgent,
      modelRef: currentModelRef,
      logService: logService,
      controllerId: 'e2e-ctrl',
      pollIntervalMs: 50,
    })
  }
  function setAgent(agent: AgentBridge | null): void {
    currentAgent = agent
    inspection = new InspectionService({ agentBridge: agent, repo, clock, modelRef: currentModelRef })
    logService = new LogService({ transport, repo, clock, agentBridge: agent, modelRef: currentModelRef })
    deployment = newDeployment()
    svc.inspection = inspection
    svc.logs = logService
    svc.deployment = deployment
  }
  function setModelRef(modelRef: string | null): void {
    currentModelRef = modelRef
    setAgent(currentAgent)
  }

  const svc: DevOpsServices = {
    repo,
    servers,
    hardware,
    processes,
    resources: new ResourceProbe(transport),
    inspection,
    logs: logService,
    deployment,
    scripts: scriptService,
    model: { resolve: async (ref) => ref ?? currentModelRef },
  }

  const handler = createApiHandler(svc)
  const connection: ConnectionFace = {
    rpc: {
      async call(_channel, endpoint, payload) {
        return handler(endpoint, payload)
      },
    },
  }
  const client = new OpsClient(connection)

  return {
    rootDir: setup.rootDir,
    serverId,
    svc,
    client,
    repo,
    clock,
    transport,
    setAgent,
    setModelRef,
    setDrop(on) {
      if (on) envRef.FAKE_SSH_DROP = '1'
      else delete envRef.FAKE_SSH_DROP
    },
    setRotated(on) {
      if (on) envRef.FAKE_SSH_ROTATED = '1'
      else delete envRef.FAKE_SSH_ROTATED
    },
    password: setup.password,
  }
}

/** scripted AI bridge returning a fixed validated command (deploy steps) */
export class ScriptedAgent implements AgentBridge {
  constructor(private readonly command: string) {}
  async run(spec: { task: string }, validate: (payload: unknown) => { ok: true; value: unknown } | { ok: false; error: string }): Promise<StructuredAgentResult> {
    const verdict = validate(JSON.stringify({ command: this.command }))
    if (!verdict.ok) return { ok: false, payload: null, rawText: spec.task, requestCount: 1, error: verdict.error }
    return { ok: true, payload: verdict.value, rawText: '', requestCount: 1 }
  }
  async cancel(): Promise<void> {}
}

/**
 * Routes by task shape: process-inspection tasks get a full-coverage report;
 * deploy/repair plan tasks get the scripted command(s). Failure injection
 * supported per stage for repair scenarios.
 */
export class RouterAgent implements AgentBridge {
  deployCommand: string
  failFirstDeploy = false
  private deployCalls = 0
  constructor(opts: { deployCommand?: string } = {}) {
    this.deployCommand = opts.deployCommand ?? 'echo dependency-ok'
  }
  async run(spec: { task: string }, validate: (payload: unknown) => { ok: true; value: unknown } | { ok: false; error: string }): Promise<StructuredAgentResult> {
    if (spec.task.includes('进程巡检员')) {
      const tokens = [...spec.task.matchAll(/^- (p\d+) \|/gm)].map((m) => m[1] ?? '')
      const verdict = validate(JSON.stringify({ analyzed: tokens, findings: [] }))
      return verdict.ok
        ? { ok: true, payload: verdict.value, rawText: '', requestCount: 1 }
        : { ok: false, payload: null, rawText: '', requestCount: 1, error: verdict.error }
    }
    this.deployCalls++
    const command = this.failFirstDeploy && this.deployCalls === 1 ? 'exit 9' : this.deployCommand
    const verdict = validate(JSON.stringify({ command }))
    return verdict.ok
      ? { ok: true, payload: verdict.value, rawText: '', requestCount: 1 }
      : { ok: false, payload: null, rawText: '', requestCount: 1, error: verdict.error }
  }
  async cancel(): Promise<void> {}
}
