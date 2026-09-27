/**
 * UI smoke (IMPROVE M8): render the overhauled OpsApp in happy-dom with a
 * fake client and walk the full navigation the requirements demand:
 * 服务器卡片 → 服务器详情(硬件/进程) → 返回；项目卡片 → 项目详情(服务/日志)。
 * Verifies the 监控 root tab is gone and 项目 is present.
 *
 * @vitest-environment happy-dom
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

// happy-dom 环境下显式声明 act 支持，消除 React 的环境告警
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { OpsApp } from '../../src/client/pages/app.tsx'
import { ServerProcessesPage } from '../../src/client/pages/server-processes.tsx'
import { OpsClient, OpsStore, type ConnectionFace } from '../../src/client/model.ts'
import { clearPageCache } from '../../src/client/page-cache.ts'

const NOW = Date.now()

const SERVER_DTO = {
  schemaVersion: 1, id: 'srv1', revision: 1, alias: 'web-01', endpoint: 'root@1.2.3.4:22',
  sshOptions: { host: '1.2.3.4', port: 22, user: 'root', authKind: 'password', jumpHosts: [], extraOptions: {} },
  credentialRefs: [], configHash: 'h', hostFingerprint: 'SHA256:abcdef',
  capabilities: { platform: 'linux', osRelease: 'Ubuntu', arch: 'x86_64', shell: '/bin/sh', probes: {}, probedAt: 1 },
  createdAt: 1, updatedAt: 1, credentials: [],
}

const SAMPLE = {
  cpuPercent: 23.4, cpuWindowMs: 300, cpuCores: 8,
  memoryTotalBytes: 16 * 1024 ** 3, memoryUsedBytes: 10 * 1024 ** 3,
  swapTotalBytes: null, swapUsedBytes: null,
  netRecvBytesPerSec: 1024 * 128, netSentBytesPerSec: 1024 * 36,
  mounts: [{ path: '/', totalBytes: 500 * 1024 ** 3, usedBytes: 235 * 1024 ** 3 }],
  collectedAt: NOW, unitNotes: '',
}

/** 进程行的最小形状（进程页 / 项目服务页共用） */
function mkProc(pid: number, name: string, cwd: string | null): Record<string, unknown> {
  return {
    pid, name, user: 'u', rssBytes: 1024 * 1024, cpuPercent: 5, startedAt: null, elapsedSeconds: null,
    state: 'S', startToken: `t${pid}`, ppid: 1, command: `/usr/bin/${name}`, cwd, ioReadBytesPerSec: null, ioWriteBytesPerSec: null,
  }
}

/** canned responses keyed by endpoint; anything else returns empty ok */
function makeResponses(): Record<string, unknown> {
  const project = {
    schemaVersion: 1, id: 'prj1', revision: 1, name: 'dsh-site', repoUrl: 'git@x:y.git', branch: 'main',
    targets: [{ id: 'tgt1', serverId: 'srv1', codeDir: '/srv/dsh-site', services: [{ name: 'web', manager: 'supervisor', managerId: 'web' }], gitCredentialRef: null, sudoCredentialRef: null, healthCheck: null, createdAt: 1, updatedAt: 1 }],
    createdAt: 1, updatedAt: 1,
  }
  const proc = (pid: number, name: string, cwd: string | null) => mkProc(pid, name, cwd)
  return {
    'servers.overview': [{ server: SERVER_DTO, latestSample: SAMPLE, lastCollectedAt: NOW, alertCount: { critical: 1, warning: 2 } }],
    'servers.list': [SERVER_DTO],
    'projects.list': [project],
    'projects.overview': [{
      project, lastRun: null,
      serviceHealth: { running: 1, total: 1 },
      aggregate: { cpuPercent: 12.5, rssBytes: 1024 ** 3 },
      alertCount: { critical: 0, warning: 0 },
    }],
    'deploy.list': [],
    'monitoring.history': { samples: [SAMPLE, { ...SAMPLE, cpuPercent: 40, collectedAt: NOW + 1000 }] },
    'monitoring.processes': {
      snapshotId: 'snap1', collectedAt: NOW,
      processes: [proc(2, 'systemd', '/'), proc(3, 'mysqld', '/var/lib/mysql'), proc(4, 'node', '/srv/dsh-site')],
      groups: [
        { kind: 'system', title: '系统应用', cwd: null, projectId: null, processes: [proc(2, 'systemd', '/')] },
        { kind: 'common', title: '常见通用软件服务', cwd: null, projectId: null, processes: [proc(3, 'mysqld', '/var/lib/mysql')] },
        { kind: 'private', title: '/srv/dsh-site', cwd: '/srv/dsh-site', projectId: 'prj1', processes: [proc(4, 'node', '/srv/dsh-site')] },
      ],
      analysisState: 'pending', coverage: { analyzed: 0, total: 3 }, findings: [],
    },
    'monitoring.projectProcesses': {
      collectedAt: NOW,
      services: [{ spec: { name: 'web', manager: 'supervisor', managerId: 'web' }, processes: [proc(4, 'web', '/srv/dsh-site')], aggregate: { cpuPercent: 38.4, rssBytes: 1.8 * 1024 ** 3, ioReadBytesPerSec: 12 * 1024, ioWriteBytesPerSec: 3 * 1024 }, status: 'running' }],
      unlinked: [], proxies: [], codeDirBytes: 2.3 * 1024 ** 3, logBytes: 412 * 1024 ** 2,
    },
    'monitoring.logTail': {
      sources: [{ sourceId: 'log1', service: 'web', path: '/srv/dsh-site/logs/web.log', status: 'active', sizeBytes: 412 * 1024 ** 2, serverId: 'srv1', lastModifiedAt: NOW }],
      alerts: [{ alertId: 'a1', severity: 'critical', summary: 'connection refused', count: 37, evidenceRef: null }],
      stats: [{ sourceId: 'log1', linesPerMinute: 120, levelCount: { error: 37, warn: 112, info: 8200 } }],
      tail: [{ sourceId: 'log1', line: 'ERROR connection refused', level: 'error', at: NOW }],
      meta: [{ sourceId: 'log1', sizeBytes: 412 * 1024 ** 2, lastModifiedAt: NOW }],
    },
    'monitoring.logs': { sources: [], alerts: [] },
    'monitoring.inspect': { runId: 'r1' },
    'deploy.events': [],
  }
}

/** 按端点固定应答的假 client（可记录调用，供断言 force 等参数） */
function makeClientFromResponses(responses: Record<string, unknown>, calls?: Array<{ endpoint: string; payload: unknown }>): OpsClient {
  const connection: ConnectionFace = {
    rpc: {
      async call(_channel, endpoint, payload) {
        calls?.push({ endpoint, payload })
        const value = responses[endpoint] ?? (endpoint.endsWith('.list') ? [] : {})
        return { ok: true as const, value }
      },
    },
  }
  return new OpsClient(connection)
}

function makeClient(): OpsClient {
  return makeClientFromResponses(makeResponses())
}

async function renderApp(): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(OpsApp, { client: makeClient(), store: new OpsStore() }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  return { container: host, root }
}

function clickByText(container: HTMLElement, selector: string, text: string): void {
  const el = [...container.querySelectorAll(selector)].find((n) => n.textContent?.includes(text))
  if (!el) throw new Error(`no ${selector} with text ${text}`)
  // 用 act 包裹点击：React 18 对 act 环境外触发的状态更新会告警
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('UI smoke: overhauled OpsApp (IMPROVE R1–R5)', () => {
  it('renders server cards (no 监控 root tab), opens detail via card click', async () => {
    const { container, root } = await renderApp()
    const html = container.innerHTML
    expect(html).toContain('服务器')
    expect(html).toContain('项目')
    expect(html).not.toContain('项目运维')
    // R2: the standalone 监控 tab is gone (root tabs only)
    expect(html).not.toContain('>监控<')
    // R1: big card content visible
    expect(html).toContain('web-01')
    expect(html).toContain('严重告警 1')

    // R2/R3: click card → server detail with hardware + processes tabs
    clickByText(container, 'div.dsh-card', 'web-01')
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(container.innerHTML).toContain('← 返回')
    expect(container.innerHTML).toContain('CPU 占用')
    expect(container.innerHTML).toContain('网络 ↓')
    expect(container.innerHTML).toContain('占用率历史')
    expect(container.innerHTML).toContain('网络吞吐历史')

    clickByText(container, 'button', '进程')
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    // 分组类别名（GROUP_META）：客户端展示「程序进程 / 常用软件 / 系统进程 / 其他」，
    // 即使宿主数据里还是旧标题也按客户端映射显示
    expect(container.innerHTML).toContain('系统进程')
    expect(container.innerHTML).toContain('常用软件')
    expect(container.innerHTML).not.toContain('常见通用软件服务')
    expect(container.innerHTML).toContain('/srv/dsh-site')

    // back to the list
    clickByText(container, 'button', '← 返回')
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(container.innerHTML).toContain('web-01')
    void root
  })

  it('renders project cards, opens detail with 服务 and 日志 tabs', async () => {
    const { container } = await renderApp()
    clickByText(container, 'button', '项目')
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(container.innerHTML).toContain('dsh-site')
    expect(container.innerHTML).toContain('1/1')
    expect(container.innerHTML).toContain('运行中')

    clickByText(container, 'div.dsh-card', 'dsh-site')
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    // per-process big cards (二轮 R2): launch mode + big numbers + icon
    expect(container.innerHTML).toContain('运行中')
    expect(container.innerHTML).toContain('PID 4')
    expect(container.innerHTML).toContain('启动：未知')
    expect(container.innerHTML).toContain('内存 RSS')
    expect(container.innerHTML).toContain('磁盘读')
    // the deployment log lives on the dedicated 部署 tab (tab split); the
    // services tab shows the summary tiles and the corner 刷新 icon instead
    expect(container.innerHTML).toContain('运行进程')
    expect(container.innerHTML).toContain('aria-label="刷新"')

    clickByText(container, 'button', '日志')
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    // R5: anomaly banner is loud; dashboard + per-file log cards (二轮 R3)
    expect(container.innerHTML).toContain('⛔ 异常')
    expect(container.innerHTML).toContain('connection refused')
    expect(container.innerHTML).toContain('日志级别分布')
    expect(container.innerHTML).toContain('web.log')
    expect(container.innerHTML).toContain('实时预览')

    // click the log card → modal with live tail + adjustable lines
    clickByText(container, 'div.dsh-card', 'web.log')
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(container.innerHTML).toContain('实时 tail · 每 2 秒刷新')
    expect(container.innerHTML).toContain('ERROR connection refused')
  })
})

describe('进程页：页面缓存 + 分组排序 + force 刷新', () => {
  beforeEach(() => { clearPageCache() })

  async function mountPage(client: OpsClient, serverId: string): Promise<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(ServerProcessesPage, { client, serverId })) })
    return { host, root }
  }

  async function unmountPage(page: { root: ReturnType<typeof createRoot> }): Promise<void> {
    await act(async () => { page.root.unmount() })
  }

  it('写缓存后重新挂载：立即渲染缓存数据（不等 fetch 返回），并提示后台刷新中', async () => {
    // 第一次挂载：正常返回数据，成功后写入模块级页面缓存
    const first = await mountPage(makeClientFromResponses(makeResponses()), 'srv-cache-a')
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(first.host.innerHTML).toContain('/srv/dsh-site')
    await unmountPage(first)

    // 第二次挂载：fetch 永不返回，页面必须立即显示缓存内容而不是空白
    const hung: ConnectionFace = { rpc: { call: () => new Promise<never>(() => undefined) } }
    const second = await mountPage(new OpsClient(hung), 'srv-cache-a')
    expect(second.host.innerHTML).toContain('/srv/dsh-site')
    expect(second.host.innerHTML).toContain('系统进程')
    expect(second.host.innerHTML).not.toContain('采集中')
    // 缓存数据 + 后台静默刷新中 → 轻提示 badge
    expect(second.host.innerHTML).toContain('缓存 · 后台刷新中')
    await unmountPage(second)
  })

  it('分组渲染顺序为 程序进程 → 常用软件 → 系统进程 → 其他（乱序输入客户端兜底排序）', async () => {
    const responses = makeResponses()
    responses['monitoring.processes'] = {
      ...(responses['monitoring.processes'] as Record<string, unknown>),
      groups: [
        { kind: 'other', title: '其他组', cwd: null, projectId: null, processes: [mkProc(9, 'bash', '/usr')] },
        { kind: 'system', title: '系统进程组', cwd: null, projectId: null, processes: [mkProc(2, 'systemd', '/')] },
        { kind: 'common', title: '常用软件组', cwd: null, projectId: null, processes: [mkProc(3, 'mysqld', '/var/lib/mysql')] },
        { kind: 'private', title: '/srv/dsh-site', cwd: '/srv/dsh-site', projectId: 'prj1', processes: [mkProc(4, 'node', '/srv/dsh-site')] },
      ],
    }
    const page = await mountPage(makeClientFromResponses(responses), 'srv-order-b')
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    const html = page.host.innerHTML
    const at = (s: string): number => html.indexOf(s)
    // private 组标题仍显示 cwd 路径且带「已关联项目」徽标，排最前；其后依次是
    // 常用软件 → 系统进程 → 其他（客户端稳定排序兜底）
    expect(at('/srv/dsh-site')).toBeGreaterThan(-1)
    expect(at('已关联项目')).toBeGreaterThan(-1)
    expect(at('/srv/dsh-site')).toBeLessThan(at('常用软件'))
    expect(at('常用软件')).toBeLessThan(at('系统进程'))
    expect(at('系统进程')).toBeLessThan(at('其他'))
    await unmountPage(page)
  })

  it('刷新按钮发起的 monitoring.processes 请求携带 force: true（后台首拉为 false）', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const page = await mountPage(makeClientFromResponses(makeResponses(), calls), 'srv-force-c')
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    const procCalls = (): Array<{ force?: boolean }> =>
      calls.filter((c) => c.endpoint === 'monitoring.processes').map((c) => c.payload as { force?: boolean })
    expect(procCalls().length).toBe(1)
    expect(procCalls()[0]!.force).toBe(false)

    clickByText(page.host, 'button', '刷新')
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(procCalls().length).toBe(2)
    expect(procCalls()[1]!.force).toBe(true)
    await unmountPage(page)
  })
})
