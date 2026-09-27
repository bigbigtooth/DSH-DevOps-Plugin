/**
 * Zero-dependency SVG charts (IMPROVE §3.3). Five components only:
 * Donut, BigNumber, LineChart, Sparkline, MiniBar. Every component renders
 * honest placeholders for null/empty data — no fabricated zeros.
 * Animations: stroke-dashoffset transitions + rAF count-up; they degrade via
 * the injected reduced-motion stylesheet.
 */
import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { colors } from './theme.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
function h(tag: any, props: any, ...children: any[]): ReactElement {
  return createElement(tag, props, ...children)
}

/** rAF count-up: eases toward `target` over `duration` ms; null renders '—'. */
function useCountUp(target: number | null, durationMs = 400): number | null {
  const [display, setDisplay] = useState<number | null>(target)
  const fromRef = useRef<number | null>(null)
  useEffect(() => {
    if (target === null) {
      setDisplay(null)
      return
    }
    const from = fromRef.current ?? 0
    const start = Date.now()
    // setInterval instead of requestAnimationFrame: the host tsconfig has no
    // DOM lib, and 16ms ticks are sufficient for sub-second count-ups
    const timer = setInterval(() => {
      const t = Date.now() - start
      const p = Math.min(1, t / durationMs)
      const eased = 1 - Math.pow(1 - p, 3)
      const value = from + (target - from) * eased
      setDisplay(value)
      if (p >= 1) {
        fromRef.current = target
        clearInterval(timer)
      } else {
        fromRef.current = value
      }
    }, 16)
    return () => clearInterval(timer)
  }, [target, durationMs])
  return display
}

// ---------- Donut ----------

export interface DonutProps {
  /** 0-100 utilization; null renders the honest empty state */
  percent: number | null
  label: string
  /** center secondary line (e.g. `9.8/16 GiB`) */
  sub?: string
  size?: number
  color?: string
}

/** Ring gauge with animated stroke and threshold coloring. */
export function Donut({ percent, label, sub, size = 108, color }: DonutProps): ReactElement {
  const stroke = 9
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = percent !== null ? Math.max(0, Math.min(100, percent)) : null
  const shown = useCountUp(clamped, 600)
  const strokeColor = color ?? (percent !== null ? (percent > 90 ? colors.err : percent > 70 ? colors.warn : colors.ok) : colors.muted)
  return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: size } },
    h('div', { style: { position: 'relative', width: size, height: size } },
      h('svg', { width: size, height: size },
        h('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: colors.surface, strokeWidth: stroke }),
        h('circle', {
          cx: size / 2, cy: size / 2, r, fill: 'none', stroke: strokeColor, strokeWidth: stroke,
          strokeLinecap: 'round', strokeDasharray: c,
          strokeDashoffset: shown === null ? c : c * (1 - shown / 100),
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
          style: { transition: 'stroke-dashoffset .6s ease-out, stroke .4s ease' },
        }),
      ),
      h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' } },
        h('div', { style: { fontSize: Math.round(size / 4.6), fontWeight: 700, fontVariantNumeric: 'tabular-nums' } },
          shown === null ? '—' : `${Math.round(shown)}%`),
        sub ? h('div', { style: { fontSize: 10, opacity: 0.7 } }, sub) : null,
      ),
    ),
    h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, label),
  )
}

// ---------- BigNumber ----------

export interface BigNumberProps {
  value: number | null
  unit: string
  label: string
  digits?: number
  color?: string
}

/** Big number + unit for non-percentage metrics (network rate, sizes). */
export function BigNumber({ value, unit, label, digits = 1, color }: BigNumberProps): ReactElement {
  const shown = useCountUp(value, 400)
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 96 } },
    h('div', { style: { fontSize: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, color: color ?? 'inherit' } },
      shown === null ? '—' : shown.toFixed(digits)),
    h('div', { style: { fontSize: 11, opacity: 0.7, fontWeight: 600 } }, unit),
    h('div', { style: { fontSize: 12, opacity: 0.85 } }, label),
  )
}

// ---------- LineChart ----------

export interface LineSeries {
  name: string
  color: string
  /** x = epoch ms, y = any finite value; null gaps break the line */
  points: Array<{ x: number; y: number | null }>
}

export interface LineChartProps {
  series: LineSeries[]
  height?: number
  /** y-axis formatter (shared by all series) */
  formatY?: (v: number) => string
  formatX?: (ms: number) => string
}

/** Multi-series polyline with light axes + legend; empty data renders a placeholder. */
export function LineChart({ series, height = 180, formatY = (v) => String(Math.round(v)), formatX = (ms) => new Date(ms).toLocaleTimeString() }: LineChartProps): ReactElement {
  const width = 640
  const pad = { l: 44, r: 12, t: 12, b: 22 }
  const all = series.flatMap((s) => s.points.filter((p) => p.y !== null) as Array<{ x: number; y: number }>)
  if (all.length < 2) {
    return h('div', { style: { height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted, fontSize: 13 } }, '暂无历史数据（调度器采集后此处显示曲线）')
  }
  const xs = all.map((p) => p.x)
  const ys = all.map((p) => p.y)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const yMax = Math.max(...ys, 0.0001) * 1.1
  const yMin = Math.min(...ys, 0)
  const sx = (x: number): number => pad.l + ((x - x0) / Math.max(1, x1 - x0)) * (width - pad.l - pad.r)
  const sy = (y: number): number => height - pad.b - ((y - yMin) / Math.max(0.0001, yMax - yMin)) * (height - pad.t - pad.b)
  const yTicks = [0, 0.5, 1].map((f) => yMin + f * (yMax - yMin))
  const xTicks = [x0, (x0 + x1) / 2, x1]
  return h('div', null,
    h('svg', { width: '100%', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' },
      yTicks.map((t, i) => h('g', { key: `y${i}` },
        h('line', { x1: pad.l, x2: width - pad.r, y1: sy(t), y2: sy(t), stroke: colors.border, strokeDasharray: '3 4' }),
        h('text', { x: pad.l - 6, y: sy(t) + 4, fontSize: 10, textAnchor: 'end', fill: colors.muted }, formatY(t)),
      )),
      xTicks.map((t, i) => h('text', { key: `x${i}`, x: sx(t), y: height - 6, fontSize: 10, textAnchor: i === 0 ? 'start' : i === 2 ? 'end' : 'middle', fill: colors.muted }, formatX(t))),
      series.map((s) => {
        const segments: string[] = []
        let current: string[] = []
        for (const p of s.points) {
          if (p.y === null) {
            if (current.length) segments.push(current.join(' '))
            current = []
            continue
          }
          current.push(`${current.length === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
        }
        if (current.length) segments.push(current.join(' '))
        return h('g', { key: s.name }, segments.map((d, i) => h('path', { key: i, d, fill: 'none', stroke: s.color, strokeWidth: 1.8, strokeLinejoin: 'round' })))
      }),
    ),
    h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 } },
      series.map((s) => h('div', { key: s.name, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 } },
        h('span', { style: { width: 10, height: 10, borderRadius: 3, background: s.color, display: 'inline-block' } }),
        s.name,
      ))),
  )
}

// ---------- Sparkline ----------

export interface SparklineProps {
  values: Array<number | null>
  color?: string
  width?: number
  height?: number
}

/** Tiny axis-less trend line; null values create gaps. */
export function Sparkline({ values, color = colors.primary, width = 120, height = 28 }: SparklineProps): ReactElement {
  const pts = values.filter((v) => v !== null) as number[]
  if (pts.length < 2) return h('span', { style: { color: colors.muted, fontSize: 11 } }, '—')
  const max = Math.max(...pts, 0.0001)
  const min = Math.min(...pts, 0)
  const step = width / Math.max(1, values.length - 1)
  let d = ''
  let started = false
  values.forEach((v, i) => {
    if (v === null) {
      started = false
      return
    }
    const x = i * step
    const y = height - 2 - ((v - min) / Math.max(0.0001, max - min)) * (height - 4)
    d += `${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `
    started = true
  })
  const lastVal = pts[pts.length - 1]!
  const lastX = (values.lastIndexOf(lastVal)) * step
  const lastY = height - 2 - ((lastVal - min) / Math.max(0.0001, max - min)) * (height - 4)
  return h('svg', { width, height },
    h('path', { d: d.trim(), fill: 'none', stroke: color, strokeWidth: 1.5 }),
    h('circle', { cx: lastX, cy: lastY, r: 2.5, fill: color }),
  )
}

// ---------- MiniBar ----------

export interface MiniBarItem {
  label: string
  value: number
  color: string
}

/** Horizontal bars with labels + counts (log level distribution). */
export function MiniBar({ items }: { items: MiniBarItem[] }): ReactElement {
  const max = Math.max(...items.map((i) => i.value), 1)
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    items.map((it) => h('div', { key: it.label, style: { display: 'grid', gridTemplateColumns: '64px 1fr 72px', alignItems: 'center', gap: 8 } },
      h('span', { style: { fontSize: 12, fontWeight: 600, color: it.color } }, it.label),
      h('div', { style: { height: 10, borderRadius: 5, background: colors.surface } },
        h('div', { style: { width: `${(it.value / max) * 100}%`, height: '100%', borderRadius: 5, background: it.color, transition: 'width .5s ease' } })),
      h('span', { style: { fontSize: 12, fontVariantNumeric: 'tabular-nums', textAlign: 'right' } }, it.value >= 1000 ? `${(it.value / 1000).toFixed(1)}k` : String(it.value)),
    )),
  )
}
