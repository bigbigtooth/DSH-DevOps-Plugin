import { describe, expect, it } from 'vitest'
import {
  parseGitPrecheck,
  buildPullCommand,
  parsePullResult,
  renderHealthCheckScript,
  parseHealthOutput,
  serviceConfigHash,
  assertFrozenCommit,
  GIT_PRECHECK_SCRIPT,
} from '../../src/host/deployment/git-precheck.ts'
import { validateCommandBoundaries } from '../../src/host/deployment/deployment-service.ts'
import { err } from '../../src/contracts/errors.ts'

const precheck = (out: string) => out

describe('git precheck (S8/S10 shared module)', () => {
  it('empty dir → clone path; not-a-repo and missing dir are failures', () => {
    expect(parseGitPrecheck('__EMPTY_DIR__')).toMatchObject({ ok: true, isEmptyDir: true })
    expect(parseGitPrecheck('__NOT_DIR__').failure).toMatch(/does not exist/)
    expect(parseGitPrecheck('__NOT_REPO__').failure).toMatch(/not a git repository/)
  })

  it('clean up-to-date repo passes', () => {
    const r = parseGitPrecheck(precheck('__BRANCH__ main\n__HEAD__ abc123\n__REMOTE__ git@x:y.git\n__BEHIND__ 0\n__AHEAD__ 0'))
    expect(r.ok).toBe(true)
    expect(r.currentBranch).toBe('main')
    expect(r.headCommit).toBe('abc123')
  })

  it('dirty tree, fetch failure, divergence and local-only commits STOP', () => {
    const dirty = parseGitPrecheck(precheck('__BRANCH__ main\n__HEAD__ abc\n__DIRTY__\n M src/a.ts\n?? tmp\n'))
    expect(dirty.ok).toBe(false)
    expect(dirty.dirtyFiles.length).toBeGreaterThan(0)

    const fetchFail = parseGitPrecheck(precheck('__BRANCH__ main\n__HEAD__ abc\n__FETCH_FAILED__'))
    expect(fetchFail.failure).toMatch(/fetch failed/)

    const diverged = parseGitPrecheck(precheck('__BRANCH__ main\n__HEAD__ abc\n__AHEAD__ 2\n__DIVERGED__'))
    expect(diverged.ok).toBe(false)
    expect(diverged.failure).toMatch(/diverged/)

    const ahead = parseGitPrecheck(precheck('__BRANCH__ main\n__HEAD__ abc\n__AHEAD__ 1\n'))
    expect(ahead.ok).toBe(false)
    expect(ahead.localOnlyCommits).toHaveLength(1)
    expect(ahead.failure).toMatch(/local-only/)
  })
})

describe('ff-only pull (S10)', () => {
  it('builds an explicit ff-only command', () => {
    expect(buildPullCommand('main')).toContain('--ff-only origin main')
  })

  it('parses success head and refuses non-fast-forward', () => {
    expect(parsePullResult('__PULLED__ deadbeef')).toEqual({ ok: true, headCommit: 'deadbeef', failure: null })
    const ff = parsePullResult('fatal: Not possible to fast-forward, aborting.')
    expect(ff.ok).toBe(false)
    expect(ff.failure).toMatch(/fast-forward/)
  })

  it('frozen commit invariant', () => {
    expect(() => assertFrozenCommit('aaa', 'aaa')).not.toThrow()
    expect(() => assertFrozenCommit('bbb', 'aaa')).toThrow(/frozen/)
  })
})

describe('health check script (S8)', () => {
  it('generates target-context checks and parses facts', () => {
    const script = renderHealthCheckScript({ processPattern: 'gunicorn app:app', ports: [8000, 9000], httpUrls: ['http://127.0.0.1:8000/health'], startWaitSeconds: 10, observeSeconds: 1 })
    expect(script).toContain('grep -F -- "$PATTERN"')
    expect(script).toContain('127.0.0.1') // target-local, never host localhost
    expect(script).toContain('port-8000')
    expect(script).toContain('process-exited-during-observe')
    const ok = parseHealthOutput('__HEALTH__ process-found\n__HEALTH__ port-8000-open\n__HEALTH__ ok')
    expect(ok.ok).toBe(true)
    const bad = parseHealthOutput('__HEALTH__ process-missing')
    expect(bad.ok).toBe(false)
  })

  it('service config hash binds scripts to configuration', () => {
    const a = serviceConfigHash([{ name: 'web', manager: 'supervisor', managerId: 'web' }])
    const b = serviceConfigHash([{ name: 'web', manager: 'supervisor', managerId: 'web2' }])
    expect(a).not.toBe(b)
  })
})

describe('AI command boundaries (S8/S10)', () => {
  it('allows in-scope repair commands', () => {
    expect(validateCommandBoundaries('pip install -r requirements.txt', ['web'])).toBeNull()
    expect(validateCommandBoundaries('supervisorctl restart web', ['web'])).toBeNull()
  })

  it('rejects git escapes, code changes, destructive and unrelated-service actions', () => {
    for (const [cmd, why] of [
      ['git push origin main', 'push'],
      ['git reset --hard HEAD~1', 'reset'],
      ['git pull origin main', 'frozen'],
      ['rm -rf /', 'destructive'],
      ['dd if=/dev/zero of=/dev/sda', 'device'],
      ['reboot', 'power'],
      ['systemctl restart unrelated-svc', 'unrelated'],
      ['supervisorctl restart other', 'unrelated'],
    ] as const) {
      expect(validateCommandBoundaries(cmd, ['web']), `should reject ${cmd}`).toContain(why as never)
    }
    void err
  })
})
