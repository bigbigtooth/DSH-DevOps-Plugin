import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLocalSshConfig } from '../../src/host/ssh/local-config.ts'
import { ServerService } from '../../src/host/servers/server-service.ts'
import { MemoryStorage } from '../../src/host/adapters/memory.ts'
import { ManualClock, type SshTransport, type VerifyOptions } from '../../src/host/adapters/ports.ts'
import { OpsRepository } from '../../src/host/repository/ops-repository.ts'
import { MemoryKeyProvider, Vault } from '../../src/host/vault/vault.ts'

describe('local SSH aliases stay inside the private transport', () => {
  let dir: string
  let configFile: string
  let key: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-config-'))
    configFile = join(dir, 'config')
    key = join(dir, 'identity')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    writeFileSync(configFile, `Host test1\n HostName 192.0.2.11\n User deploy\n Port 2222\n IdentityFile "${key}"\n`)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('uses real ssh -G to resolve aliases and explicit command overrides', async () => {
    const result = await resolveLocalSshConfig('ssh test1', true, { configFile })
    expect(result).toEqual({ host: '192.0.2.11', port: 2222, user: 'deploy', identityPem: readFileSync(key, 'utf8') })
    expect(await resolveLocalSshConfig('ssh -p 2200 root@test1', false, { configFile }))
      .toEqual({ host: '192.0.2.11', port: 2200, user: 'root' })
  })

  it('rejects shell commands and unsupported config proxies', async () => {
    await expect(resolveLocalSshConfig('ssh test1; touch /tmp/no', false, { configFile })).rejects.toThrow(/metacharacter/)
    writeFileSync(configFile, 'Host test1\n ProxyCommand nc %h %p\n')
    await expect(resolveLocalSshConfig('ssh test1', false, { configFile })).rejects.toThrow(/ProxyCommand/)
  })

  it('binds verify/save to resolved fields and encrypts imported identity only on save', async () => {
    const clock = new ManualClock()
    const repo = new OpsRepository({ domain: await new MemoryStorage().openDomain('alias-test'), clock, controllerId: 'test' })
    const vault = new Vault(new MemoryKeyProvider())
    let verified: VerifyOptions | undefined
    const transport = {
      verify: async (options: VerifyOptions) => {
        verified = options
        return { fingerprint: 'SHA256:fixture', hostKeyEntry: 'host ssh-ed25519 fixture', platform: 'linux', osRelease: '', arch: '', shell: '' }
      },
      materializeServer: () => {},
    } as unknown as SshTransport
    const service = new ServerService(repo, transport, vault, clock, (command, loadKey) => resolveLocalSshConfig(command, loadKey, { configFile }))
    const draft = { alias: 'test1', commandLine: 'ssh test1' }
    const result = await service.verify(draft)
    expect(verified).toMatchObject({ host: '192.0.2.11', port: 2222, user: 'deploy', authKind: 'privatekey' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY')
    expect(repo.listServers()).toHaveLength(0)
    const saved = await service.addFromTicket(draft, result.ticket, result.fingerprint)
    expect(saved.endpoint).toBe('deploy@192.0.2.11:2222')
    const credential = repo.getCredential(saved.credentialRefs[0]!)!
    expect(credential.encryptedValue).not.toContain('PRIVATE KEY')
    expect(await vault.decrypt(credential.encryptedValue)).toBe(readFileSync(key, 'utf8'))

    writeFileSync(configFile, `Host test1\n HostName 192.0.2.12\n User deploy\n Port 2222\n IdentityFile "${key}"\n`)
    await expect(service.addFromTicket(draft, result.ticket, result.fingerprint)).rejects.toThrow(/does not match/)
  })
})
