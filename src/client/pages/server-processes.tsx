/**
 * 服务器详情 · 进程页：宿主侧分类分组 —— 程序进程（按启动目录分组，关联项目
 * 的在前）/ 常用软件 / 系统进程 / 其他 —— 可折叠分区 + 每进程资源行。已知应用
 * 在首列显示图标与友好名称；每行展示启动方式（supervisor / pm2 / sh 脚本 /
 * systemd / …）。
 *
 * 数据流：接入 useCachedPageData（stale-while-revalidate）——切走再切回时立即
 * 显示上次数据（模块级页面缓存，key `processes:${serverId}`），后台静默刷新；
 * 工具条展示数据新鲜度（采集于 HH:mm，缓存 + 后台刷新中给轻提示）。
 * 分类在宿主侧完成（classify.ts），UI 只渲染分组，但客户端会再做一次防御性
 * 稳定排序（private → common → system → other），保证旧缓存 / 异常数据也按
 * 正确顺序展示（private 内部保持宿主给的相对顺序，关联项目的在前）。
 * 「刷新」按钮携带 force=true 让宿主同步重算；「进程 AI 巡检」保持原语义：
 * 先触发 monitoring.inspect，再强制刷新进程数据。
 */
import { createElement, useState } from 'react'
import type { ReactElement } from 'react'
import type { OpsClient } from '../model.ts'
import { cardStyle, badge, errText } from '../hooks.ts'
import { useCachedPageData } from '../page-cache.ts'
import { Icon } from '../icons.tsx'
import { knownApp, launchModeLabel } from '../known-apps.ts'
import { colors, radii, formatBytes, formatPercent } from '../theme.ts'

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
  cwd: string | null
  command: string
  launchMode: string | null
}

interface ProcessGroupView {
  kind: 'system' | 'common' | 'private' | 'other'
  title: string
  cwd: string | null
  projectId: string | null
  processes: ProcessRow[]
}

interface ProcessesResponse {
  collectedAt: number | null
  processes: ProcessRow[]
  groups: ProcessGroupView[]
  analysisState: string
  coverage: { analyzed: number; total: number }
  findings: Array<{ processStartTokens: string[]; severity: string; summary: string; evidence: string; suggestion: string }>
}

const GROUP_META: Record<ProcessGroupView['kind'], { label: string; color: string }> = {
  private: { label: '程序进程', color: colors.ok },
  common: { label: '常用软件', color: colors.primary },
  system: { label: '系统进程', color: colors.muted },
  other: { label: '其他', color: colors.warn },
}

/** 分组渲染优先级：程序进程 → 常用软件 → 系统进程 → 其他（客户端兜底排序用） */
const GROUP_KIND_ORDER: readonly string[] = ['private', 'common', 'system', 'other']

/** 巡检分析状态 → 中文（AGENTS 约定：枚举不得以英文原样露出） */
const ANALYSIS_STATE_LABEL: Record<string, string> = {
  pending: '待执行', unavailable: '模型不可用', running: '进行中', complete: '已完成', partial: '部分完成', failed: '失败',
}

/** 巡检发现级别 → 中文 */
const SEVERITY_LABEL: Record<string, string> = { critical: '严重', warning: '警告', info: '提示' }

function groupRank(kind: ProcessGroupView['kind']): number {
  const i = GROUP_KIND_ORDER.indexOf(kind)
  return i === -1 ? GROUP_KIND_ORDER.length : i
}

/** 毫秒时间戳 → 本地 HH:mm（补零）。theme.ts 没有时钟格式化，就地实现，不引入新依赖 */
function formatClock(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const thStyle: Record<string, string | number> = {
  textAlign: 'left', fontSize: 12, color: colors.muted, borderBottom: `1px solid ${colors.border}`,
  padding: '9px 14px', fontWeight: 700, whiteSpace: 'nowrap',
}
const tdStyle: Record<string, string | number> = {
  borderBottom: `1px solid ${colors.border}`, padding: '11px 14px', fontSize: 13.5, verticalAlign: 'middle',
}

function LaunchBadge({ mode }: { mode: string | null }): ReactElement {
  const tone = mode === 'supervisor' || mode === 'pm2' ? 'primary' : mode === 'sh-script' ? 'ok' : mode ? 'muted' : 'muted'
  return badge(launchModeLabel(mode), tone as 'primary' | 'ok' | 'muted')
}

export function ServerProcessesPage({ client, serverId }: { client: OpsClient; serverId: string }): ReactElement {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [inspectError, setInspectError] = useState<string | null>(null)

  // 进入即显缓存：切走再切回时立即渲染上次数据，后台静默刷新；
  // 刷新（手动）时 force=true 让宿主同步重算，后台首拉/静默刷新 force=false 只读宿主缓存
  const { data, loading, error, refreshing, fromCache, refresh } = useCachedPageData<ProcessesResponse>(
    `processes:${serverId}`,
    (opts) => client.call('monitoring.processes', { serverId, force: opts.force }),
  )

  // 「进程 AI 巡检」保持原有语义：先触发宿主 AI 巡检，成功后再强制刷新进程数据
  const runInspect = async (): Promise<void> => {
    setInspectError(null)
    const res = await client.call('monitoring.inspect', { serverId, kind: 'process' })
    if (!res.ok) {
      setInspectError(`${res.error.code}: ${res.error.message}`)
      return
    }
    void refresh(true)
  }

  const toggleGroup = (title: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }

  const q = query.trim()
  // 客户端防御性排序兜底：private(程序进程) → common(常用软件) → system(系统进程) → other(其他)。
  // 宿主侧按此顺序返回，但旧缓存 / 异常数据可能乱序；Array.prototype.sort 为稳定排序，
  // private 内部保持宿主给的相对顺序（关联项目的在前）。
  const groups: ProcessGroupView[] = data
    ? [...data.groups]
        .sort((a, b) => groupRank(a.kind) - groupRank(b.kind))
        .map((g) => ({ ...g, processes: g.processes.filter((p) => !q || p.name.includes(q) || String(p.pid).includes(q) || p.command.includes(q)) }))
        .filter((g) => g.processes.length > 0)
    : []

  const staleRefresh = fromCache && refreshing

  return h('div', null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' as const } },
      h('input', { style: { padding: '8px 12px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', width: 240, fontSize: 14 }, placeholder: '搜索进程 / PID / 命令…', value: query, onChange: (e: { target: { value: string } }) => setQuery(e.target.value) }),
      h('span', { style: { flex: 1 } }),
      // 数据新鲜度：展示采集时间；当前是缓存数据且后台在刷新时给轻提示
      data
        ? badge(
            staleRefresh ? '缓存 · 后台刷新中' : `采集于 ${formatClock(data.collectedAt)}`,
            staleRefresh ? 'primary' : 'muted',
          )
        : null,
      data ? badge(`AI 巡检${ANALYSIS_STATE_LABEL[data.analysisState] ?? data.analysisState} · 覆盖 ${data.coverage.analyzed}/${data.coverage.total}`, data.analysisState === 'partial' ? 'warn' : data.analysisState === 'complete' ? 'ok' : 'muted') : null,
      h('button', { className: 'dsh-btn', onClick: () => void refresh(true), disabled: loading, style: { padding: '7px 16px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 13 } }, loading ? '采集中…' : '刷新'),
      h('button', { className: 'dsh-btn', onClick: () => void runInspect(), disabled: loading, style: { padding: '7px 16px', borderRadius: radii.sm, border: `1px solid ${colors.primaryBorder}`, background: colors.primarySoft, cursor: 'pointer', fontWeight: 600, color: 'inherit', fontSize: 13 } }, '进程 AI 巡检'),
    ),
    error ? errText(error) : null,
    inspectError ? errText(inspectError) : null,
    data && data.analysisState === 'partial' ? h('div', { style: { ...cardStyle, border: `1px solid ${colors.warn}`, marginBottom: 12, fontSize: 13, color: colors.warn } }, '部分分析——结果不代表整台服务器正常') : null,

    // AI findings
    data && data.findings.length > 0
      ? h('div', { style: { ...cardStyle, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontWeight: 700, fontSize: 14 } }, 'AI 巡检发现'),
          data.findings.map((f, i) => h('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
            badge(SEVERITY_LABEL[f.severity] ?? f.severity, f.severity === 'critical' ? 'err' : f.severity === 'warning' ? 'warn' : 'muted'),
            h('span', { style: { fontSize: 13 } }, f.summary),
            h('span', { style: { fontSize: 12, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.evidence.slice(0, 80)),
          )),
        )
      : null,

    !data && !error ? h('div', { style: { color: colors.muted, padding: 24, textAlign: 'center', fontSize: 14 } }, loading ? '采集中…' : '') : null,

    // classified groups
    groups.map((g, gi) => {
      const isCollapsed = collapsed.has(g.title)
      const meta = GROUP_META[g.kind]
      return h('div', { key: g.title, className: 'dsh-anim-card', style: { ...cardStyle, padding: 0, marginBottom: 12, overflow: 'hidden', animationDelay: `${gi * 40}ms` } },
        h('div', {
          onClick: () => toggleGroup(g.title),
          style: { display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', cursor: 'pointer', borderBottom: isCollapsed ? 'none' : `1px solid ${colors.border}` },
        },
          h('span', { style: { fontSize: 11, transition: 'transform .2s ease', display: 'inline-block', transform: isCollapsed ? 'rotate(-90deg)' : 'none' } }, '▼'),
          h('span', { style: { width: 9, height: 9, borderRadius: 999, background: meta.color } }),
          h('span', { style: { fontWeight: 700, fontSize: 15 } }, g.kind === 'private' ? g.title : meta.label),
          g.kind === 'private' && g.projectId ? badge('已关联项目', 'ok') : null,
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 13, color: colors.muted } }, `${g.processes.length} 个进程`),
        ),
        isCollapsed
          ? null
          : h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
              h('thead', null, h('tr', null, ['应用', 'PID', '用户', 'CPU', '内存', '状态', '启动方式', '命令'].map((t) =>
                h('th', { key: t, style: thStyle }, t)))),
              h('tbody', null, g.processes.slice(0, 200).map((p) => {
                const app = knownApp(p.name)
                const known = app.label !== p.name
                return h('tr', { key: p.pid, style: { transition: 'background .15s ease' } },
                  h('td', { style: { ...tdStyle, whiteSpace: 'nowrap' } },
                    h('span', { style: { display: 'inline-flex', marginRight: 8, verticalAlign: '-4px' } }, h(Icon, { name: app.icon, size: 18, color: colors.primary })),
                    h('span', { style: { fontWeight: 700 } }, known ? app.label : p.name),
                    known ? h('span', { style: { marginLeft: 6, fontSize: 11, color: colors.muted } }, p.name) : null),
                  h('td', { style: { ...tdStyle, fontVariantNumeric: 'tabular-nums' } }, p.pid),
                  h('td', { style: tdStyle }, p.user),
                  h('td', { style: { ...tdStyle, fontVariantNumeric: 'tabular-nums', color: (p.cpuPercent ?? 0) > 80 ? colors.err : 'inherit', fontWeight: 600 } }, formatPercent(p.cpuPercent, 1)),
                  h('td', { style: { ...tdStyle, fontVariantNumeric: 'tabular-nums' } }, formatBytes(p.rssBytes, 0)),
                  h('td', { style: tdStyle }, badge(p.state, p.state.startsWith('Z') ? 'err' : p.state.startsWith('R') ? 'ok' : 'muted')),
                  h('td', { style: tdStyle }, LaunchBadge({ mode: p.launchMode })),
                  h('td', { style: { ...tdStyle, fontSize: 12, color: colors.muted, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: p.cwd ? `cwd: ${p.cwd}` : p.command }, p.command || '—'),
                )
              }))),
      )
    }),
    data && groups.length === 0 ? h('div', { style: { color: colors.muted, padding: 24, textAlign: 'center', fontSize: 14 } }, q ? '没有匹配的进程' : '无进程数据') : null,
  )
}
