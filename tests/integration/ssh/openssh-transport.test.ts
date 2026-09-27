/**
 * S2/S3 integration through the fake-ssh shim (see helpers/fake-ssh.ts for
 * why the real ssh binary cannot be exercised in this environment).
 *
 * Still REAL: the private `-F` config file semantics, the controlled askpass
 * channel (prompt file + 0600 reply file, secrets never in argv/env), host-key
 * pinning vs accept-new, identity-bound detached execution, the POSIX wrapper
 * running under real sh, stop facts, reconcile queries, and connection-loss
 * classification.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeSsh, fakeSshEnv, type FakeSshSetup } from '../../helpers/fake-ssh.ts'
import { OpenSshTransport, taskDirFor, shqRemotePath } from '../../../src/host/ssh/openssh-transport.ts'
import { renderPrivateConfig } from '../../../src/host/ssh/private-config.ts'
import { OpsRepository } from '../../../src/host/repository/ops-repository.ts'
import { MemoryStorage } from '../../../src/host/adapters/memory.ts'
import { RemoteExecutionService } from '../../../src/host/execution/execution-service.ts'

let setup: FakeSshSetup
let workDir: string
let transport: OpenSshTransport
const SERVER_ID = 'it-srv'

let envRef: Record<string, string>
beforeAll(async () => {
  setup = installFakeSsh()
  workDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-work-'))
  envRef = fakeSshEnv(setup)
  transport = new OpenSshTransport({
    workDir,
    resolveSecrets: async () => ({ targetSecret: setup.password, jumpSecrets: [] }),
    connectTimeoutMs: 10_000,
    probeTimeoutMs: 15_000,
    spawnEnv: envRef,
  })
  // pin the host key for SERVER_ID once, from a first accept-new verify
  const first = await transport.verify({
    host: '127.0.0.1',
    port: 22,
    user: setup.username,
    authKind: 'password',
    secret: setup.password,
    acceptUnknownFingerprint: true,
    timeoutMs: 20_000,
  })
  pinnedFingerprint = first.fingerprint
  const khDir = join(workDir, 'known_hosts')
  const vf = readdirSync(khDir).find((f) => f.startsWith('verify-'))
  seedConfig()
  transport.seedHostKey(SERVER_ID, readFileSync(join(khDir, vf!), 'utf8').trim())
}, 30_000)

let pinnedFingerprint = ''

afterAll(async () => {
  void setup
  void workDir
})

function seedConfig(): void {
  const config = renderPrivateConfig({
    host: '127.0.0.1',
    port: 22,
    user: setup.username,
    authKind: 'password',
    knownHostsFile: transport['knownHostsPath'](SERVER_ID),
    connectTimeoutSeconds: 10,
  })
  transport.writeServerConfig(SERVER_ID, config)
}

describe('ssh transport integration via fake-ssh shim (S2/S3)', () => {
  it('password login works through the controlled askpass channel and pins the host key', async () => {
    expect(pinnedFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+={0,2}$/)
    // pinned login succeeds
    seedConfig()
    const result = await transport.verify({
      host: '127.0.0.1',
      port: 22,
      user: setup.username,
      authKind: 'password',
      secret: setup.password,
      timeoutMs: 20_000,
    })
    expect(result.platform).toBe('macos') // "remote" is this macOS host
    const khDir = join(workDir, 'known_hosts')
    const files = readdirSync(khDir)
    expect(files.some((f) => f.startsWith('verify-'))).toBe(true)
  }, 40_000)

  it('wrong password fails with auth-failed (askpass protocol answered, ssh refuses)', async () => {
    await expect(
      transport.verify({
        host: '127.0.0.1',
        port: 22,
        user: setup.username,
        authKind: 'password',
        secret: 'totally-wrong',
        acceptUnknownFingerprint: true,
        timeoutMs: 20_000,
      }),
    ).rejects.toMatchObject({ code: 'auth-failed' })
  }, 40_000)

  it('pinned fingerprint: accept-new captured the key; pinned verify succeeds', async () => {
    const khDir = join(workDir, 'known_hosts')
    const files = readdirSync(khDir)
    const verifyEntry = files.find((f) => f.startsWith('verify-'))
    expect(verifyEntry).toBeTruthy()
    const entry = readFileSync(join(khDir, verifyEntry!), 'utf8').trim()
    expect(entry).toContain('ssh-ed25519')
    seedConfig()
    transport.seedHostKey(SERVER_ID, entry)
    const result = await transport.verify({
      host: '127.0.0.1',
      port: 22,
      user: setup.username,
      authKind: 'password',
      secret: setup.password,
      timeoutMs: 20_000,
    })
    expect(result.platform).toBe('macos')
  }, 40_000)

  it('host key change is refused with host-fingerprint-changed', async () => {
    seedConfig()
    envRef.FAKE_SSH_ROTATED = '1'
    await expect(
      transport.verify({
        host: '127.0.0.1',
        port: 22,
        user: setup.username,
        authKind: 'password',
        secret: setup.password,
        timeoutMs: 20_000,
      }),
    ).rejects.toMatchObject({ code: 'host-fingerprint-changed' })
    delete envRef.FAKE_SSH_ROTATED
  }, 40_000)

  it('execute runs remote commands via argv (no client-side shell)', async () => {
    const res = await transport.execute({
      serverId: SERVER_ID,
      runId: 'it',
      stepId: 'echo',
      attemptId: 'a1',
      command: 'echo hello-remote && pwd',
      timeoutMs: 20_000,
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('hello-remote')
    expect(res.stdout).toContain(setup.rootDir) // sandbox cwd applied remotely
  }, 40_000)

  it('connection loss classifies as unknown, not as failure', async () => {
    envRef.FAKE_SSH_DROP = '1'
    const res = await transport.execute({
      serverId: SERVER_ID,
      runId: 'it',
      stepId: 'drop',
      attemptId: 'a1',
      command: 'echo should-not-run',
      timeoutMs: 20_000,
    })
    delete envRef.FAKE_SSH_DROP
    expect(res.connectionLost).toBe(true)
    expect(res.stdout).not.toContain('should-not-run')
  }, 40_000)

  it('writeFile → stat → readFileRange round-trips bytes with dev:inode identity', async () => {
    const path = 'probe-file.txt'
    await transport.writeFile(SERVER_ID, path, 'identity-content-0123456789')
    const stat = await transport.stat(SERVER_ID, path)
    expect(stat).not.toBeNull()
    expect(stat!.size).toBe('identity-content-0123456789'.length)
    expect(stat!.identity).toMatch(/^\d+:\d+$/)
    const read = await transport.readFileRange(SERVER_ID, path, 0, 1024)
    expect(read.data).toBe('identity-content-0123456789')
    expect(read.eof).toBe(true)
    const partial = await transport.readFileRange(SERVER_ID, path, 8, 5)
    expect(partial.data).toBe('-cont')
    expect(partial.eof).toBe(false)
  }, 40_000)

  it('remote execution unit end-to-end: intent-first, detached wrapper, published facts, idempotent identity', async () => {
    const storage = new MemoryStorage()
    const repo = new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock: { now: () => Date.now() }, controllerId: 'it' })
    const exec = new RemoteExecutionService(transport, repo, { now: () => Date.now() }, { pollIntervalMs: 50 })
    const req = {
      serverId: SERVER_ID,
      runId: 'it-run',
      stepId: 'it-step',
      attemptId: 'a1',
      stage: 'TEST',
      intent: 'run: echo unit',
      payload: '#!/bin/sh\necho unit-output\nexit 3\n',
      timeoutMs: 30_000,
      pollIntervalMs: 50,
    }
    // synchronous wrapper run probe: does the wrapper work at all?
    const probe = await transport.execute({
      serverId: SERVER_ID,
      runId: 'probe-run',
      stepId: 'probe-step',
      attemptId: 'a1',
      command: `sh ${shqRemotePath(taskDirFor('probe-run', 'probe-step', 'a1') + '/wrapper.sh')} start ${shqRemotePath(taskDirFor('probe-run', 'probe-step', 'a1'))}; echo rc=$?; ls ${shqRemotePath(taskDirFor('probe-run', 'probe-step', 'a1'))}`,
      timeoutMs: 15_000,
    })
    console.log('PROBE (no wrapper uploaded yet):', probe.exitCode, JSON.stringify(probe.stdout.slice(0, 200)), JSON.stringify(probe.stderr.slice(0, 200)))
    const result = await exec.executeUnit(req)
    console.log('DEBUG task dir:', setup.rootDir, JSON.stringify(readdirSync(join(setup.rootDir, '.dsh-devops-tasks')).map((d) => {
      try { return `${d}: ${readdirSync(join(setup.rootDir, '.dsh-devops-tasks', d)).join(',')}` } catch { return d }
    })))
    expect(result.exit.kind).toBe('exited')
    expect(result.exit.exitCode).toBe(3)
    expect(result.outputTail).toContain('unit-output')
    expect(result.step.status).toBe('FAILED')
    // repeat with the same identity queries the original unit (exactly one dispatch)
    const again = await exec.executeUnit(req)
    expect(again.exit.exitCode).toBe(3)
    // reconcile on a never-started unit
    const fact = await exec.inspectUnit(SERVER_ID, 'never', 'never', 'a1')
    expect(fact.status).toBe('NOT_STARTED')
  }, 60_000)

  it('stop request terminates a running remote task and records the stop facts', async () => {
    const storage = new MemoryStorage()
    const repo = new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock: { now: () => Date.now() }, controllerId: 'it' })
    const exec = new RemoteExecutionService(transport, repo, { now: () => Date.now() }, { pollIntervalMs: 50 })
    const running = exec.executeUnit({
      serverId: SERVER_ID,
      runId: 'it-stop',
      stepId: 'sleepy',
      attemptId: 'a1',
      stage: 'TEST',
      intent: 'run: sleep 60',
      payload: '#!/bin/sh\nsleep 60\n',
      timeoutMs: 120_000,
      pollIntervalMs: 50,
    })
    // wait until the remote wrapper is running
    let attempts = 0
    while (attempts < 100) {
      const facts = await exec.safeInspect(SERVER_ID, 'it-stop', 'sleepy', 'a1')
      if (facts.status === 'RUNNING') break
      await new Promise((r) => setTimeout(r, 100))
      attempts++
    }
    const facts = await exec.requestStop(SERVER_ID, 'it-stop', 'sleepy', 'a1')
    expect(facts.status).toBe('STOPPED')
    const outcome = await running
    expect(outcome.step.status).toBe('FAILED') // stopped ≠ succeeded
  }, 120_000)

  it('the plugin-private artifacts exist with isolation intact', () => {
    const cfg = join(workDir, 'configs', `${SERVER_ID}.conf`)
    expect(existsSync(cfg)).toBe(true)
    const text = readFileSync(cfg, 'utf8')
    expect(text).toContain('GlobalKnownHostsFile /dev/null')
    expect(text).toContain('ControlMaster no')
    expect(text).toContain('IdentitiesOnly yes')
    expect(existsSync(join(workDir, 'askpass.sh'))).toBe(true)
  })
})
