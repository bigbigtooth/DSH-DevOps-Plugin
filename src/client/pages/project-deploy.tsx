/**
 * Project detail · deploy tab.
 * - the 🚀 部署 action lives HERE (moved from the services tab): the overlay
 *   opens instantly in a pending state and re-binds to the real run when the
 *   RPC answers (run creation on the host takes seconds).
 * - deployment log: records grouped by outcome — 成功 (SUCCEEDED) vs 失败
 *   (FAILED/STOPPED) via filter chips, each record expands to its persisted
 *   event log (deploy.events) with success events green / failure events red.
 * - 详情 opens the full-screen progress overlay for any run (live polling).
 */
import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { OpsClient } from '../model.ts'
import { usePoll, cardStyle, badge, errText } from '../hooks.ts'
import { Icon } from '../icons.tsx'
import { colors, radii, resolveOpaqueDialogBase, timeAgo } from '../theme.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
function h(tag: any, props: any, ...children: any[]): ReactElement {
  return createElement(tag, props, ...children)
}

export interface RunRow {
  runId: string
  status: string
  stage: string
  kind: string
  targetCommit: string | null
  failureReason: string | null
  createdAt: number
  updatedAt: number
}

export interface RunEvent {
  runId: string
  sequence: number
  timestamp: number
  type: string
  payload: Record<string, any>
}

const ACTIVE_STATUSES = ['RUNNING', 'QUEUED', 'REPAIRING', 'STOPPING', 'RECONCILE_REQUIRED']
const STOPPABLE = ['RUNNING', 'QUEUED', 'REPAIRING']
const TERMINAL = ['SUCCEEDED', 'FAILED', 'STOPPED']

/**
 * Outcome categories for the deployment log. A STOPPED run performed no
 * update and no restart — it is NOT a failure: it renders gray as
 * “已停止 · 无操作” and never counts into the ❌ 失败 category.
 */
function runOutcome(r: RunRow): 'ok' | 'fail' | 'stopped' | 'active' {
  if (r.status === 'SUCCEEDED') return 'ok'
  if (r.status === 'FAILED') return 'fail'
  if (r.status === 'STOPPED') return 'stopped'
  return 'active'
}

/** human-readable run statuses for badges (raw enum elsewhere). */
const STATUS_LABELS: Record<string, string> = {
  SUCCEEDED: '成功',
  FAILED: '失败',
  STOPPED: '已停止 · 无操作',
  RUNNING: '进行中',
  QUEUED: '排队中',
  REPAIRING: '修复中',
  STOPPING: '停止中',
  RECONCILE_REQUIRED: '待人工核对',
}
export function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s
}

/** run.kind 的展示名：原来把 'first-deploy' 原样亮给用户 */
const KIND_LABELS: Record<string, string> = {
  'first-deploy': '首次部署',
  update: '更新部署',
}
export function kindLabel(k: string): string {
  return KIND_LABELS[k] ?? k
}

const STAGE_LABELS: Record<string, string> = {
  PRECHECK: '预检 · 检测代码与分支',
  PULL: '拉取更新 (git pull)',
  DEPENDENCIES: '安装依赖',
  BUILD: '构建',
  SERVICE_RESTART: '重启服务',
  HEALTH_CHECK: '健康检查',
  LOG_VERIFY: '校验重启日志',
  LOG_REFRESH: '刷新日志来源',
  ALREADY_LATEST: '代码已是最新，无需重启',
  REPAIR: '自动修复',
  RECOVERY: '重启后恢复核对',
  STOP: '停止',
}
const EVENT_LABELS: Record<string, string> = {
  START: '开始部署',
  STAGE: '阶段切换',
  COMMIT_FROZEN: '冻结目标提交',
  ALREADY_LATEST: '代码已是最新',
  LOG_VERIFY: '日志校验结果',
  REDEPLOY_SUCCEEDED: '部署成功',
  DEPLOY_SUCCEEDED: '部署成功',
  SUCCEED: '完成',
  FAIL: '失败',
  REQUEST_STOP: '请求停止',
  ENTER_REPAIR: '进入修复',
  RESUME_FROM_REPAIR: '修复后继续',
  ENTER_RECONCILE: '需要人工核对',
  CONFIRM_STOPPED: '已停止',
  RESOLVE_RECONCILE_CONTINUE: '继续执行',
  RESOLVE_RECONCILE_ARCHIVE: '归档关闭',
}
export function stageLabel(s: string): string {
  return STAGE_LABELS[s] ?? s
}
function eventLabel(t: string): string {
  return EVENT_LABELS[t] ?? t
}
function describeEvent(e: RunEvent): string {
  const p = e.payload ?? {}
  const bits: string[] = []
  if (p.stage) bits.push(stageLabel(String(p.stage)))
  if (p.commit) bits.push(`提交 ${String(p.commit).slice(0, 8)}`)
  if (p.previous) bits.push(`原 ${String(p.previous).slice(0, 8)}`)
  if (p.errorCount != null) bits.push(`${p.errorCount} 行错误`)
  if (Array.isArray(p.offenders) && p.offenders.length) bits.push(String(p.offenders[0]))
  if (p.reason) bits.push(String(p.reason))
  if (p.from && p.to) bits.push(`${p.from} → ${p.to}`)
  return bits.join(' · ')
}
const isErrEvent = (t: string): boolean => t === 'FAIL' || t === 'ENTER_RECONCILE' || t === 'REQUEST_STOP'
const isOkEvent = (t: string): boolean => t === 'SUCCEED' || t === 'REDEPLOY_SUCCEEDED' || t === 'DEPLOY_SUCCEEDED' || t === 'ALREADY_LATEST'

/**
 * The host remounts the panel slot at any time (storage notifications — see
 * app.tsx persistedStack / hooks.ts pollCache). Deploy feedback lives in module
 * scope so the progress/error overlay survives those remounts; otherwise the
 * click's popup vanishes the instant the host re-renders and the user sees
 * "nothing happened".
 */
let persistedOverlayRunId: string | null = null

export function ProjectDeployPage({ client, projectId }: { client: OpsClient; projectId: string }): ReactElement {
  const [runsState, reloadRuns] = usePoll<RunRow[]>(`deploy.list:${projectId}`,
    () => client.call('deploy.list', { projectId, limit: 20 }).then((r) => (r.ok ? (r.value as RunRow[]) : Promise.resolve([] as RunRow[]))),
    4000,
    [projectId],
  )
  const runs = runsState ?? []
  const activeRun = runs.find((r) => ACTIVE_STATUSES.includes(r.status))
  const latestRun = runs[0]
  const deploying = activeRun !== undefined

  const [overlayRunId, setOverlayRunId] = useState<string | null>(persistedOverlayRunId)
  const setOverlay = (id: string | null): void => {
    persistedOverlayRunId = id
    setOverlayRunId(id)
  }
  /** event log cache per run + which record is expanded */
  const [steps, setSteps] = useState<Map<string, RunEvent[]>>(new Map())
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'ok' | 'fail' | 'stopped'>('all')

  /** Trigger a redeploy; the overlay opens INSTANTLY in a pending state —
   *  creating the run on the host takes seconds (persistent storage writes)
   *  and an await-then-open flow leaves the click without any feedback.
   *  The overlay is re-bound to the real run (or the failure) on response. */
  const redeploy = async (): Promise<void> => {
    setOverlay('pending')
    const res = await client.call('deploy.redeploy', { projectId })
    if (!res.ok) {
      // surface the failure in the overlay too (e.g. occupancy / precheck)
      setOverlay(`error:${res.error.message}`)
      return
    }
    const run = res.value as unknown as RunRow
    setOverlay(run.runId)
    void reloadRuns()
  }

  // A remount (host storage notifications) drops the in-flight redeploy
  // promise; while the overlay is pending, promote to the run as soon as the
  // deploy.list poll sees it so the pending state can never get stuck.
  useEffect(() => {
    if (overlayRunId === 'pending' && activeRun) setOverlay(activeRun.runId)
  }, [overlayRunId, activeRun])

  /** Deploy click: with an active run, show its progress instead of stacking
   *  another (rejected) deploy — the server is single-occupancy per target. */
  const onDeployClick = (): void => {
    if (deploying && activeRun) setOverlay(activeRun.runId)
    else void redeploy()
  }

  const stopRun = async (runId: string): Promise<void> => {
    await client.call('deploy.stop', { runId })
    void reloadRuns()
  }
  /** Expand a record's persisted event log (toggle; loads once, then cached). */
  const toggleEvents = async (runId: string): Promise<void> => {
    if (expandedRunId === runId) {
      setExpandedRunId(null)
      return
    }
    setExpandedRunId(runId)
    if (!steps.has(runId)) {
      const res = await client.call('deploy.events', { runId, afterSequence: 0 })
      if (res.ok) setSteps((prev) => new Map(prev).set(runId, res.value as unknown as RunEvent[]))
    }
  }

  const okRuns = runs.filter((r) => runOutcome(r) === 'ok')
  const failRuns = runs.filter((r) => runOutcome(r) === 'fail')
  const stoppedRuns = runs.filter((r) => runOutcome(r) === 'stopped')
  const shown = filter === 'all' ? runs : filter === 'ok' ? okRuns : filter === 'fail' ? failRuns : stoppedRuns

  const chips: Array<{ key: 'all' | 'ok' | 'fail' | 'stopped'; label: string; count: number; active: string; icon: 'check-circle' | 'x-circle' | 'pause' | null }> = [
    { key: 'all', label: '全部', count: runs.length, active: colors.primary, icon: null },
    { key: 'ok', label: '成功', count: okRuns.length, active: colors.ok, icon: 'check-circle' },
    { key: 'fail', label: '失败', count: failRuns.length, active: colors.err, icon: 'x-circle' },
    { key: 'stopped', label: '已停止', count: stoppedRuns.length, active: 'rgba(128,128,128,.9)', icon: 'pause' },
  ]

  return h('div', { className: 'dsh-anim-page' },
    // ---- action bar: deploy button + current status ----
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' as const } },
      h('button', {
        className: 'dsh-btn',
        onClick: onDeployClick,
        title: 'SSH 检查代码是否最新；有更新则拉取并重启服务，随后校验日志确认重启成功；失败时 AI 自动尝试修复',
        style: deployBtn(deploying),
      }, deploying ? `部署进行中…` : '一键部署'),
      deploying && activeRun ? h('button', { className: 'dsh-btn', onClick: () => setOverlay(activeRun.runId), style: ghostBtn }, '查看进度') : null,
      h('span', { style: { flex: 1 } }),
      deploying || latestRun
        ? h('span', { style: { fontSize: 13, color: colors.muted } },
            deploying
              ? h('span', null, h('b', { style: { color: colors.primary } }, '部署中：'), `${stageLabel(activeRun?.stage || '')} · ${statusLabel(activeRun?.status ?? '')}`)
              : h('span', null, '最近部署：', badge(statusLabel(latestRun!.status), runOutcome(latestRun!) === 'ok' ? 'ok' : runOutcome(latestRun!) === 'fail' ? 'err' : 'muted'), latestRun!.targetCommit ? ` · ${latestRun!.targetCommit.slice(0, 8)}` : '', '（已是最新则不重启）'))
        : h('span', { style: { fontSize: 13, color: colors.muted } }, '还没有部署记录'),
    ),

    // ---- deployment log card with outcome filter ----
    h('div', { className: 'dsh-card', style: cardStyle },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const, marginBottom: 12 } },
        h('div', { style: { fontWeight: 700, fontSize: 15 } }, '部署日志'),
        h('span', { style: { flex: 1 } }),
        h('div', { style: { display: 'flex', gap: 6, background: colors.surface, borderRadius: radii.sm, padding: 3 } },
          chips.map((c) => h('button', {
            key: c.key,
            className: 'dsh-btn',
            onClick: () => setFilter(c.key),
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 12px', borderRadius: radii.sm - 3, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
              color: filter === c.key ? '#fff' : 'inherit',
              background: filter === c.key ? c.active : 'transparent',
            },
          }, c.icon ? h(Icon, { name: c.icon, size: 13, color: filter === c.key ? '#fff' : c.active }) : null, `${c.label} ${c.count}`)),
        ),
      ),

      shown.length === 0
        ? h('div', { style: { color: colors.muted, fontSize: 12.5, padding: '14px 0', textAlign: 'center' } },
            filter === 'ok' ? '还没有成功的部署记录' : filter === 'fail' ? '没有失败的部署记录' : filter === 'stopped' ? '没有已停止的部署记录' : '暂无部署记录——点击上方“一键部署”开始第一次部署')
        : null,

      shown.map((r) => {
        const outcome = runOutcome(r)
        const expanded = expandedRunId === r.runId
        return h('div', { key: r.runId, style: { borderTop: `1px solid ${colors.border}`, padding: '8px 0' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const } },
            badge(statusLabel(r.status), outcome === 'ok' ? 'ok' : outcome === 'fail' ? 'err' : outcome === 'stopped' ? 'muted' : 'primary', ['RUNNING', 'REPAIRING'].includes(r.status)),
            h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, stageLabel(r.stage) || '—'),
            h('span', { style: { fontSize: 11, color: colors.muted } }, `${kindLabel(r.kind)} · ${r.targetCommit ? r.targetCommit.slice(0, 8) : '—'} · ${timeAgo(r.createdAt)}`),
            h('span', { style: { flex: 1 } }),
            STOPPABLE.includes(r.status) ? h('button', { className: 'dsh-btn', onClick: () => void stopRun(r.runId), style: { ...btnSmall, borderColor: colors.err, color: colors.err, background: colors.errSoft } }, '停止') : null,
            r.status === 'RECONCILE_REQUIRED' ? h('button', { className: 'dsh-btn', onClick: () => void client.call('deploy.reconcile', { runId: r.runId }), style: btnSmall }, '核对') : null,
            h('button', { className: 'dsh-btn', onClick: () => setOverlay(r.runId), style: btnSmall }, '详情'),
            h('button', { className: 'dsh-btn', onClick: () => void toggleEvents(r.runId), style: { ...btnSmall, fontWeight: expanded ? 700 : 400 } }, expanded ? '收起日志' : '日志'),
          ),
          // failure reason line for failed runs (full text on hover)
          outcome === 'fail' && r.failureReason
            ? h('div', { style: { fontSize: 11.5, color: colors.err, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '2px 0 0 2px' }, title: r.failureReason }, `失败原因：${r.failureReason}`)
            : null,
          // inline persisted event log — success green / failure red
          expanded
            ? h('div', { style: { marginTop: 6, padding: '8px 10px', borderRadius: radii.sm, background: 'rgba(0,0,0,.14)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 } },
                (steps.get(r.runId) ?? []).length === 0
                  ? h('div', { style: { color: colors.muted } }, '加载事件中…')
                  : (steps.get(r.runId) ?? []).map((e) => h('div', { key: e.sequence, style: { display: 'flex', gap: 10, padding: '2px 0', color: isErrEvent(e.type) ? colors.err : isOkEvent(e.type) ? colors.ok : 'inherit' } },
                      h('span', { style: { color: colors.muted, minWidth: 64 } }, new Date(e.timestamp).toLocaleTimeString()),
                      h('span', { style: { minWidth: 96, fontWeight: 600 } }, eventLabel(e.type)),
                      h('span', { style: { flex: 1, wordBreak: 'break-all' } }, describeEvent(e)),
                    )),
              )
            : null,
        )
      }),
    ),

    // ---- deploy progress overlay ----
    overlayRunId ? h(DeployOverlay, {
      client,
      runId: overlayRunId,
      onClose: () => { setOverlay(null); void reloadRuns() },
    }) : null,
  )
}

// ---------- deploy progress overlay ----------

function DeployOverlay({ client, runId, onClose }: { client: OpsClient; runId: string; onClose: () => void }): ReactElement {
  const pending = runId === 'pending'
  const inlineError = runId.startsWith('error:') ? runId.slice('error:'.length) : null
  const [run, setRun] = useState<RunRow | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  // the page behind the dialog must not bleed through: composite the
  // translucent surface over an opaque base resolved from the host theme
  const [dialogBg] = useState(resolveOpaqueDialogBase)
  const cursorRef = useRef(0)
  // no DOM lib in this tsconfig: keep the log element structurally typed
  const logRef = useRef<{ scrollTo?: (opts: { top: number }) => void; scrollHeight?: number } | null>(null)

  useEffect(() => {
    if (inlineError || pending) return
    let alive = true
    const tick = async (): Promise<void> => {
      const [runRes, evRes] = await Promise.all([
        client.call('deploy.get', { runId }),
        client.call('deploy.events', { runId, afterSequence: cursorRef.current }),
      ])
      if (!alive) return
      if (runRes.ok && runRes.value) setRun(runRes.value as unknown as RunRow)
      if (evRes.ok) {
        const fresh = (evRes.value as unknown as RunEvent[]) ?? []
        if (fresh.length) {
          cursorRef.current = Math.max(...fresh.map((e) => e.sequence))
          setEvents((prev) => [...prev, ...fresh.filter((e) => !prev.some((p) => p.sequence === e.sequence))].sort((a, b) => a.sequence - b.sequence))
        }
      }
      if (runRes.ok && runRes.value && TERMINAL.includes((runRes.value as unknown as RunRow).status)) {
        clearInterval(timer)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, inlineError, pending])

  useEffect(() => {
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight ?? 0 })
  }, [events.length])

  // build an ordered step timeline from encountered STAGE events + current stage
  const stepOrder: string[] = []
  for (const e of events) {
    if (e.type === 'STAGE' && e.payload?.stage && !stepOrder.includes(String(e.payload.stage))) stepOrder.push(String(e.payload.stage))
  }
  if (run?.stage && !stepOrder.includes(run.stage)) stepOrder.push(run.stage)
  const currentIdx = run ? stepOrder.indexOf(run.stage) : -1
  const failed = run?.status === 'FAILED' || inlineError !== null
  const succeeded = run?.status === 'SUCCEEDED'

  return h('div', {
    onClick: onClose,
    style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 },
  },
    h('div', {
      className: 'dsh-anim-card',
      onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
      style: { ...cardStyle, width: 'min(760px, 94vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', background: `linear-gradient(${colors.surface}, ${colors.surface}), ${dialogBg}`, boxShadow: '0 12px 40px rgba(0,0,0,.35)' },
    },
      // header
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: `1px solid ${colors.border}` } },
        inlineError
          ? h(Icon, { name: 'alert', size: 22, color: colors.err })
          : succeeded
            ? h(Icon, { name: 'check-circle', size: 22, color: colors.ok })
            : failed
              ? h(Icon, { name: 'x-circle', size: 22, color: colors.err })
              : h(Icon, { name: 'rocket', size: 22, color: colors.primary }),
        h('div', null,
          h('div', { style: { fontWeight: 700, fontSize: 15 } }, inlineError ? '部署未能启动' : '部署进度'),
          h('div', { style: { fontSize: 12, color: colors.muted } }, inlineError ? '' : run ? `状态 ${statusLabel(run.status)} · ${stageLabel(run.stage || '')}` : pending ? '正在启动部署…' : '连接中…'),
        ),
        h('span', { style: { flex: 1 } }),
        !inlineError && (pending || (run && !TERMINAL.includes(run.status))) ? badge(pending ? '启动中' : '进行中', 'primary', true) : null,
        h('button', { className: 'dsh-btn', onClick: onClose, style: { padding: '4px 12px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 } }, '✕ 关闭'),
      ),

      pending
        ? h('div', { style: { padding: '34px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 } },
            h('div', { className: 'dsh-anim-pulse', style: { display: 'flex' } }, h(Icon, { name: 'rocket', size: 34, color: colors.primary })),
            h('div', { style: { fontSize: 13.5, fontWeight: 600 } }, '正在创建部署任务并向目标服务器申请执行…'),
            h('div', { style: { fontSize: 12, color: colors.muted } }, '通常需要几秒；创建成功后这里会实时显示各阶段进度'),
          )
        : inlineError
        ? h('div', { style: { padding: 18 } },
            errText(`部署失败：${inlineError}`),
            /occupied|占用/.test(inlineError)
              ? h('div', { style: { marginTop: 8, fontSize: 12.5, color: colors.warn } },
                  '目标服务器正被另一个部署任务占用。可关闭本弹窗，在下方“部署记录”中找到占用中的 run 点「停止」释放后重试。')
              : null)
        : h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
            // step timeline
            stepOrder.length ? h('div', { style: { padding: '14px 18px 6px', display: 'flex', flexDirection: 'column', gap: 8 } },
              stepOrder.map((st, i) => {
                const state = currentIdx < 0 ? 'pending' : i < currentIdx ? 'done' : i === currentIdx ? (failed ? 'error' : succeeded ? 'done' : 'active') : 'pending'
                return h('div', { key: st, style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5 } },
                  h('span', { style: { width: 20, textAlign: 'center', color: state === 'done' ? colors.ok : state === 'error' ? colors.err : state === 'active' ? colors.primary : colors.muted, fontWeight: 700 } },
                    state === 'done' ? '✓' : state === 'error' ? '✕' : state === 'active' ? '●' : '○'),
                  h('span', { style: { color: state === 'pending' ? colors.muted : 'inherit', fontWeight: state === 'active' ? 700 : 500 } }, stageLabel(st)),
                  state === 'active' ? h('span', { className: 'dsh-anim-pulse', style: { fontSize: 12, color: colors.primary } }, '进行中…') : null,
                )
              }),
            ) : null,

            // live event log
            h('div', { ref: logRef, style: { flex: 1, overflow: 'auto', margin: '8px 18px', padding: '10px 12px', borderRadius: radii.sm, background: 'rgba(0,0,0,.18)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, minHeight: 160 } },
              events.length === 0 ? h('div', { style: { color: colors.muted } }, '等待部署事件…') : null,
              events.map((e) => h('div', { key: e.sequence, style: { display: 'flex', gap: 8, padding: '2px 0', color: isErrEvent(e.type) ? colors.err : isOkEvent(e.type) ? colors.ok : 'inherit' } },
                h('span', { style: { color: colors.muted, minWidth: 58 } }, new Date(e.timestamp).toLocaleTimeString()),
                h('span', { style: { minWidth: 96, fontWeight: 600 } }, eventLabel(e.type)),
                h('span', { style: { flex: 1, wordBreak: 'break-all' } }, describeEvent(e)),
              )),
            ),

            // failure reason + actions
            run?.status === 'FAILED' && run.failureReason ? h('div', { style: { margin: '0 18px 10px', padding: '8px 12px', borderRadius: radii.sm, background: colors.errSoft, color: colors.err, fontSize: 12.5 } }, `失败原因：${run.failureReason}`) : null,
            h('div', { style: { padding: '10px 18px 16px', display: 'flex', alignItems: 'center', gap: 10 } },
              succeeded ? h('span', { style: { color: colors.ok, fontWeight: 700, fontSize: 13.5 } }, `✓ 部署成功${run?.targetCommit ? ` · ${run.targetCommit.slice(0, 8)}` : ''}`) : null,
              h('span', { style: { flex: 1 } }),
              !inlineError && run && STOPPABLE.includes(run.status)
                ? h('button', { className: 'dsh-btn', onClick: () => void client.call('deploy.stop', { runId: run.runId }), style: { ...btnSmall, borderColor: colors.err, color: colors.err, background: colors.errSoft, fontSize: 13, padding: '6px 14px' } }, '停止部署')
                : null,
              run && TERMINAL.includes(run.status) ? h('button', { className: 'dsh-btn', onClick: onClose, style: { ...btnSmall, fontSize: 13, padding: '6px 14px' } }, '完成') : null,
            ),
          ),
    ),
  )
}

// ---------- style helpers ----------

function deployBtn(busy: boolean): Record<string, string | number> {
  return { padding: '8px 18px', borderRadius: radii.sm, border: `1px solid ${colors.primaryBorder}`, background: colors.primarySoft, cursor: busy ? 'default' : 'pointer', fontWeight: 700, fontSize: 14, color: 'inherit', opacity: busy ? 0.75 : 1 }
}
const ghostBtn: Record<string, string | number> = { padding: '8px 14px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 13 }
const btnSmall: Record<string, string | number> = { padding: '3px 10px', borderRadius: 6, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 11 }
