/**
 * Log visualization feed (IMPROVE §4.6): level classification, per-source
 * statistics and tail assembly from stored fragments. Pure functions —
 * no SSH, no storage; the API layer feeds them with repo data.
 * Nothing is invented: stats cover only fragments that were actually read.
 */
import type { LogFragment, LogSource } from '../../contracts/entities.ts'

export type LogLevel = 'error' | 'warn' | 'info'

const ERROR_PATTERN = /\b(ERROR|FATAL|PANIC|CRITICAL|EMERG|ERR)\b/
const WARN_PATTERN = /\b(WARN|WARNING|NOTICE)\b/

/** Classify one log line by conventional level keywords (case-sensitive). */
export function classifyLine(line: string): LogLevel | null {
  if (ERROR_PATTERN.test(line)) return 'error'
  if (WARN_PATTERN.test(line)) return 'warn'
  return null
}

export interface SourceStat {
  sourceId: string
  linesPerMinute: number | null
  levelCount: { error: number; warn: number; info: number }
}

export interface TailLine {
  sourceId: string
  line: string
  level: LogLevel | null
  at: number | null
}

/** Common timestamp prefixes: syslog `Sep 19 12:03:01`, nginx/ISO `2026-09-19T12:03:01`, `2026-09-19 12:03:01`. */
const TIME_PATTERNS: Array<{ re: RegExp; yearless?: boolean }> = [
  { re: /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/ },
  { re: /^[A-Z][a-z]{2}\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/, yearless: true },
]

function extractTime(line: string, now: number): number | null {
  for (const { re, yearless } of TIME_PATTERNS) {
    const m = re.exec(line)
    if (!m) continue
    if (yearless) {
      const day = Number(m[1])
      const d = new Date(now)
      const t = new Date(d.getFullYear(), d.getMonth(), day, Number(m[2]), Number(m[3]), Number(m[4])).getTime()
      return Number.isFinite(t) ? t : null
    }
    const t = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime()
    return Number.isFinite(t) ? t : null
  }
  return null
}

/**
 * Level counts over the fragments collected in the trailing `windowMs`.
 * `info` counts only lines that carry a conventional INFO/DEBUG marker OR
 * any line that is neither error nor warn — the total is always all lines.
 */
export function statSource(fragments: LogFragment[], now: number, windowMs = 3_600_000): SourceStat {
  const recent = fragments.filter((f) => f.collectedAt >= now - windowMs)
  const levelCount = { error: 0, warn: 0, info: 0 }
  let totalLines = 0
  for (const fragment of recent) {
    for (const rawLine of fragment.content.split('\n')) {
      const line = rawLine.trimEnd()
      if (!line.trim()) continue
      totalLines++
      const level = classifyLine(line)
      if (level === 'error') levelCount.error++
      else if (level === 'warn') levelCount.warn++
      else levelCount.info++
    }
  }
  const windowMinutes = Math.max(1, Math.min(windowMs, now - (recent[0]?.collectedAt ?? now)) / 60_000)
  return {
    sourceId: fragments[0]?.sourceId ?? '',
    linesPerMinute: recent.length > 0 && totalLines > 0 ? totalLines / windowMinutes : recent.length > 0 ? 0 : null,
    levelCount,
  }
}

/** Newest-last tail assembled from fragments, newest fragment first. */
export function buildTail(fragments: LogFragment[], limitLines: number): TailLine[] {
  const lines: TailLine[] = []
  const newest = [...fragments].sort((a, b) => b.collectedAt - a.collectedAt)
  for (const fragment of newest) {
    if (lines.length >= limitLines) break
    const fragmentLines = fragment.content.split('\n').filter((l) => l.trim())
    for (let i = fragmentLines.length - 1; i >= 0 && lines.length < limitLines; i--) {
      const line = fragmentLines[i]!
      lines.push({ sourceId: fragment.sourceId, line, level: classifyLine(line), at: extractTime(line, fragment.collectedAt) })
    }
  }
  return lines.reverse()
}

export interface TailSourceView {
  source: LogSource
  stat: SourceStat
}

/** Assemble the whole feed for the log page. */
export function buildLogTailView(
  sources: LogSource[],
  fragmentsBySource: Map<string, LogFragment[]>,
  now: number,
  limitLines: number,
): { stats: SourceStat[]; tail: TailLine[] } {
  const stats: SourceStat[] = []
  const allFragments: LogFragment[] = []
  for (const source of sources) {
    const fragments = fragmentsBySource.get(source.sourceId) ?? []
    allFragments.push(...fragments)
    const stat = statSource(fragments, now)
    stat.sourceId = source.sourceId
    stats.push(stat)
  }
  return { stats, tail: buildTail(allFragments, limitLines) }
}
