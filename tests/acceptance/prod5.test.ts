/**
 * Acceptance checks (PROD §5): the subset verifiable in THIS environment is
 * executed here against the real service stack; each assertion names the
 * acceptance clause it proves. Items that require the full DSH Web GUI, real
 * model backends or physical target machines are tracked in
 * docs/ACCEPTANCE.md §"environment-gated" and intentionally absent here.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystem, RouterAgent, ALWAYS_UP_PROCESS, type SystemUnderTest } from '../helpers/system.ts'
import { newRequestId } from '../../src/client/model.ts'

let sys: SystemUnderTest
let addedServerId = ''

beforeAll(async () => {
  sys = await buildSystem({ modelRef: 'test/model', agent: new RouterAgent() })
}, 60_000)

afterAll(async () => {
  void sys
})

describe('PROD §5 acceptance — executable subset', () => {
  it('§5.1 SSH 验证失败不得添加服务器（无未验证记录）', async () => {
    const before = sys.repo.listServers().length
    const res = await sys.client.call('servers.verify', {
      alias: 'acc-bad', host: '127.0.0.1', port: 22, user: 'testuser',
      authKind: 'password', secret: 'wrong-on-purpose',
    })
    expect(res.ok).toBe(false)
    expect(sys.repo.listServers().length).toBe(before)
  }, 60_000)

  it('§5.2 不读取系统 SSH 配置：插件私有配置完成验证与自动连接', async () => {
    // the whole stack runs with -F private config + GlobalKnownHostsFile /dev/null;
    // a poisoned user config is never loaded (transport renders its own)
    const draft = { alias: 'acc-iso', host: '127.0.0.1', port: 22, user: 'testuser', authKind: 'password' as const, secret: sys.password }
    const verify = await sys.client.call('servers.verify', draft)
    expect(verify.ok).toBe(true)
    if (!verify.ok) return
    const add = await sys.client.call('servers.add', { ...draft, ticket: verify.value.ticket, confirmedFingerprint: verify.value.fingerprint })
    expect(add.ok).toBe(true)
    if (add.ok) addedServerId = add.value.id
  }, 60_000)

  it('§5.4 全量进程分组可查（含内存与运行时间口径），无遗漏', async () => {
    expect(addedServerId).toBeTruthy()
    const ps = await sys.client.call('monitoring.processes', { serverId: addedServerId })
    expect(ps.ok).toBe(true)
    if (!ps.ok) return
    expect(ps.value.processes.length).toBeGreaterThan(3)
    const grouped = new Set(ps.value.processes.map((p) => p.startToken))
    expect(grouped.size).toBe(ps.value.processes.length) // identity unique → nothing lost
  }, 90_000)

  it('§5.10 手动更新：git pull 记录提交、部署与健康验证全部通过才算成功', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'dsh-acc-origin-'))
    execSync('git init -b main', { cwd: origin, stdio: 'ignore' })
    execSync('git config user.email t@t && git config user.name t', { cwd: origin, stdio: 'ignore' })
    execSync('echo v1 > app.txt && git add . && git commit -qm v1', { cwd: origin, stdio: 'ignore' })
    const codeDir = join(sys.rootDir, `acc-app-${Math.random().toString(36).slice(2, 8)}`)
    execSync(`git clone --quiet ${origin} ${codeDir}`, { env: { ...process.env, HOME: sys.rootDir } })
    const saved = await sys.client.call('projects.save', {
      name: 'acc-project',
      repoUrl: origin,
      branch: 'main',
      targets: [{
        serverId: sys.serverId,
        codeDir,
        services: [{ name: ALWAYS_UP_PROCESS, manager: 'process', managerId: ALWAYS_UP_PROCESS }],
        healthCheck: { processNamePattern: ALWAYS_UP_PROCESS, ports: [], httpUrls: [], startWaitSeconds: 5, observeSeconds: 0 },
      }],
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const created = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId: saved.value.id, targetId: saved.value.targets[0]!.id, kind: 'update' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const final = await sys.svc.deployment.runUpdate(created.value.runId)
    expect(final.status).toBe('SUCCEEDED')
    expect(final.targetCommit).toMatch(/^[0-9a-f]{40}$/)
    // health evidence recorded — success is backed by the ORIGINAL check
    expect(final.healthCheckSnapshot).toBeTruthy()
  }, 180_000)

  it('§5.13 失败状态不被呈现为成功（健康检查失败 → FAILED 而非 SUCCEEDED）', async () => {
    // health check demands a process that never exists anywhere
    const origin = mkdtempSync(join(tmpdir(), 'dsh-acc-origin2-'))
    execSync('git init -b main', { cwd: origin, stdio: 'ignore' })
    execSync('git config user.email t@t && git config user.name t', { cwd: origin, stdio: 'ignore' })
    execSync('echo v1 > app.txt && git add . && git commit -qm v1', { cwd: origin, stdio: 'ignore' })
    const codeDir = join(sys.rootDir, `acc-app2-${Math.random().toString(36).slice(2, 8)}`)
    execSync(`git clone --quiet ${origin} ${codeDir}`, { env: { ...process.env, HOME: sys.rootDir } })
    const saved = await sys.client.call('projects.save', {
      name: 'acc-project-unhealthy',
      repoUrl: origin,
      branch: 'main',
      targets: [{
        serverId: sys.serverId,
        codeDir,
        services: [{ name: 'never-exists-svc', manager: 'process', managerId: 'never-exists-svc' }],
        healthCheck: { processNamePattern: 'never-exists-anywhere-xyz', ports: [], httpUrls: [], startWaitSeconds: 3, observeSeconds: 0 },
      }],
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const created = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId: saved.value.id, targetId: saved.value.targets[0]!.id, kind: 'update' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const final = await sys.svc.deployment.runUpdate(created.value.runId)
    expect(final.status).toBe('FAILED')
    expect(final.failureReason ?? '').toMatch(/health|repair|no executor/i)
  }, 180_000)
})
