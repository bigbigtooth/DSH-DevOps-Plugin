/**
 * Regression: 项目详情“部署”tab（按钮 + 部署日志按成功/失败分类）。
 *
 * Covers the original dead-click bug and the tab restructure:
 *  - the 🚀 部署 button lives in the deploy tab (services tab keeps only a
 *    status line — no deploy action there anymore)
 *  - optimistic overlay: the popup appears instantly, before the (slow) RPC
 *    resolves; a zombie active run no longer locks the button silently
 *  - deployment log: records filterable by outcome (成功/失败), each record
 *    expands to its persisted event log inline (success green / failure red)
 *  - deploy.create with execute:true actually runs and releases occupancy
 *  - occupancy conflicts close the conflicting run as FAILED (no zombies)
 */
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { buildSystem, type SystemUnderTest } from '../helpers/system.ts'
import { ProjectDeployPage } from '../../src/client/pages/project-deploy.tsx'
import { ProjectServicesPage } from '../../src/client/pages/project-services.tsx'
import { newRequestId } from '../../src/client/model.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// the project tsconfig intentionally has no DOM lib — structural types only
interface ButtonLike { textContent: string | null; click(): void }
interface ContainerLike { textContent: string | null; querySelectorAll(sel: string): { [index: number]: ButtonLike; length: number }; remove(): void }
interface DocLike { createElement(tag: string): ContainerLike; body: { appendChild(node: ContainerLike): unknown } }
const doc = (globalThis as { document?: DocLike }).document!

async function setup(): Promise<{ sys: SystemUnderTest; container: ContainerLike; root: Root }> {
  const sys = await buildSystem()
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLDivElement)
  return { sys, container, root }
}

async function dispose(container: ContainerLike, root: Root): Promise<void> {
  await act(async () => {
    root.unmount()
  })
  container.remove()
}

async function renderPage(root: Root, client: SystemUnderTest['client'], projectId: string): Promise<void> {
  await act(async () => {
    root.render(createElement(ProjectDeployPage, { client, projectId }))
  })
  // let the deploy.list poll settle
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150))
  })
}

function findButton(container: ContainerLike, text: string): ButtonLike | undefined {
  const buttons = container.querySelectorAll('button')
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i]!
    if (b.textContent?.includes(text)) return b
  }
  return undefined
}

async function saveProject(sys: SystemUnderTest): Promise<{ projectId: string; targetId: string }> {
  const res = await sys.client.call('projects.save', {
    name: 'deploy-tab-proj',
    repoUrl: 'https://example.com/repo.git',
    branch: 'main',
    targets: [{ serverId: sys.serverId, codeDir: '/srv/app' }],
  })
  if (!res.ok) throw new Error(`projects.save failed: ${res.error.message}`)
  return { projectId: res.value.id, targetId: res.value.targets[0]!.id }
}

/** poll deploy.get until the run reaches a terminal status (test-side) */
async function waitForTerminal(sys: SystemUnderTest, runId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const res = await sys.client.call('deploy.get', { runId })
    const status = res.ok && res.value ? res.value.status : null
    if (status && ['SUCCEEDED', 'FAILED', 'STOPPED'].includes(status)) return status
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`run ${runId} did not reach a terminal status in time`)
}

describe('deploy tab (project detail)', () => {
  it('services tab no longer has the deploy action (moved to the 部署 tab)', async () => {
    const { sys, container, root } = await setup()
    try {
      const { projectId, targetId } = await saveProject(sys)
      // seed one record so the status line renders
      const seeded = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId, targetId, kind: 'update' })
      expect(seeded.ok).toBe(true)
      await act(async () => {
        root.render(createElement(ProjectServicesPage, { client: sys.client, projectId }))
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200))
      })
      expect(findButton(container, '部署')).toBeUndefined() // no 🚀 部署 / 部署进行中… button
      // the status line remains and points into the 部署 tab (active-run
      // branch shows 部署中, terminal branch shows the explicit pointer)
      expect(container.textContent ?? '').toMatch(/部署中：|部署操作与日志见“部署”标签/)
    } finally {
      await dispose(container, root)
    }
  })

  it('clean state: click opens the progress overlay instantly', async () => {
    const { sys, container, root } = await setup()
    try {
      const { projectId } = await saveProject(sys)
      await renderPage(root, sys.client, projectId)
      const btn = findButton(container, '部署')
      expect(btn?.textContent).toBe('一键部署')
      await act(async () => {
        btn!.click()
      })
      // the popup must be up in the SAME frame as the click — with the fast
      // in-process client it may already have re-bound to the real run, so
      // assert the overlay (not the transient pending text, which the
      // slow-RPC test below pins down deterministically)
      expect(container.textContent ?? '').toMatch(/部署进度/)
      // reset the persisted overlay for the next test
      await act(async () => {
        findButton(container, '关闭')!.click()
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30))
      })
      expect(container.textContent ?? '').not.toMatch(/部署进度|部署未能启动/)
    } finally {
      await dispose(container, root)
    }
  })

  it('deployment log: outcome filters + inline event log with failure reason', async () => {
    const { sys, container, root } = await setup()
    try {
      const { projectId, targetId } = await saveProject(sys)
      // one failed run (fake target /srv/app is not a git repo) + one stopped run
      const f1 = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId, targetId, kind: 'update', execute: true })
      if (f1.ok) await waitForTerminal(sys, f1.value.runId)
      const f2 = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId, targetId, kind: 'update' })
      if (f2.ok) await waitForTerminal(sys, (await sys.client.call('deploy.stop', { runId: f2.value.runId })).ok ? f2.value.runId : f2.value.runId)

      await renderPage(root, sys.client, projectId)
      const text0 = container.textContent ?? ''
      // filter chips with counts — STOPPED is its own gray category, NOT failure
      // (chips carry a small SVG icon now; text assertions ignore it)
      expect(text0).toMatch(/全部 2/)
      expect(text0).toMatch(/成功 0/)
      expect(text0).toMatch(/失败 1/)
      expect(text0).toMatch(/已停止 1/)
      // stopped records render as gray “已停止 · 无操作”, not failure
      expect(text0).toContain('已停止 · 无操作')
      // failure reason line only for the genuinely failed record
      expect(text0).toContain('失败原因：git precheck failed')

      // 成功 filter → empty state
      await act(async () => {
        findButton(container, '成功 0')!.click()
      })
      expect(container.textContent ?? '').toContain('还没有成功的部署记录')

      // 失败 filter → only the FAILED record, no stopped/no empty state
      await act(async () => {
        findButton(container, '失败 1')!.click()
      })
      const failText = container.textContent ?? ''
      expect(failText).not.toContain('还没有成功的部署记录')
      expect(failText).not.toContain('已停止 · 无操作')
      expect(failText).toContain('失败原因：git precheck failed')

      // 已停止 filter → only the STOPPED record
      await act(async () => {
        findButton(container, '已停止 1')!.click()
      })
      const stoppedText = container.textContent ?? ''
      expect(stoppedText).toContain('已停止 · 无操作')
      expect(stoppedText).not.toContain('失败原因')

      // back to 全部, expand the newest record's inline event log
      await act(async () => {
        findButton(container, '全部 2')!.click()
      })
      await act(async () => {
        findButton(container, '日志')!.click()
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200))
      })
      const logText = container.textContent ?? ''
      expect(logText).toContain('开始部署')
      expect(logText).toContain('失败')
      expect(logText).toContain('git precheck failed')
      // collapse again
      await act(async () => {
        findButton(container, '收起日志')!.click()
      })
      expect(container.textContent ?? '').not.toContain('开始部署')
    } finally {
      await dispose(container, root)
    }
  })

  it('list-page deploy (execute:true) actually runs and releases occupancy — the button does not stay busy', async () => {
    const { sys, container, root } = await setup()
    try {
      const { projectId, targetId } = await saveProject(sys)
      // what the fixed projects-list page sends
      const res = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId, targetId, kind: 'update', execute: true })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      // the fake target /srv/app is not a git repo → precheck fails → FAILED
      const status = await waitForTerminal(sys, res.value.runId)
      expect(status).toBe('FAILED')
      // occupancy released on terminal → the project is deployable again
      expect(sys.repo.getServerExecState(sys.serverId)?.occupiedByRunId ?? null).toBeNull()

      await renderPage(root, sys.client, projectId)
      const btn = findButton(container, '部署')
      expect(btn?.textContent).toBe('一键部署') // not stuck at 部署进行中…
    } finally {
      await dispose(container, root)
    }
  })

  it('legacy zombie QUEUED run: busy click opens the run overlay (survives remount); stopping it from the overlay unblocks the button', async () => {
    const { sys, container, root } = await setup()
    try {
      const { projectId, targetId } = await saveProject(sys)
      // legacy data: a bare QUEUED run holding occupancy (pre-fix deploy.create)
      const zombie = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId, targetId, kind: 'first-deploy' })
      expect(zombie.ok).toBe(true)
      if (!zombie.ok) return

      await renderPage(root, sys.client, projectId)
      const btn = findButton(container, '部署')
      expect(btn?.textContent).toContain('部署进行中') // still honest: a run is active

      // clicking the busy button must NOT stack another deploy — it opens the
      // active run's overlay instead (and the popup must actually appear)
      await act(async () => {
        btn!.click()
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100))
      })
      expect(container.textContent ?? '').toContain('部署进度')
      // no extra run was created by the click
      const runs = await sys.client.call('deploy.list', { projectId, limit: 50 })
      expect(runs.ok && runs.value.length).toBe(1)

      // panel-slot remount (what the host does on storage notifications):
      // the overlay survives — feedback is no longer silently wiped
      await act(async () => {
        root.unmount()
      })
      const root2 = createRoot(container as unknown as HTMLDivElement)
      await renderPage(root2, sys.client, projectId)
      expect(container.textContent ?? '').toContain('部署进度')

      // stop the zombie from the overlay → occupancy released → button restored
      await act(async () => {
        findButton(container, '停止部署')!.click()
      })
      expect(await waitForTerminal(sys, zombie.value.runId)).toBe('STOPPED')
      expect(sys.repo.getServerExecState(sys.serverId)?.occupiedByRunId ?? null).toBeNull()
      await act(async () => {
        findButton(container, '关闭')!.click()
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30))
      })
      expect(findButton(container, '部署')?.textContent).toBe('一键部署')
      await act(async () => {
        root2.unmount()
      })
    } finally {
      await dispose(container, root)
    }
  })

  it('optimistic dialog: the overlay appears BEFORE the (slow) redeploy RPC resolves', async () => {
    const { sys, container, root } = await setup()
    try {
      const { projectId } = await saveProject(sys)
      // wrap the client so deploy.redeploy answers after a 2.5s delay —
      // mimicking the real host's seconds-long run creation
      const delayed = new Map<string, Promise<unknown>>()
      const slowClient = {
        call: (endpoint: 'deploy.redeploy', payload: unknown, signal?: AbortSignal) => {
          if (endpoint !== 'deploy.redeploy') return sys.client.call(endpoint, payload as never, signal)
          if (!delayed.has(endpoint)) {
            delayed.set(endpoint, new Promise((resolve) => {
              setTimeout(() => { void sys.client.call(endpoint, payload as never, signal).then(resolve) }, 2500)
            }))
          }
          return delayed.get(endpoint)! as ReturnType<typeof sys.client.call>
        },
      } as unknown as SystemUnderTest['client']

      await renderPage(root, slowClient, projectId)
      const btn = findButton(container, '部署')
      expect(btn?.textContent).toBe('一键部署')
      const t0 = Date.now()
      await act(async () => {
        btn!.click()
      })
      // measured immediately after the click: the pending dialog must already
      // be up (the old code awaited the RPC first → seconds of dead click)
      const appearMs = Date.now() - t0
      expect(container.textContent ?? '').toContain('部署进度')
      expect(container.textContent ?? '').toContain('正在启动部署')
      expect(appearMs).toBeLessThan(500)
      // when the RPC resolves, the overlay re-binds to the real run
      await act(async () => {
        await new Promise((r) => setTimeout(r, 2800))
      })
      expect(container.textContent ?? '').toMatch(/部署进度|部署未能启动/)
      expect(container.textContent ?? '').not.toContain('正在启动部署')
      // leave a clean overlay state for other tests
      await act(async () => {
        findButton(container, '关闭')!.click()
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30))
      })
    } finally {
      await dispose(container, root)
    }
  })

  it('occupancy conflict at creation closes the run as FAILED (no zombie QUEUED run)', async () => {
    const { sys, container, root } = await setup()
    try {
      const { projectId, targetId } = await saveProject(sys)
      const first = await sys.client.call('deploy.create', { requestId: newRequestId(), projectId, targetId, kind: 'first-deploy' })
      expect(first.ok).toBe(true)

      // a second deploy on the same server must fail AND leave no new active run
      const second = await sys.client.call('deploy.redeploy', { projectId })
      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.error.code).toBe('task-occupied')

      const runs = await sys.client.call('deploy.list', { projectId, limit: 50 })
      if (runs.ok) {
        const active = runs.value.filter((r) => !['SUCCEEDED', 'FAILED', 'STOPPED'].includes(r.status))
        // only the legitimate first holder is active; the conflicting attempt
        // was closed as FAILED instead of lingering as a second QUEUED run
        expect(active.length).toBe(1)
        expect(active[0]!.runId).toBe(first.ok ? first.value.runId : '')
        expect(runs.value.find((r) => r.status === 'FAILED')?.failureReason ?? '').toMatch(/occupancy/)
      }
    } finally {
      await dispose(container, root)
    }
  })

  it('AI repair rescues a dirty-worktree deploy — failure is only declared when AI cannot fix it', async () => {
    const { execSync } = await import('node:child_process')
    const { mkdtempSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const { ScriptedAgent } = await import('../helpers/system.ts')
    const sys = await buildSystem({ modelRef: 'test/model', agent: new ScriptedAgent('git stash push -m dsh-devops-repair') })
    const container = doc.createElement('div')
    doc.body.appendChild(container)
    const root = createRoot(container as unknown as HTMLDivElement)
    try {
      // real git repo under the fake-ssh sandbox; tracked file dirtied locally
      const gitEnv = { ...process.env, HOME: sys.rootDir }
      const origin = mkdtempSync(joinPath(sys.rootDir, 'origin-'))
      execSync('git init -b main', { cwd: origin, stdio: 'ignore', env: gitEnv })
      execSync('git config user.email t@t && git config user.name t', { cwd: origin, stdio: 'ignore' })
      execSync('echo v1 > app.txt && git add . && git commit -qm v1', { cwd: origin, stdio: 'ignore' })
      const codeDir = joinPath(sys.rootDir, 'dirty-app')
      execSync(`git clone --quiet ${origin} ${codeDir}`, { env: gitEnv, stdio: 'ignore' })
      execSync('git config user.email t@t && git config user.name t', { cwd: codeDir, stdio: 'ignore' })
      execSync('echo local-change >> app.txt', { cwd: codeDir, stdio: 'ignore' })

      const saved = await sys.client.call('projects.save', {
        name: 'ai-repair-proj', repoUrl: origin, branch: 'main',
        targets: [{ serverId: sys.serverId, codeDir }],
      })
      expect(saved.ok).toBe(true)
      if (!saved.ok) return
      const res = await sys.client.call('deploy.redeploy', { projectId: saved.value.id })
      expect(res.ok).toBe(true)
      if (!res.ok) return

      // precheck fails (dirty) → AI repair (stash) → pipeline re-runs → success
      const status = await waitForTerminal(sys, res.value.runId)
      expect(status).toBe('SUCCEEDED')
      // the local change is PRESERVED in the stash, not destroyed
      const stashes = execSync('git stash list', { cwd: codeDir, env: gitEnv }).toString()
      expect(stashes).toContain('dsh-devops-repair')
      // events prove the repair loop ran
      const events = await sys.client.call('deploy.events', { runId: res.value.runId, afterSequence: 0 })
      const types = events.ok ? events.value.map((e) => e.type) : []
      expect(types).toContain('ENTER_REPAIR')
      expect(types).toContain('RESUME_FROM_REPAIR')
      expect(types).toContain('ALREADY_LATEST')
    } finally {
      await dispose(container, root)
    }
  }, 25_000)

  it('no model configured → the failure is honest and names the missing AI repair', async () => {
    const { execSync } = await import('node:child_process')
    const { mkdtempSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const { sys, container, root } = await setup() // no agent, no modelRef
    try {
      const gitEnv = { ...process.env, HOME: sys.rootDir }
      const origin = mkdtempSync(joinPath(sys.rootDir, 'origin-'))
      execSync('git init -b main', { cwd: origin, stdio: 'ignore', env: gitEnv })
      execSync('git config user.email t@t && git config user.name t', { cwd: origin, stdio: 'ignore' })
      execSync('echo v1 > app.txt && git add . && git commit -qm v1', { cwd: origin, stdio: 'ignore' })
      const codeDir = joinPath(sys.rootDir, 'dirty-app')
      execSync(`git clone --quiet ${origin} ${codeDir}`, { env: gitEnv, stdio: 'ignore' })
      execSync('echo local-change >> app.txt', { cwd: codeDir, stdio: 'ignore' })

      const saved = await sys.client.call('projects.save', {
        name: 'no-model-proj', repoUrl: origin, branch: 'main',
        targets: [{ serverId: sys.serverId, codeDir }],
      })
      expect(saved.ok).toBe(true)
      if (!saved.ok) return
      const res = await sys.client.call('deploy.redeploy', { projectId: saved.value.id })
      expect(res.ok).toBe(true)
      if (!res.ok) return

      expect(await waitForTerminal(sys, res.value.runId)).toBe('FAILED')
      const run = await sys.client.call('deploy.get', { runId: res.value.runId })
      expect(run.ok && run.value ? run.value.failureReason ?? '' : '').toMatch(/未配置 AI 模型，无法自动修复/)
    } finally {
      await dispose(container, root)
    }
  }, 25_000)
})
