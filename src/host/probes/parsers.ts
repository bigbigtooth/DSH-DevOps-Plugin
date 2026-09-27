/**
 * Platform probe parsers — pure functions over captured command output so
 * Linux and macOS fixtures can be unit-tested without a live target.
 * Missing fields are `null` (unavailable), never 0.
 */
import type { HardwareSample, ProcessEntry } from '../../contracts/entities.ts'

// ---------- hardware: CPU via /proc/stat (Linux, sampled twice) ----------

export interface ProcStatSample {
  idle: number
  total: number
  cores: number
}

export function parseProcStat(output: string): ProcStatSample {
  const lines = output.split('\n').filter((l) => l.startsWith('cpu'))
  let idle = 0
  let total = 0
  let cores = 0
  for (const line of lines) {
    const cols = line.trim().split(/\s+/).slice(1).map(Number)
    if (cols.some((n) => Number.isNaN(n))) continue
    const idleAll = (cols[3] ?? 0) + (cols[4] ?? 0) // idle + iowait
    const sum = cols.reduce((a, b) => a + b, 0)
    if (line.startsWith('cpu ')) {
      idle = idleAll
      total = sum
    } else {
      cores++
    }
  }
  return { idle, total, cores }
}

export function cpuPercentBetween(a: ProcStatSample, b: ProcStatSample): number | null {
  if (a.total === 0 || b.total === 0) return null
  const dIdle = b.idle - a.idle
  const dTotal = b.total - a.total
  if (dTotal < 0) return null // counters regressed (reboot/resume): unavailable
  if (dTotal === 0) return 0 // identical samples: no busy time observed
  return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100))
}

// ---------- hardware: macOS top CPU line ----------

export function parseMacTopCpu(topOutput: string): number | null {
  // take the LAST "CPU usage" line (top -l prints per sampled frame)
  const matches = [...topOutput.matchAll(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/g)]
  const last = matches.at(-1)
  if (!last) return null
  const user = Number(last[1])
  const sys = Number(last[2])
  if (Number.isNaN(user) || Number.isNaN(sys)) return null
  return Math.max(0, Math.min(100, user + sys))
}

// ---------- hardware: memory ----------

export function parseMemInfo(output: string): { total: number | null; available: number | null } {
  const get = (key: string): number | null => {
    const m = new RegExp(`${key}:\\s+(\\d+)`).exec(output)
    return m ? Number(m[1]) : null
  }
  const total = get('MemTotal')
  const available = get('MemAvailable') ?? get('MemFree')
  return { total, available }
}

export function parseFreeB(output: string): { total: number | null; used: number | null; swapTotal: number | null; swapUsed: number | null } {
  const line = output.split('\n').find((l) => l.startsWith('Mem:'))
  const swap = output.split('\n').find((l) => l.startsWith('Swap:'))
  const nums = (l?: string): Array<number | null> => (l ? l.trim().split(/\s+/).slice(1).map((v) => (/^\d+$/.test(v) ? Number(v) : null)) : [])
  const mem = nums(line)
  const sw = nums(swap)
  return {
    total: mem[0] ?? null,
    used: mem[1] ?? null,
    swapTotal: sw[0] ?? null,
    swapUsed: sw[1] ?? null,
  }
}

export function parseMacMemory(vmStatOutput: string, sysctlMemsize: string): { total: number | null; used: number | null; swapTotal: number | null; swapUsed: number | null } {
  const pageSize = 4096
  const get = (key: string): number | null => {
    const m = new RegExp(`${key}:\\s+(\\d+)`).exec(vmStatOutput)
    return m ? Number(m[1]) * pageSize : null
  }
  const total = /^\d+$/.test(sysctlMemsize.trim()) ? Number(sysctlMemsize.trim()) : null
  const free = get('Pages free')
  const inactive = get('Pages inactive')
  const speculative = get('Pages speculative')
  const wired = get('Pages wired down')
  const compressed = get('Pages stored in compressor') ?? get('Pages occupied by compressor')
  const active = get('Pages active')
  if (total === null) return { total: null, used: null, swapTotal: null, swapUsed: null }
  const usableFree = (free ?? 0) + (inactive ?? 0) + (speculative ?? 0)
  const used = Math.max(0, total - usableFree)
  const swapIn = get('Swapins') ?? 0
  const swapOut = get('Swapouts') ?? 0
  return {
    total,
    used,
    swapTotal: null, // macOS swap is dynamic; reported via sysctl vm.swapusage when available
    swapUsed: swapIn + swapOut > 0 ? swapIn + swapOut : null,
    ...(wired !== null && compressed !== null && active !== null ? {} : {}),
  }
}

export function parseMacSwapUsage(output: string): { total: number | null; used: number | null } {
  // e.g. `total = 2048.00M  used = 512.00M  free = 1536.00M`
  const total = /total\s*=\s*([\d.]+)M/.exec(output)
  const used = /used\s*=\s*([\d.]+)M/.exec(output)
  return {
    total: total ? Number(total[1]) * 1024 * 1024 : null,
    used: used ? Number(used[1]) * 1024 * 1024 : null,
  }
}

// ---------- hardware: mounts (df -kP) ----------

export interface DfEntry {
  path: string
  totalBytes: number | null
  usedBytes: number | null
}

export function parseDf(output: string): DfEntry[] {
  const entries: DfEntry[] = []
  for (const line of output.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 6) continue
    const path = cols[5]!
    if (!path.startsWith('/')) continue
    entries.push({
      path,
      totalBytes: /^\d+$/.test(cols[1] ?? '') ? Number(cols[1]) * 1024 : null,
      usedBytes: /^\d+$/.test(cols[2] ?? '') ? Number(cols[2]) * 1024 : null,
    })
  }
  return entries
}

// ---------- processes (shared ps format for Linux + macOS) ----------

export const PS_FORMAT = 'pid=,ppid=,user=,rss=,pcpu=,lstart=,stat=,args='

/**
 * Parse `ps -eo pid=,ppid=,user=,rss=,pcpu=,lstart=,stat=,args=`.
 * lstart shape: `Mon Sep 17 01:02:03 2026` (7 tokens) on both platforms.
 * CPU note: ps pcpu = per-core percentage (single core 100%, can exceed 100),
 * intentionally different from the whole-machine CPU metric.
 */
export function parsePsOutput(output: string, collectedAt: number): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    // header row if present
    if (/^\s*PID\b/.test(line)) continue
    const parsed = parsePsLine(line)
    if (parsed) entries.push(parsed)
  }
  void collectedAt
  return entries
}

function parsePsLine(line: string): ProcessEntry | null {
  // fixed leading fields: pid ppid user rss pcpu (PS_FORMAT order)
  const m = /^ *\d+ +\d+ +/.exec(line)
  if (!m) return null
  const parts = line.trim().split(/\s+/)
  const pid = Number(parts[0])
  const ppid = Number(parts[1])
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null
  const user = parts[2] ?? ''
  const rss = parts[3] === '?' || parts[3] === undefined ? null : /^\d+$/.test(parts[3]) ? Number(parts[3]) * 1024 : null
  const pcpuRaw = parts[4]
  const pcpu = pcpuRaw !== undefined && /^-?[\d.]+$/.test(pcpuRaw) ? Number(pcpuRaw) : null
  // skip the first five tokens deterministically, then parse lstart
  const skipMatch = /^(\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+)/.exec(line)
  const rest = skipMatch ? line.slice(skipMatch[1]!.length) : line.trim()
  // BSD lstart: `Tue Sep 16 09:10:00 2026` (day-of-month may be space-padded)
  const lstartMatch = /^([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*/.exec(rest)
  let lstart = ''
  let afterLstart = rest
  if (lstartMatch) {
    lstart = lstartMatch[1]!.trim().replace(/\s+/g, ' ')
    afterLstart = rest.slice(lstartMatch[0].length - 1)
  } else {
    // fallback: 7 tokens then stat
    const tokens = rest.split(/\s+/)
    lstart = tokens.slice(0, 7).join(' ')
    afterLstart = rest.slice(lstart.length)
  }
  const stat = afterLstart.trim().split(/\s+/)[0] ?? '?'
  const command = afterLstart.trim().slice(stat.length).trim()
  if (!Number.isInteger(pid)) return null
  const startToken = `${pid}:${lstart}`
  return {
    pid,
    ppid,
    user,
    rssBytes: rss,
    cpuPercent: pcpu,
    startedAt: null, // absolute epoch not portable; startToken carries the identity
    elapsedSeconds: null,
    state: stat,
    startToken: lstart ? startToken : `pid:${pid}`,
    command,
    name: commandName(command, pid),
    cwd: null,
    ioReadBytesPerSec: null,
    ioWriteBytesPerSec: null,
    launchMode: null,
  }
}

function commandName(command: string, pid: number): string {
  if (!command) return `pid-${pid}`
  const first = command.split(' ')[0] ?? ''
  const slash = first.lastIndexOf('/')
  // `nginx: worker process` / `postgres: checkpointer` style argv0 names end
  // with a colon — strip it so the common-service name lists still match
  return (slash >= 0 ? first.slice(slash + 1) : first).replace(/:$/, '')
}

/**
 * Grouping: prefer an associated service definition match, then code-path
 * evidence; everything unreliable lands in `unassigned` with its PID intact.
 */
export function groupProcesses(
  processes: ProcessEntry[],
  rules: Array<{ match: string; project: string }>,
): Map<string, ProcessEntry[]> {
  const groups = new Map<string, ProcessEntry[]>()
  const unassigned: ProcessEntry[] = []
  for (const p of processes) {
    let group: string | null = null
    for (const rule of rules) {
      if (matchRule(rule.match, p)) {
        group = rule.project
        break
      }
    }
    if (group === null && p.command) {
      // code-path evidence: any configured project path inside the command line
      // (callers pass rules for this; here only service-name heuristics apply)
    }
    const key = group ?? 'unassigned'
    const list = groups.get(key) ?? []
    list.push(p)
    groups.set(key, list)
  }
  if (unassigned.length) groups.set('unassigned', unassigned)
  return groups
}

function matchRule(match: string, p: ProcessEntry): boolean {
  if (match.startsWith('cmd:')) return p.command.includes(match.slice(4))
  if (match.startsWith('name:')) return p.name === match.slice(5)
  return p.name === match || p.command.includes(match)
}

// ---------- hardware: network IO (two-sample delta, loopback excluded) ----------

export interface NetDevSample {
  /** cumulative counters per interface in bytes */
  recv: Record<string, number>
  sent: Record<string, number>
}

/** Linux: parse /proc/net/dev cumulative byte counters. */
export function parseNetDev(output: string): NetDevSample {
  const recv: Record<string, number> = {}
  const sent: Record<string, number> = {}
  for (const line of output.split('\n')) {
    // `  eth0: 12345 packets ...` — interface name ends at ':'
    const m = /^\s*([^:\s]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/.exec(line)
    if (!m) continue
    const iface = m[1]!
    if (iface === 'lo') continue
    recv[iface] = Number(m[2])
    sent[iface] = Number(m[3])
  }
  return { recv, sent }
}

/** macOS: parse `netstat -ib` cumulative byte counters (Name/Ibytes/Obytes). */
export function parseNetstatIb(output: string): NetDevSample {
  const recv: Record<string, number> = {}
  const sent: Record<string, number> = {}
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 7 || cols[0] === 'Name') continue
    const iface = cols[0]!
    if (iface.startsWith('lo')) continue
    // netstat -ib columns: Name Mtu Network Address Ibytes Obytes Ipkts ...
    const ibytes = Number(cols[4])
    const obytes = Number(cols[5])
    if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) continue
    recv[iface] = (recv[iface] ?? 0) + ibytes
    sent[iface] = (sent[iface] ?? 0) + obytes
  }
  return { recv, sent }
}

/** Sum per-interface deltas between two samples; null when counters regressed or window invalid. */
export function netRateBetween(a: NetDevSample, b: NetDevSample, windowMs: number): { recvBytesPerSec: number | null; sentBytesPerSec: number | null } {
  if (windowMs <= 0) return { recvBytesPerSec: null, sentBytesPerSec: null }
  let recvDelta = 0
  let sentDelta = 0
  let sawInterface = false
  for (const iface of Object.keys(b.recv)) {
    const r0 = a.recv[iface]
    const r1 = b.recv[iface]!
    const s0 = a.sent[iface]
    const s1 = b.sent[iface]!
    // counter regression (reboot/ifdown) → that interface unusable, skip it
    if (r0 === undefined || r1 < r0) continue
    if (s0 === undefined || s1 < s0) continue
    sawInterface = true
    recvDelta += r1 - r0
    sentDelta += s1 - s0
  }
  if (!sawInterface) return { recvBytesPerSec: null, sentBytesPerSec: null }
  const sec = windowMs / 1000
  return {
    recvBytesPerSec: Math.max(0, recvDelta / sec),
    sentBytesPerSec: Math.max(0, sentDelta / sec),
  }
}

// ---------- process cwd (batch /proc symlink read, macOS lsof) ----------

/** Linux: parse `printf '%s %s\n' pid "$(readlink ...)"` batch output. */
export function parseProcCwdBatch(output: string): Map<number, string> {
  const map = new Map<number, string>()
  for (const line of output.split('\n')) {
    const m = /^(\d+) (.+)$/.exec(line.trim())
    if (!m) continue
    const pid = Number(m[1])
    if (!Number.isInteger(pid)) continue
    map.set(pid, m[2]!)
  }
  return map
}

/** macOS: parse `lsof -a -d cwd -Fn -p <pids>` output (pPID/fPID lines, nPATH follows). */
export function parseLsofCwd(output: string): Map<number, string> {
  const map = new Map<number, string>()
  let current: number | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1))
      current = Number.isInteger(pid) ? pid : null
    } else if (line.startsWith('n') && current !== null) {
      const path = line.slice(1)
      if (path.startsWith('/')) map.set(current, path)
    }
  }
  return map
}

// ---------- per-process IO (Linux /proc/PID/io, two-sample delta) ----------

export interface ProcIoSample {
  readBytes: number
  writeBytes: number
}

/** Parse rchar/wchar (bytes actually served by the OS) from /proc/PID/io. */
export function parseProcIo(output: string): ProcIoSample | null {
  const rchar = /^rchar:\s*(\d+)/m.exec(output)
  const wchar = /^wchar:\s*(\d+)/m.exec(output)
  if (!rchar || !wchar) return null
  return { readBytes: Number(rchar[1]), writeBytes: Number(wchar[1]) }
}

/** Parse the batch form: `== <pid>` lines each followed by /proc/PID/io content. */
export function parseProcIoBatch(output: string): Map<number, ProcIoSample> {
  const map = new Map<number, ProcIoSample>()
  let current: number | null = null
  let sample: { rchar: number | null; wchar: number | null } | null = null
  const flush = (): void => {
    if (current !== null && sample && sample.rchar !== null && sample.wchar !== null) {
      map.set(current, { readBytes: sample.rchar, writeBytes: sample.wchar })
    }
  }
  for (const line of output.split('\n')) {
    const marker = /^== (\d+)$/.exec(line.trim())
    if (marker) {
      flush()
      current = Number(marker[1])
      sample = { rchar: null, wchar: null }
      continue
    }
    if (!sample) continue
    const r = /^rchar:\s*(\d+)/.exec(line.trim())
    const w = /^wchar:\s*(\d+)/.exec(line.trim())
    if (r) sample.rchar = Number(r[1])
    if (w) sample.wchar = Number(w[1])
  }
  flush()
  return map
}

/** Sum two batch samples into per-pid byte rates; null rate when counters regressed. */
export function procIoRatesBetween(a: Map<number, ProcIoSample>, b: Map<number, ProcIoSample>, windowMs: number): Map<number, { readBytesPerSec: number; writeBytesPerSec: number }> {
  const rates = new Map<number, { readBytesPerSec: number; writeBytesPerSec: number }>()
  if (windowMs <= 0) return rates
  const sec = windowMs / 1000
  for (const [pid, s1] of b) {
    const s0 = a.get(pid)
    if (!s0 || s1.readBytes < s0.readBytes || s1.writeBytes < s0.writeBytes) continue
    rates.set(pid, {
      readBytesPerSec: Math.max(0, (s1.readBytes - s0.readBytes) / sec),
      writeBytesPerSec: Math.max(0, (s1.writeBytes - s0.writeBytes) / sec),
    })
  }
  return rates
}

// ---------- capability table ----------

export interface CapabilityRow {
  name: string
  status: 'available' | 'limited' | 'unavailable'
  reason: string
}

export function capabilityTable(platform: string, tools: Record<string, 'available' | 'unavailable'>): CapabilityRow[] {
  const rows: CapabilityRow[] = []
  const has = (t: string) => tools[t] === 'available'
  rows.push(
    platform === 'linux'
      ? { name: 'cpu.sample', status: has('sh') ? 'available' : 'unavailable', reason: has('sh') ? '/proc/stat sampling' : 'no shell' }
      : platform === 'macos'
        ? { name: 'cpu.sample', status: has('top') ? 'available' : 'limited', reason: has('top') ? 'top -l sampling' : 'top missing; CPU unavailable' }
        : { name: 'cpu.sample', status: 'unavailable', reason: 'unknown platform' },
  )
  rows.push(
    platform === 'linux'
      ? { name: 'memory', status: has('free') ? 'available' : 'limited', reason: has('free') ? 'free -b' : '/proc/meminfo missing free' }
      : platform === 'macos'
        ? { name: 'memory', status: has('vm_stat') ? 'available' : 'unavailable', reason: has('vm_stat') ? 'vm_stat + sysctl' : 'vm_stat missing' }
        : { name: 'memory', status: 'unavailable', reason: 'unknown platform' },
  )
  rows.push({ name: 'disk', status: has('df') ? 'available' : 'unavailable', reason: has('df') ? 'df -kP' : 'df missing' })
  rows.push({ name: 'processes', status: has('ps') ? 'available' : 'unavailable', reason: has('ps') ? 'ps -eo with lstart identity' : 'ps missing' })
  return rows
}
