/**
 * Log source discovery (S6): the program verifies — AI only proposes.
 * Supervisor first: real effective configs, includes, stdout/stderr merge,
 * and AUTO-generated files. NONE / device files / missing files become
 * explicit statuses, never fake readable sources.
 */
import type { LogSource } from '../../contracts/entities.ts'
import { SCHEMA_VERSION } from '../../contracts/entities.ts'

export interface SupervisorCandidate {
  service: string
  path: string
  /** config evidence: file and key this came from */
  origin: string
  status: 'file' | 'none' | 'merged'
}

/** Parse one supervisor ini into program sections. */
export function parseSupervisorConfig(text: string, origin: string): { programs: Array<{ name: string; stdout: string | null; stderr: string | null; redirect: boolean }>; includes: string[] } {
  const programs: Array<{ name: string; stdout: string | null; stderr: string | null; redirect: boolean }> = []
  const includes: string[] = []
  let section = ''
  let current: { name: string; stdout: string | null; stderr: string | null; redirect: boolean } | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/;.*$/, '').trim()
    if (!line) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) {
      section = sec[1]!
      if (section === 'include') continue
      const prog = /^program:(.+)$/.exec(section)
      if (prog) {
        current = { name: prog[1]!, stdout: null, stderr: null, redirect: false }
        programs.push(current)
      } else {
        current = null
      }
      continue
    }
    const kv = /^([A-Za-z_]+)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]!
    const value = kv[2]!.trim()
    if (section === 'include' && (key === 'files' || key === 'files-special')) {
      includes.push(value)
      continue
    }
    if (!current) continue
    if (key === 'stdout_logfile') current.stdout = normalizeLogValue(value)
    if (key === 'stderr_logfile') current.stderr = normalizeLogValue(value)
    if (key === 'redirect_stderr') current.redirect = value.toLowerCase() === 'true' || value === '1'
  }
  void origin
  return { programs, includes }
}

function normalizeLogValue(v: string): string | null {
  // supervisor: AUTO → sys.stdout based; NONE → explicit no file
  if (v.toUpperCase() === 'NONE') return 'NONE'
  if (/^AUTO$/i.test(v) || /^sys\.std(out|err)$/i.test(v)) return 'AUTO'
  return v.replace('%(here)s', '')
}

/**
 * Resolve candidates from one parsed config file. stdout/stderr merged into
 * the stdout path when redirect_stderr=true; AUTO resolves to "no file"
 * (service-managed stream), NONE likewise.
 */
export function resolveSupervisorCandidates(parsed: ReturnType<typeof parseSupervisorConfig>, origin: string): SupervisorCandidate[] {
  const out: SupervisorCandidate[] = []
  for (const p of parsed.programs) {
    const stdoutPath = p.stdout && p.stdout !== 'NONE' && p.stdout !== 'AUTO' ? p.stdout : null
    if (p.redirect) {
      if (stdoutPath) out.push({ service: p.name, path: stdoutPath, origin: `${origin}:[program:${p.name}] stdout_logfile (redirect_stderr=true)`, status: 'merged' })
      else out.push({ service: p.name, path: p.stdout ?? 'AUTO', origin: `${origin}:[program:${p.name}] stdout_logfile`, status: 'none' })
      continue
    }
    if (stdoutPath) out.push({ service: p.name, path: stdoutPath, origin: `${origin}:[program:${p.name}] stdout_logfile`, status: 'file' })
    else out.push({ service: p.name, path: p.stdout ?? 'AUTO', origin: `${origin}:[program:${p.name}] stdout_logfile`, status: 'none' })
    const stderrPath = p.stderr && p.stderr !== 'NONE' && p.stderr !== 'AUTO' ? p.stderr : null
    if (stderrPath) out.push({ service: p.name, path: stderrPath, origin: `${origin}:[program:${p.name}] stderr_logfile`, status: 'file' })
    else if (p.stderr) out.push({ service: p.name, path: p.stderr, origin: `${origin}:[program:${p.name}] stderr_logfile`, status: 'none' })
  }
  return out
}

/**
 * Validate AI/user-proposed candidates against the transport. A candidate is
 * accepted only with a stat-able regular file; devices/missing become explicit
 * statuses. Returns records ready to persist (new or unchanged user ones kept).
 */
export interface CandidateValidation {
  service: string
  path: string
  origin: string
  status: LogSource['status']
  statusReason: string
  fileIdentity: string | null
}

export async function validateCandidate(
  candidate: { service: string; path: string; origin: string },
  io: { stat: (path: string) => Promise<{ size: number; identity: string } | null> },
): Promise<CandidateValidation> {
  if (candidate.path === 'NONE' || candidate.path === 'AUTO') {
    return { ...candidate, status: 'none', statusReason: 'supervisor streams to service manager (no file)', fileIdentity: null }
  }
  if (!candidate.path.startsWith('/')) {
    return { ...candidate, status: 'unsupported', statusReason: 'relative or non-file path', fileIdentity: null }
  }
  if (isDevicePath(candidate.path)) {
    return { ...candidate, status: 'unsupported', statusReason: 'device/char file cannot be read safely', fileIdentity: null }
  }
  const stat = await io.stat(candidate.path)
  if (!stat) {
    return { ...candidate, status: 'missing', statusReason: 'file does not exist (yet)', fileIdentity: null }
  }
  return { ...candidate, status: 'active', statusReason: '', fileIdentity: stat.identity }
}

function isDevicePath(path: string): boolean {
  return path === '/dev/null' || path.startsWith('/dev/') || path.startsWith('/proc/') || path.startsWith('/sys/')
}

/**
 * Extract log-file candidates from process command lines (IMPROVE 二轮 R3):
 * redirects (`>> /var/log/x.log`, `2>>`, `>`, `&>>`) and log flags
 * (`--error-logfile /p`, `--log-file=/p`, `--logfile /p`).
 * Conservative: absolute paths only, `.log` suffix (or a `/log` directory),
 * device files excluded, deduplicated.
 */
export function candidatesFromProcessCommands(commands: string[]): string[] {
  const found = new Set<string>()
  for (const cmd of commands) {
    for (const m of cmd.matchAll(/(?:\d)?&?>>?\s*(\/[^\s;&|"'<>]+)/g)) {
      const p = m[1]!
      if (/\.log\d*/i.test(p) || /\/logs?\//i.test(p)) found.add(p)
    }
    for (const m of cmd.matchAll(/--[\w-]*log[\w-]*[=\s]+(\/[^\s;&|"']+)/gi)) {
      const p = m[1]!
      if (/\.log\d*/i.test(p) || /\/logs?\//i.test(p)) found.add(p)
    }
  }
  return [...found].filter((p) => !isDevicePath(p))
}

/** Build a fresh LogSource record for a validated candidate. */
export function toLogSource(v: CandidateValidation, input: { projectId: string; serverId: string; now: number; fingerprint: string; userDefined: boolean }): LogSource {
  const sourceId = `log_${input.serverId}_${v.service}_${v.path.replaceAll('/', '_')}`.slice(0, 120)
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceId,
    projectId: input.projectId,
    serverId: input.serverId,
    service: v.service,
    configOrigin: v.origin,
    path: v.path,
    fileIdentity: v.fileIdentity,
    status: v.status,
    statusReason: v.statusReason,
    fingerprint: input.fingerprint,
    discoveredAt: input.now,
    readCursor: 0,
    generation: 0,
    truncatedAtDiscovery: false,
    userDefined: input.userDefined,
    sizeBytes: null,
    lastModifiedAt: null,
    ignored: false,
  }
}

/**
 * Bounded search over a project directory for config entry points
 * (supervisor conf.d, app config dirs). The AI may propose; this walker only
 * looks at configured/bounded locations — never a whole-disk scan.
 */
export function boundedSearchPaths(projectCodeDir: string): string[] {
  return [
    `${projectCodeDir}/supervisor`,
    `${projectCodeDir}/supervisor/conf.d`,
    `${projectCodeDir}/deploy`,
    `${projectCodeDir}/deploy/supervisor`,
    `${projectCodeDir}/conf`,
    `${projectCodeDir}/conf/supervisor`,
    `${projectCodeDir}/config`,
    `${projectCodeDir}/config/supervisor`,
    '/etc/supervisor/conf.d',
    '/etc/supervisord.conf',
    '/etc/supervisor/supervisord.conf',
  ]
}

/**
 * Common in-project log directories to enumerate for `*.log` files (IMPROVE
 * follow-up): a `logs/` (or `log/`) directory directly under the code dir.
 */
export function logDirSearchPaths(projectCodeDir: string): string[] {
  return [`${projectCodeDir}/logs`, `${projectCodeDir}/log`]
}

/** Does a discovered filename look like a log file (`.log`, `.log.1`, `out.log`) */
export function looksLikeLogFile(name: string): boolean {
  return /\.log(\.\d+)?$/.test(name) || /(^|[._-])(stdout|stderr|out|err)\.log$/i.test(name)
}
