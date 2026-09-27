/**
 * Zero-dependency inline SVG icon set (IMPROVE UI 调整): crisp stroke icons
 * replace the emoji glyphs (⚙️🧮🧠🌐…) which rendered inconsistently across
 * platforms and too small at text sizes. Lucide-style 24×24 viewBox, stroke
 * inherits currentColor so icons follow the host light/dark theme. Every
 * consumer passes an explicit pixel size — the old emoji scaled with font
 * size only, which is why they looked tiny.
 */
import { createElement } from 'react'
import type { ReactElement } from 'react'

export type IconName =
  | 'server' | 'layers' | 'globe' | 'feather' | 'shield' | 'route' | 'scale'
  | 'database' | 'leaf' | 'zap' | 'box' | 'key' | 'clock' | 'file-text'
  | 'flame' | 'chart' | 'hexagon' | 'trend' | 'code' | 'coffee' | 'terminal'
  | 'gem' | 'gear' | 'network' | 'compass' | 'message' | 'activity' | 'cpu'
  | 'memory' | 'folder' | 'search' | 'refresh' | 'rocket' | 'check-circle'
  | 'x-circle' | 'alert' | 'pause'

interface Shape {
  tag: 'path' | 'circle' | 'rect' | 'line' | 'polyline' | 'ellipse' | 'polygon'
  attrs: Record<string, string | number>
}

const PATHS: Record<IconName, Shape[]> = {
  server: [
    { tag: 'rect', attrs: { x: 2, y: 2, width: 20, height: 8, rx: 2 } },
    { tag: 'rect', attrs: { x: 2, y: 14, width: 20, height: 8, rx: 2 } },
    { tag: 'line', attrs: { x1: 6, y1: 6, x2: 6.01, y2: 6 } },
    { tag: 'line', attrs: { x1: 10, y1: 6, x2: 10.01, y2: 6 } },
    { tag: 'line', attrs: { x1: 6, y1: 18, x2: 6.01, y2: 18 } },
    { tag: 'line', attrs: { x1: 10, y1: 18, x2: 10.01, y2: 18 } },
  ],
  layers: [
    { tag: 'path', attrs: { d: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z' } },
    { tag: 'path', attrs: { d: 'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65' } },
    { tag: 'path', attrs: { d: 'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65' } },
  ],
  globe: [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 10 } },
    { tag: 'path', attrs: { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' } },
    { tag: 'path', attrs: { d: 'M2 12h20' } },
  ],
  feather: [
    { tag: 'path', attrs: { d: 'M12.67 19a2 2 0 0 0 1.42-.59l6.15-6.17a6 6 0 0 0-8.49-8.49L5.59 9.91A2 2 0 0 0 5 11.33V18a1 1 0 0 0 1 1z' } },
    { tag: 'path', attrs: { d: 'M16 8 2 22' } },
    { tag: 'path', attrs: { d: 'M17.5 15H9' } },
  ],
  shield: [
    { tag: 'path', attrs: { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' } },
  ],
  route: [
    { tag: 'circle', attrs: { cx: 6, cy: 19, r: 3 } },
    { tag: 'path', attrs: { d: 'M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15' } },
    { tag: 'circle', attrs: { cx: 18, cy: 5, r: 3 } },
  ],
  scale: [
    { tag: 'path', attrs: { d: 'm16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z' } },
    { tag: 'path', attrs: { d: 'm2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z' } },
    { tag: 'path', attrs: { d: 'M7 21h10' } },
    { tag: 'path', attrs: { d: 'M12 3v18' } },
    { tag: 'path', attrs: { d: 'M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2' } },
  ],
  database: [
    { tag: 'ellipse', attrs: { cx: 12, cy: 5, rx: 9, ry: 3 } },
    { tag: 'path', attrs: { d: 'M3 5v14a9 3 0 0 0 18 0V5' } },
    { tag: 'path', attrs: { d: 'M3 12a9 3 0 0 0 18 0' } },
  ],
  leaf: [
    { tag: 'path', attrs: { d: 'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z' } },
    { tag: 'path', attrs: { d: 'M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12' } },
  ],
  zap: [
    { tag: 'path', attrs: { d: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z' } },
  ],
  box: [
    { tag: 'path', attrs: { d: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z' } },
    { tag: 'path', attrs: { d: 'm3.3 7 8.7 5 8.7-5' } },
    { tag: 'path', attrs: { d: 'M12 22V12' } },
  ],
  key: [
    { tag: 'path', attrs: { d: 'm15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4' } },
    { tag: 'path', attrs: { d: 'm21 2-9.6 9.6' } },
    { tag: 'circle', attrs: { cx: 7.5, cy: 15.5, r: 5.5 } },
  ],
  clock: [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 10 } },
    { tag: 'polyline', attrs: { points: '12 6 12 12 16 14' } },
  ],
  'file-text': [
    { tag: 'path', attrs: { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' } },
    { tag: 'path', attrs: { d: 'M14 2v4a2 2 0 0 0 2 2h4' } },
    { tag: 'path', attrs: { d: 'M10 9H8' } },
    { tag: 'path', attrs: { d: 'M16 13H8' } },
    { tag: 'path', attrs: { d: 'M16 17H8' } },
  ],
  flame: [
    { tag: 'path', attrs: { d: 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z' } },
  ],
  chart: [
    { tag: 'path', attrs: { d: 'M3 3v16a2 2 0 0 0 2 2h16' } },
    { tag: 'path', attrs: { d: 'M18 17V9' } },
    { tag: 'path', attrs: { d: 'M13 17V5' } },
    { tag: 'path', attrs: { d: 'M8 17v-3' } },
  ],
  hexagon: [
    { tag: 'path', attrs: { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z' } },
  ],
  trend: [
    { tag: 'polyline', attrs: { points: '22 7 13.5 15.5 8.5 10.5 2 17' } },
    { tag: 'polyline', attrs: { points: '16 7 22 7 22 13' } },
  ],
  code: [
    { tag: 'polyline', attrs: { points: '16 18 22 12 16 6' } },
    { tag: 'polyline', attrs: { points: '8 6 2 12 8 18' } },
  ],
  coffee: [
    { tag: 'path', attrs: { d: 'M10 2v2' } },
    { tag: 'path', attrs: { d: 'M14 2v2' } },
    { tag: 'path', attrs: { d: 'M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1' } },
    { tag: 'path', attrs: { d: 'M6 2v2' } },
  ],
  terminal: [
    { tag: 'polyline', attrs: { points: '4 17 10 11 4 5' } },
    { tag: 'line', attrs: { x1: 12, y1: 19, x2: 20, y2: 19 } },
  ],
  gem: [
    { tag: 'path', attrs: { d: 'M6 3h12l4 6-10 13L2 9Z' } },
    { tag: 'path', attrs: { d: 'M11 3 8 9l4 13 4-13-3-6' } },
    { tag: 'path', attrs: { d: 'M2 9h20' } },
  ],
  gear: [
    { tag: 'path', attrs: { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' } },
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 3 } },
  ],
  network: [
    { tag: 'rect', attrs: { x: 16, y: 16, width: 6, height: 6, rx: 1 } },
    { tag: 'rect', attrs: { x: 2, y: 16, width: 6, height: 6, rx: 1 } },
    { tag: 'rect', attrs: { x: 9, y: 2, width: 6, height: 6, rx: 1 } },
    { tag: 'path', attrs: { d: 'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3' } },
    { tag: 'path', attrs: { d: 'M12 12V8' } },
  ],
  compass: [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 10 } },
    { tag: 'polygon', attrs: { points: '16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88' } },
  ],
  message: [
    { tag: 'path', attrs: { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' } },
  ],
  activity: [
    { tag: 'polyline', attrs: { points: '22 12 18 12 15 21 9 3 6 12 2 12' } },
  ],
  cpu: [
    { tag: 'rect', attrs: { x: 4, y: 4, width: 16, height: 16, rx: 2 } },
    { tag: 'rect', attrs: { x: 9, y: 9, width: 6, height: 6 } },
    { tag: 'path', attrs: { d: 'M15 2v2' } },
    { tag: 'path', attrs: { d: 'M15 20v2' } },
    { tag: 'path', attrs: { d: 'M2 15h2' } },
    { tag: 'path', attrs: { d: 'M2 9h2' } },
    { tag: 'path', attrs: { d: 'M20 15h2' } },
    { tag: 'path', attrs: { d: 'M20 9h2' } },
    { tag: 'path', attrs: { d: 'M9 2v2' } },
    { tag: 'path', attrs: { d: 'M9 20v2' } },
  ],
  memory: [
    { tag: 'path', attrs: { d: 'M6 19v-3' } },
    { tag: 'path', attrs: { d: 'M10 19v-3' } },
    { tag: 'path', attrs: { d: 'M14 19v-3' } },
    { tag: 'path', attrs: { d: 'M18 19v-3' } },
    { tag: 'path', attrs: { d: 'M8 11V9' } },
    { tag: 'path', attrs: { d: 'M16 11V9' } },
    { tag: 'path', attrs: { d: 'M12 11V9' } },
    { tag: 'path', attrs: { d: 'M2 15h20' } },
    { tag: 'path', attrs: { d: 'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z' } },
  ],
  folder: [
    { tag: 'path', attrs: { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' } },
  ],
  search: [
    { tag: 'circle', attrs: { cx: 11, cy: 11, r: 8 } },
    { tag: 'path', attrs: { d: 'm21 21-4.3-4.3' } },
  ],
  refresh: [
    { tag: 'path', attrs: { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' } },
    { tag: 'path', attrs: { d: 'M21 3v5h-5' } },
    { tag: 'path', attrs: { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' } },
    { tag: 'path', attrs: { d: 'M8 16H3v5' } },
  ],
  rocket: [
    { tag: 'path', attrs: { d: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z' } },
    { tag: 'path', attrs: { d: 'm12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z' } },
    { tag: 'path', attrs: { d: 'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0' } },
    { tag: 'path', attrs: { d: 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5' } },
  ],
  'check-circle': [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 10 } },
    { tag: 'path', attrs: { d: 'm9 12 2 2 4-4' } },
  ],
  'x-circle': [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 10 } },
    { tag: 'path', attrs: { d: 'm15 9-6 6' } },
    { tag: 'path', attrs: { d: 'm9 9 6 6' } },
  ],
  alert: [
    { tag: 'path', attrs: { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z' } },
    { tag: 'path', attrs: { d: 'M12 9v4' } },
    { tag: 'path', attrs: { d: 'M12 17h.01' } },
  ],
  pause: [
    { tag: 'rect', attrs: { x: 14, y: 4, width: 4, height: 16, rx: 1 } },
    { tag: 'rect', attrs: { x: 6, y: 4, width: 4, height: 16, rx: 1 } },
  ],
}

export interface IconProps {
  name: IconName
  /** pixel size; icons no longer ride on font size (the emoji problem) */
  size?: number
  color?: string
  className?: string
  style?: Record<string, string | number>
}

/** Stroke icon; inherits currentColor unless `color` is given. */
export function Icon({ name, size = 20, color, className, style }: IconProps): ReactElement {
  const shapes = PATHS[name] ?? PATHS.gear!
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color ?? 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className,
    'aria-hidden': true,
    style: { flexShrink: 0, display: 'inline-block', verticalAlign: 'middle', ...style },
  }, ...shapes.map((s, i) => createElement(s.tag, { key: i, ...s.attrs })))
}
