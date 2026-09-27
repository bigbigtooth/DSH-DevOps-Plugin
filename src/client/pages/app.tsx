/**
 * OpsApp (IMPROVE §3.1): two big segmented root tabs — 服务器 / 项目.
 * The old top-level 监控 tab is gone; server monitoring is entered by
 * clicking a server card (server detail with hardware/processes tabs), and
 * projects are entered by clicking a project card (services/logs tabs).
 */
import { createElement, useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { OpsClient, OpsStore } from '../model.ts'
import { ROOT_VIEW, viewTitle, isDetail, type View } from '../router.ts'
import { Icon, type IconName } from '../icons.tsx'
import { colors, radii } from '../theme.ts'
import { ServersListPage } from './servers-list.tsx'
import { ServerHardwarePage } from './server-hardware.tsx'
import { ServerProcessesPage } from './server-processes.tsx'
import { ProjectsListPage } from './projects-list.tsx'
import { ProjectServicesPage } from './project-services.tsx'
import { ProjectDeployPage } from './project-deploy.tsx'
import { ProjectLogsPage } from './project-logs.tsx'
import { AiModelSettingsModal } from './model-settings.tsx'

/* eslint-disable @typescript-eslint/no-explicit-any */
function h(tag: any, props: any, ...children: any[]): ReactElement {
  return createElement(tag, props, ...children)
}

export interface PageProps {
  client: OpsClient
  store: OpsStore
  navigate: {
    openServer: (serverId: string, alias?: string) => void
    openProject: (projectId: string, alias?: string) => void
    back: () => void
  }
}

const TABS: Array<{ key: 'servers' | 'projects'; label: string; icon: IconName }> = [
  { key: 'servers', label: '服务器', icon: 'server' },
  { key: 'projects', label: '项目', icon: 'layers' },
]

/**
 * The host may re-render the panel slot at any time (e.g. on storage change
 * notifications from the scheduler). A useState-held view stack would reset
 * to the root on every such remount — the user's place is kept in module
 * scope instead and restored on remount.
 */
let persistedStack: View[] = [ROOT_VIEW]

export function OpsApp({ client, store }: { client: OpsClient; store: OpsStore }): ReactElement {
  const [stack, setStack] = useState<View[]>(persistedStack)
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false)
  const current = stack[stack.length - 1]!

  // store heartbeat: offline flag + server list for pickers (read-only, cheap)
  useEffect(() => {
    void store.refresh(client)
    const t = setInterval(() => { void store.refresh(client) }, 8000)
    return () => clearInterval(t)
  }, [client, store])

  const update = useCallback((next: View[] | ((prev: View[]) => View[])): void => {
    setStack((prev) => {
      const nextStack = typeof next === 'function' ? next(prev) : next
      persistedStack = nextStack
      return nextStack
    })
  }, [])

  const push = useCallback((view: View): void => {
    update((s) => [...s, view])
  }, [update])
  const back = useCallback((): void => {
    update((s) => (s.length > 1 ? s.slice(0, -1) : s))
  }, [update])
  const switchRoot = useCallback((root: View): void => {
    update([root])
  }, [update])

  const navigate = { openServer: (id: string, alias?: string) => push({ kind: 'server', serverId: id, serverAlias: alias, tab: 'hardware' }), openProject: (id: string, alias?: string) => push({ kind: 'project', projectId: id, projectAlias: alias, tab: 'services' }), back }

  const detailTab = (keys: readonly string[], labels: readonly string[], active: string, onPick: (k: string) => void): ReactElement =>
    h('div', { style: { display: 'flex', gap: 6, background: colors.surface, borderRadius: radii.md, padding: 4, width: 'fit-content' } },
      keys.map((k, i) => h('button', {
        key: k,
        onClick: () => onPick(k),
        style: {
          padding: '7px 20px', borderRadius: radii.sm - 4, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
          color: active === k ? '#fff' : 'inherit',
          background: active === k ? colors.primary : 'transparent',
          transition: 'background .2s ease, color .2s ease',
        },
      }, labels[i])),
    )

  const setDetailTab = (tab: string): void => {
    update((s) => s.map((v, i) => {
      if (i !== s.length - 1) return v
      if (v.kind === 'server') return { ...v, tab: tab as 'hardware' | 'processes' }
      if (v.kind === 'project') return { ...v, tab: tab as 'services' | 'logs' | 'deploy' }
      return v
    }))
  }

  return h('div', { className: 'dsh-anim-page', style: { padding: 20, fontFamily: 'system-ui, sans-serif', fontSize: 13, color: 'inherit', overflow: 'auto', height: '100%', boxSizing: 'border-box' } },
    // breadcrumb for detail views
    isDetail(current)
      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
          h('button', {
            className: 'dsh-btn',
            onClick: back,
            style: { border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', borderRadius: radii.sm, padding: '5px 14px', cursor: 'pointer', fontSize: 13 },
          }, '← 返回'),
          h('span', { style: { fontSize: 18, fontWeight: 700 } }, viewTitle(current)),
        )
      : null,
    // root segmented tab (hidden inside detail views — the breadcrumb takes over)
    !isDetail(current)
      ? h('div', {
          style: {
            position: 'relative', display: 'grid', gridTemplateColumns: `repeat(${TABS.length}, 1fr)`,
            background: colors.surface, borderRadius: radii.md, padding: 5, marginBottom: 18, maxWidth: 420,
          },
        },
          h('div', {
            key: current.kind,
            style: {
              position: 'absolute', top: 5, bottom: 5, left: 5, width: `calc((100% - 10px) / ${TABS.length})`,
              background: colors.primary, borderRadius: radii.sm + 1,
              transform: current.kind === 'projects' ? 'translateX(100%)' : 'translateX(0)',
              transition: 'transform .24s ease-out',
            },
          }),
          TABS.map((t) =>
            h('button', {
              key: t.key,
              className: 'dsh-tab-item',
              onClick: () => switchRoot({ kind: t.key }),
              style: {
                position: 'relative', zIndex: 1, padding: '11px 0', border: 'none', borderRadius: radii.sm,
                background: 'transparent', cursor: 'pointer', fontSize: 15, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                color: current.kind === t.key ? '#fff' : 'inherit',
              },
            }, h(Icon, { name: t.icon, size: 18, color: current.kind === t.key ? '#fff' : colors.primary }), t.label),
          ),
        )
      : null,
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' as const } },
      current.kind === 'server' || current.kind === 'project'
        ? detailTab(
            current.kind === 'server' ? (['hardware', 'processes'] as const) : (['services', 'logs', 'deploy'] as const),
            current.kind === 'server' ? (['硬件', '进程'] as const) : (['服务', '日志', '部署'] as const),
            current.tab,
            setDetailTab)
        : h('div', { style: { fontSize: 20, fontWeight: 700 } }, viewTitle(current)),
      // 全局入口：AI 模型设置（首次 AI 部署/巡检/修复所用模型）
      h('button', {
        className: 'dsh-btn',
        onClick: () => setAiSettingsOpen(true),
        title: 'AI 模型设置：选择首次 AI 部署、巡检与修复使用的 provider/model',
        'aria-label': 'AI 模型设置',
        style: { width: 34, height: 34, borderRadius: radii.pill, border: `1px solid ${colors.borderStrong}`, background: 'transparent', cursor: 'pointer', color: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
      }, h(Icon, { name: 'gear', size: 17 })),
    ),
    aiSettingsOpen ? h(AiModelSettingsModal, { client, onClose: () => setAiSettingsOpen(false) }) : null,
    current.kind === 'servers' ? h(ServersListPage, { client, store, navigate }) : null,
    current.kind === 'projects' ? h(ProjectsListPage, { client, store, navigate }) : null,
    current.kind === 'server' && current.tab === 'hardware' ? h(ServerHardwarePage, { client, serverId: current.serverId }) : null,
    current.kind === 'server' && current.tab === 'processes' ? h(ServerProcessesPage, { client, serverId: current.serverId }) : null,
    current.kind === 'project' && current.tab === 'services' ? h(ProjectServicesPage, { client, projectId: current.projectId }) : null,
    current.kind === 'project' && current.tab === 'logs' ? h(ProjectLogsPage, { client, projectId: current.projectId }) : null,
    current.kind === 'project' && current.tab === 'deploy' ? h(ProjectDeployPage, { client, projectId: current.projectId }) : null,
  )
}
