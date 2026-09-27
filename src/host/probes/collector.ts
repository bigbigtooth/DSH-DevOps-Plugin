/**
 * Collectors: drive the SSH transport, run platform-appropriate probe
 * commands, parse with pure parsers, persist immutable snapshots.
 * Missing capabilities → `null` values + limited flag, never fabricated zeros.
 */
import { err } from '../../contracts/errors.ts'
import type { HardwareSample, ProcessEntry, ProcessSnapshot } from '../../contracts/entities.ts'
import { SCHEMA_VERSION } from '../../contracts/entities.ts'
import type { SshTransport, ClockPort } from '../adapters/ports.ts'
import type { OpsRepository } from '../repository/ops-repository.ts'
import {
  parseProcStat,
  cpuPercentBetween,
  parseMacTopCpu,
  parseMemInfo,
  parseFreeB,
  parseMacMemory,
  parseMacSwapUsage,
  parseDf,
  parsePsOutput,
  parseNetDev,
  parseNetstatIb,
  netRateBetween,
  parseProcCwdBatch,
  parseLsofCwd,
  parseProcIoBatch,
  procIoRatesBetween,
  PS_FORMAT,
  capabilityTable,
} from './parsers.ts'
import { applyLaunchModes } from './classify.ts'
import { shq } from '../ssh/openssh-transport.ts'

const LINUX_CPU_SAMPLE_SCRIPT = 'cat /proc/stat'
const MAC_CPU_SAMPLE_SCRIPT = 'top -l 2 -n 0 | grep "CPU usage"'
const LINUX_MEM_SCRIPT = 'free -b 2>/dev/null || cat /proc/meminfo'
const MAC_MEM_SCRIPT = 'vm_stat; echo ---SWAP---; sysctl -n vm.swapusage 2>/dev/null; echo ---TOTAL---; sysctl -n hw.memsize 2>/dev/null'
const DF_SCRIPT = 'df -kP'
const PS_SCRIPT = `ps -eo ${PS_FORMAT}`
const LINUX_NET_SCRIPT = 'cat /proc/net/dev'
// -n（纯数字，不做地址解析）：解析模式在受限网络环境下会因 DNS 查询挂死
const MAC_NET_SCRIPT = 'netstat -ibn'
/** batch read of per-pid working directories; unreadable pids silently drop out */
const LINUX_CWD_SCRIPT = `for d in /proc/[0-9]*; do p=\${d#/proc/}; c=$(readlink "$d/cwd" 2>/dev/null); [ -n "$c" ] && printf '%s %s\\n' "$p" "$c"; done`
const MAC_CWD_BATCH = 100
const MAC_CWD_TIMEOUT_MS = 10_000

export class HardwareCollector {
  constructor(
    private readonly transport: SshTransport,
    private readonly clock: ClockPort,
  ) {}

  async collect(serverId: string, platform: 'linux' | 'macos' | 'unknown'): Promise<{ sample: HardwareSample; capabilities: ReturnType<typeof capabilityTable> }> {
    const collectedAt = this.clock.now()
    let cpuPercent: number | null = null
    let cpuWindowMs: number | null = null
    let cores: number | null = null
    let memTotal: number | null = null
    let memUsed: number | null = null
    let swapTotal: number | null = null
    let swapUsed: number | null = null
    const limits: string[] = []

    if (platform === 'macos') {
      const top = await this.transport.execute({ serverId, runId: 'probe', stepId: 'cpu', attemptId: '0', command: MAC_CPU_SAMPLE_SCRIPT, timeoutMs: 30_000 })
      cpuPercent = parseMacTopCpu(top.stdout)
      cpuWindowMs = 1000 // top -l 2 samples ~1s apart
      const mem = await this.transport.execute({ serverId, runId: 'probe', stepId: 'mem', attemptId: '0', command: MAC_MEM_SCRIPT, timeoutMs: 30_000 })
      const [vmStat, , swapusage] = mem.stdout.split('---SWAP---').flatMap((s) => s.split('---TOTAL---'))
      const total = mem.stdout.split('---TOTAL---')[1]?.trim() ?? ''
      const m = parseMacMemory(vmStat ?? '', total)
      memTotal = m.total
      memUsed = m.used
      const su = parseMacSwapUsage(swapusage ?? '')
      swapTotal = su.total
      swapUsed = su.used
    } else {
      // linux — and unknown platform: the Linux /proc probes are read-only and
      // cheap, so try them first and fall back to macOS when they yield nothing
      // (a stale `unknown` capability must not permanently hide CPU/memory)
      const a = await this.transport.execute({ serverId, runId: 'probe', stepId: 'cpu-a', attemptId: '0', command: LINUX_CPU_SAMPLE_SCRIPT, timeoutMs: 30_000 })
      const sampleA = parseProcStat(a.stdout)
      const started = Date.now()
      await sleep(300)
      cpuWindowMs = Date.now() - started
      const b = await this.transport.execute({ serverId, runId: 'probe', stepId: 'cpu-b', attemptId: '0', command: LINUX_CPU_SAMPLE_SCRIPT, timeoutMs: 30_000 })
      const sampleB = parseProcStat(b.stdout)
      cpuPercent = cpuPercentBetween(sampleA, sampleB)
      cores = sampleB.cores || null
      const mem = await this.transport.execute({ serverId, runId: 'probe', stepId: 'mem', attemptId: '0', command: LINUX_MEM_SCRIPT, timeoutMs: 30_000 })
      if (mem.stdout.includes('Mem:')) {
        const f = parseFreeB(mem.stdout)
        memTotal = f.total
        memUsed = f.used
        swapTotal = f.swapTotal
        swapUsed = f.swapUsed
      } else {
        const mi = parseMemInfo(mem.stdout)
        memTotal = mi.total
        memUsed = mi.total !== null && mi.available !== null ? mi.total - mi.available : null
        limits.push('swap unavailable without free(1)')
      }
      if (platform === 'unknown' && cpuPercent === null) {
        try {
          const top = await this.transport.execute({ serverId, runId: 'probe', stepId: 'cpu-mac', attemptId: '0', command: MAC_CPU_SAMPLE_SCRIPT, timeoutMs: 30_000 })
          cpuPercent = parseMacTopCpu(top.stdout)
          if (cpuPercent !== null) cpuWindowMs = 1000
        } catch {
          limits.push('macOS cpu fallback unavailable')
        }
      }
      if (platform === 'unknown' && memTotal === null) {
        try {
          const memMac = await this.transport.execute({ serverId, runId: 'probe', stepId: 'mem-mac', attemptId: '0', command: MAC_MEM_SCRIPT, timeoutMs: 30_000 })
          const [vmStat, , swapusage] = memMac.stdout.split('---SWAP---').flatMap((s) => s.split('---TOTAL---'))
          const total = memMac.stdout.split('---TOTAL---')[1]?.trim() ?? ''
          const m = parseMacMemory(vmStat ?? '', total)
          memTotal = m.total
          memUsed = m.used
          const su = parseMacSwapUsage(swapusage ?? '')
          swapTotal = su.total
          swapUsed = su.used
        } catch {
          limits.push('macOS memory fallback unavailable')
        }
      }
      if (platform === 'unknown') limits.push('platform unprobed: tried Linux probes with macOS fallback')
    }

    const df = await this.transport.execute({ serverId, runId: 'probe', stepId: 'df', attemptId: '0', command: DF_SCRIPT, timeoutMs: 30_000 })
    const mounts = parseDf(df.stdout).map((d) => ({ path: d.path, totalBytes: d.totalBytes, usedBytes: d.usedBytes }))

    // network throughput over the same style of two-sample window as CPU
    let netRecv: number | null = null
    let netSent: number | null = null
    try {
      const netStart = Date.now()
      const netA = await this.transport.execute({ serverId, runId: 'probe', stepId: 'net-a', attemptId: '0', command: platform === 'macos' ? MAC_NET_SCRIPT : LINUX_NET_SCRIPT, timeoutMs: 30_000 })
      await sleep(300)
      const netB = await this.transport.execute({ serverId, runId: 'probe', stepId: 'net-b', attemptId: '0', command: platform === 'macos' ? MAC_NET_SCRIPT : LINUX_NET_SCRIPT, timeoutMs: 30_000 })
      const windowMs = Date.now() - netStart
      const sampleA = platform === 'macos' ? parseNetstatIb(netA.stdout) : parseNetDev(netA.stdout)
      const sampleB = platform === 'macos' ? parseNetstatIb(netB.stdout) : parseNetDev(netB.stdout)
      const rate = netRateBetween(sampleA, sampleB, windowMs)
      netRecv = rate.recvBytesPerSec
      netSent = rate.sentBytesPerSec
    } catch {
      limits.push('network IO unavailable')
    }

    const sample: HardwareSample = {
      cpuPercent,
      cpuWindowMs,
      cpuCores: cores,
      memoryTotalBytes: memTotal,
      memoryUsedBytes: memUsed,
      swapTotalBytes: swapTotal,
      swapUsedBytes: swapUsed,
      netRecvBytesPerSec: netRecv,
      netSentBytesPerSec: netSent,
      mounts,
      collectedAt,
      unitNotes: 'bytes; cpuPercent is whole-machine utilization 0-100 over the sampling window',
    }
    return { sample, capabilities: capabilityTable(platform, {}) }
  }
}

export class ProcessCollector {
  constructor(
    private readonly transport: SshTransport,
    private readonly repo: OpsRepository,
    private readonly clock: ClockPort,
  ) {}

  async collect(serverId: string, scope: 'all' | 'focused' = 'all', limitReason: string | null = null, platform: 'linux' | 'macos' | 'unknown' = 'unknown'): Promise<ProcessSnapshot> {
    const res = await this.transport.execute({ serverId, runId: 'probe', stepId: 'ps', attemptId: '0', command: PS_SCRIPT, timeoutMs: 60_000 })
    if (res.exitCode !== 0 && res.stdout.trim() === '') {
      throw err('capability-unsupported', 'probes', `process enumeration failed: ${res.stderr.trim().split('\n')[0] || 'no output'}`)
    }
    const processes = parsePsOutput(res.stdout, this.clock.now())
    await this.attachCwd(serverId, processes, platform)
    applyLaunchModes(processes)
    const snapshot: ProcessSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      snapshotId: `snap_${this.clock.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      serverId,
      scope,
      collectedAt: this.clock.now(),
      processes,
      limited: limitReason !== null,
      limitReason,
    }
    await this.repo.putProcessSnapshot(snapshot)
    return snapshot
  }

  /**
   * Best-effort working directories. Permission-restricted pids keep cwd=null
   * (classified into `other`, never dropped); a failed batch only nulls that batch.
   */
  private async attachCwd(serverId: string, processes: ProcessEntry[], platform: 'linux' | 'macos' | 'unknown'): Promise<void> {
    try {
      if (platform === 'linux' || platform === 'unknown') {
        // unknown platform: the /proc batch is read-only and fails silently per-entry
        const res = await this.transport.execute({ serverId, runId: 'probe', stepId: 'cwd', attemptId: '0', command: LINUX_CWD_SCRIPT, timeoutMs: 20_000 })
        const map = parseProcCwdBatch(res.stdout)
        for (const p of processes) {
          const cwd = map.get(p.pid)
          if (cwd) p.cwd = cwd
        }
        if (platform === 'unknown' && map.size === 0) {
          await this.attachCwdMacos(serverId, processes)
        }
      } else if (platform === 'macos') {
        await this.attachCwdMacos(serverId, processes)
      }
      // otherwise: cwd stays null
    } catch {
      // cwd is enrichment only — the snapshot itself stays valid
    }
  }

  private async attachCwdMacos(serverId: string, processes: ProcessEntry[]): Promise<void> {
    const pids = processes.map((p) => p.pid)
    for (let i = 0; i < pids.length; i += MAC_CWD_BATCH) {
      const batch = pids.slice(i, i + MAC_CWD_BATCH)
      const res = await this.transport.execute({
        serverId,
        runId: 'probe',
        stepId: `cwd-${i / MAC_CWD_BATCH}`,
        attemptId: '0',
        command: `lsof -a -d cwd -Fn -p ${batch.join(',')}`,
        timeoutMs: MAC_CWD_TIMEOUT_MS,
      }).catch(() => null)
      if (!res || res.exitCode !== 0) continue
      const map = parseLsofCwd(res.stdout)
      for (const p of processes.slice(i, i + MAC_CWD_BATCH)) {
        const cwd = map.get(p.pid)
        if (cwd) p.cwd = cwd
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Best-effort per-process resource probe for the project services view
 * (IMPROVE §4.5): /proc/PID/io rates (Linux only) and codeDir disk usage.
 * Unavailable data is null — never fabricated zeros.
 */
export class ResourceProbe {
  constructor(private readonly transport: SshTransport) {}

  /** Two batch reads of /proc/PID/io, 500ms apart (Linux only). */
  async collectProcessIoRates(serverId: string, pids: number[]): Promise<Map<number, { readBytesPerSec: number; writeBytesPerSec: number }>> {
    if (pids.length === 0) return new Map()
    const script = (suffix: string) => `for p in ${pids.join(' ')}; do echo "== $p"; grep -E '^(rchar|wchar):' /proc/$p/io 2>/dev/null ${suffix}; done`
    try {
      const a = await this.transport.execute({ serverId, runId: 'probe', stepId: `pio-a`, attemptId: '0', command: script(''), timeoutMs: 15_000 })
      await sleep(500)
      const b = await this.transport.execute({ serverId, runId: 'probe', stepId: `pio-b`, attemptId: '0', command: script(''), timeoutMs: 15_000 })
      return procIoRatesBetween(parseProcIoBatch(a.stdout), parseProcIoBatch(b.stdout), 500)
    } catch {
      return new Map()
    }
  }

  /** `du -sk` of one path; null on failure or missing path. */
  async measurePathBytes(serverId: string, path: string): Promise<number | null> {
    try {
      const res = await this.transport.execute({ serverId, runId: 'probe', stepId: 'du', attemptId: '0', command: `du -sk ${shq(path)} 2>/dev/null`, timeoutMs: 30_000 })
      if (res.exitCode !== 0 && !res.stdout.trim()) return null
      const kb = Number(res.stdout.trim().split(/\s+/)[0])
      return Number.isFinite(kb) ? kb * 1024 : null
    } catch {
      return null
    }
  }

  /** stat one path (GNU + BSD stat forms); null on failure. */
  async statPath(serverId: string, path: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const res = await this.transport.execute({
        serverId, runId: 'probe', stepId: 'stat', attemptId: '0',
        command: `stat -c '%s %Y' ${shq(path)} 2>/dev/null || stat -f '%z %m' ${shq(path)} 2>/dev/null`,
        timeoutMs: 10_000,
      })
      const parts = res.stdout.trim().split(/\s+/)
      const size = Number(parts[0])
      const mtimeSec = Number(parts[1])
      if (!Number.isFinite(size) || !Number.isFinite(mtimeSec)) return null
      return { size, mtimeMs: mtimeSec * 1000 }
    } catch {
      return null
    }
  }

  /**
   * Find nginx/apache config files that reference the project codeDir
   * (reverse proxies pointing at the project, IMPROVE 二轮 R2).
   * Best-effort without sudo: permission-restricted config dirs yield fewer
   * or no results, which is reported as an empty list, never fabricated.
   */
  async detectReverseProxies(serverId: string, codeDir: string): Promise<Array<{ server: string; configPath: string; serverNames: string[] }>> {
    try {
      const res = await this.transport.execute({
        serverId, runId: 'probe', stepId: 'proxy-grep', attemptId: '0',
        command: `grep -rIlF ${shq(codeDir)} /etc/nginx /etc/apache2 /etc/httpd 2>/dev/null | head -20`,
        timeoutMs: 20_000,
      })
      const files = res.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')).slice(0, 10)
      const proxies: Array<{ server: string; configPath: string; serverNames: string[] }> = []
      for (const configPath of files) {
        const server = configPath.includes('nginx') ? 'nginx' : 'apache'
        const sn = await this.transport.execute({
          serverId, runId: 'probe', stepId: 'proxy-sn', attemptId: '0',
          command: `grep -ihE 'server_name|servername' ${shq(configPath)} 2>/dev/null | head -5`,
          timeoutMs: 10_000,
        }).catch(() => null)
        const serverNames = (sn?.stdout ?? '')
          .split('\n')
          .map((l) => l.trim().replace(/^#\s*/, '').split(/\s+/).slice(1).join(' ').trim())
          .filter(Boolean)
        proxies.push({ server, configPath, serverNames })
      }
      return proxies
    } catch {
      return []
    }
  }
}

export { shq }
