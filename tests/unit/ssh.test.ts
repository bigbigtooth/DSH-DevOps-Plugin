import { describe, expect, it } from 'vitest'
import { parseSshCommand } from '../../src/host/ssh/parse.ts'
import { renderPrivateConfig, configHash } from '../../src/host/ssh/private-config.ts'
import { renderWrapper } from '../../src/host/execution/wrapper.ts'

describe('ssh command parser (S2)', () => {
  it('parses destination, port, user', () => {
    const p = parseSshCommand('ssh -p 2222 admin@web.example.com')
    expect(p.host).toBe('web.example.com')
    expect(p.port).toBe(2222)
    expect(p.user).toBe('admin')
    expect(p.authKind).toBe('password')
  })

  it('parses -l and -i forms', () => {
    const p = parseSshCommand('ssh -l root -i /keys/id_ed25519 -p 22 h1')
    expect(p.user).toBe('root')
    expect(p.identityFile).toBe('/keys/id_ed25519')
    expect(p.authKind).toBe('privatekey')
  })

  it('parses jump host chains', () => {
    const p = parseSshCommand('ssh -J jump1@10.0.0.1:2222,jump2@10.0.0.2 root@internal')
    expect(p.jumpHosts).toEqual([
      { host: '10.0.0.1', port: 2222, user: 'jump1' },
      { host: '10.0.0.2', port: 22, user: 'jump2' },
    ])
  })

  it('REJECTS tunnels, background, config overrides, remote commands', () => {
    for (const cmd of [
      'ssh -L 8080:localhost:80 h1',
      'ssh -R 80:localhost:8080 h1',
      'ssh -D 1080 h1',
      'ssh -W h2:22 h1',
      'ssh -N -f h1',
      'ssh -F /home/user/config h1',
      'ssh -o UserKnownHostsFile=/tmp/kh h1',
      'ssh -o ProxyCommand="nc -x proxy" h1',
      'ssh h1 "rm -rf /"',
      'ssh h1 -- ls',
      'ssh h1; rm -rf /',
      'ssh h1 `id`',
      'ssh h1 && echo done',
      'sudo ssh h1',
      'ssh',
    ]) {
      expect(() => parseSshCommand(cmd), `should reject: ${cmd}`).toThrow()
    }
  })

  it('rejects unknown -o keys even if harmless-looking', () => {
    expect(() => parseSshCommand('ssh -o SendEnv=LANG h1')).toThrow()
    expect(() => parseSshCommand('ssh -o ConnectTimeout=5 h1')).not.toThrow()
  })
})

describe('private config generation (S2 isolation)', () => {
  const base = {
    host: 'web1',
    port: 22,
    user: 'root',
    authKind: 'password' as const,
    knownHostsFile: '/data/ssh/known_hosts/srv1',
  }

  it('pins every isolation point', () => {
    const text = renderPrivateConfig(base)
    expect(text).toContain('Host dsh-devops-target')
    expect(text).toContain(`UserKnownHostsFile '/data/ssh/known_hosts/srv1'`)
    expect(text).toContain('GlobalKnownHostsFile /dev/null')
    expect(text).toContain('StrictHostKeyChecking yes')
    expect(text).toContain('IdentitiesOnly yes')
    expect(text).toContain('IdentityAgent none')
    expect(text).toContain('ForwardAgent no')
    expect(text).toContain('ControlMaster no')
    expect(text).toContain('ControlPath none')
    expect(text).toContain('PreferredAuthentications password,keyboard-interactive')
    expect(text).toContain('PubkeyAuthentication no')
  })

  it('key auth binds the identity file and disables password', () => {
    const text = renderPrivateConfig({ ...base, authKind: 'privatekey', identityFile: '/data/keys/k1' })
    expect(text).toContain(`IdentityFile '/data/keys/k1'`)
    expect(text).toContain('PreferredAuthentications publickey')
  })

  it('jump hosts share the same isolation boundary', () => {
    const text = renderPrivateConfig({
      ...base,
      jumpHosts: [{ alias: 'dsh-devops-jump-0', host: '10.0.0.1', port: 2222, user: 'jump1' }],
    })
    expect(text).toContain('Host dsh-devops-jump-0')
    expect(text).toContain('ProxyJump dsh-devops-jump-0')
    // jump section carries isolation too
    const jumpSection = text.split('Host dsh-devops-jump-0')[1]!.split('Host dsh-devops-target')[0]!
    expect(jumpSection).toContain('GlobalKnownHostsFile /dev/null')
    expect(jumpSection).toContain('ControlMaster no')
  })

  it('escapes single quotes in values', () => {
    const text = renderPrivateConfig({ ...base, host: "ho'st" })
    expect(text).toContain(`HostName 'ho'\\''st'`)
  })

  it('config hash binds alias/endpoint/options/credentials', () => {
    const h1 = configHash({ alias: 'a', endpoint: 'r@h:22', sshOptions: { host: 'h', port: 22, user: 'r', authKind: 'password', jumpHosts: [], extraOptions: {} }, credentialRefs: ['c1', 'c2'] })
    const h2 = configHash({ alias: 'a', endpoint: 'r@h:22', sshOptions: { host: 'h', port: 22, user: 'r', authKind: 'password', jumpHosts: [], extraOptions: {} }, credentialRefs: ['c2', 'c1'] })
    const h3 = configHash({ alias: 'b', endpoint: 'r@h:22', sshOptions: { host: 'h', port: 22, user: 'r', authKind: 'password', jumpHosts: [], extraOptions: {} }, credentialRefs: ['c1', 'c2'] })
    expect(h1).toBe(h2) // credential order-insensitive
    expect(h1).not.toBe(h3)
  })
})

describe('remote wrapper (S3)', () => {
  it('is POSIX sh without bash-isms or JS-template accidents', () => {
    const script = renderWrapper()
    expect(script.startsWith('#!/bin/sh')).toBe(true)
    expect(script).not.toContain('setsid') // macOS has no setsid
    expect(script).not.toContain('kill -TERM -- "-$PGID"') // never signals its own group
    expect(script).toContain('lstart') // PID-reuse-safe start token
    expect(script).toContain('descendant_pids') // tree-based termination
    expect(script).toContain('mv "$DIR/.status.tmp" "$DIR/status"') // atomic publish
  })
})
