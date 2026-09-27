/**
 * Projects list (IMPROVE §4.4): big cards over projects.overview —
 * deployment status, service health, resource aggregates, alert counts.
 * Deploy actions live on the card; details open on click. The create form
 * collapses into a drawer.
 */
import { createElement, useCallback, useState } from 'react'
import type { ReactElement } from 'react'
import { newRequestId, type OpsClient, type OpsStore } from '../model.ts'
import type { PageProps } from './app.tsx'
import { usePoll, cardStyle, badge, errText, emptyState } from '../hooks.ts'
import { colors, radii, formatBytes, formatPercent, timeAgo } from '../theme.ts'
import { statusLabel } from './project-deploy.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */
function h(tag: any, props: any, ...children: any[]): ReactElement {
  return createElement(tag, props, ...children)
}

interface OverviewEntry {
  project: { id: string; name: string; repoUrl: string; branch: string; revision: number; targets: Array<{ id: string; serverId: string; codeDir: string; services: Array<{ name: string }> }> }
  lastRun: { runId: string; status: string; stage: string; kind: string; targetCommit: string | null; createdAt: number; finishedAt: number | null } | null
  serviceHealth: { running: number; total: number }
  aggregate: { cpuPercent: number | null; rssBytes: number | null }
  alertCount: { critical: number; warning: number }
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | 'primary' | 'muted'> = {
  SUCCEEDED: 'ok', RUNNING: 'primary', REPAIRING: 'warn', QUEUED: 'muted',
  FAILED: 'err', STOPPING: 'warn', STOPPED: 'muted', RECONCILE_REQUIRED: 'warn',
}

export function ProjectsListPage({ client, store, navigate }: PageProps & { store: OpsStore }): ReactElement {
  const [overview, reload] = usePoll<OverviewEntry[]>('projects.overview', () => client.call('projects.overview', {}).then((r) => (r.ok ? (r.value as OverviewEntry[]) : Promise.reject(new Error(r.error.message)))), 4000, [])
  const [createOpen, setCreateOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyRun, setBusyRun] = useState<string | null>(null)

  const deploy = useCallback(async (projectId: string, targetId: string, kind: 'first-deploy' | 'update') => {
    setActionError(null)
    // execute: true — the button means "deploy now"; without it the run is a
    // bare QUEUED record nothing ever executes (and its occupancy never
    // releases, locking the project's deploy UI).
    const res = await client.call('deploy.create', { requestId: newRequestId(), projectId, targetId, kind, execute: true })
    if (!res.ok) setActionError(`${res.error.code}: ${res.error.message}`)
    void store.refreshRuns(client)
    reload()
  }, [client, store, reload])

  return h('div', null,
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 14 } },
      h('button', {
        className: 'dsh-btn',
        onClick: () => setCreateOpen((v) => !v),
        style: { padding: '8px 18px', borderRadius: radii.sm, border: `1px solid ${colors.primaryBorder}`, background: colors.primarySoft, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'inherit' },
      }, createOpen ? '收起' : '+ 新建项目'),
    ),
    createOpen ? h(CreateProjectDrawer, { client, store, onDone: () => { setCreateOpen(false); reload() } }) : null,
    actionError ? errText(actionError) : null,
    !overview ? h('div', { style: { color: colors.muted, padding: 24, textAlign: 'center' } }, '加载中…') : null,
    overview && overview.length === 0 ? emptyState('还没有项目——点击右上角“新建项目”开始') : null,
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(680px, 1fr))', gap: 20 } },
      (overview ?? []).map((entry, i) => ProjectCard({ entry, index: i, busyRun, onOpen: () => navigate.openProject(entry.project.id, entry.project.name), onDeploy: deploy, setBusyRun })),
    ),
  )
}

function ProjectCard({ entry, index, busyRun, onOpen, onDeploy, setBusyRun }: { entry: OverviewEntry; index: number; busyRun: string | null; onOpen: () => void; onDeploy: (projectId: string, targetId: string, kind: 'first-deploy' | 'update') => Promise<void>; setBusyRun: (v: string | null) => void }): ReactElement {
  const p = entry.project
  const target = p.targets[0]
  const tone = entry.lastRun ? STATUS_TONE[entry.lastRun.status] ?? 'muted' : 'muted'
  const statusText = entry.lastRun ? statusLabel(entry.lastRun.status) : '未部署'
  const active = entry.lastRun && ['RUNNING', 'REPAIRING', 'QUEUED'].includes(entry.lastRun.status)
  const deploying = busyRun === p.id || active

  const runDeploy = (kind: 'first-deploy' | 'update'): void => {
    if (!target) return
    setBusyRun(p.id)
    void onDeploy(p.id, target.id, kind).finally(() => setBusyRun(null))
  }

  return h('div', { className: 'dsh-card dsh-anim-card', onClick: onOpen, style: { ...cardStyle, padding: 26, animationDelay: `${index * 30}ms`, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      h('span', { style: { fontSize: 19, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.name),
      h('span', { style: { flex: 1 } }),
      badge(statusText, tone, tone === 'err'),
    ),
    h('div', { style: { fontSize: 13, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${p.repoUrl} @ ${p.branch}`),
    target ? h('div', { style: { fontSize: 13, color: colors.muted } }, `部署目录 ${target.codeDir}`) : null,
    // runtime info strip
    h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap' as const, fontSize: 13.5 } },
      h('span', null,
        h('span', { style: { color: colors.muted } }, '服务 '),
        h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, `${entry.serviceHealth.running}/${entry.serviceHealth.total}`),
        ' 运行中'),
      h('span', null, h('span', { style: { color: colors.muted } }, 'CPU '), h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, formatPercent(entry.aggregate.cpuPercent, 1))),
      h('span', null, h('span', { style: { color: colors.muted } }, '内存 '), h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, formatBytes(entry.aggregate.rssBytes, 1))),
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const } },
      entry.alertCount.critical > 0 ? badge(`严重告警 ${entry.alertCount.critical}`, 'err', true) : null,
      entry.alertCount.warning > 0 ? badge(`告警 ${entry.alertCount.warning}`, 'warn') : null,
      entry.lastRun
        ? h('span', { style: { fontSize: 12.5, color: colors.muted } },
            `最近部署 ${timeAgo(entry.lastRun.finishedAt ?? entry.lastRun.createdAt)}`,
            entry.lastRun.targetCommit ? ` · ${entry.lastRun.targetCommit.slice(0, 8)}` : '')
        : null,
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, borderTop: `1px solid ${colors.border}`, paddingTop: 12 } },
      target
        ? ([
            h('button', { key: 'first', className: 'dsh-btn', onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); runDeploy('first-deploy') }, disabled: deploying, style: btnSmall }, deploying ? '部署中…' : '首次 AI 部署'),
            h('button', { key: 'update', className: 'dsh-btn', onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); runDeploy('update') }, disabled: deploying, style: btnSmall }, '手动更新'),
          ])
        : null,
      h('span', { style: { flex: 1 } }),
      h('span', { style: { fontSize: 13.5, fontWeight: 600, color: colors.primary } }, '进入详情 →'),
    ),
  )
}

const btnSmall: Record<string, string | number> = { padding: '7px 16px', borderRadius: 8, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 }

function CreateProjectDrawer({ client, store, onDone }: { client: OpsClient; store: OpsStore; onDone: () => void }): ReactElement {
  const [name, setName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [codeDir, setCodeDir] = useState('')
  const [targetServerId, setTargetServerId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [servers, setServers] = useState<Array<{ id: string; alias: string }>>([])

  usePoll('servers.list:drawer', async () => {
    const res = await client.call('servers.list', {})
    if (res.ok) setServers(res.value as Array<{ id: string; alias: string }>)
  }, 10_000, [])

  const create = useCallback(async (): Promise<void> => {
    if (!targetServerId) {
      setError('选择目标服务器')
      return
    }
    const res = await client.call('projects.save', { name, repoUrl, branch, targets: [{ serverId: targetServerId, codeDir }] })
    if (!res.ok) setError(`${res.error.code}: ${res.error.message}`)
    else {
      void store.refresh(client)
      onDone()
    }
  }, [client, name, repoUrl, branch, codeDir, targetServerId, store, onDone])

  const inputStyle: Record<string, string | number> = { padding: '8px 10px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', fontSize: 13 }

  return h('div', { className: 'dsh-anim-card', style: { ...cardStyle, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 } },
    h('div', { style: { fontWeight: 700, fontSize: 15 } }, '新建项目'),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' as const } },
      h('input', { style: { ...inputStyle, width: 140 }, placeholder: '项目名', value: name, onChange: (e: { target: { value: string } }) => setName(e.target.value) }),
      h('input', { style: { ...inputStyle, flex: 1, minWidth: 220 }, placeholder: 'Git 仓库 URL', value: repoUrl, onChange: (e: { target: { value: string } }) => setRepoUrl(e.target.value) }),
      h('input', { style: { ...inputStyle, width: 110 }, placeholder: '分支', value: branch, onChange: (e: { target: { value: string } }) => setBranch(e.target.value) }),
      h('input', { style: { ...inputStyle, width: 180 }, placeholder: '目标代码目录', value: codeDir, onChange: (e: { target: { value: string } }) => setCodeDir(e.target.value) }),
      h('select', { style: { ...inputStyle, width: 150 }, value: targetServerId, onChange: (e: { target: { value: string } }) => setTargetServerId(e.target.value) },
        h('option', { value: '' }, '目标服务器…'),
        servers.map((s) => h('option', { key: s.id, value: s.id }, s.alias))),
      h('button', { className: 'dsh-btn', style: { ...inputStyle, cursor: 'pointer', width: 'auto', fontWeight: 600 }, onClick: () => void create() }, '保存'),
    ),
    error ? errText(error) : null,
  )
}
