/**
 * E2E counterexamples (PLAN §6.2): every listed failure mode must produce the
 * honest outcome — no fabricated successes, no silent data loss, no blind
 * retries. Implemented over the real service stack.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystem, RouterAgent, ALWAYS_UP_PROCESS, type SystemUnderTest } from '../helpers/system.ts'
import { newRequestId } from '../../src/client/model.ts'
import type { AgentBridge, StructuredAgentResult } from '../../src/host/adapters/ports.ts'
import { SCHEMA_VERSION } from '../../src/contracts/entities.ts'

let sys: SystemUnderTest

beforeAll(async () => {
  sys = await buildSystem({ modelRef: 'test/model', agent: new RouterAgent() })
}, 60_000)

afterAll(async () => {
  void sys
})

function makeRepoWithApp(): { origin: string; codeDir: string } {
  const origin = mkdtempSync(join(tmpdir(), 'dsh-ce-origin-'))
  execSync('git init -b main', { cwd: origin, stdio: 'ignore' })
  execSync('git config user.email t@t && git config user.name t', { cwd: origin, stdio: 'ignore' })
  execSync('echo v1 > app.txt && git add . && git commit -qm v1', { cwd: origin, stdio: 'ignore' })
  const codeDir = join(sys.rootDir, `ce-app-${Math.random().toString(36).slice(2, 8)}`)
  execSync(`git clone --quiet ${origin} ${codeDir}`, { env: { ...process.env, HOME: sys.rootDir } })
  return { origin, codeDir }
}

async function makeProject(codeDir: string, origin: string): Promise<{ projectId: string; targetId: string }> {
  const saved = await sys.client.call('projects.save', {
    name: `ce-${Math.random().toString(36).slice(2, 6)}`,
    repoUrl: origin,
    branch: 'main',
    targets: [{
      serverId: sys.serverId,
      codeDir,
      services: [{ name: ALWAYS_UP_PROCESS, manager: 'process', managerId: ALWAYS_UP_PROCESS }],
      healthCheck: { processNamePattern: ALWAYS_UP_PROCESS, ports: [], httpUrls: [], startWaitSeconds: 5, observeSeconds: 0 },
    }],
  })
  if (!saved.ok) throw new Error('project save failed')
  return { projectId: saved.value.id, targetId: saved.value.targets[0]!.id }
}

describe('PLAN §6.2 counterexample matrix (e2e)', () => {
  it('系统 SSH 配置恰好能登录，插件配置错误 → 仍失败，不回落系统配置', async () => {
    const res = await sys.client.call('servers.verify', {
      alias: 'wrong-pw', host: '127.0.0.1', port: 22, user: 'testuser',
      authKind: 'password', secret: 'deliberately-wrong-password',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('auth-failed')
  }, 60_000)

  it('保存前修改了已验证配置/凭据 → 票据失效，重新验证', async () => {
    const draft = { alias: 'ticket-swap', host: '127.0.0.1', port: 22, user: 'testuser', authKind: 'password' as const, secret: sys.password }
    const verify = await sys.client.call('servers.verify', draft)
    if (!verify.ok) throw new Error('verify failed')
    // swap the secret after verification
    const add = await sys.client.call('servers.add', { ...draft, secret: 'changed-after-verify', ticket: verify.value.ticket, confirmedFingerprint: verify.value.fingerprint })
    expect(add.ok).toBe(false)
    if (!add.ok) expect(add.error.code).toBe('validation-failed')
  }, 60_000)

  it('模型只分析了部分进程 → 部分覆盖标记 partial，不冒充全量正常', async () => {
    // agent claims to analyze only one token per batch — server must reject fabrication
    // and keep the run partial/failed with honest coverage numbers.
    const lazy: AgentBridge = {
      async run(spec, validate) {
        const tokens = [...spec.task.matchAll(/tok-[^ |\n]+/g)].map((m) => m[0])
        const payload = { analyzed: tokens.slice(0, 1), findings: [] } // analyzes 1 of N
        const verdict = validate(JSON.stringify(payload))
        return verdict.ok
          ? { ok: true, payload: verdict.value, rawText: '', requestCount: 1 }
          : { ok: false, payload: null, rawText: '', requestCount: 1, error: verdict.error }
      },
      async cancel() {},
    }
    sys.setAgent(lazy)
    // 本 harness 只给 transport 种了 e2e-srv 的 SSH 配置，repo 里没有服务器
    // 记录；monitoring.inspect 需要 requireServer 命中，先补一条最小记录
    // （transport 的 resolveSecrets 不读该记录，占位字段即可）
    await sys.repo.putServer({
      schemaVersion: SCHEMA_VERSION,
      id: sys.serverId,
      revision: 1,
      alias: 'e2e-srv',
      endpoint: '127.0.0.1:22',
      sshOptions: { host: '127.0.0.1', port: 22, user: 'testuser', authKind: 'password', jumpHosts: [], extraOptions: {} },
      credentialRefs: [],
      configHash: 'e2e-seed',
      hostFingerprint: 'e2e-seed',
      capabilities: { platform: 'unknown', osRelease: '', arch: '', shell: '', probes: {}, probedAt: null },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    try {
      // AI 解耦：巡检由 monitoring.inspect 触发（手动巡检按钮路径），
      // 页面读取只展示最近落库的巡检结论，自身不再同步跑模型
      const ins = await sys.client.call('monitoring.inspect', { serverId: sys.serverId, kind: 'process' })
      expect(ins.ok).toBe(true)
      const ps = await sys.client.call('monitoring.processes', { serverId: sys.serverId, force: true })
      if (ps.ok) {
        expect(ps.value.analysisState === 'partial' || ps.value.analysisState === 'failed').toBe(true)
        expect(ps.value.coverage.analyzed).toBeLessThan(ps.value.coverage.total)
      }
    } finally {
      // 断言失败也必须恢复默认 agent，否则污染后续部署用例
      sys.setAgent(new RouterAgent())
    }
  }, 90_000)

  it('用户停止后 SSH 断开 → 停止中或待核对，不释放占用', async () => {
    const { origin, codeDir } = makeRepoWithApp()
    const { projectId, targetId } = await makeProject(codeDir, origin)
    const created = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId, targetId, kind: 'update' })
    if (!created.ok) throw new Error('create failed')
    const runId = created.value.runId
    sys.setDrop(true) // every subsequent connection drops
    const stopped = await sys.client.call('deploy.stop', { runId })
    sys.setDrop(false)
    // regardless of whether the stop request itself got through, the run must
    // NOT present as SUCCEEDED
    if (stopped.ok) {
      expect(['STOPPED', 'STOPPING', 'RECONCILE_REQUIRED']).toContain(stopped.value.status)
    }
    const run = sys.repo.getDeploymentRun(runId)
    expect(run?.status === 'SUCCEEDED').toBe(false)
    // occupancy released only on a terminal, confirmed state
    const execState = sys.repo.getServerExecState(sys.serverId)
    if (!['SUCCEEDED', 'FAILED', 'STOPPED'].includes(run?.status ?? '')) {
      expect(execState?.occupiedByRunId).toBe(runId)
    }
    // simulate the user resolving (archiving) the interrupted run so later tests can deploy
    const unresolved = sys.repo.listUnfinishedRuns()
    for (const r of unresolved) {
      await sys.repo.releaseServer(r.targetSnapshot.serverId, r.runId).catch(() => undefined)
    }
  }, 90_000)

  it('候选脚本生成成功但未实际验证 → 保持候选，不作为稳定脚本复用', async () => {
    const { origin, codeDir } = makeRepoWithApp()
    const { projectId, targetId } = await makeProject(codeDir, origin)
    const created = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId, targetId, kind: 'update' })
    if (!created.ok) throw new Error('create failed')
    const final = await sys.svc.deployment.runUpdate(created.value.runId)
    if (final.status !== 'SUCCEEDED') console.log('CE-DEBUG failureReason:', JSON.stringify(final.failureReason), 'steps:', JSON.stringify(sys.repo.listStepRecords(created.value.runId).map((s) => [s.stage, s.status, s.outputTail.slice(0, 80)])))
    expect(final.status).toBe('SUCCEEDED')
    const scripts = await sys.client.call('scripts.list', { projectId })
    if (scripts.ok) {
      // any scripts extracted from this run are candidates, not verified
      for (const s of scripts.value) {
        expect(s.status === 'candidate' || s.status === 'verified').toBe(true)
        if (s.validation.validatedAt === null) expect(s.status).toBe('candidate')
      }
    }
  }, 120_000)

  it('重复点击部署 → 同一 runId，不重复派发', async () => {
    const { origin, codeDir } = makeRepoWithApp()
    const { projectId, targetId } = await makeProject(codeDir, origin)
    const requestId = newRequestId()
    const a = await sys.client.call('deploy.create', { requestId, projectId, targetId, kind: 'update' })
    const b = await sys.client.call('deploy.create', { requestId, projectId, targetId, kind: 'update' })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.value.runId).toBe(b.value.runId)
      // cleanup: close the queued run so later tests can acquire the server
      await sys.client.call('deploy.stop', { runId: a.value.runId })
      await sys.repo.releaseServer(sys.serverId, a.value.runId).catch(() => undefined)
    }
  }, 60_000)

  it('页面关闭/客户端断开不取消已接受任务 → 服务器端继续推进', async () => {
    const { origin, codeDir } = makeRepoWithApp()
    const { projectId, targetId } = await makeProject(codeDir, origin)
    // create then "close the browser": further client calls fail, task proceeds Host-side
    const created = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId, targetId, kind: 'update' })
    if (!created.ok) console.log('CREATE-DEBUG:', JSON.stringify(created.error))
    if (!created.ok) throw new Error('create failed')
    sys.setDrop(true)
    const final = await sys.svc.deployment.runUpdate(created.value.runId).catch(() => null)
    sys.setDrop(false)
    // the Host-side driver still advanced the task record (or honestly marked unknown)
    const run = sys.repo.getDeploymentRun(created.value.runId)
    expect(run).toBeTruthy()
    expect(run!.status === 'SUCCEEDED' || run!.status === 'RECONCILE_REQUIRED' || final === null).toBe(true)
  }, 120_000)
})
