/**
 * Servers list (IMPROVE §4.1): big card grid over servers.overview.
 * Read-only polling (4s, no SSH). The whole card opens the server detail;
 * destructive actions hide behind a small overflow toggle. The add-server
 * flow (verify → fingerprint confirm → save) collapses into a drawer.
 */
import { createElement, useCallback, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { OpsClient, OpsStore } from '../model.ts'
import type { PageProps } from './app.tsx'
import { usePoll, cardStyle, badge, errText, emptyState } from '../hooks.ts'
import { Donut, Sparkline } from '../charts.tsx'
import { Icon } from '../icons.tsx'
import { colors, radii, formatPercent, timeAgo } from '../theme.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
function h(tag: any, props: any, ...children: any[]): ReactElement {
  return createElement(tag, props, ...children)
}

interface OverviewEntry {
  server: { id: string; alias: string; endpoint: string; hostFingerprint: string; capabilities: { platform: string; osRelease?: string; arch?: string }; credentials: Array<{ configured: boolean; error: string | null }> }
  latestSample: { cpuPercent: number | null; memoryTotalBytes: number | null; memoryUsedBytes: number | null; mounts: Array<{ path: string; totalBytes: number | null; usedBytes: number | null }> } | null
  lastCollectedAt: number | null
  alertCount: { critical: number; warning: number }
}

export function ServersListPage({ client, store, navigate }: PageProps & { store: OpsStore }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const [overview, reload, loadError] = usePoll<OverviewEntry[]>('servers.overview', () => client.call('servers.overview', {}).then((r) => (r.ok ? (r.value as OverviewEntry[]) : Promise.reject(new Error(r.error.message)))), 4000, [])
  const [addOpen, setAddOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const doRemove = useCallback(async (serverId: string) => {
    await client.call('servers.remove', { serverId })
    setConfirmId(null)
    void store.refresh(client)
    reload()
  }, [client, store, reload])

  return h('div', null,
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 14 } },
      h('button', {
        className: 'dsh-btn',
        onClick: () => setAddOpen((v) => !v),
        style: { padding: '8px 18px', borderRadius: radii.sm, border: `1px solid ${colors.primaryBorder}`, background: colors.primarySoft, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'inherit' },
      }, addOpen ? '收起' : '+ 添加服务器'),
    ),
    addOpen ? h(AddServerDrawer, { client, store, onDone: () => { setAddOpen(false); reload() } }) : null,
    state.offline ? errText(`Host 连接不可用（离线）${state.lastError ? `——${state.lastError}` : '——状态来自上次快照'}`) : null,
    loadError ? errText(loadError) : null,
    !overview && !loadError ? h('div', { style: { color: colors.muted, padding: 24, textAlign: 'center' } }, '加载中…') : null,
    overview && overview.length === 0 ? emptyState('还没有服务器——点击右上角“添加服务器”开始') : null,
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(640px, 1fr))', gap: 20 } },
      (overview ?? []).map((entry, i) => ServerCard({ entry, index: i, onOpen: () => navigate.openServer(entry.server.id, entry.server.alias), onRemove: () => doRemove(entry.server.id), confirmRemove: confirmId === entry.server.id, setConfirmRemove: (v) => setConfirmId(v ? entry.server.id : null) })),
    ),
  )
}

/** 平台枚举的展示名（探测数据缺失时的兜底） */
const PLATFORM_LABELS: Record<string, string> = { linux: 'Linux', macos: 'macOS', unknown: '未知系统' }

/**
 * 卡片右上角的系统标签：优先 osRelease——Linux 是 /etc/os-release 的
 * PRETTY_NAME（自带发行版+版本，如 "Ubuntu 22.04.3 LTS"）；macOS 的 probe
 * 只报版本号（如 14.5），补上平台名。都没探测到才显示"未知系统"。
 */
function osLabel(cap: { platform?: string; osRelease?: string } | null | undefined): string {
  const release = (cap?.osRelease ?? '').trim()
  if (release) {
    if (cap?.platform === 'macos' && /^\d+(\.\d+)*$/.test(release)) return `macOS ${release}`
    return release
  }
  const platform = cap?.platform
  if (!platform) return '未知系统'
  return PLATFORM_LABELS[platform] ?? platform
}

function ServerCard({ entry, index, onOpen, onRemove, confirmRemove, setConfirmRemove }: { entry: OverviewEntry; index: number; onOpen: () => void; onRemove: () => void; confirmRemove: boolean; setConfirmRemove: (v: boolean) => void }): ReactElement {
  const s = entry.latestSample
  const cred = entry.server.credentials?.[0]
  const credMissing = cred ? !cred.configured : false
  const memPercent = s && s.memoryTotalBytes ? ((s.memoryUsedBytes ?? 0) / s.memoryTotalBytes) * 100 : null
  const rootMount = s?.mounts.find((m) => m.path === '/') ?? s?.mounts[0]
  const diskPercent = rootMount && rootMount.totalBytes ? ((rootMount.usedBytes ?? 0) / rootMount.totalBytes) * 100 : null
  const status = credMissing ? { tone: 'err' as const, text: '凭据缺失' } : s ? { tone: 'ok' as const, text: '在线' } : { tone: 'muted' as const, text: '无数据' }

  return h('div', {
    className: 'dsh-card dsh-anim-card',
    onClick: onOpen,
    style: { ...cardStyle, padding: 26, animationDelay: `${index * 30}ms`, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 14 },
  },
    // header: status + alias + platform
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      h(Icon, { name: 'server', size: 24, color: colors.primary }),
      h('span', { style: { fontSize: 19, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.server.alias),
      badge(status.text, status.tone),
      h('span', { style: { flex: 1 } }),
      h('span', {
        style: { fontSize: 12.5, padding: '3px 12px', borderRadius: radii.pill, border: `1px solid ${colors.borderStrong}`, opacity: 0.9 },
        title: entry.server.capabilities?.arch ? `${osLabel(entry.server.capabilities)} · ${entry.server.capabilities.arch}` : osLabel(entry.server.capabilities),
      }, osLabel(entry.server.capabilities)),
    ),
    h('div', { style: { fontSize: 13, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.server.endpoint),
    // metrics row
    s
      ? h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-around', gap: 8, padding: '6px 0' } },
          h(Donut, { percent: s.cpuPercent, label: 'CPU', size: 132 }),
          h(Donut, { percent: memPercent, label: '内存', size: 132 }),
          h(Donut, { percent: diskPercent, label: '磁盘 /', size: 132 }),
        )
      : h('div', { style: { padding: '26px 0', textAlign: 'center', color: colors.muted } }, `— 无数据（${timeAgo(entry.lastCollectedAt)}）`),
    // alerts + updated
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      entry.alertCount.critical > 0 ? badge(`严重告警 ${entry.alertCount.critical}`, 'err', true) : null,
      entry.alertCount.warning > 0 ? badge(`告警 ${entry.alertCount.warning}`, 'warn') : null,
      entry.alertCount.critical === 0 && entry.alertCount.warning === 0 ? badge('无告警', 'ok') : null,
      h('span', { style: { flex: 1 } }),
      s ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: colors.muted } },
        `CPU ${formatPercent(s.cpuPercent, 0)} · ${timeAgo(entry.lastCollectedAt)}`,
        h(Sparkline, { values: s.cpuPercent !== null ? [s.cpuPercent * 0.8, s.cpuPercent, s.cpuPercent * 0.9] : [null], width: 90, height: 24 }),
      ) : null,
    ),
    // footer actions
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, borderTop: `1px solid ${colors.border}`, paddingTop: 12 } },
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5, fontWeight: 600, color: colors.primary } }, '进入监控 →'),
      h('span', { style: { flex: 1 } }),
      confirmRemove
        ? h('div', { style: { display: 'flex', gap: 8 }, onClick: (e: { stopPropagation: () => void }) => e.stopPropagation() },
            h('span', { style: { fontSize: 12.5, alignSelf: 'center', color: colors.warn } }, '确认删除？'),
            h('button', { className: 'dsh-btn', onClick: onRemove, style: { padding: '5px 14px', borderRadius: 6, border: `1px solid ${colors.err}`, background: colors.errSoft, color: colors.err, cursor: 'pointer', fontSize: 12.5 } }, '删除'),
            h('button', { className: 'dsh-btn', onClick: () => setConfirmRemove(false), style: { padding: '5px 14px', borderRadius: 6, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12.5 } }, '取消'),
          )
        : h('button', {
            className: 'dsh-btn',
            onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); setConfirmRemove(true) },
            style: { padding: '5px 14px', borderRadius: 6, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: colors.muted, cursor: 'pointer', fontSize: 12.5 },
          }, '删除'),
    ),
  )
}

/** Verify → fingerprint confirm → save. Same RPC flow as before, prettier shell. */
function AddServerDrawer({ client, store, onDone }: { client: OpsClient; store: OpsStore; onDone: () => void }): ReactElement {
  const [alias, setAlias] = useState('')
  const [commandLine, setCommandLine] = useState('')
  const [secret, setSecret] = useState('')
  const [verify, setVerify] = useState<{ ticket: string; fingerprint: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const doVerify = useCallback(async () => {
    setBusy(true)
    setError(null)
    const res = await client.call('servers.verify', { alias, commandLine, secret: secret || undefined })
    setBusy(false)
    if (res.ok) setVerify(res.value as { ticket: string; fingerprint: string })
    else setError(`${res.error.code}: ${res.error.message}`)
  }, [client, alias, commandLine, secret])

  const doAdd = useCallback(async () => {
    if (!verify) return
    setBusy(true)
    const res = await client.call('servers.add', { alias, commandLine, secret: secret || undefined, ticket: verify.ticket, confirmedFingerprint: verify.fingerprint })
    setBusy(false)
    if (res.ok) {
      setVerify(null)
      setSecret('')
      void store.refresh(client)
      onDone()
    } else setError(`${res.error.code}: ${res.error.message}`)
  }, [client, verify, alias, commandLine, secret, store, onDone])

  const inputStyle: Record<string, string | number> = { padding: '8px 10px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', fontSize: 13 }

  return h('div', { className: 'dsh-anim-card', style: { ...cardStyle, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 } },
    h('div', { style: { fontWeight: 700, fontSize: 15 } }, '添加服务器（先验证后保存）'),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' as const } },
      h('input', { style: { ...inputStyle, width: 140 }, placeholder: '名称', value: alias, onChange: (e: { target: { value: string } }) => setAlias(e.target.value) }),
      h('input', { style: { ...inputStyle, flex: 1, minWidth: 240 }, placeholder: 'ssh -p 22 user@host（或直接填地址）', value: commandLine, onChange: (e: { target: { value: string } }) => setCommandLine(e.target.value) }),
      h('input', { style: { ...inputStyle, width: 150 }, placeholder: '密码/口令', type: 'password', value: secret, onChange: (e: { target: { value: string } }) => setSecret(e.target.value) }),
      h('button', { className: 'dsh-btn', style: { ...inputStyle, cursor: 'pointer', width: 'auto' }, disabled: busy, onClick: () => void doVerify() }, busy ? '验证中…' : '验证连接'),
    ),
    verify
      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const } },
          h('span', null, '主机指纹：'),
          h('code', { style: { fontSize: 11 } }, verify.fingerprint),
          h('button', { className: 'dsh-btn', style: { padding: '6px 16px', borderRadius: radii.sm, border: `1px solid ${colors.primaryBorder}`, background: colors.primarySoft, cursor: 'pointer', fontWeight: 600, color: 'inherit' }, onClick: () => void doAdd() }, '确认指纹并保存'),
          h('button', { className: 'dsh-btn', style: { padding: '6px 14px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', cursor: 'pointer' }, onClick: () => setVerify(null) }, '取消'),
        )
      : null,
    error ? errText(error) : null,
  )
}
