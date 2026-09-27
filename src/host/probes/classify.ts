/**
 * Process classifier (IMPROVE §4.3): partitions a process snapshot into
 * private services grouped by working directory, well-known common services,
 * system applications, and an `other` remainder. Pure functions — no SSH,
 * no storage.
 *
 * Output order follows the page's reading priority: 关联项目的私有服务组优先
 * （其余私有组按 cwd 排序随后），然后是常用软件、系统进程、其他。判定优先级
 * （classifyOne）不受此排序影响。
 *
 * Invariants:
 * - the classification is total: every input process appears in exactly one
 *   group; nothing is dropped
 * - cwd evidence wins over name lists: a mysqld started from /srv/x is a
 *   private service of /srv/x, not a "common" service
 * - unreadable cwd (null) is honest: the process lands in `other`, never
 *   guessed into a group
 */
import type { ProcessEntry, ProcessGroup, ProcessGroupKind } from '../../contracts/entities.ts'

/** Directory prefixes that count as system locations for private-service detection. */
const SYSTEM_PATH_PREFIXES = ['/', '/usr', '/var', '/opt', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/System', '/Library', '/private', '/Applications']

/** Well-known generic service process names (IMPROVE §4.3 category 2). */
const COMMON_SERVICE_NAMES = new Set([
  'mysqld', 'mariadbd', 'postgres', 'postmaster', 'redis-server', 'mongod',
  'nginx', 'httpd', 'apache2', 'caddy', 'traefik', 'haproxy',
  'dockerd', 'containerd', 'containerd-shim-runc-v2', 'kubelet', 'supervisord', 'pm2',
  'rabbitmq-server', 'beam.smp', 'memcached', 'clickhouse-server', 'etcd',
  'consul', 'vault', 'prometheus', 'grafana', 'alertmanager', 'node_exporter',
])

/** Kernel threads and system daemons (category 1). */
const SYSTEM_PROCESS_NAMES = new Set([
  'systemd', 'systemd-journal', 'systemd-udevd', 'systemd-resolve', 'systemd-logind',
  'systemd-timesyn', 'init', 'sh', 'sshd', 'cron', 'crond', 'rsyslogd', 'syslogd',
  'dbus-daemon', 'dbusd', 'launchd', 'loginwindow', 'Finder', 'WindowServer',
  'kernel_task', 'watchdogd', 'udevd', 'snapd', 'udevil', 'acpid', 'agetty',
  'NetworkManager', 'wpa_supplicant', 'cupsd', 'nmbd', 'smbd', 'pickup', 'cleanup',
  'qmgr', 'trivial-rewrite', 'smtpd', 'master', 'tlsmgr', 'auditd', 'selinuxd',
])

export interface ClassifyOptions {
  /** project codeDirs (from all projects' targets) → private cwd matching a prefix is linked */
  codeDirs?: Array<{ projectId: string; codeDir: string }>
  /** user grouping rules from the monitoring policy (match may be `name:`/`cmd:`/bare) */
  groupingRules?: Array<{ match: string; project: string }>
}

export function classifyProcesses(processes: ProcessEntry[], options: ClassifyOptions = {}): ProcessGroup[] {
  const system: ProcessEntry[] = []
  const common: ProcessEntry[] = []
  const other: ProcessEntry[] = []
  const byCwd = new Map<string, ProcessEntry[]>()

  for (const p of processes) {
    if (isKernelThread(p)) {
      system.push(p)
      continue
    }
    const cwd = p.cwd
    if (cwd && !isSystemPath(cwd)) {
      const list = byCwd.get(cwd) ?? []
      list.push(p)
      byCwd.set(cwd, list)
      continue
    }
    if (COMMON_SERVICE_NAMES.has(p.name) || matchesRule(p, options.groupingRules ?? [])) {
      common.push(p)
      continue
    }
    if (cwd && isSystemPath(cwd) && SYSTEM_PROCESS_NAMES.has(p.name)) {
      system.push(p)
      continue
    }
    other.push(p)
  }

  // 私有组：关联项目的组优先（按 cwd 排序），未关联的随后（同样按 cwd 排序）；
  // 之后才是常用软件、系统进程、其他 —— 与页面「项目进程最相关」的阅读顺序一致
  const privateGroups = [...byCwd.entries()]
    .map(([cwd, list]) => ({
      cwd,
      processes: sortGroup(list),
      projectId: matchProject(cwd, options.codeDirs ?? []),
    }))
    .sort((a, b) => a.cwd.localeCompare(b.cwd))
    .sort((a, b) => Number(b.projectId !== null) - Number(a.projectId !== null))
  const groups: ProcessGroup[] = []
  for (const g of privateGroups) {
    groups.push({ kind: 'private', title: g.cwd, cwd: g.cwd, projectId: g.projectId, processes: g.processes })
  }
  if (common.length) groups.push({ kind: 'common', title: '常用软件', cwd: null, projectId: null, processes: sortGroup(common) })
  if (system.length) groups.push({ kind: 'system', title: '系统进程', cwd: null, projectId: null, processes: sortGroup(system) })
  if (other.length) groups.push({ kind: 'other', title: '其他（cwd 不可读或未归类）', cwd: null, projectId: null, processes: sortGroup(other) })
  return groups
}

/** Category for a single process — mirrors classifyProcesses precedence. */
export function classifyOne(p: ProcessEntry, options: ClassifyOptions = {}): ProcessGroupKind {
  if (isKernelThread(p)) return 'system'
  if (p.cwd && !isSystemPath(p.cwd)) return 'private'
  if (COMMON_SERVICE_NAMES.has(p.name) || matchesRule(p, options.groupingRules ?? [])) return 'common'
  if (p.cwd && isSystemPath(p.cwd) && SYSTEM_PROCESS_NAMES.has(p.name)) return 'system'
  return 'other'
}

function isKernelThread(p: ProcessEntry): boolean {
  // linux kernel threads: names like kworker/0:1, ksoftirqd/0, [rcu_sched]
  if (/^kworker/.test(p.name) || /^ksoftirqd/.test(p.name) || /^kthread/.test(p.name) || /^rcu_/.test(p.name)) return true
  if (p.command.startsWith('[') && p.command.endsWith(']')) return true
  return false
}

function isSystemPath(cwd: string): boolean {
  return SYSTEM_PATH_PREFIXES.some((prefix) => (prefix === '/' ? cwd === '/' : cwd === prefix || cwd.startsWith(prefix + '/')))
}

function matchProject(cwd: string, codeDirs: Array<{ projectId: string; codeDir: string }>): string | null {
  for (const { projectId, codeDir } of codeDirs) {
    if (cwd === codeDir || cwd.startsWith(codeDir.endsWith('/') ? codeDir : codeDir + '/')) return projectId
  }
  return null
}

function matchesRule(p: ProcessEntry, rules: Array<{ match: string; project: string }>): boolean {
  for (const rule of rules) {
    if (rule.match.startsWith('cmd:')) {
      if (p.command.includes(rule.match.slice(4))) return true
    } else if (rule.match.startsWith('name:')) {
      if (p.name === rule.match.slice(5)) return true
    } else if (p.name === rule.match || p.command.includes(rule.match)) {
      return true
    }
  }
  return false
}

/** CPU-descending so the busiest process of each group is visible first. */
function sortGroup(list: ProcessEntry[]): ProcessEntry[] {
  return [...list].sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || b.pid - a.pid)
}

// ---------- launch-mode detection (IMPROVE R2 二轮) ----------

/** ancestor process names that identify a service manager, closest match wins */
const MANAGER_PATTERNS: Array<[RegExp, string]> = [
  [/^supervisord$/i, 'supervisor'],
  [/^pm2/i, 'pm2'],
  [/^systemd/, 'systemd'],
  [/^launchd$/i, 'launchd'],
  [/^(dockerd|containerd)/i, 'docker'],
  [/^kubelet$/i, 'kubernetes'],
  [/^(npm|yarn|pnpm)$/i, 'npm'],
]
const SHELL_NAMES = /^(sh|bash|zsh|dash|fish)$/i

/**
 * Derive how each process was launched by walking the ppid ancestor chain
 * within the snapshot (bounded depth, cycle-safe). A recognized manager
 * anywhere up the chain wins; otherwise any shell ancestor → 'sh-script';
 * a reparent-to-1 process → 'direct'; else null (unknown).
 * Mutates entries in place — the snapshot is a private copy by then.
 */
export function applyLaunchModes(processes: ProcessEntry[]): void {
  const byPid = new Map(processes.map((p) => [p.pid, p]))
  for (const p of processes) {
    let current = p
    const seen = new Set<number>([p.pid])
    let manager: string | null = null
    let sawShell = false
    for (let depth = 0; depth < 8; depth++) {
      const parent = current.ppid !== null ? byPid.get(current.ppid) : undefined
      if (!parent || seen.has(parent.pid)) break
      seen.add(parent.pid)
      const matched = MANAGER_PATTERNS.find(([re]) => re.test(parent.name))
      if (matched) {
        manager = matched[1]
        break
      }
      if (SHELL_NAMES.test(parent.name)) sawShell = true
      current = parent
    }
    p.launchMode = manager ?? (sawShell ? 'sh-script' : p.ppid === 1 || p.ppid === null ? 'direct' : null)
  }
}
