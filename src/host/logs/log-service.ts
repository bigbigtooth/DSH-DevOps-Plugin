/**
 * Log reading + AI analysis (S6). Invariants:
 * - readCursor and analysis progress are tracked separately: bytes are read
 *   into bounded fragments first; only an ACCEPTED report advances analysis.
 *   AI failure leaves the fragment pending — the same bytes can be retried,
 *   never permanently skipped.
 * - rotation (identity change) and truncation (size < cursor) create a new
 *   generation with an explicit gap, never silent success.
 * - alerts dedupe by service+path+feature and keep occurrence counts.
 */
import { createHash } from 'node:crypto'
import { err } from '../../contracts/errors.ts'
import type { Alert, LogFragment, LogSource, MonitoringPolicy } from '../../contracts/entities.ts'
import { SCHEMA_VERSION } from '../../contracts/entities.ts'
import type { SshTransport, AgentBridge, ClockPort } from '../adapters/ports.ts'
import type { OpsRepository } from '../repository/ops-repository.ts'
import {
  boundedSearchPaths,
  candidatesFromProcessCommands,
  logDirSearchPaths,
  looksLikeLogFile,
  parseSupervisorConfig,
  resolveSupervisorCandidates,
  toLogSource,
  validateCandidate,
} from './discovery.ts'
import { z } from 'zod'

export const FIRST_READ_MAX_LINES = 1000
export const FIRST_READ_MAX_BYTES = 1024 * 1024
export const PER_ROUND_MAX_BYTES = 1024 * 1024

const logReportSchema = z.object({
  anomalies: z
    .array(
      z.object({
        fragmentId: z.string(),
        severity: z.enum(['info', 'warning', 'critical']),
        summary: z.string().min(1),
        /** must be a verbatim excerpt of the fragment content */
        excerpt: z.string().min(1),
        suggestion: z.string().default(''),
      }),
    )
    .default([]),
})

export type LogReport = z.infer<typeof logReportSchema>

/** AI log-discovery plan: the app's own output log files (paths under codeDir). */
const zLogPlan = z.object({
  logs: z
    .array(z.object({ path: z.string().min(1), service: z.string().optional() }))
    .default([]),
})

export interface LogServiceDeps {
  transport: SshTransport
  repo: OpsRepository
  clock: ClockPort
  agentBridge: AgentBridge | null
  modelRef: string | null
  /** optional host logger; AI-discovery outcome is surfaced here for observability */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void }
}

export class LogService {
  constructor(private readonly deps: LogServiceDeps) {}

  /**
   * Read one source incrementally. Reads FIRST_READ limits on the first pass
   * (last N lines of the existing file), then byte-cursor increments.
   */
  async readSource(source: LogSource): Promise<{ fragments: LogFragment[]; source: LogSource; gap: number }> {
    if (source.status !== 'active') return { fragments: [], source, gap: 0 }
    const stat = await this.deps.transport.stat(source.serverId, source.path)
    if (!stat) {
      const updated: LogSource = { ...source, status: 'missing', statusReason: 'file removed', fileIdentity: null, sizeBytes: null }
      await this.deps.repo.updateLogSource(source.sourceId, () => updated)
      return { fragments: [], source: updated, gap: 0 }
    }
    let working = source
    let gap = 0
    if (source.fileIdentity !== null && source.fileIdentity !== stat.identity) {
      // rotation or replace: previous generation ends where the cursor is
      const prevSize = await this.readSizeAtIdentity(source)
      gap = Math.max(0, prevSize - source.readCursor)
      working = {
        ...source,
        generation: source.generation + 1,
        readCursor: 0,
        fileIdentity: stat.identity,
        statusReason: 'rotated/replaced',
      }
      await this.deps.repo.updateLogSource(source.sourceId, () => working)
    } else if (source.fileIdentity !== null && stat.size < source.readCursor) {
      // truncation: cursor beyond EOF
      gap = source.readCursor - stat.size
      working = {
        ...source,
        generation: source.generation + 1,
        readCursor: 0,
        truncatedAtDiscovery: true,
        statusReason: 'truncated',
      }
      await this.deps.repo.updateLogSource(source.sourceId, () => working)
    } else if (source.fileIdentity === null) {
      working = { ...source, fileIdentity: stat.identity }
    }
    if (working.sizeBytes !== stat.size || working.lastModifiedAt !== stat.mtimeMs) {
      working = { ...working, sizeBytes: stat.size, lastModifiedAt: stat.mtimeMs }
    }

    const isFirstRead = working.readCursor === 0 && working.generation === 0
    const offset = working.readCursor
    const maxBytes = isFirstRead ? FIRST_READ_MAX_BYTES : PER_ROUND_MAX_BYTES
    const read = await this.deps.transport.readFileRange(working.serverId, working.path, offset, maxBytes)
    let content = read.data
    if (isFirstRead) {
      // last N lines window on the first pass
      const lines = content.split('\n')
      const kept = lines.slice(-FIRST_READ_MAX_LINES)
      const dropped = lines.length - kept.length
      if (dropped > 0) {
        content = kept.join('\n')
        gap += offset === 0 ? 0 : 0 // offsets below refer to bytes; line drop recorded as truncation flag
        working = { ...working, truncatedAtDiscovery: true }
      }
    }
    if (content.length === 0) {
      return { fragments: [], source: working, gap }
    }
    const fragment: LogFragment = {
      schemaVersion: SCHEMA_VERSION,
      fragmentId: `frag_${this.deps.clock.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      sourceId: working.sourceId,
      runId: null,
      startOffset: offset,
      endOffset: offset + Buffer.byteLength(read.data, 'utf8'),
      content,
      collectedAt: this.deps.clock.now(),
      analysisState: 'pending',
      analysisError: null,
      readTruncated: content.length < read.data.length || (isFirstRead && content !== read.data),
      gapBeforeBytes: gap,
    }
    await this.deps.repo.putLogFragment(fragment)
    const advanced: LogSource = { ...working, readCursor: fragment.endOffset }
    await this.deps.repo.updateLogSource(working.sourceId, () => advanced)
    return { fragments: [fragment], source: advanced, gap }
  }

  private async readSizeAtIdentity(source: LogSource): Promise<number> {
    // best effort: current size of the OLD path content is unknown after
    // rotation; use the last fragment end offset as the known bound
    const fragments = this.deps.repo.listLogFragments(source.sourceId)
    const last = fragments.at(-1)
    return last ? last.endOffset : source.readCursor
  }

  /** Analyze all pending fragments; returns accepted count. */
  async analyzePending(source: LogSource, policy: MonitoringPolicy | null): Promise<{ accepted: number; failed: number }> {
    const pending = this.deps.repo.listLogFragments(source.sourceId).filter((f) => f.analysisState === 'pending')
    if (!pending.length) return { accepted: 0, failed: 0 }
    if (!this.deps.agentBridge || !this.deps.modelRef) {
      return { accepted: 0, failed: pending.length }
    }
    let accepted = 0
    let failed = 0
    for (const fragment of pending) {
      try {
        const result = await this.deps.agentBridge.run(
          {
            sessionId: `logcheck:${fragment.fragmentId}`,
            model: this.deps.modelRef,
            maxRequests: 20,
            toolNames: [],
            timeoutMs: 240_000,
            task: renderLogTask(source, fragment, policy),
          },
          (payload) => {
            const parsed = logReportSchema.safeParse(extractJson(payload))
            if (!parsed.success) return { ok: false as const, error: 'invalid report schema' }
            for (const a of parsed.data.anomalies) {
              if (a.fragmentId !== fragment.fragmentId) return { ok: false as const, error: 'foreign fragmentId' }
              if (!fragment.content.includes(a.excerpt)) return { ok: false as const, error: `excerpt not found in fragment: ${a.excerpt.slice(0, 40)}` }
            }
            return { ok: true as const, value: parsed.data }
          },
        )
        if (!result.ok) {
          failed++
          await this.deps.repo.putLogFragment({ ...fragment, analysisError: result.error ?? 'invalid' })
          continue
        }
        const report = result.payload as LogReport
        await this.deps.repo.putLogFragment({ ...fragment, analysisState: 'complete', analysisError: null })
        accepted++
        for (const a of report.anomalies) {
          await this.recordAlert(source, a.severity, a.summary, a.excerpt, fragment.fragmentId)
        }
      } catch (e) {
        failed++
        await this.deps.repo.putLogFragment({ ...fragment, analysisError: e instanceof Error ? e.message : String(e) })
      }
    }
    return { accepted, failed }
  }

  private async recordAlert(source: LogSource, severity: Alert['severity'], summary: string, excerpt: string, fragmentId: string): Promise<void> {
    const feature = createHash('sha256').update(`${summary}|${excerpt.slice(0, 80)}`).digest('hex').slice(0, 12)
    const dedupeKey = `${source.serverId}:${source.service}:${source.path}:${feature}`
    const existing = this.deps.repo.findAlertByDedupe(dedupeKey)
    const now = this.deps.clock.now()
    if (existing) {
      await this.deps.repo.putAlert({ ...existing, lastSeenAt: now, count: existing.count + 1 })
      return
    }
    await this.deps.repo.putAlert({
      schemaVersion: SCHEMA_VERSION,
      alertId: `alert_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      serverId: source.serverId,
      projectId: source.projectId,
      service: source.service,
      source: 'log',
      severity,
      dedupeKey,
      summary,
      evidenceRef: fragmentId,
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
      deploymentWindow: false,
    })
  }

  /** Cycle: read then analyze; used by manual checks and the scheduler. */
  async checkSource(source: LogSource, policy: MonitoringPolicy | null): Promise<{ runId: string; accepted: number; failed: number }> {    if (source.ignored) throw err('validation-failed', 'logs', 'source is ignored by policy')
    const { fragments } = await this.readSource(source)
    const now = this.deps.clock.now()
    const runId = `logrun_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const run = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      serverId: source.serverId,
      kind: 'logs' as const,
      snapshotId: null,
      startedAt: now,
      finishedAt: now,
      analysisState: 'running' as const,
      coverageAnalyzed: 0,
      coverageTotal: fragments.length,
      findings: [],
      evidenceRefs: fragments.map((f) => f.fragmentId),
      error: null,
      trigger: 'manual' as const,
    }
    await this.deps.repo.putInspectionRun(run)
    if (!this.deps.modelRef) {
      await this.deps.repo.putInspectionRun({ ...run, analysisState: 'unavailable', error: 'no model configured' })
      return { runId, accepted: 0, failed: fragments.length }
    }
    const { accepted, failed } = await this.analyzePending(source, policy)
    await this.deps.repo.putInspectionRun({
      ...run,
      finishedAt: this.deps.clock.now(),
      analysisState: failed === 0 ? (accepted + failed === 0 ? 'complete' : 'complete') : accepted > 0 ? 'partial' : 'failed',
      coverageAnalyzed: accepted,
      coverageTotal: fragments.length,
      error: failed > 0 ? `${failed} fragment(s) failed analysis` : null,
    })
    return { runId, accepted, failed }
  }

  // ---------- discovery (IMPROVE follow-up) ----------

  private async statFile(serverId: string, path: string): Promise<{ size: number; identity: string } | null> {
    const st = await this.deps.transport.stat(serverId, path).catch(() => null)
    return st ? { size: st.size, identity: st.identity } : null
  }

  private async readRemoteFile(serverId: string, path: string, maxBytes = 200_000): Promise<string | null> {
    const st = await this.deps.transport.stat(serverId, path).catch(() => null)
    if (!st) return null
    const read = await this.deps.transport.readFileRange(serverId, path, 0, Math.min(maxBytes, st.size)).catch(() => null)
    return read?.data ?? null
  }

  /**
   * Discover log sources for one project target across several default
   * strategies — supervisor configs, the project's own `logs/` directory, and
   * startup `*.sh` scripts. Program verifies every candidate with a real
   * stat; candidates that are not readable files become explicit statuses and
   * are still recorded so the UI shows WHY. User-pinned (manual) sources are
   * never overwritten. Returns the count registered/updated plus the list.
   */
  async discoverProject(input: { projectId: string; serverId: string; codeDir: string }): Promise<{ registered: number; sources: LogSource[] }> {
    const { projectId, serverId, codeDir } = input
    const candidates: Array<{ service: string; path: string; origin: string }> = []
    const io = { stat: (path: string) => this.statFile(serverId, path) }

    // 1) supervisor: existing config entry points (files or conf.d dirs) → parse
    for (const entry of boundedSearchPaths(codeDir)) {
      const dirEntries = await this.deps.transport.listDir(serverId, entry, 100).catch(() => [])
      const confFiles = dirEntries.filter((e) => !e.isDir && /\.(conf|ini|cfg)$/i.test(e.name)).map((e) => ({ path: `${entry}/${e.name}`, origin: entry }))
      const asFile = dirEntries.length === 0 ? [{ path: entry, origin: entry }] : []
      for (const f of [...confFiles, ...asFile]) {
        const text = await this.readRemoteFile(serverId, f.path)
        if (!text) continue
        const parsed = parseSupervisorConfig(text, f.path)
        for (const c of resolveSupervisorCandidates(parsed, f.path)) candidates.push({ service: c.service, path: c.path, origin: c.origin })
      }
    }

    // 2) project logs directory (logs/ or log/) → *.log files
    for (const dir of logDirSearchPaths(codeDir)) {
      const entries = await this.deps.transport.listDir(serverId, dir, 200).catch(() => [])
      for (const e of entries) {
        if (e.isDir || !looksLikeLogFile(e.name)) continue
        candidates.push({ service: `logs:${e.name}`, path: `${dir}/${e.name}`, origin: `代码目录日志 ${dir}` })
      }
    }

    // 3) startup shell scripts: redirects + log flags inside the script text
    const codeEntries = await this.deps.transport.listDir(serverId, codeDir, 300).catch(() => [])
    for (const e of codeEntries.filter((x) => !x.isDir && /\.sh$/i.test(x.name)).slice(0, 30)) {
      const text = await this.readRemoteFile(serverId, `${codeDir}/${e.name}`, 100_000)
      if (!text) continue
      for (const p of candidatesFromProcessCommands([text])) {
        candidates.push({ service: `script:${e.name}`, path: p, origin: `启动脚本 ${codeDir}/${e.name}` })
      }
    }

    // 4) AI-assisted (IMPROVE follow-up): read the project's own code/config
    //    (manifests, .env, logging configs, ecosystem/app configs) and let the
    //    model surface log files the app writes itself — beyond supervisor and
    //    nginx. Every proposed path is still stat-validated below, so a wrong
    //    guess degrades to an explicit 'missing' status, never a fake source.
    if (this.deps.agentBridge && this.deps.modelRef) {
      try {
        const proposed = await this.aiProposeLogPaths(serverId, codeDir, codeEntries)
        for (const c of proposed) candidates.push(c)
        this.deps.logger?.info?.(`[dsh-devops] AI log discovery (${codeDir}): proposed ${proposed.length} candidate(s) via model ${this.deps.modelRef}`)
      } catch (e) {
        // AI discovery is an extension; the deterministic candidates still stand
        this.deps.logger?.warn?.(`[dsh-devops] AI log discovery skipped (${codeDir}): ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      this.deps.logger?.info?.(`[dsh-devops] AI log discovery disabled for ${codeDir}: agentBridge=${this.deps.agentBridge ? 'yes' : 'no'} modelRef=${this.deps.modelRef ?? 'null'}`)
    }

    const seen = new Set<string>()
    const out: LogSource[] = []
    let registered = 0
    // path-keyed so a stable file keeps ONE source regardless of which strategy
    // named it (supervisor program vs manual pin); a manual pin is never
    // re-added or overwritten by a discovery candidate for the same path.
    const existingByPath = new Map<string, LogSource>()
    for (const s of this.deps.repo.listLogSources({ projectId, serverId })) existingByPath.set(s.path, s)
    for (const cand of candidates) {
      if (cand.path === 'NONE' || cand.path === 'AUTO') continue
      if (seen.has(cand.path)) continue
      seen.add(cand.path)
      const validation = await validateCandidate(cand, io)
      const prior = existingByPath.get(cand.path)
      if (prior?.userDefined) {
        out.push(prior)
        continue
      }
      let merged: LogSource
      if (prior) {
        merged = { ...prior, status: validation.status, statusReason: validation.statusReason, configOrigin: validation.origin, fileIdentity: validation.fileIdentity ?? prior.fileIdentity }
      } else {
        merged = toLogSource(validation, { projectId, serverId, now: this.deps.clock.now(), fingerprint: '', userDefined: false })
      }
      await this.deps.repo.putLogSource(merged)
      registered++
      out.push(merged)
    }
    return { registered, sources: out }
  }

  /**
   * Ask the model which log files the application writes itself, based on a
   * bounded read of the project's own manifests/config/startup code. Returns
   * UNVALIDATED candidates (path + a short service tag); the caller stat-checks
   * each one, so a hallucinated path simply becomes a 'missing' source. Paths
   * are normalised to absolute under `codeDir` before validation.
   */
  private async aiProposeLogPaths(
    serverId: string,
    codeDir: string,
    codeEntries: Array<{ name: string; isDir: boolean }>,
  ): Promise<Array<{ service: string; path: string; origin: string }>> {
    const bridge = this.deps.agentBridge
    const modelRef = this.deps.modelRef
    if (!bridge || !modelRef) return []
    const rootFiles = codeEntries.filter((e) => !e.isDir).map((e) => e.name)
    // manifests, env files, and logging/app config are the evidence worth reading
    const interesting = rootFiles.filter((n) =>
      /(\.env|package\.json|composer\.json|requirements\.txt|pyproject\.toml|pom\.xml|build\.gradle|config\.(json|ya?ml|js|ts)$|logging|logger|log4j|logback|ecosystem|wnmp|application[-.\w]*\.(ya?ml|properties|conf|ini)$|settings\.\w+$|wp-config|nginx\.conf|\.ini$)/i.test(n),
    )
    const scripts = rootFiles.filter((n) => /\.(sh|bash)$/i.test(n))
    // Django/gunicorn/uwicorn keep their LOGGING + access/error-file config one
    // level down (a project package dir), so a top-level-only read misses the
    // app's own log targets entirely. Probe immediate subdirectories for
    // settings/config/logging files and read those too.
    const subdirs = codeEntries.filter((e) => e.isDir).map((e) => e.name).slice(0, 8)
    const nestedFiles: string[] = []
    for (const sub of subdirs) {
      const entries = await this.deps.transport
        .listDir(serverId, `${codeDir}/${sub}`, 150)
        .catch(() => [])
      for (const e of entries) {
        if (e.isDir) continue
        if (/(settings|config|logging|logger|gunicorn|uwicorn|pasta|asgi|wsgi|application|app)[-.\w]*\.(py|ya?ml|json|conf|cfg|ini|toml|properties)$|\.(conf\.py|config\.py)$|settings\.py|log4j|logback/i.test(e.name)) {
          nestedFiles.push(`${sub}/${e.name}`)
        }
      }
    }
    // root-relative paths, root files first (bounded remote reads)
    const filesToRead = [...new Set([...interesting, ...scripts, ...nestedFiles])].slice(0, 28)
    const corpus: string[] = []
    let budget = 54_000
    for (const rel of filesToRead) {
      if (budget <= 0) break
      const text = await this.readRemoteFile(serverId, `${codeDir}/${rel}`, Math.min(40_000, budget))
      if (!text) continue
      const clipped = discoveryExcerpt(text)
      budget -= clipped.length
      corpus.push(`### ${rel}\n${clipped}`)
    }
    if (corpus.length === 0) {
      this.deps.logger?.info?.(`[dsh-devops] AI discovery ${codeDir}: no readable config/manifest content, skipping AI step`)
      return []
    }
    const listing = codeEntries.slice(0, 200).map((e) => (e.isDir ? `${e.name}/` : e.name)).join('\n')
    // DSH persists agent sessions durably, so a re-used id fails with
    // "session ... already exists". Each discovery pass must own a fresh,
    // unique session identity (mirrors inspection/deploy run-scoped ids).
    const nonce = `${this.deps.clock.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const result = await bridge.run(
      {
        sessionId: `logdiscover:${serverId}:${codeDir}:${nonce}`,
        model: modelRef,
        maxRequests: 20,
        toolNames: [],
        timeoutMs: 240_000,
        task: renderDiscoverTask(codeDir, listing, corpus),
      },
      (payload) => {
        const parsed = zLogPlan.safeParse(extractJson(payload))
        if (!parsed.success) return { ok: false as const, error: 'invalid log plan schema' }
        return { ok: true as const, value: parsed.data }
      },
    )
    if (!result.ok) {
      this.deps.logger?.warn?.(`[dsh-devops] AI discovery ${codeDir}: model returned no valid plan (${result.error ?? 'unknown'})`)
      return []
    }
    const data = result.payload as { logs: Array<{ path: string; service?: string }> }
    const root = codeDir.replace(/\/+$/, '')
    const out: Array<{ service: string; path: string; origin: string }> = []
    for (const item of data.logs) {
      let p = (item.path ?? '').trim()
      if (!p || p.includes('*')) continue
      if (!p.startsWith('/')) p = `${root}/${p.replace(/^\.\/+/, '')}`
      out.push({ service: item.service?.trim() || `ai:${p.split('/').at(-1) || 'log'}`, path: p, origin: 'AI 代码/配置分析' })
    }
    return out.slice(0, 25)
  }

  /** Register one user-provided absolute log path (manual pin). */
  async addManual(input: { projectId: string; serverId: string; path: string; service?: string }): Promise<LogSource> {
    const path = input.path.trim()
    if (!path) throw err('validation-failed', 'logs', '日志路径不能为空')
    const service = input.service?.trim() || `manual:${path.split('/').at(-1) || 'log'}`
    const io = { stat: (p: string) => this.statFile(input.serverId, p) }
    const validation = await validateCandidate({ service, path, origin: '手动登记' }, io)
    const source = toLogSource(validation, { projectId: input.projectId, serverId: input.serverId, now: this.deps.clock.now(), fingerprint: '', userDefined: true })
    const existing = this.deps.repo.getLogSource(source.sourceId)
    if (existing) {
      const updated: LogSource = { ...existing, status: validation.status, statusReason: validation.statusReason, fileIdentity: validation.fileIdentity ?? existing.fileIdentity, ignored: false }
      await this.deps.repo.updateLogSource(existing.sourceId, () => updated)
      return updated
    }
    await this.deps.repo.putLogSource(source)
    return source
  }
}

/**
 * Compact, logging-relevant excerpt of one config/source file for the discovery
 * prompt. Small files pass through whole; large ones contribute their head plus
 * a window centred on the first logging keyword, so a Django `LOGGING` dict (or
 * a winston/log4j handler block) far down the file is never truncated away —
 * while the total stays small enough for modest model routes to answer reliably
 * instead of dropping the stream.
 */
export function discoveryExcerpt(text: string): string {
  const MAX = 6500
  if (text.length <= MAX) return text
  const head = text.slice(0, 2500)
  // strong logging-CONFIG locators only (an early `import logging` must not
  // win over a `LOGGING = {...}` / handler block that lives much later)
  const strong = /LOGGING\s*=|FileHandler|RotatingFileHandler|TimedRotating|access_?log|error_?log|log_?(?:file|path|dir|destination|level)|\bfilename\s*[:=]|\/logs?\/|\.log\b|log4j|logback|winston|pino|monolog/i
  const m = strong.exec(text)
  if (m && m.index > 2200) {
    const start = Math.max(0, m.index - 800)
    const window = text.slice(start, start + (MAX - head.length - 4))
    return `${head}\n…\n${window}`
  }
  return head
}

function renderDiscoverTask(codeDir: string, listing: string, corpus: string[]): string {
  const lines: string[] = []
  lines.push('你是运维日志排查助手。下面是一个项目代码目录的文件清单与部分配置/代码内容。')
  lines.push(`项目代码根目录（绝对）：${codeDir}`)
  lines.push('')
  lines.push('目录清单：')
  lines.push(listing)
  lines.push('')
  lines.push('已读取的文件内容：')
  lines.push(corpus.join('\n\n'))
  lines.push('')
  lines.push('任务：找出【该应用自身写入的所有日志文件】——不仅是 supervisor/nginx 托管的，')
  lines.push('而是应用代码、日志库配置（如 log4j/winston/pino/monolog/Django LOGGING 等）、环境变量、启动脚本中声明的日志输出目标。')
  lines.push('要求：')
  lines.push('1. 只输出 JSON：{"logs": [{"path": "/绝对路径", "service": "简短服务/用途标签"}]}。')
  lines.push(`2. path 必须是绝对路径；若配置中是相对路径（如 ./logs/app.log、logs/x.log），请基于代码根目录 ${codeDir} 拼成绝对路径。`)
  lines.push('3. 不要臆测未在任何文件中体现的路径；不要包含通配符或目录（必须是具体文件）。宁缺勿滥。')
  lines.push('4. 没有发现则输出 {"logs": []}。')
  return lines.join('\n')
}

function renderLogTask(source: LogSource, fragment: LogFragment, policy: MonitoringPolicy | null): string {
  const lines: string[] = []
  lines.push(`你是日志巡检员。检查以下服务日志片段是否有异常、错误、告警。`)
  lines.push(`项目服务：${source.service}；文件：${source.path}（片段 ${fragment.startOffset}–${fragment.endOffset} 字节）。`)
  if (policy?.naturalLanguage) lines.push(`用户附加检查要求：${policy.naturalLanguage}`)
  if (policy?.logIgnore.length) lines.push(`用户忽略规则（仅用于降低优先级，不得隐藏读取失败）：${policy.logIgnore.map((r) => r.pathPattern).join('、')}`)
  lines.push('')
  lines.push('日志片段：')
  lines.push(fragment.content.slice(0, 8000))
  lines.push('')
  lines.push('只输出 JSON：{"anomalies": [{"fragmentId": "...", "severity": "info|warning|critical", "summary": "...", "excerpt": "原文摘录", "suggestion": "..."}]}。excerpt 必须是片段原文的逐字摘录；没有异常返回空数组。')
  return lines.join('\n')
}

function extractJson(text: unknown): unknown {
  if (typeof text !== 'string') return text
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return text
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return text
  }
}
