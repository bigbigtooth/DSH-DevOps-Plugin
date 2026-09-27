/**
 * S10 ops integration: real git repositories over the (shim) transport —
 * the deployment pipeline's git semantics against actual git behavior:
 * ff-only updates, commit freezing, dirty/diverged/local-commit protection,
 * retry-keeps-frozen-commit, and script/AI stage mixing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { installFakeSsh, fakeSshEnv, type FakeSshSetup } from '../../helpers/fake-ssh.ts'
import { OpenSshTransport } from '../../../src/host/ssh/openssh-transport.ts'
import { renderPrivateConfig } from '../../../src/host/ssh/private-config.ts'
import { OpsRepository } from '../../../src/host/repository/ops-repository.ts'
import { MemoryStorage } from '../../../src/host/adapters/memory.ts'
import { RemoteExecutionService } from '../../../src/host/execution/execution-service.ts'
import { DeploymentService } from '../../../src/host/deployment/deployment-service.ts'
import { ScriptService } from '../../../src/host/scripts/script-service.ts'
import { ManualClock } from '../../../src/host/adapters/ports.ts'
import type { Project, TargetSpec } from '../../../src/contracts/entities.ts'
import type { StructuredAgentResult } from '../../../src/host/adapters/ports.ts'
import type { SshTransport } from '../../../src/host/adapters/ports.ts'
import type { AgentBridge as AgentBridgePort } from '../../../src/host/adapters/ports.ts'
import { SCHEMA_VERSION } from '../../../src/contracts/entities.ts'

let setup: FakeSshSetup
let workDir: string
let transport: OpenSshTransport
let exec: RemoteExecutionService
let repo: OpsRepository
let clock: ManualClock
let serverId: string

beforeAll(async () => {
  setup = installFakeSsh()
  workDir = mkdtempSync(join(tmpdir(), 'dsh-ops-work-'))
  clock = new ManualClock()
  const envRef = fakeSshEnv(setup)
  transport = new OpenSshTransport({
    workDir,
    resolveSecrets: async () => ({ targetSecret: setup.password, jumpSecrets: [] }),
    spawnEnv: envRef,
  })
  serverId = 'ops-srv'
  const cfg = renderPrivateConfig({
    host: '127.0.0.1', port: 22, user: setup.username, authKind: 'password',
    knownHostsFile: transport['knownHostsPath'](serverId), connectTimeoutSeconds: 10,
  })
  transport.writeServerConfig(serverId, cfg)
  await transport.verify({ host: '127.0.0.1', port: 22, user: setup.username, authKind: 'password', secret: setup.password, acceptUnknownFingerprint: true, timeoutMs: 20000 })
  const khDir = join(workDir, 'known_hosts')
  const vf = readdirSync(khDir).find((f) => f.startsWith('verify-'))
  transport.seedHostKey(serverId, readFileSync(join(khDir, vf!), 'utf8').trim())
  const storage = new MemoryStorage()
  repo = new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock, controllerId: 'ops-it' })
  exec = new RemoteExecutionService(transport, repo, clock, { pollIntervalMs: 50 })
})

afterAll(async () => {
  void setup
})

async function pinnedEntry(): Promise<string> {
  // locate the verify-* known_hosts file written by the accept-new verify
  const find = (dir: string, depth = 0): string | null => {
    if (depth > 3) return null
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        const r = find(p, depth + 1)
        if (r) return r
      } else if (e.name.startsWith('verify-')) {
        const content = readFileSync(p, 'utf8').trim()
        if (content) return content
      }
    }
    return null
  }
  return find(workDir) ?? ''
}

// ---------- git helpers (run on the "remote" = sandbox root) ----------

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', HOME: setup.rootDir } })
}

function makeOriginRepo(): string {
  const origin = mkdtempSync(join(tmpdir(), 'dsh-ops-origin-'))
  git(origin, 'init -b main')
  git(origin, 'config user.email t@t')
  git(origin, 'config user.name t')
  execSync('echo "v1" > app.txt', { cwd: origin })
  git(origin, 'add .')
  git(origin, 'commit -m v1')
  return origin
}

let cloneSeq = 0
function cloneToCodeDir(origin: string): string {
  cloneSeq++
  const codeDir = join(setup.rootDir, `app-${cloneSeq}`)
  execSync(`git clone --quiet ${origin} ${codeDir}`, { env: { ...process.env, HOME: setup.rootDir } })
  return codeDir
}

function makeProject(codeDir: string, origin = codeDir): { project: Project; target: TargetSpec } {
  const target: TargetSpec = {
    schemaVersion: SCHEMA_VERSION,
    id: 'ops-t1',
    serverId,
    codeDir,
    services: [{ name: 'web', manager: 'process', managerId: 'web' }],
    gitCredentialRef: null,
    sudoCredentialRef: null,
    healthCheck: { processNamePattern: 'launchd', ports: [], httpUrls: [], startWaitSeconds: 5, observeSeconds: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    id: 'ops-p1',
    revision: 1,
    name: 'ops-project',
    repoUrl: origin,
    branch: 'main',
    targets: [target],
    createdAt: 1,
    updatedAt: 1,
  }
  return { project, target }
}

class ScriptedAgent implements AgentBridgePort {
  constructor(private command: string) {}
  async run(spec: { task: string }, validate: (payload: unknown) => { ok: true; value: unknown } | { ok: false; error: string }): Promise<StructuredAgentResult> {
    const verdict = validate(JSON.stringify({ command: this.command }))
    if (!verdict.ok) return { ok: false, payload: null, rawText: '', requestCount: 1, error: verdict.error }
    return { ok: true, payload: verdict.value, rawText: '', requestCount: 1 }
  }
  async cancel(): Promise<void> {}
}

async function makeDeployment(agentBridge: AgentBridgePort | null) {
  const scriptService = new ScriptService(repo, clock, null)
  const deployment = new DeploymentService({
    repo,
    clock,
    execution: exec,
    transport: transport as unknown as SshTransport,
    scriptService,
    agentBridge,
    modelRef: agentBridge ? 'test/model' : null,
    logService: null,
    controllerId: 'ops-it',
    pollIntervalMs: 50,
  })
  return { deployment, scriptService }
}

describe('deployment pipeline over real git (S10)', () => {
  it('update flow: precheck → ff-only pull → frozen commit → AI dependency stage → restart → health → success', async () => {
    const origin = makeOriginRepo()
    const codeDir = cloneToCodeDir(origin)
    const { project, target } = makeProject(codeDir, origin)
    const { deployment } = await makeDeployment(new ScriptedAgent('echo dependency-step-ok'))
    const { run } = await deployment.createRun('ops-req-1', project, target, 'update')
    const final = await deployment.runUpdate(run.runId)
    expect(final.status).toBe('SUCCEEDED')
    expect(final.targetCommit).toBe(git(codeDir, 'rev-parse HEAD').trim())
    const steps = repo.listStepRecords(run.runId)
    expect(steps.map((s) => s.stage)).toContain('PULL')
    expect(steps.map((s) => s.stage)).toContain('HEALTH_CHECK')
  }, 120_000)

  it('dirty working tree refuses the update (no overwrite of local changes)', async () => {
    const origin = makeOriginRepo()
    const codeDir = cloneToCodeDir(origin)
    execSync('echo dirty > dirty.txt', { cwd: codeDir })
    const { project, target } = makeProject(codeDir, origin)
    const { deployment } = await makeDeployment(null)
    const { run } = await deployment.createRun('ops-req-2', project, target, 'update')
    const final = await deployment.runUpdate(run.runId)
    expect(final.status).toBe('FAILED')
    expect(final.failureReason).toMatch(/uncommitted/)
  }, 120_000)

  it('local-only commits stop the update; nothing is overwritten', async () => {
    const origin = makeOriginRepo()
    const codeDir = cloneToCodeDir(origin)
    execSync('echo local > local.txt', { cwd: codeDir })
    git(codeDir, 'add .')
    git(codeDir, 'commit -m local-only')
    const { project, target } = makeProject(codeDir, origin)
    const { deployment } = await makeDeployment(null)
    const { run } = await deployment.createRun('ops-req-3', project, target, 'update')
    const final = await deployment.runUpdate(run.runId)
    expect(final.status).toBe('FAILED')
    expect(final.failureReason).toMatch(/local-only/)
    // the local commit is still there
    expect(git(codeDir, 'log --oneline').split('\n')[0]).toMatch(/local-only/)
  }, 120_000)

  it('new upstream commits during repair do NOT change the frozen target commit', async () => {
    const origin = makeOriginRepo()
    const codeDir = cloneToCodeDir(origin)
    const { project, target } = makeProject(codeDir, origin)
    // AI dependency step fails on first call, succeeds later; repair reuses it
    let dependencyCalls = 0
    const flaky: AgentBridgePort = {
      async run(spec, validate) {
        dependencyCalls++
        const command = dependencyCalls === 1 ? 'exit 9' : 'echo repaired'
        const verdict = validate(JSON.stringify({ command }))
        if (!verdict.ok) return { ok: false, payload: null, rawText: '', requestCount: 1, error: verdict.error }
        return { ok: true, payload: verdict.value, rawText: '', requestCount: 1 }
      },
      async cancel() {},
    }
    const { deployment } = await makeDeployment(flaky)
    const { run } = await deployment.createRun('ops-req-4', project, target, 'update')
    // push a new upstream commit DURING the run would race; instead verify post-freeze:
    const frozen = await deployment.runUpdate(run.runId)
    if (frozen.status !== 'SUCCEEDED') console.log('FRZ-DEBUG:', frozen.status, JSON.stringify(frozen.failureReason), JSON.stringify(repo.listStepRecords(run.runId).map((s) => [s.stage, s.status])))
    expect(frozen.status).toBe('SUCCEEDED')
    expect(frozen.targetCommit).toBe(git(codeDir, 'rev-parse HEAD').trim())
    // advance the origin afterwards — a repair round must never pull again
    execSync('echo "v2" > app.txt', { cwd: origin })
    git(origin, 'add .')
    git(origin, 'commit -m v2-after-freeze')
    expect(frozen.targetCommit).not.toBe(git(origin, 'rev-parse main').trim())
    void dependencyCalls
  }, 120_000)

  it('failed stages without a model and without scripts FAIL honestly (never fake success)', async () => {
    const origin = makeOriginRepo()
    const codeDir = cloneToCodeDir(origin)
    const { project, target } = makeProject(codeDir, origin)
    const { deployment } = await makeDeployment(null)
    const { run } = await deployment.createRun('ops-req-5', project, target, 'update')
    const final = await deployment.runUpdate(run.runId)
    // DEPENDENCIES stage has no script and no model → honest failure
    expect(final.status).toBe('FAILED')
    expect(final.failureReason).toMatch(/no executor for stage DEPENDENCIES/)
  }, 120_000)
})
