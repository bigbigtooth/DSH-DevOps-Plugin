/**
 * Design tokens + formatters for the overhauled client (IMPROVE §3.2).
 * Inline-style friendly values only; colors use rgba so they sit on both
 * light and dark host themes without a theme provider.
 */

export const colors = {
  primary: '#3b82f6',
  primarySoft: 'rgba(59,130,246,.22)',
  primaryBorder: 'rgba(59,130,246,.55)',
  ok: '#22c55e',
  okSoft: 'rgba(34,197,94,.16)',
  warn: '#f59e0b',
  warnSoft: 'rgba(245,158,11,.16)',
  err: '#ef4444',
  errSoft: 'rgba(239,68,68,.18)',
  border: 'rgba(128,128,128,.25)',
  borderStrong: 'rgba(128,128,128,.45)',
  surface: 'rgba(128,128,128,.08)',
  surfaceStrong: 'rgba(128,128,128,.15)',
  text: 'inherit',
  muted: 'rgba(128,128,128,.95)',
}

export const radii = { sm: 8, md: 12, lg: 14, pill: 999 }

export const shadow = {
  card: '0 1px 3px rgba(0,0,0,.08)',
  cardHover: '0 8px 24px rgba(0,0,0,.14)',
}

export const duration = { fast: 180, base: 240, slow: 360 }

/**
 * One-time animation/hover stylesheet. Injected by entry.ts; classes are
 * referenced from inline styles' className. prefers-reduced-motion disables
 * every animation and transition.
 */
export const ANIM_STYLE_ID = 'dsh-devops-anim'
export const ANIM_CSS = `
@keyframes dsh-fade-in-up { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes dsh-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes dsh-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
@keyframes dsh-spin { to { transform: rotate(360deg); } }
.dsh-anim-card { animation: dsh-fade-in-up .36s ease-out both; }
.dsh-anim-page { animation: dsh-fade-in .16s ease-out both; }
.dsh-anim-pulse { animation: dsh-pulse 1.6s ease-in-out infinite; }
.dsh-spin { animation: dsh-spin .9s linear infinite; }
.dsh-card { transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
.dsh-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.14); border-color: rgba(59,130,246,.5); }
.dsh-btn { transition: background .15s ease, border-color .15s ease, opacity .15s ease; }
.dsh-btn:hover { border-color: rgba(59,130,246,.55); background: rgba(59,130,246,.14); }
.dsh-btn:disabled { opacity: .5; cursor: default; }
.dsh-tab-item { transition: color .2s ease; }
.dsh-collapse { transition: max-height .25s ease, opacity .2s ease; overflow: hidden; }
@media (prefers-reduced-motion: reduce) {
  .dsh-anim-card, .dsh-anim-page, .dsh-anim-pulse, .dsh-spin { animation: none !important; }
  .dsh-card, .dsh-btn, .dsh-tab-item, .dsh-collapse { transition: none !important; }
  .dsh-card:hover { transform: none; }
}
`

// ---------- formatters ----------

export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(u === 0 ? 0 : digits)} ${units[u]}`
}

export function formatRate(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${formatBytes(n, 1)}/s`
}

export function formatPercent(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${n.toFixed(digits)}%`
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** Threshold color for utilization percentages. */
export function utilizationColor(percent: number | null | undefined): string {
  if (percent === null || percent === undefined) return colors.muted
  if (percent > 90) return colors.err
  if (percent > 70) return colors.warn
  return colors.ok
}

// ---------- opaque dialog base ----------

/** Structural DOM views: the project tsconfig has no DOM lib. */
interface BgElementLike {
  parentElement: BgElementLike | null
}
interface CssStyleLike {
  backgroundColor?: string
}
interface WindowViewLike {
  getComputedStyle(el: BgElementLike): CssStyleLike
  matchMedia?(query: string): { matches: boolean }
}
interface BackdropDocLike {
  body?: BgElementLike | null
  querySelector(selector: string): BgElementLike | null
  defaultView?: WindowViewLike | null
}

/**
 * Opaque base color for modal dialogs: `colors.surface` is translucent, so the
 * page behind a dialog bleeds through. The host theme is unknown at build
 * time, so walk up from our own panel container to the first ancestor painted
 * with an effectively opaque background and use it as the base; the
 * translucent surface is layered over it via CSS compositing (the
 * linear-gradient trick). Falls back to the OS color scheme when every
 * ancestor is transparent. Layer with:
 * `background: linear-gradient(${colors.surface}, ${colors.surface}), ${bg}`.
 */
export function resolveOpaqueDialogBase(): string {
  const doc = (globalThis as { document?: BackdropDocLike }).document
  const view = doc?.defaultView
  if (!doc || !view || typeof view.getComputedStyle !== 'function') return '#1b1c1f'
  let el: BgElementLike | null = doc.querySelector('[data-dsh-devops-panel]') ?? doc.body ?? null
  for (let depth = 0; el !== null && depth < 32; depth++, el = el.parentElement) {
    const bg = view.getComputedStyle(el).backgroundColor
    const m = typeof bg === 'string' ? /rgba?\(([^)]+)\)/.exec(bg.replace(/\s+/g, '')) : null
    if (!m) continue
    const parts = m[1]!.split(',').map((s) => Number.parseFloat(s))
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) continue
    const alpha = parts.length >= 4 ? parts[3]! : 1
    if (alpha >= 0.95) return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`
  }
  const dark = typeof view.matchMedia === 'function' && view.matchMedia('(prefers-color-scheme: dark)').matches
  return dark ? '#1b1c1f' : '#ffffff'
}
