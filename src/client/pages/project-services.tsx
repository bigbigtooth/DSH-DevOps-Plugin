/**
 * Project detail · services tab.
 * - READABLE summary: big stat tiles (running processes / CPU / memory / code
 *   dir / logs) instead of the old 11px badges (IMPROVE §4.4 feedback).
 * - Host-cached process view: entering shows the last snapshot instantly and
 *   displays its update time; the 刷新 button forces a fresh SSH collection.
 * - the 🚀 部署 action and the deployment log moved to the dedicated 部署 tab
 *   (project-deploy.tsx); this tab keeps only the one-line deploy status.
 * Below: reverse-proxy cards, then one big card per running process with live
 * CPU sparklines.
 */
import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { OpsClient } from '../model.ts'
import { usePoll, cardStyle, badge, errText } from '../hooks.ts'
import { useCachedPageData } from '../page-cache.ts'
import { BigNumber, Sparkline } from '../charts.tsx'
import { Icon, type IconName } from '../icons.tsx'
import { knownApp, launchModeLabel } from '../known-apps.ts'
import { colors, radii, formatBytes, formatPercent, timeAgo } from '../theme.ts'
import { stageLabel, statusLabel, type RunRow } from './project-deploy.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */
function h(tag: any, props: any, ...children: any[]): ReactElement {
  return createElement(tag, props, ...children)
}

interface ProcessRow {
  pid: number
  name: string
  user: string
  rssBytes: number | null
  cpuPercent: number | null
  state: string
  command: string
  cwd: string | null
  ioReadBytesPerSec: number | null
  ioWriteBytesPerSec: number | null
  launchMode: string | null
}

interface ProjectProcessesResponse {
  collectedAt: number | null
  services: Array<{
    spec: { name: string; manager: string; managerId: string }
    processes: ProcessRow[]
    aggregate: { cpuPercent: number | null; rssBytes: number | null; ioReadBytesPerSec: number | null; ioWriteBytesPerSec: number | null }
    status: 'running' | 'stopped' | 'unknown'
  }>
  unlinked: ProcessRow[]
  proxies: Array<{ server: string; configPath: string; serverNames: string[] }>
  codeDirBytes: number | null
  logBytes: number | null
}

/** client-side rolling series (per pid) built from polled samples */
const SERIES_LIMIT = 60

export function ProjectServicesPage({ client, projectId }: { client: OpsClient; projectId: string }): ReactElement {
  // 进程视图：宿主侧已有缓存（plain read 即返回上次快照）；客户端再缓存一层
  // （key `projectServices:${projectId}`），切 tab 回来立即显示上次数据、后台
  // 静默刷新，避免闪白。保留 5s 轮询驱动 CPU 实时趋势。
  const { data, refresh, error } = useCachedPageData<ProjectProcessesResponse>(
    `projectServices:${projectId}`,
    (opts) => client.call('monitoring.projectProcesses', { projectId, force: opts.force }),
    { intervalMs: 5000 },
  )
  // runs only feed the one-line deploy status; the action + full log live in
  // the dedicated 部署 tab
  const [runsState] = usePoll<RunRow[]>(`deploy.list:${projectId}`,
    () => client.call('deploy.list', { projectId, limit: 20 }).then((r) => (r.ok ? (r.value as RunRow[]) : Promise.resolve([] as RunRow[]))),
    4000,
    [projectId],
  )
  const runs = runsState ?? []
  const [refreshing, setRefreshing] = useState(false)
  const historyRef = useRef<Map<number, number[]>>(new Map())

  const activeRun = runs.find((r) => ['RUNNING', 'QUEUED', 'REPAIRING', 'STOPPING', 'RECONCILE_REQUIRED'].includes(r.status))
  const latestRun = runs[0]
  const deploying = activeRun !== undefined

  /** 强制宿主同步重算（force=true 透传），返回即为新数据并写入页面缓存。 */
  const forceRefresh = (): void => {
    setRefreshing(true)
    void refresh(true).finally(() => setRefreshing(false))
  }

  // feed live sparkline history keyed by pid
  useEffect(() => {
    if (!data) return
    const all = [...data.services.flatMap((s) => s.processes), ...data.unlinked]
    for (const p of all) {
      const list = historyRef.current.get(p.pid) ?? []
      list.push(p.cpuPercent ?? 0)
      if (list.length > SERIES_LIMIT) list.shift()
      historyRef.current.set(p.pid, list)
    }
  }, [data])

  const rows = data
    ? [
        ...data.services.flatMap((s) => s.processes.map((p) => ({ p, service: s.spec.name }))),
        ...data.unlinked.map((p) => ({ p, service: null as string | null })),
      ]
    : []
  const runningServices = (data?.services ?? []).filter((s) => s.status === 'running').length
  const totalServices = (data?.services ?? []).length
  const totalCpu = rows.reduce((a, r) => a + (r.p.cpuPercent ?? 0), 0)
  const totalRss = rows.reduce((a, r) => a + (r.p.rssBytes ?? 0), 0)

  return h('div', { className: 'dsh-anim-page' },
    // ---- top action bar: update time on the left, 刷新 as a small icon in
    // the top-right corner (the old text button crowded the toolbar) ----
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' as const } },
      h('span', { style: { fontSize: 13, color: colors.muted }, title: data?.collectedAt ? new Date(data.collectedAt).toLocaleString() : '' },
        data?.collectedAt ? `数据更新：${timeAgo(data.collectedAt)}` : data === null ? '采集中…' : '暂无数据'),
      h('span', { style: { flex: 1 } }),
      h('button', {
        className: 'dsh-btn',
        disabled: refreshing,
        onClick: () => void forceRefresh(),
        title: '立即通过 SSH 重新采集进程数据',
        'aria-label': '刷新',
        style: { width: 34, height: 34, borderRadius: radii.pill, border: `1px solid ${colors.borderStrong}`, background: 'transparent', cursor: refreshing ? 'default' : 'pointer', color: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      }, h(Icon, { name: 'refresh', size: 18, className: refreshing ? 'dsh-spin' : undefined })),
    ),

    // ---- readable summary tiles (IMPROVE §4.4) ----
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 18 } },
      h(StatTile, { icon: 'activity', label: '运行进程', value: String(rows.length), sub: `服务 ${runningServices}/${totalServices}`, tone: rows.length > 0 ? 'ok' : 'muted' }),
      h(StatTile, { icon: 'cpu', label: 'CPU 合计', value: formatPercent(totalCpu, 1), sub: '单核口径求和', tone: totalCpu > 80 ? 'err' : 'primary' }),
      h(StatTile, { icon: 'memory', label: '内存合计', value: formatBytes(totalRss, 1).split(' ')[0]!, unit: formatBytes(totalRss, 1).split(' ')[1], sub: 'RSS 求和', tone: 'primary' }),
      data?.codeDirBytes != null ? h(StatTile, { icon: 'folder', label: '代码目录', value: formatBytes(data.codeDirBytes, 1).split(' ')[0]!, unit: formatBytes(data.codeDirBytes, 1).split(' ')[1], sub: 'du 缓存 5 分钟', tone: 'muted' }) : null,
      data?.logBytes != null ? h(StatTile, { icon: 'file-text', label: '日志合计', value: formatBytes(data.logBytes, 1).split(' ')[0]!, unit: formatBytes(data.logBytes, 1).split(' ')[1], sub: '所有来源求和', tone: 'muted' }) : null,
    ),

    error ? h('div', { style: { marginBottom: 12 } }, errText(error)) : null,

    // ---- deployment status line (action + log live in the 部署 tab) ----
    deploying || latestRun
      ? h('div', { style: { fontSize: 13, color: colors.muted, marginTop: -8, marginBottom: 14 } },
          deploying
            ? h('span', null, h('b', { style: { color: colors.primary } }, '部署中：'), `${stageLabel(activeRun?.stage || '')} · ${statusLabel(activeRun?.status ?? '')}`)
            : latestRun
              ? h('span', null, '最近部署：', badge(statusLabel(latestRun.status), latestRun.status === 'SUCCEEDED' ? 'ok' : latestRun.status === 'FAILED' ? 'err' : 'muted'), latestRun.targetCommit ? ` · ${latestRun.targetCommit.slice(0, 8)}` : '', '（部署操作与日志见“部署”标签）')
              : null)
      : null,

    // ---- reverse proxies pointing at the project ----
    (data?.proxies ?? []).length > 0
      ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 16 } },
          (data?.proxies ?? []).map((px, i) => h('div', { key: i, className: 'dsh-card', style: { ...cardStyle, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h(Icon, { name: px.server === 'nginx' ? 'globe' : 'feather', size: 22, color: colors.primary }),
              h('span', { style: { fontWeight: 700, fontSize: 14, textTransform: 'capitalize' } }, px.server),
              badge('反代指向本项目', 'primary'),
            ),
            px.serverNames.length ? h('div', { style: { fontSize: 12.5 } }, '域名：', px.serverNames.map((n) => h('code', { key: n, style: { marginRight: 8, fontSize: 12 } }, n))) : null,
            h('div', { style: { fontSize: 11, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: px.configPath }, px.configPath),
          )),
        )
      : null,

    // ---- ONE BIG CARD PER RUNNING PROCESS ----
    rows.map(({ p, service }, i) => {
      const app = knownApp(p.name)
      const known = app.label !== p.name
      const cpuHistory = historyRef.current.get(p.pid) ?? []
      return h('div', { key: `${p.pid}-${i}`, className: 'dsh-card dsh-anim-card', style: { ...cardStyle, animationDelay: `${Math.min(i, 8) * 40}ms`, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const } },
          h('span', { style: { display: 'inline-flex', width: 34, height: 34, borderRadius: radii.sm, background: colors.surface, alignItems: 'center', justifyContent: 'center' } },
            h(Icon, { name: app.icon, size: 24, color: colors.primary })),
          h('span', { style: { fontSize: 17, fontWeight: 700 } }, known ? app.label : p.name),
          known ? h('span', { style: { fontSize: 12, color: colors.muted } }, p.name) : null,
          service ? badge(service === '进程' ? '默认进程分组' : `服务 ${service}`, 'primary') : null,
          badge(`PID ${p.pid}`, 'muted'),
          badge(`启动：${launchModeLabel(p.launchMode)}`, p.launchMode === 'supervisor' || p.launchMode === 'pm2' ? 'primary' : p.launchMode === 'sh-script' ? 'ok' : 'muted'),
          badge(p.state.startsWith('Z') ? '僵尸进程' : '运行中', p.state.startsWith('Z') ? 'err' : 'ok'),
          h('span', { style: { flex: 1 } }),
          h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 } },
            h('span', { style: { fontSize: 10, color: colors.muted } }, 'CPU 实时趋势'),
            h(Sparkline, { values: cpuHistory, width: 140, height: 30, color: colors.primary }),
          ),
        ),
        h('div', { style: { display: 'flex', gap: 28, flexWrap: 'wrap' as const } },
          h(BigNumber, { value: p.cpuPercent, unit: '%（单核口径）', label: 'CPU 占用', digits: 1, color: (p.cpuPercent ?? 0) > 80 ? colors.err : 'inherit' }),
          h(BigNumber, { value: p.rssBytes !== null ? p.rssBytes / (1024 * 1024 * 1024) : null, unit: 'GiB', label: '内存 RSS', digits: 2 }),
          h(BigNumber, { value: p.ioReadBytesPerSec !== null ? p.ioReadBytesPerSec / 1024 : null, unit: 'KiB/s ↓IO', label: '磁盘读', digits: 0 }),
          h(BigNumber, { value: p.ioWriteBytesPerSec !== null ? p.ioWriteBytesPerSec / 1024 : null, unit: 'KiB/s ↑IO', label: '磁盘写', digits: 0 }),
          h(BigNumber, { value: null, unit: `用户 ${p.user}`, label: p.cwd ? `cwd ${p.cwd}` : 'cwd 不可读', digits: 0 }),
        ),
        h('div', { style: { fontSize: 12, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: p.command }, p.command || '—'),
      )
    }),
    !data && !error ? h('div', { style: { color: colors.muted, padding: 24, textAlign: 'center' } }, '首次采集中（通过 SSH 拉取进程快照，稍候自动缓存）…') : null,
    data && rows.length === 0 ? h('div', { style: { ...cardStyle, color: colors.warn, textAlign: 'center', padding: 28 } }, '未发现本项目运行中的进程——服务可能已停止，或进程未在注册的代码目录下启动') : null,
  )
}

// ---------- summary tile (readable big numbers) ----------

function StatTile({ icon, label, value, unit, sub, tone = 'muted' }: { icon: IconName; label: string; value: string; unit?: string; sub?: string; tone?: 'ok' | 'err' | 'primary' | 'muted' }): ReactElement {
  const fg = tone === 'ok' ? colors.ok : tone === 'err' ? colors.err : tone === 'primary' ? colors.primary : 'inherit'
  return h('div', { className: 'dsh-card', style: { ...cardStyle, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600, color: colors.muted } },
      h(Icon, { name: icon, size: 22, color: colors.primary }), label),
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' as const } },
      h('span', { style: { fontSize: 30, fontWeight: 800, lineHeight: 1.05, color: fg, fontVariantNumeric: 'tabular-nums' } }, value),
      unit ? h('span', { style: { fontSize: 15, fontWeight: 600, color: fg } }, unit) : null,
    ),
    sub ? h('div', { style: { fontSize: 12, color: colors.muted } }, sub) : null,
  )
}

// ---------- style helpers ----------

