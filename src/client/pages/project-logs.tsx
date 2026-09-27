/**
 * Project detail · logs tab (IMPROVE §4.6 + 二轮 R3): dashboard charts on
 * top (rate + level distribution), then ONE BIG CARD PER LOG FILE with disk
 * usage, last update time, growth rate and anomaly state. Clicking a card
 * opens a modal overlay with a LIVE tail preview (line count adjustable).
 * Log sources include files discovered from the project's own launch
 * commands (cmdline:). Data is repo-read-only + one bounded stat per source,
 * safe to poll every 5s.
 */
import { createElement, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { OpsClient } from '../model.ts'
import { usePoll, cardStyle, badge, errText } from '../hooks.ts'
import { useCachedPageData } from '../page-cache.ts'
import { LineChart, MiniBar, type LineSeries } from '../charts.tsx'
import { Icon } from '../icons.tsx'
import { colors, radii, formatBytes, formatRate, timeAgo } from '../theme.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
function h(tag: any, props: any, ...children: any[]): ReactElement {
  return createElement(tag, props, ...children)
}

interface TailResponse {
  sources: Array<{ sourceId: string; service: string; path: string; status: string; sizeBytes: number | null; lastModifiedAt: number | null; serverId: string; configOrigin: string; userDefined?: boolean }>
  alerts: Array<{ alertId: string; severity: string; summary: string; count: number; evidenceRef: string | null }>
  stats: Array<{ sourceId: string; linesPerMinute: number | null; levelCount: { error: number; warn: number; info: number } }>
  tail: Array<{ sourceId: string; line: string; level: string | null; at: number | null }>
  meta: Array<{ sourceId: string; sizeBytes: number | null; lastModifiedAt: number | null }>
}

const TAIL_LINE_OPTIONS = [50, 100, 200, 500]

/** survives panel slot remounts so the preview modal is not silently closed */
let persistedPreview: { sourceId: string; path: string; service: string } | null = null

export function ProjectLogsPage({ client, projectId }: { client: OpsClient; projectId: string }): ReactElement {
  const [preview, setPreviewState] = useState(persistedPreview)
  const setPreview = (p: { sourceId: string; path: string; service: string } | null): void => {
    persistedPreview = p
    setPreviewState(p)
  }
  // 列表数据：进入即显上次数据（模块级页面缓存，key `logTail:${projectId}`），
  // 保留 5s 轮询做准实时刷新；弹窗内的实时 tail 仍走 usePoll
  const { data, refresh, error } = useCachedPageData<TailResponse>(
    `logTail:${projectId}`,
    () => client.call('monitoring.logTail', { projectId, limitLines: 200 }).then((r) => (r.ok ? { ok: true as const, value: r.value as TailResponse } : { ok: false as const, error: r.error })),
    { intervalMs: 5000 },
  )
  const prevSizes = useRef<Map<string, { size: number; at: number }>>(new Map())
  const [newPath, setNewPath] = useState('')
  const [newService, setNewService] = useState('')
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  const discover = async (): Promise<void> => {
    setActionMsg(null)
    const res = await client.call('monitoring.discoverLogs', { projectId })
    if (!res.ok) { setActionMsg(`发现失败：${res.error.message}`); return }
    setActionMsg(`已扫描默认路径，登记/更新 ${res.value.registered} 个日志来源`)
    void refresh()
  }
  const addSource = async (): Promise<void> => {
    const path = newPath.trim()
    if (!path) { setActionMsg('请输入日志文件的绝对路径'); return }
    setActionMsg(null)
    const res = await client.call('monitoring.logSourceAdd', { projectId, path, service: newService.trim() || undefined })
    if (!res.ok) { setActionMsg(`新增失败：${res.error.message}`); return }
    setNewPath('')
    setNewService('')
    setActionMsg(res.value.status === 'active' ? `已监控：${res.value.path}` : `已登记（当前${res.value.status === 'missing' ? '文件不存在，待写入后自动就绪' : '不可读：' + res.value.statusReason}）：${res.value.path}`)
    void refresh()
  }
  const removeSource = async (sourceId: string): Promise<void> => {
    await client.call('monitoring.logSourceRemove', { sourceId })
    void refresh()
  }

  const criticals = (data?.alerts ?? []).filter((a) => a.severity === 'critical')
  const warnings = (data?.alerts ?? []).filter((a) => a.severity === 'warning')
  const totalLevels = (data?.stats ?? []).reduce(
    (acc, s) => ({ error: acc.error + s.levelCount.error, warn: acc.warn + s.levelCount.warn, info: acc.info + s.levelCount.info }),
    { error: 0, warn: 0, info: 0 },
  )

  const rateSeries: LineSeries[] = (data?.stats ?? [])
    .map((s, i) => {
      const source = data?.sources.find((src) => src.sourceId === s.sourceId)
      const palette = [colors.primary, '#8b5cf6', '#ec4899', colors.warn]
      return {
        name: source?.service ?? s.sourceId,
        color: palette[i % palette.length]!,
        points: [{ x: Date.now(), y: s.linesPerMinute }],
      }
    })
    .filter((s) => s.points.some((p) => p.y !== null))

  return h('div', null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 } },
      h('span', { style: { flex: 1 } }),
      h('button', { className: 'dsh-btn', onClick: () => void refresh(true), style: { padding: '6px 14px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', cursor: 'pointer', color: 'inherit' } }, '刷新'),
      h('button', {
        className: 'dsh-btn',
        onClick: () => void discover(),
        title: '扫描 supervisor 配置、代码目录 logs、启动脚本等默认位置，自动登记日志文件',
        style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', cursor: 'pointer', color: 'inherit' },
      }, h(Icon, { name: 'search', size: 15 }), '发现日志'),
      h('button', {
        className: 'dsh-btn',
        onClick: async (): Promise<void> => {
          const serverId = data?.sources[0]?.serverId
          if (serverId) await client.call('monitoring.inspect', { serverId, kind: 'logs' })
          void refresh()
        },
        style: { padding: '6px 14px', borderRadius: radii.sm, border: `1px solid ${colors.primaryBorder}`, background: colors.primarySoft, cursor: 'pointer', fontWeight: 600, color: 'inherit' },
      }, '日志 AI 检查'),
    ),

    // manual add row — self-pinned sources survive re-discovery
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' as const } },
      h('input', { placeholder: '新增监控日志绝对路径，如 /var/log/app/error.log', value: newPath, onChange: (e: { target: { value: string } }) => setNewPath(e.target.value), style: { padding: '7px 10px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', fontSize: 13, flex: 1, minWidth: 240, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }),
      h('input', { placeholder: '服务标签（可选）', value: newService, onChange: (e: { target: { value: string } }) => setNewService(e.target.value), style: { padding: '7px 10px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', fontSize: 13, width: 150 } }),
      h('button', { className: 'dsh-btn', onClick: () => void addSource(), style: { padding: '7px 14px', borderRadius: radii.sm, border: `1px solid ${colors.primaryBorder}`, background: colors.primarySoft, cursor: 'pointer', fontWeight: 600, color: 'inherit' } }, '+ 监控此文件'),
    ),
    actionMsg ? h('div', { style: { fontSize: 12, color: colors.muted, marginTop: -6, marginBottom: 12 } }, actionMsg) : null,
    error ? errText(error) : null,

    // anomaly banner — loud by design
    criticals.length > 0
      ? h('div', {
          className: 'dsh-anim-pulse',
          style: { background: colors.errSoft, border: `1px solid ${colors.err}`, color: colors.err, borderRadius: radii.md, padding: '12px 16px', marginBottom: 14, fontWeight: 700, fontSize: 14 },
        },
          `⛔ 异常：${criticals.map((a) => `${a.summary}（${a.count} 次）`).join('；')}`)
      : null,
    warnings.length > 0
      ? h('div', { style: { background: colors.warnSoft, border: `1px solid ${colors.warn}`, color: colors.warn, borderRadius: radii.md, padding: '10px 16px', marginBottom: 14, fontWeight: 600, fontSize: 13 } },
          `⚠ 告警：${warnings.map((a) => `${a.summary}（${a.count} 次）`).join('；')}`)
      : null,
    data && data.sources.length === 0
      ? h('div', { style: { ...cardStyle, color: colors.muted, textAlign: 'center', padding: 32 } }, '暂无日志来源——点上方“发现日志”扫描默认路径，或在输入框中手动添加日志文件路径')
      : null,

    // dashboard (top)
    data && data.sources.length > 0
      ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 14 } },
          h('div', { className: 'dsh-card', style: cardStyle },
            h('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 8 } }, '日志速率（行/分钟 · 最近 1 小时窗口）'),
            h(LineChart, { series: rateSeries, height: 150, formatY: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v))) })),
          h('div', { className: 'dsh-card', style: cardStyle },
            h('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 10 } }, '日志级别分布（最近 1 小时窗口）'),
            h(MiniBar, { items: [
              { label: 'ERROR', value: totalLevels.error, color: colors.err },
              { label: 'WARN', value: totalLevels.warn, color: colors.warn },
              { label: '其他', value: totalLevels.info, color: colors.ok },
            ] }),
            totalLevels.error > 0 ? h('div', { style: { marginTop: 10, fontSize: 12, color: colors.err } }, `检测到 ${totalLevels.error} 行 ERROR——请关注上方异常横幅`) : null,
          ),
        )
      : null,

    // ONE BIG CARD PER LOG FILE (二轮 R3)
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 } },
      (data?.sources ?? []).map((src, i) => {
        const stat = data?.stats.find((s) => s.sourceId === src.sourceId)
        const meta = data?.meta.find((m) => m.sourceId === src.sourceId)
        const size = meta?.sizeBytes ?? src.sizeBytes
        const updatedAt = meta?.lastModifiedAt ?? src.lastModifiedAt
        const prev = prevSizes.current.get(src.sourceId)
        let growth: number | null = null
        if (prev && size !== null && size > prev.size && updatedAt !== null) {
          const dtSec = Math.max(1, (Date.now() - prev.at) / 1000)
          growth = (size - prev.size) / dtSec
        }
        if (size !== null) prevSizes.current.set(src.sourceId, { size, at: Date.now() })
        const errors = stat?.levelCount.error ?? 0
        const warns = stat?.levelCount.warn ?? 0
        const hasAnomaly = errors > 0 || criticals.some((a) => a.summary !== '' && stat !== undefined && stat.levelCount.error > 0)
        return h('div', {
          key: src.sourceId,
          className: 'dsh-card dsh-anim-card',
          onClick: () => setPreview({ sourceId: src.sourceId, path: src.path, service: src.service }),
          style: { ...cardStyle, animationDelay: `${Math.min(i, 8) * 40}ms`, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10 },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('span', { style: { display: 'inline-flex', width: 32, height: 32, borderRadius: radii.sm, background: colors.surface, alignItems: 'center', justifyContent: 'center' } },
              h(Icon, { name: 'file-text', size: 20, color: colors.primary })),
            h('span', { style: { fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, src.path.split('/').at(-1) ?? src.path),
            src.userDefined ? badge('手动', 'primary') : null,
            h('span', { style: { flex: 1 } }),
            badge(src.status === 'active' ? '● 活跃' : src.status, src.status === 'active' ? 'ok' : 'warn'),
            src.userDefined
              ? h('button', {
                  className: 'dsh-btn',
                  title: '取消监控此文件',
                  onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); void removeSource(src.sourceId) },
                  style: { padding: '2px 8px', borderRadius: 6, border: `1px solid ${colors.borderStrong}`, background: 'transparent', cursor: 'pointer', color: colors.muted, fontSize: 12 },
                }, '✕')
              : null,
          ),
          h('div', { style: { fontSize: 12, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: src.path }, `${src.service} → ${src.path}`),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            /^AI\b|AI 代码|AI 分析/.test(src.configOrigin) ? badge('AI 发现', 'primary') : null,
            h('span', { title: src.configOrigin, style: { fontSize: 11.5, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `来源：${src.configOrigin}`),
          ),
          h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' as const, fontSize: 12.5 } },
            h('span', null, h('span', { style: { color: colors.muted } }, '磁盘 '), h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, formatBytes(size, 1))),
            h('span', null, h('span', { style: { color: colors.muted } }, '更新 '), h('b', null, updatedAt ? timeAgo(updatedAt) : '—')),
            growth !== null && growth > 1 ? h('span', { style: { color: colors.ok } }, `▲ ${formatRate(growth)}`) : null,
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            errors > 0 ? badge(`⛔ ERROR ${errors} 行`, 'err', true) : badge('无异常', 'ok'),
            warns > 0 ? badge(`WARN ${warns}`, 'warn') : null,
            stat?.linesPerMinute != null ? badge(`${stat.linesPerMinute.toFixed(0)} 行/分`, 'muted') : null,
            h('span', { style: { flex: 1 } }),
            h('span', { style: { fontSize: 12, fontWeight: 600, color: colors.primary } }, '实时预览 →'),
          ),
        )
      }),
    ),

    // modal: live tail preview with adjustable line count
    preview ? h(LogPreviewModal, { client, projectId, preview, onClose: () => setPreview(null) }) : null,
  )
}

function LogPreviewModal({ client, projectId, preview, onClose }: { client: OpsClient; projectId: string; preview: { sourceId: string; path: string; service: string }; onClose: () => void }): ReactElement {
  const [limitLines, setLimitLines] = useState(100)
  const [data, , error] = usePoll<TailResponse>(`logTail:${preview.sourceId}:${limitLines}`,
    () => client.call('monitoring.logTail', { projectId, sourceId: preview.sourceId, limitLines }).then((r) => (r.ok ? (r.value as TailResponse) : Promise.reject(new Error(r.error.message)))),
    2000,
    [projectId, preview.sourceId, limitLines],
  )
  return h('div', {
    onClick: onClose,
    style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 },
  },
    h('div', {
      className: 'dsh-anim-card',
      onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
      style: { ...cardStyle, width: 'min(900px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', background: 'rgba(128,128,128,.12)' },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${colors.border}` } },
        h(Icon, { name: 'file-text', size: 20, color: colors.primary }),
        h('div', { style: { overflow: 'hidden' } },
          h('div', { style: { fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, preview.path),
          h('div', { style: { fontSize: 11, color: colors.muted } }, `${preview.service} · 实时 tail · 每 2 秒刷新`),
        ),
        h('span', { style: { flex: 1 } }),
        h('span', { style: { fontSize: 12, color: colors.muted } }, '行数'),
        h('select', {
          onChange: (e: { target: { value: string } }) => setLimitLines(Number(e.target.value)),
          value: limitLines,
          style: { padding: '4px 8px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', fontSize: 12 },
        }, TAIL_LINE_OPTIONS.map((n) => h('option', { key: n, value: n }, n))),
        h('button', { className: 'dsh-btn', onClick: onClose, style: { padding: '4px 12px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 } }, '✕ 关闭'),
      ),
      h('div', { style: { overflow: 'auto', padding: '8px 0', background: colors.surface, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, minHeight: 200 } },
        error ? h('div', { style: { padding: 16, color: colors.err } }, error) : null,
        data?.tail.length === 0 && !error ? h('div', { style: { padding: 16, color: colors.muted } }, '暂无内容（调度器按周期读取日志后此处显示）') : null,
        data?.tail.map((t, i) => {
          const isError = t.level === 'error'
          return h('div', { key: i, style: {
            padding: '2px 16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            color: isError ? colors.err : t.level === 'warn' ? colors.warn : 'inherit',
            background: isError ? colors.errSoft : 'transparent',
            fontWeight: isError ? 600 : 400,
          } }, t.line)
        }),
      ),
    ),
  )
}
