import { describe, expect, it } from 'vitest'
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
  groupProcesses,
  capabilityTable,
  parseNetDev,
  parseNetstatIb,
  netRateBetween,
  parseProcCwdBatch,
  parseLsofCwd,
  parseProcIo,
  parseProcIoBatch,
  procIoRatesBetween,
} from '../../src/host/probes/parsers.ts'

const LINUX_PROC_STAT_A = `cpu  100 0 200 10000 50 0 0 0 0 0
cpu0 60 0 120 5000 30 0 0 0 0 0
cpu1 40 0 80 5000 20 0 0 0 0 0
intr 123
`
const LINUX_PROC_STAT_B = `cpu  150 0 250 11000 60 0 0 0 0 0
cpu0 90 0 150 5500 40 0 0 0 0 0
cpu1 60 0 100 5500 20 0 0 0 0 0
intr 123
`

describe('hardware parsers (S4)', () => {
  it('CPU percent from /proc/stat sampling delta with window', () => {
    const a = parseProcStat(LINUX_PROC_STAT_A)
    const b = parseProcStat(LINUX_PROC_STAT_B)
    expect(a.cores).toBe(2)
    const pct = cpuPercentBetween(a, b)
    expect(pct).not.toBeNull()
    expect(pct!).toBeGreaterThan(0)
    expect(pct!).toBeLessThanOrEqual(100)
    // identical samples → 0, not an error
    expect(cpuPercentBetween(a, a)).toBe(0)
    // regressed counters → null (unavailable), never fabricated
    expect(cpuPercentBetween(b, a)).toBeNull()
  })

  it('macOS top CPU uses the LAST sampled frame', () => {
    const top = `CPU usage: 1.0% user, 1.0% sys, 98.0% idle
CPU usage: 10.50% user, 9.50% sys, 80.0% idle`
    expect(parseMacTopCpu(top)).toBeCloseTo(20.0)
    expect(parseMacTopCpu('nothing here')).toBeNull()
  })

  it('memory from free -b, /proc/meminfo and vm_stat', () => {
    const free = parseFreeB('Mem:  16000 8000 4000 0 4000 8000\nSwap: 4000 1000 3000')
    expect(free.total).toBe(16000)
    expect(free.used).toBe(8000)
    expect(free.swapUsed).toBe(1000)
    const mi = parseMemInfo('MemTotal: 32104000 kB\nMemFree: 2104000 kB\nMemAvailable: 12104000 kB')
    expect(mi.total).toBe(32104000)
    expect(mi.available).toBe(12104000)
    const mac = parseMacMemory('Pages free: 12000.\nPages active: 40000.\nPages inactive: 30000.\nPages speculative: 2000.\nPages wired down: 50000.\nPages occupied by compressor: 8000.', '17179869184')
    expect(mac.total).toBe(17179869184)
    expect(mac.used).toBeGreaterThan(0)
    const swap = parseMacSwapUsage('total = 2048.00M  used = 512.00M  free = 1536.00M')
    expect(swap.used).toBe(512 * 1024 * 1024)
  })

  it('df parsing keeps mount paths and byte units', () => {
    const df = parseDf(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1  1000  600  400  60% /
map auto_home   0   0   0  100% /home`)
    expect(df).toHaveLength(1)
    expect(df[0]!.path).toBe('/')
    expect(df[0]!.usedBytes).toBe(600 * 1024)
    expect(df[0]!.totalBytes).toBe(1000 * 1024)
  })
})

const MAC_PS = `  501   1 root   20480   0.5 Tue Sep 16 09:10:00 2026 S /usr/sbin/syslogd
  742 7421 alice 512000  210.0 Tue Sep 16 09:12:30 2026 R /usr/local/bin/node server.js
  999     1 alice      0   0.0 Tue Sep 16 09:13:00 2026 Z (zombie-worker)
`
const LINUX_PS = ` 1234     1 www-data 102400  3.5 Mon Sep 15 22:01:01 2026 S nginx: master process
 1235  1234 www-data  98304  4.0 Mon Sep 15 22:01:02 2026 S nginx: worker process
`

describe('process parsers (S4)', () => {
  it('parses macOS ps output incl. zombie and >100% cpu', () => {
    const entries = parsePsOutput(MAC_PS, 0)
    expect(entries).toHaveLength(3)
    const node = entries[1]!
    expect(node.pid).toBe(742)
    expect(node.name).toBe('node')
    expect(node.user).toBe('alice')
    expect(node.rssBytes).toBe(512000 * 1024)
    expect(node.cpuPercent).toBe(210.0) // per-core caliber exceeds 100
    const zombie = entries[2]!
    expect(zombie.state).toBe('Z') // zombies must not be dropped
    expect(zombie.startToken).toContain('999:')
  })

  it('parses Linux ps output and captures parent/child identity', () => {
    const entries = parsePsOutput(LINUX_PS, 0)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.ppid).toBe(1)
    expect(entries[1]!.ppid).toBe(1234)
    // start tokens stable and distinct
    expect(entries[0]!.startToken).not.toBe(entries[1]!.startToken)
  })

  it('grouping never loses processes: unmatched land in unassigned', () => {
    const entries = parsePsOutput(MAC_PS + LINUX_PS, 0)
    const groups = groupProcesses(entries, [{ match: 'cmd:server.js', project: 'webshop' }])
    expect(groups.get('webshop')!.map((p) => p.pid)).toEqual([742])
    const totalGrouped = [...groups.values()].reduce((a, l) => a + l.length, 0)
    expect(totalGrouped).toBe(entries.length)
    expect(groups.get('unassigned')!.length).toBe(4)
  })

  it('capability table marks unavailable without tools', () => {
    const rows = capabilityTable('macos', { top: 'available', vm_stat: 'unavailable', df: 'available', ps: 'available' })
    const mem = rows.find((r) => r.name === 'memory')!
    expect(mem.status).toBe('unavailable')
    const cpu = rows.find((r) => r.name === 'cpu.sample')!
    expect(cpu.status).toBe('available')
  })
})

// ---------- IMPROVE §4.2/§4.3: network IO, cwd, per-process IO ----------

const NETDEV_A = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 40 0 0 0 0 0 0 5000 40 0 0 0 0 0 0
  eth0: 100000 100 0 0 0 0 0 0 50000 80 0 0 0 0 0 0
`
const NETDEV_B = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9000 60 0 0 0 0 0 0 9000 60 0 0 0 0 0 0
  eth0: 304800 300 0 0 0 0 0 0 150000 200 0 0 0 0 0 0
`

describe('network parsers (IMPROVE §4.2)', () => {
  it('parseNetDev excludes loopback and reads cumulative bytes', () => {
    const a = parseNetDev(NETDEV_A)
    expect(a.recv.eth0).toBe(100000)
    expect(a.sent.eth0).toBe(50000)
    expect(a.recv.lo).toBeUndefined()
  })

  it('netRateBetween differences counters over the window', () => {
    const a = parseNetDev(NETDEV_A)
    const b = parseNetDev(NETDEV_B)
    const rate = netRateBetween(a, b, 1000)
    expect(rate.recvBytesPerSec).toBeCloseTo(204800) // 304800-100000 over 1s
    expect(rate.sentBytesPerSec).toBeCloseTo(100000)
  })

  it('netRateBetween reports null when counters regress (reboot)', () => {
    const a = parseNetDev(NETDEV_B)
    const b = parseNetDev(NETDEV_A)
    expect(netRateBetween(a, b, 1000).recvBytesPerSec).toBeNull()
    expect(netRateBetween(a, b, 0).sentBytesPerSec).toBeNull()
  })

  it('parseNetstatIb sums per-family rows and skips loopback', () => {
    const out = `<Link#2> 1500 <Link#2> 00:00 1000 500 10 5
eth0 1500 <Link#2> 00:00 2000 800 10 5
lo0 16384 <Link#1> 00:00 999 999 9 9`
    const s = parseNetstatIb(out)
    expect(s.recv.eth0).toBe(2000)
    expect(s.recv.lo0).toBeUndefined()
  })
})

describe('cwd parsers (IMPROVE §4.3)', () => {
  it('parseProcCwdBatch maps pid→path and skips unreadable entries', () => {
    const map = parseProcCwdBatch('123 /srv/app\n456 /usr/sbin\nbadline\n789 ')
    expect(map.get(123)).toBe('/srv/app')
    expect(map.get(456)).toBe('/usr/sbin')
    expect(map.has(789)).toBe(false)
    expect(map.size).toBe(2)
  })

  it('parseLsofCwd follows p/n record pairs', () => {
    const out = 'p742\nn/srv/app\ncwd\np999\nn/usr/bin\n'
    const map = parseLsofCwd(out)
    expect(map.get(742)).toBe('/srv/app')
    expect(map.get(999)).toBe('/usr/bin')
  })
})

describe('per-process IO parsers (IMPROVE §4.5)', () => {
  it('parseProcIo reads rchar/wchar', () => {
    expect(parseProcIo('rchar: 1000\nwchar: 500\n')).toEqual({ readBytes: 1000, writeBytes: 500 })
    expect(parseProcIo('no data')).toBeNull()
  })

  it('parseProcIoBatch + procIoRatesBetween compute rates per pid', () => {
    const a = parseProcIoBatch('== 1\nrchar: 1000\nwchar: 200\n== 2\nrchar: 10\nwchar: 5\n')
    const b = parseProcIoBatch('== 1\nrchar: 2000\nwchar: 400\n== 2\nrchar: 5\nwchar: 6\n')
    const rates = procIoRatesBetween(a, b, 1000)
    expect(rates.get(1)).toEqual({ readBytesPerSec: 1000, writeBytesPerSec: 200 })
    expect(rates.has(2)).toBe(false) // regressed counters → excluded
  })
})
