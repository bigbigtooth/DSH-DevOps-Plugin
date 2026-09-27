/**
 * Shared client hooks + reusable UI style helpers for the overhauled pages.
 * Polls pause while the tab is hidden (visibilitychange) and when the
 * callback identity changes they restart cleanly.
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { colors, radii } from './theme.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
function h(tag: any, props: any, ...children: any[]): ReactElement {
  return createElement(tag, props, ...children)
}

/**
 * Module-level poll cache + in-flight dedup. The host re-renders the panel
 * slot frequently (storage notifications), remounting pages; cached results
 * make remounts seamless (no loading flash) and the in-flight set keeps
 * SSH-backed polls from stacking.
 */
const pollCache = new Map<string, unknown>()
const pollInFlight = new Map<string, Promise<unknown>>()

/**
 * Poll an async loader on a fixed interval. The loader runs immediately on
 * mount and whenever `deps` change; polling skips while document.hidden.
 * `key` identifies the poll site for cross-remount caching.
 * Returns [data, reload, error].
 */
export function usePoll<R>(key: string, loader: () => Promise<R>, intervalMs: number, deps: unknown[]): [R | null, () => void, string | null] {
  const [data, setData] = useState<R | null>(() => (pollCache.has(key) ? (pollCache.get(key) as R) : null))
  const [error, setError] = useState<string | null>(null)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const run = useCallback((): void => {
    if (pollInFlight.has(key)) return
    const p = loaderRef.current()
      .then((v) => {
        pollCache.set(key, v)
        pollInFlight.delete(key)
        setData(v)
        setError(null)
      })
      .catch((e: unknown) => {
        pollInFlight.delete(key)
        setError(e instanceof Error ? e.message : String(e))
      })
    pollInFlight.set(key, p as Promise<unknown>)
  }, [key])
  useEffect(() => {
    run()
    if (intervalMs <= 0) return
    const t = setInterval(() => {
      // structural access: the project tsconfig has no DOM lib
      const doc = (globalThis as { document?: { hidden?: boolean } }).document
      if (doc?.hidden) return
      run()
    }, intervalMs)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, intervalMs, ...deps])
  return [data, run, error]
}

// ---------- shared inline-style pieces ----------

export const cardStyle: Record<string, string | number> = {
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  padding: 18,
  background: colors.surface,
  boxShadow: '0 1px 3px rgba(0,0,0,.08)',
}

export function badge(text: string, tone: 'ok' | 'warn' | 'err' | 'muted' | 'primary' = 'muted', pulse = false): ReactElement {
  const map: Record<string, { fg: string; bg: string; bd: string }> = {
    ok: { fg: colors.ok, bg: colors.okSoft, bd: colors.ok },
    warn: { fg: colors.warn, bg: colors.warnSoft, bd: colors.warn },
    err: { fg: colors.err, bg: colors.errSoft, bd: colors.err },
    primary: { fg: colors.primary, bg: colors.primarySoft, bd: colors.primaryBorder },
    muted: { fg: colors.muted, bg: colors.surface, bd: colors.borderStrong },
  }
  const t = map[tone]!
  return h('span', {
    className: pulse ? 'dsh-anim-pulse' : undefined,
    style: {
      padding: '2px 10px', borderRadius: radii.pill, fontSize: 11, fontWeight: 600,
      color: t.fg, background: t.bg, border: `1px solid ${t.bd}`, whiteSpace: 'nowrap',
    },
  }, text)
}

export function metricLabel(text: string): ReactElement {
  return h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.75 } }, text)
}

export const sectionTitle: Record<string, string | number> = { fontSize: 15, fontWeight: 700 }

export function errText(message: string): ReactElement {
  return h('div', { style: { color: colors.err, fontSize: 12 } }, message)
}

export function emptyState(text: string): ReactElement {
  return h('div', {
    style: {
      border: `1px dashed ${colors.borderStrong}`, borderRadius: radii.md,
      padding: '36px 16px', textAlign: 'center', color: colors.muted, fontSize: 13,
    },
  }, text)
}
