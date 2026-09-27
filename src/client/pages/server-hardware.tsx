/**
 * Server detail · hardware tab (IMPROVE §4.2): utilization donuts + big
 * numbers up top (CPU / memory / disk / network IO), history line chart
 * below. Data comes from stored samples (monitoring.history, read-only);
 * 立即检查 forces one live collection.
 * 数据接入 useCachedPageData：进入即显上次数据（模块级页面缓存），保留 30s
 * 轮询；缓存按 (server, 时间窗口) 两个维度存，切换窗口 / 切回页面都即时显示
 * 对应数据。
 */
import { createElement, useState } from 'react'
import type { ReactElement } from 'react'
import type { OpsClient } from '../model.ts'
import { cardStyle, badge, errText } from '../hooks.ts'
import { useCachedPageData } from '../page-cache.ts'
import { Donut, BigNumber, LineChart, type LineSeries } from '../charts.tsx'
import { colors, radii, formatBytes, formatRate, formatPercent, timeAgo, utilizationColor } from '../theme.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
function h(tag: any, props: any, ...children: any[]): ReactElement {
  return createElement(tag, props, ...children)
}

interface Sample {
  cpuPercent: number | null
  cpuWindowMs: number | null
  cpuCores: number | null
  memoryTotalBytes: number | null
  memoryUsedBytes: number | null
  swapTotalBytes: number | null
  swapUsedBytes: number | null
  netRecvBytesPerSec: number | null
  netSentBytesPerSec: number | null
  mounts: Array<{ path: string; totalBytes: number | null; usedBytes: number | null }>
  collectedAt: number
}

const RANGES: Array<{ label: string; minutes: number }> = [
  { label: '30 分钟', minutes: 30 },
  { label: '1 小时', minutes: 60 },
  { label: '6 小时', minutes: 360 },
  { label: '24 小时', minutes: 1440 },
]

export function ServerHardwarePage({ client, serverId }: { client: OpsClient; serverId: string }): ReactElement {
  const [rangeMinutes, setRangeMinutes] = useState(60)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set())

  // 进入即显缓存 + 保留 30s 轮询；monitoring.history 无 force 参数，fetcher 忽略 force
  const { data: history, error: historyError, refresh: reloadHistory } = useCachedPageData<{ samples: Sample[] }>(
    `hardware:${serverId}:${rangeMinutes}`,
    () => client.call('monitoring.history', { serverId, rangeMinutes }).then((r) => (r.ok ? { ok: true as const, value: r.value as { samples: Sample[] } } : { ok: false as const, error: r.error })),
    { intervalMs: 30_000 },
  )

  const latest = history?.samples.at(-1) ?? null
  const memPercent = latest && latest.memoryTotalBytes ? ((latest.memoryUsedBytes ?? 0) / latest.memoryTotalBytes) * 100 : null
  const rootMount = latest?.mounts.find((m) => m.path === '/') ?? latest?.mounts[0] ?? null
  const diskPercent = rootMount && rootMount.totalBytes ? ((rootMount.usedBytes ?? 0) / rootMount.totalBytes) * 100 : null
  const otherMounts = latest?.mounts.filter((m) => m !== rootMount) ?? []

  const doCheck = async (): Promise<void> => {
    setChecking(true)
    setCheckError(null)
    const res = await client.call('monitoring.hardware', { serverId })
    setChecking(false)
    if (!res.ok) setCheckError(`${res.error.code}: ${res.error.message}`)
    else {
      const value = res.value as { analysisState: string }
      if (value.analysisState !== 'complete') setCheckError(`本次采集未成功（状态 ${value.analysisState}）——请检查服务器连接与凭据`)
    }
    void reloadHistory() // 后台静默刷新历史曲线，不遮蔽当前数据
  }

  const samples = history?.samples ?? []
  const mk = (name: string, color: string, pick: (s: Sample) => number | null): LineSeries => ({
    name, color, points: samples.map((s) => ({ x: s.collectedAt, y: pick(s) })),
  })
  // percent series and network-rate series get separate charts — a shared
  // linear axis would flatten the 0-100% lines under thousands of KiB/s
  const utilSeries: LineSeries[] = [
    mk('CPU %', colors.primary, (s) => s.cpuPercent),
    mk('内存 %', colors.warn, (s) => (s.memoryTotalBytes ? ((s.memoryUsedBytes ?? 0) / s.memoryTotalBytes) * 100 : null)),
    mk('磁盘 / %', colors.ok, (s) => {
      const m = s.mounts.find((mm) => mm.path === '/') ?? s.mounts[0]
      return m && m.totalBytes ? ((m.usedBytes ?? 0) / m.totalBytes) * 100 : null
    }),
  ].filter((s) => !hiddenSeries.has(s.name))
  const netSeries: LineSeries[] = [
    mk('↓ 网络 KiB/s', '#8b5cf6', (s) => (s.netRecvBytesPerSec !== null ? s.netRecvBytesPerSec / 1024 : null)),
    mk('↑ 网络 KiB/s', '#ec4899', (s) => (s.netSentBytesPerSec !== null ? s.netSentBytesPerSec / 1024 : null)),
  ].filter((s) => !hiddenSeries.has(s.name))

  const toggleSeries = (name: string): void => {
    setHiddenSeries((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const utilLegend = ['CPU %', '内存 %', '磁盘 / %']
  const netLegend = ['↓ 网络 KiB/s', '↑ 网络 KiB/s']

  return h('div', null,
    // toolbar
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' as const } },
      h('div', { style: { display: 'flex', gap: 4, background: colors.surface, borderRadius: radii.md, padding: 3 } },
        RANGES.map((r) => h('button', {
          key: r.minutes,
          onClick: () => setRangeMinutes(r.minutes),
          style: {
            padding: '5px 14px', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: radii.sm - 3, cursor: 'pointer',
            color: 'inherit', background: rangeMinutes === r.minutes ? colors.primary : 'transparent',
          },
        }, r.label)),
      ),
      h('span', { style: { flex: 1 } }),
      latest ? h('span', { style: { fontSize: 11, color: colors.muted } }, `采集于 ${timeAgo(latest.collectedAt)}`) : null,
      h('button', { className: 'dsh-btn', onClick: () => void doCheck(), disabled: checking, style: { padding: '6px 16px', borderRadius: radii.sm, border: `1px solid ${colors.primaryBorder}`, background: colors.primarySoft, cursor: 'pointer', fontWeight: 600, color: 'inherit' } }, checking ? '采集中…' : '立即检查'),
    ),
    historyError ? errText(historyError) : null,
    checkError ? errText(checkError) : null,

    // metric cards (top of the page, IMPROVE R2)
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 16 } },
      h('div', { className: 'dsh-card', style: { ...cardStyle, display: 'flex', justifyContent: 'center', padding: 14 } },
        h(Donut, { percent: latest?.cpuPercent ?? null, label: `CPU 占用${latest?.cpuCores ? ` · ${latest.cpuCores} 核` : ''}`, size: 116 })),
      h('div', { className: 'dsh-card', style: { ...cardStyle, display: 'flex', justifyContent: 'center', padding: 14 } },
        h(Donut, { percent: memPercent, label: '内存占用', sub: latest?.memoryTotalBytes ? `${formatBytes(latest.memoryUsedBytes ?? 0, 0)} / ${formatBytes(latest.memoryTotalBytes, 0)}` : undefined, size: 116 })),
      h('div', { className: 'dsh-card', style: { ...cardStyle, display: 'flex', justifyContent: 'center', padding: 14 } },
        h(Donut, { percent: diskPercent, label: `磁盘 ${rootMount?.path ?? ''}`, sub: rootMount && rootMount.totalBytes ? `${formatBytes(rootMount.usedBytes ?? 0, 0)} / ${formatBytes(rootMount.totalBytes, 0)}` : undefined, size: 116 })),
      h('div', { className: 'dsh-card', style: { ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-around', padding: 14 } },
        h(BigNumber, { value: latest?.netRecvBytesPerSec ?? null, unit: '接收', label: '网络 ↓', color: colors.primary }),
        h(BigNumber, { value: latest?.netSentBytesPerSec ?? null, unit: '发送', label: '网络 ↑', color: '#ec4899' }),
      ),
    ),
    // swap + other mounts strip
    latest
      ? h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' as const, marginBottom: 16, fontSize: 12 } },
          latest.swapTotalBytes
            ? badge(`Swap ${formatBytes(latest.swapUsedBytes ?? 0, 1)} / ${formatBytes(latest.swapTotalBytes, 1)}`, (latest.swapUsedBytes ?? 0) / latest.swapTotalBytes > 0.8 ? 'warn' : 'muted')
            : null,
          otherMounts.map((m) => {
            const pct = m.totalBytes ? ((m.usedBytes ?? 0) / m.totalBytes) * 100 : null
            return badge(`${m.path} ${formatPercent(pct, 0)}`, utilizationColor(pct) === colors.err ? 'err' : utilizationColor(pct) === colors.warn ? 'warn' : 'muted')
          }),
        )
      : null,

    // history charts (percent + network, IMPROVE R2)
    h('div', { className: 'dsh-card', style: cardStyle },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
        h('div', { style: { fontSize: 14, fontWeight: 700 } }, '占用率历史（%）'),
        h('span', { style: { flex: 1 } }),
        utilLegend.map((name) => h('button', {
          key: name,
          onClick: () => toggleSeries(name),
          style: {
            fontSize: 11, padding: '2px 10px', borderRadius: radii.pill, cursor: 'pointer',
            border: `1px solid ${hiddenSeries.has(name) ? colors.borderStrong : 'transparent'}`,
            background: hiddenSeries.has(name) ? 'transparent' : colors.surfaceStrong,
            color: 'inherit', textDecoration: hiddenSeries.has(name) ? 'line-through' : 'none',
          },
        }, name)),
      ),
      h(LineChart, { series: utilSeries, height: 180, formatY: (v: number) => `${Math.round(v)}%` }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 10px' } },
        h('div', { style: { fontSize: 14, fontWeight: 700 } }, '网络吞吐历史（KiB/s）'),
        h('span', { style: { flex: 1 } }),
        netLegend.map((name) => h('button', {
          key: name,
          onClick: () => toggleSeries(name),
          style: {
            fontSize: 11, padding: '2px 10px', borderRadius: radii.pill, cursor: 'pointer',
            border: `1px solid ${hiddenSeries.has(name) ? colors.borderStrong : 'transparent'}`,
            background: hiddenSeries.has(name) ? 'transparent' : colors.surfaceStrong,
            color: 'inherit', textDecoration: hiddenSeries.has(name) ? 'line-through' : 'none',
          },
        }, name)),
      ),
      h(LineChart, { series: netSeries, height: 140, formatY: (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(1)}M` : `${Math.round(v)}`) }),
    ),
  )
}
