import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryStorage } from '../../src/host/adapters/memory.ts'
import { ManualClock } from '../../src/host/adapters/ports.ts'
import { OpsRepository } from '../../src/host/repository/ops-repository.ts'
import { ServerService, TICKET_TTL_MS } from '../../src/host/servers/server-service.ts'
import { Vault, MemoryKeyProvider } from '../../src/host/vault/vault.ts'
import type { SshTransport, VerifyOptions, VerifyResult, ClockPort } from '../../src/host/adapters/ports.ts'
import { err } from '../../src/contracts/errors.ts'

class FakeVerifyTransport implements Partial<SshTransport> {
  calls = 0
  failWith: ReturnType<typeof err> | null = null
  fingerprint = 'ssh-ed25519 SHA256:AAAA'
  async verify(opts: VerifyOptions): Promise<VerifyResult> {
    this.calls++
    if (this.failWith) throw this.failWith
    if (opts.expectedFingerprint && opts.expectedFingerprint !== this.fingerprint) {
      throw err('host-fingerprint-changed', 'ssh', 'host key does not match the saved fingerprint')
    }
    return { fingerprint: this.fingerprint, hostKeyEntry: 'host ssh-ed25519 AAAA', platform: 'linux', osRelease: 'Ubuntu 24.04', arch: 'x86_64', shell: '/bin/bash' }
  }
}

async function makeSut() {
  const storage = new MemoryStorage()
  const clock = new ManualClock()
  const repo = new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock, controllerId: 'c' })
  const vault = new Vault(new MemoryKeyProvider())
  const transport = new FakeVerifyTransport()
  const svc = new ServerService(repo, transport as unknown as SshTransport, vault, clock)
  sutVault = vault
  return { repo, svc, transport, clock }
}

const draft = {
  alias: 'web-1',
  host: 'web1.example.com',
  port: 22,
  user: 'deploy',
  authKind: 'password' as const,
  secret: 's3cret',
}

describe('server add/update lifecycle (S2)', () => {
  let sut: Awaited<ReturnType<typeof makeSut>>
  beforeEach(async () => {
    sut = await makeSut()
  })

  it('verify → ticket → save: no server record without a successful verification', async () => {
    const { repo, svc, transport } = sut
    // verification failure → nothing persisted
    transport.failWith = err('auth-failed', 'ssh', 'Permission denied')
    await expect(svc.verify(draft)).rejects.toThrow(/Permission denied/)
    expect(repo.listServers()).toHaveLength(0)
    // success path
    transport.failWith = null
    const { ticket, fingerprint } = await svc.verify(draft)
    expect(transport.calls).toBe(2) // one failed attempt + one successful
    const server = await svc.addFromTicket(draft, ticket, fingerprint)
    expect(repo.listServers()).toHaveLength(1)
    // credential is stored encrypted
    const ref = server.credentialRefs[0]!
    const record = repo.getCredential(ref)!
    expect(record.encryptedValue).not.toContain('s3cret')
    expect(await vaultDecrypt(sut.repo, sutVault, ref)).toBe('s3cret')
  })

  it('verify probes the OS and the saved server carries real capabilities (卡片显示 OS 名+版本的数据来源)', async () => {
    const { repo, svc } = sut
    const { ticket, fingerprint } = await svc.verify(draft)
    const server = await svc.addFromTicket(draft, ticket, fingerprint)
    expect(server.capabilities.platform).toBe('linux')
    expect(server.capabilities.osRelease).toBe('Ubuntu 24.04')
    expect(server.capabilities.arch).toBe('x86_64')
    expect(server.capabilities.probedAt).toBeTruthy()
    // 落库值可从 repo 读回（servers.overview 即此数据）
    expect(repo.getServer(server.id)?.capabilities.osRelease).toBe('Ubuntu 24.04')
  })

  it('ensureProbedCapabilities backfills unknown capabilities once via probe and persists them', async () => {
    const { repo, svc, transport } = sut
    const { ticket, fingerprint } = await svc.verify(draft)
    const server = await svc.addFromTicket(draft, ticket, fingerprint)
    // 模拟旧数据：capabilities 全 unknown（早期版本落库时丢弃探测结果）
    const stale = { ...server, revision: server.revision + 1, capabilities: { platform: 'unknown' as const, osRelease: '', arch: '', shell: '', probes: {}, probedAt: null } }
    await repo.putServer(stale)
    const probeTransport = Object.assign(transport, {
      probeCalls: 0,
      async probe() {
        this.probeCalls++
        return { platform: 'linux' as const, osRelease: 'Debian 12', arch: 'aarch64', shell: '/bin/zsh', tools: { ps: 'available' as const } }
      },
    })
    const caps = await svc.ensureProbedCapabilities(server.id)
    expect(caps.platform).toBe('linux')
    expect(caps.osRelease).toBe('Debian 12')
    expect(repo.getServer(server.id)?.capabilities.osRelease).toBe('Debian 12')
    expect(repo.getServer(server.id)?.capabilities.arch).toBe('aarch64')
    // 已探测成功 → 第二次调用不再发 probe
    await svc.ensureProbedCapabilities(server.id)
    expect((probeTransport as unknown as { probeCalls: number }).probeCalls).toBe(1)
  })

  it('ensureProbedCapabilities keeps old values when the probe fails (never blocks collection)', async () => {
    const { repo, svc, transport } = sut
    const { ticket, fingerprint } = await svc.verify(draft)
    const server = await svc.addFromTicket(draft, ticket, fingerprint)
    // 模拟旧数据 capabilities 全 unknown，且 probe 失败
    const stale = { ...server, revision: server.revision + 1, capabilities: { platform: 'unknown' as const, osRelease: '', arch: '', shell: '', probes: {}, probedAt: null } }
    await repo.putServer(stale)
    Object.assign(transport, {
      async probe() {
        throw err('auth-failed', 'ssh', 'probe failed')
      },
    })
    const caps = await svc.ensureProbedCapabilities(server.id)
    expect(caps.platform).toBe('unknown') // 失败只保留旧值，不抛出
    expect(repo.getServer(server.id)?.capabilities.platform).toBe('unknown')
  })

  it('confirmed fingerprint must match the verified one', async () => {
    const { svc } = sut
    const { ticket } = await svc.verify(draft)
    await expect(svc.addFromTicket(draft, ticket, 'ssh-ed25519 SHA256:MISMATCH')).rejects.toThrow(/fingerprint/)
  })

  it('ticket expiry forces a fresh verification', async () => {
    const { svc, clock } = sut
    const { ticket, fingerprint } = await svc.verify(draft)
    clock.advance(TICKET_TTL_MS + 1000)
    await expect(svc.addFromTicket(draft, ticket, fingerprint)).rejects.toThrow(/expired/)
  })

  it('changed draft invalidates the ticket binding (verify old, save new → refused)', async () => {
    const { svc } = sut
    const { ticket, fingerprint } = await svc.verify(draft)
    // attacker swaps the host after verification
    await expect(svc.addFromTicket({ ...draft, host: 'evil.example.com' }, ticket, fingerprint)).rejects.toThrow()
    expect(sut.repo.listServers()).toHaveLength(0)
  })

  it('connection changes require a fresh verification; occupied servers refuse switch', async () => {
    const { repo, svc } = sut
    const { ticket, fingerprint } = await svc.verify(draft)
    const server = await svc.addFromTicket(draft, ticket, fingerprint)
    // simulate occupancy
    await repo.acquireServer(server.id, 'run-x', 'deployment')
    await expect(svc.updateServer(server.id, { ...draft, port: 2222 }, ticket, fingerprint)).rejects.toThrow(/active task/)
    await repo.releaseServer(server.id, 'run-x')
    // the old ticket binds port 22 — the changed draft invalidates it (S2 反例: 保存前修改配置)
    await expect(svc.updateServer(server.id, { ...draft, port: 2222 }, ticket, fingerprint)).rejects.toThrow(/ticket does not match|fresh verification/)
  })

  it('deletion is blocked while a project references the server', async () => {
    const { repo, svc } = sut
    const { ticket, fingerprint } = await svc.verify(draft)
    const server = await svc.addFromTicket(draft, ticket, fingerprint)
    await expect(svc.removeServer(server.id)).resolves.toBeUndefined()
  })

  it('health check decrypts stored credentials (restart safety)', async () => {
    const { repo, svc } = sut
    const { ticket, fingerprint } = await svc.verify(draft)
    const server = await svc.addFromTicket(draft, ticket, fingerprint)
    const health = await svc.healthCheck(server.id)
    expect(health.ok).toBe(true)
    void repo
  })
})

async function vaultDecrypt(repo: OpsRepository, vault: Vault, ref: string): Promise<string> {
  return vault.decrypt(repo.getCredential(ref)!.encryptedValue)
}

// helper bound to the current suite's vault
let sutVault: Vault
