/**
 * Classification matrix for IMPROVE §4.3: private (by cwd, 关联项目优先) /
 * common / system / other, project linking, user grouping rules, and totality
 * (no process may be dropped by classification).
 */
import { describe, expect, it } from 'vitest'
import { classifyProcesses, classifyOne, applyLaunchModes } from '../../src/host/probes/classify.ts'
import type { ProcessEntry } from '../../src/contracts/entities.ts'

function proc(over: Partial<ProcessEntry>): ProcessEntry {
  return {
    pid: 1, name: 'proc', user: 'u', rssBytes: 1024, cpuPercent: 1.0,
    startedAt: null, elapsedSeconds: null, state: 'S', startToken: 'tok',
    ppid: null, command: '/usr/bin/proc', cwd: null,
    ioReadBytesPerSec: null, ioWriteBytesPerSec: null, launchMode: null,
    ...over,
  }
}

describe('classifyProcesses (IMPROVE §4.3)', () => {
  it('partitions into system / common / private by name and cwd', () => {
    const entries = [
      proc({ pid: 1, name: 'kworker/0:1', command: '[kworker/0:1]' }),        // kernel thread
      proc({ pid: 2, name: 'systemd', cwd: '/', command: '/sbin/init' }),      // system daemon
      proc({ pid: 3, name: 'mysqld', cwd: '/var/lib/mysql' }),                 // common (system cwd)
      proc({ pid: 4, name: 'node', cwd: '/srv/dsh-site' }),                    // private by cwd
      proc({ pid: 5, name: 'worker', cwd: '/home/deploy/worker' }),            // private (home dirs are private)
      proc({ pid: 6, name: 'mystery', cwd: null }),                            // other — cwd unreadable
    ]
    const groups = classifyProcesses(entries)
    const byKind = new Map(groups.map((g) => [g.kind, g]))
    expect(byKind.get('system')!.processes.map((p) => p.pid).sort()).toEqual([1, 2])
    expect(byKind.get('common')!.processes.map((p) => p.pid)).toEqual([3])
    expect(byKind.get('private')!.title).toBe('/srv/dsh-site')
    // two different cwds → two private groups
    expect(groups.filter((g) => g.kind === 'private')).toHaveLength(2)
    expect(byKind.get('other')!.processes.map((p) => p.pid)).toEqual([6])
  })

  it('cwd evidence wins over the common-service name list', () => {
    const entries = [proc({ pid: 9, name: 'redis-server', cwd: '/srv/mystack' })]
    const groups = classifyProcesses(entries)
    expect(groups[0]!.kind).toBe('private')
    expect(groups[0]!.title).toBe('/srv/mystack')
  })

  it('links private cwds to project codeDirs', () => {
    const entries = [proc({ pid: 10, name: 'node', cwd: '/srv/dsh-site/sub' })]
    const groups = classifyProcesses(entries, { codeDirs: [{ projectId: 'prj1', codeDir: '/srv/dsh-site' }] })
    expect(groups[0]!.projectId).toBe('prj1')
  })

  it('groupingRules from the monitoring policy promote into common', () => {
    const entries = [proc({ pid: 11, name: 'mydaemon', command: '/opt/myapp/bin/mydaemon --serve', cwd: '/usr' })]
    const withRule = classifyProcesses(entries, { groupingRules: [{ match: 'cmd:mydaemon', project: 'custom' }] })
    expect(withRule[0]!.kind).toBe('common')
    const withNameRule = classifyProcesses(entries, { groupingRules: [{ match: 'name:mydaemon', project: 'custom' }] })
    expect(withNameRule[0]!.kind).toBe('common')
  })

  it('classification is total: every process lands in exactly one group', () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      proc({ pid: i + 1, name: `p${i}`, cwd: i % 3 === 0 ? `/srv/app${i}` : i % 3 === 1 ? '/usr' : null }))
    const groups = classifyProcesses(entries)
    const total = groups.reduce((a, g) => a + g.processes.length, 0)
    expect(total).toBe(entries.length)
  })

  it('classifyOne mirrors the group precedence', () => {
    expect(classifyOne(proc({ name: 'sshd', cwd: '/usr' }))).toBe('system')
    expect(classifyOne(proc({ name: 'nginx', cwd: '/etc' }))).toBe('common')
    expect(classifyOne(proc({ name: 'java', cwd: '/srv/x' }))).toBe('private')
    expect(classifyOne(proc({ name: 'whoami', cwd: null }))).toBe('other')
  })

  it('private groups are sorted by cwd and members by cpu desc', () => {
    const entries = [
      proc({ pid: 1, name: 'a', cwd: '/srv/b', cpuPercent: 5 }),
      proc({ pid: 2, name: 'b', cwd: '/srv/a', cpuPercent: 1 }),
      proc({ pid: 3, name: 'c', cwd: '/srv/a', cpuPercent: 9 }),
    ]
    const groups = classifyProcesses(entries)
    const privateGroups = groups.filter((g) => g.kind === 'private')
    expect(privateGroups.map((g) => g.title)).toEqual(['/srv/a', '/srv/b'])
    expect(privateGroups[0]!.processes[0]!.pid).toBe(3)
  })

  it('group order is private (linked first) → common → system → other with page titles', () => {
    const entries = [
      proc({ pid: 1, name: 'kworker/0:1', command: '[kworker/0:1]' }),   // system
      proc({ pid: 2, name: 'mysqld', cwd: '/var/lib/mysql' }),            // common
      proc({ pid: 3, name: 'node', cwd: '/home/app/other' }),             // private 未关联
      proc({ pid: 4, name: 'node', cwd: '/srv/dsh-site' }),               // private 关联项目
      proc({ pid: 5, name: 'mystery', cwd: null }),                       // other
    ]
    const groups = classifyProcesses(entries, { codeDirs: [{ projectId: 'prj1', codeDir: '/srv/dsh-site' }] })
    expect(groups.map((g) => g.kind)).toEqual(['private', 'private', 'common', 'system', 'other'])
    // 关联项目的私有组排在最前；未关联的按 cwd 排序随后
    expect(groups[0]!.projectId).toBe('prj1')
    expect(groups[1]!.projectId).toBeNull()
    expect(groups.map((g) => g.title)).toEqual(['/srv/dsh-site', '/home/app/other', '常用软件', '系统进程', '其他（cwd 不可读或未归类）'])
  })
})

describe('applyLaunchModes (IMPROVE 二轮 R2)', () => {
  it('detects supervisor / pm2 / systemd managers up the ancestor chain', () => {
    const entries = [
      proc({ pid: 100, name: 'supervisord', ppid: 1, command: 'supervisord' }),
      proc({ pid: 101, name: 'gunicorn', ppid: 100, command: 'gunicorn app:app' }),
      proc({ pid: 102, name: 'node', ppid: 100, command: 'pm2 worker' }),
      proc({ pid: 103, name: 'systemd-journal', ppid: 1, command: '/lib/systemd/systemd-journald' }),
      proc({ pid: 104, name: 'python', ppid: 103, command: 'python bot.py' }),
    ]
    applyLaunchModes(entries)
    const byPid = new Map(entries.map((p) => [p.pid, p]))
    expect(byPid.get(101)!.launchMode).toBe('supervisor')
    expect(byPid.get(102)!.launchMode).toBe('supervisor') // manager closest up the chain wins
    expect(byPid.get(104)!.launchMode).toBe('systemd')
    expect(byPid.get(100)!.launchMode).toBe('direct') // reparented to 1
  })

  it('marks shell-launched processes as sh-script and unknown as null', () => {
    const entries = [
      proc({ pid: 200, name: 'bash', ppid: 1, command: '/bin/bash run.sh' }),
      proc({ pid: 201, name: 'node', ppid: 200, command: 'node server.js' }),
      proc({ pid: 202, name: 'nginx:', ppid: 999, command: 'nginx: master process' }),
    ]
    applyLaunchModes(entries)
    const byPid = new Map(entries.map((p) => [p.pid, p]))
    expect(byPid.get(201)!.launchMode).toBe('sh-script')
    expect(byPid.get(202)!.launchMode).toBeNull() // parent 999 not in snapshot, ppid ≠ 1
  })
})
