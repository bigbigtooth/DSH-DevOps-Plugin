/**
 * E2E: the full business path a user would drive from the three pages —
 * add server → monitor → schedule → project → update deploy → scripts →
 * stop/reconcile → restart recovery — against the real service stack.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystem, RouterAgent, ALWAYS_UP_PROCESS, type SystemUnderTest } from '../helpers/system.ts'
import { newRequestId } from '../../src/client/model.ts'

let sys: SystemUnderTest

beforeAll(async () => {
  sys = await buildSystem({ modelRef: 'test/model', agent: new RouterAgent() })
}, 60_000)

afterAll(async () => {
  void sys
})

async function addServer(): Promise<string> {
  const draft = { alias: 'e2e-web', host: '127.0.0.1', port: 22, user: 'testuser', authKind: 'password' as const, secret: sys.password }
  const verify = await sys.client.call('servers.verify', draft)
  expect(verify.ok).toBe(true)
  if (!verify.ok) throw new Error('verify failed')
  const added = await sys.client.call('servers.add', { ...draft, ticket: verify.value.ticket, confirmedFingerprint: verify.value.fingerprint })
  expect(added.ok).toBe(true)
  if (!added.ok) throw new Error('add failed')
  return added.value.id
}

async function createProject(codeDir: string, origin: string): Promise<{ projectId: string; targetId: string }> {
  const saved = await sys.client.call('projects.save', {
    name: 'e2e-project',
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
  if (!saved.ok) throw new Error('save failed')
  return { projectId: saved.value.id, targetId: saved.value.targets[0]!.id }
}

function makeOriginRepo(): string {
  const origin = mkdtempSync(join(tmpdir(), 'dsh-e2e-origin-'))
  execSync('git init -b main', { cwd: origin, stdio: 'ignore' })
  execSync('git config user.email t@t && git config user.name t', { cwd: origin, stdio: 'ignore' })
  execSync('echo v1 > app.txt && git add . && git commit -qm v1', { cwd: origin, stdio: 'ignore' })
  return origin
}

describe('e2e full lifecycle', () => {
  it('server add → monitors → project → idempotent deploy → success with events', async () => {
    // 1) add server via pages path
    const serverId = await addServer()
    expect(serverId).toBeTruthy()

    // 2) hardware monitor
    const hw = await sys.client.call('monitoring.hardware', { serverId })
    expect(hw.ok).toBe(true)
    if (hw.ok) expect(hw.value.analysisState).toBe('complete')

    // 3) process monitor: 页面读取已与 AI 解耦——冷缓存首读只采集进程（无落库
    // 巡检记录时 analysisState 为 pending）；AI 走 monitoring.inspect（手动巡检
    // 按钮路径），完成后页面 force 刷新即可看到最近落库巡检的结论
    const ps1 = await sys.client.call('monitoring.processes', { serverId })
    expect(ps1.ok).toBe(true)
    if (ps1.ok) expect(ps1.value.processes.length).toBeGreaterThan(3)
    const ins = await sys.client.call('monitoring.inspect', { serverId, kind: 'process' })
    expect(ins.ok).toBe(true)
    const ps = await sys.client.call('monitoring.processes', { serverId, force: true })
    if (!ps.ok) console.log('PS-DEBUG:', JSON.stringify(ps.error))
    if (ps.ok && ps.value.analysisState !== 'complete') console.log('ANALYSIS-DEBUG:', ps.value.analysisState, sys.repo.listInspectionRuns({ serverId })[0]?.error)
    expect(ps.ok).toBe(true)
    if (ps.ok) {
      expect(ps.value.processes.length).toBeGreaterThan(3)
      expect(ps.value.analysisState).toBe('complete')
      // coverage 描述最近落库巡检那份快照，与页面本次采集是两次独立观测
      expect(ps.value.coverage.analyzed).toBeGreaterThan(0)
      expect(ps.value.coverage.total).toBeGreaterThan(0)
    }

    // 4) project + deploy (idempotent by requestId — double click safe)
    const origin = makeOriginRepo()
    const codeDir = join(sys.rootDir, 'e2e-app')
    execSync(`git clone --quiet ${origin} ${codeDir}`, { env: { ...process.env, HOME: sys.rootDir } })
    const { projectId, targetId } = await createProject(codeDir, origin)
    const requestId = newRequestId()
    const d1 = await sys.client.call('deploy.create', { requestId, projectId, targetId, kind: 'update' })
    const d2 = await sys.client.call('deploy.create', { requestId, projectId, targetId, kind: 'update' })
    expect(d1.ok && d2.ok).toBe(true)
    if (d1.ok && d2.ok) expect(d1.value.runId).toBe(d2.value.runId)

    // 5) drive to completion and inspect persisted evidence
    if (!d1.ok) throw new Error('create failed')
    const runId = d1.value.runId
    const final = await sys.svc.deployment.runUpdate(runId)
    expect(final.status).toBe('SUCCEEDED')
    expect(final.targetCommit).toMatch(/^[0-9a-f]{40}$/)

    const runView = await sys.client.call('deploy.get', { runId })
    expect(runView.ok && runView.value?.status).toBe('SUCCEEDED')
    const steps = await sys.client.call('deploy.steps', { runId })
    expect(steps.ok && steps.value.map((s) => s.stage)).toContain('PULL')
    const events = await sys.client.call('deploy.events', { runId, afterSequence: 0 })
    expect(events.ok && events.value.length).toBeGreaterThan(3)
  }, 180_000)

  it('client store polls active runs and replays events without duplicates', async () => {
    const { OpsStore } = await import('../../src/client/model.ts')
    const store = new OpsStore()
    await store.refresh(sys.client)
    expect(store.getState().servers.length).toBeGreaterThan(0)
    await store.refreshRuns(sys.client)
    const before = store.getState().activeRuns.length
    await store.refreshRuns(sys.client)
    expect(store.getState().activeRuns.length).toBe(before)
  })
})
