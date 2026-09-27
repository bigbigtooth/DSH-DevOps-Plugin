/**
 * Git precheck + update module (S8/S10 shared): remote repository inspection
 * and `git pull --ff-only` with a frozen target commit.
 * All commands are read-only prechecks until the explicit pull step.
 */
import { err } from '../../contracts/errors.ts'
import { sha256 } from '../ssh/private-config.ts'

export interface GitPrecheckResult {
  ok: boolean
  isRepo: boolean
  isEmptyDir: boolean
  dirty: boolean
  dirtyFiles: string[]
  currentBranch: string
  remoteUrl: string | null
  localOnlyCommits: string[]
  headCommit: string | null
  /** commits the local branch is behind origin (0 when up to date / unknown) */
  behind: number
  failure: string | null
}

export const GIT_PRECHECK_SCRIPT = [
  'set -u',
  'DIR=$1',
  'cd "$DIR" 2>/dev/null || { echo __NOT_DIR__; exit 0; }',
  'if [ ! -d .git ] && [ -z "$(ls -A 2>/dev/null)" ]; then echo __EMPTY_DIR__; exit 0; fi',
  'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo __NOT_REPO__; exit 0; fi',
  'echo __BRANCH__ $(git rev-parse --abbrev-ref HEAD 2>/dev/null)',
  'echo __HEAD__ $(git rev-parse HEAD 2>/dev/null)',
  'echo __REMOTE__ $(git config --get remote.origin.url 2>/dev/null)',
  'if [ -n "$(git status --porcelain 2>/dev/null)" ]; then echo __DIRTY__; git status --porcelain | head -20; fi',
  'git fetch origin --quiet 2>/dev/null || echo __FETCH_FAILED__',
  'UPSTREAM=$(git rev-parse origin/"$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null)',
  'HEAD_C=$(git rev-parse HEAD 2>/dev/null)',
  'if [ -n "$UPSTREAM" ] && [ -n "$HEAD_C" ]; then',
  '  git rev-list --count "$HEAD_C..$UPSTREAM" | tr -d " " | xargs -I{} echo __BEHIND__ {}',
  '  git rev-list --count "$UPSTREAM..$HEAD_C" | tr -d " " | xargs -I{} echo __AHEAD__ {}',
  '  git merge-base --is-ancestor "$UPSTREAM" "$HEAD_C" 2>/dev/null || echo __DIVERGED__',
  'fi',
].join('\n')

export function parseGitPrecheck(stdout: string): GitPrecheckResult {
  const r: GitPrecheckResult = {
    ok: false,
    isRepo: false,
    isEmptyDir: false,
    dirty: false,
    dirtyFiles: [],
    currentBranch: '',
    remoteUrl: null,
    localOnlyCommits: [],
    headCommit: null,
    behind: 0,
    failure: null,
  }
  if (stdout.includes('__NOT_DIR__')) {
    r.failure = 'code directory does not exist'
    return r
  }
  if (stdout.includes('__EMPTY_DIR__')) {
    r.isEmptyDir = true
    r.ok = true
    return r
  }
  if (stdout.includes('__NOT_REPO__')) {
    r.failure = 'directory exists but is not a git repository'
    return r
  }
  r.isRepo = true
  r.currentBranch = /__BRANCH__ (.+)/.exec(stdout)?.[1]?.trim() ?? ''
  r.headCommit = /__HEAD__ ([0-9a-f]+)/.exec(stdout)?.[1]?.trim() ?? null
  r.remoteUrl = /__REMOTE__ (.+)/.exec(stdout)?.[1]?.trim() || null
  if (stdout.includes('__DIRTY__')) {
    r.dirty = true
    r.dirtyFiles = stdout
      .split('\n')
      .filter((l) => /^(M|A|D|R|U|AM|MM|[MADRU?]{1,2}) /.test(l.trim()))
      .slice(0, 20)
    r.failure = 'working directory has uncommitted changes'
    return r
  }
  if (stdout.includes('__FETCH_FAILED__')) {
    r.failure = 'git fetch failed (credentials or network)'
    return r
  }
  r.behind = Number(/__BEHIND__ (\d+)/.exec(stdout)?.[1] ?? 0)
  const ahead = Number(/__AHEAD__ (\d+)/.exec(stdout)?.[1] ?? 0)
  const diverged = stdout.includes('__DIVERGED__')
  if (ahead > 0) r.localOnlyCommits = Array.from({ length: Math.min(ahead, 10) }, (_, i) => `local-${i + 1}`)
  if (ahead > 0 || diverged) {
    r.failure = ahead > 0 && diverged ? 'branch has diverged from origin' : ahead > 0 ? `branch has ${ahead} local-only commit(s)` : 'branch diverged from origin'
    return r
  }
  r.ok = true
  return r
}

export function buildPullCommand(branch: string): string {
  // explicit ff-only: never merge/rebase; the commit is frozen right after
  return `git fetch origin ${branch} && git checkout ${branch} 2>/dev/null; git pull --ff-only origin ${branch} && echo __PULLED__ $(git rev-parse HEAD)`
}

export function parsePullResult(stdout: string): { ok: boolean; headCommit: string | null; failure: string | null } {
  const m = /__PULLED__ ([0-9a-f]+)/.exec(stdout)
  if (m) return { ok: true, headCommit: m[1]!.trim(), failure: null }
  if (/not possible to fast-forward|divergent|aborting/i.test(stdout)) {
    return { ok: false, headCommit: null, failure: 'pull is not a fast-forward; branch diverged' }
  }
  return { ok: false, headCommit: null, failure: stdout.trim().split('\n').at(-1) || 'pull failed' }
}

/** Health check payload: process + ports verified in the TARGET context. */
export function renderHealthCheckScript(input: {
  processPattern: string
  ports: number[]
  httpUrls: string[]
  startWaitSeconds: number
  observeSeconds: number
}): string {
  const lines: string[] = ['#!/bin/sh', '# dsh-devops health check (runs on the TARGET server)', 'set -u', `PATTERN=${shq(input.processPattern)}`, '']
  lines.push('check_process() {')
  lines.push('  ps -eo pid=,lstart=,args= | grep -F -- "$PATTERN" | grep -v grep >/dev/null 2>&1')
  lines.push('}')
  lines.push('check_port() {')
  lines.push('  PORT=$1')
  lines.push('  if command -v nc >/dev/null 2>&1; then nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; return $?; fi')
  lines.push('  if command -v curl >/dev/null 2>&1; then curl -s -o /dev/null "http://127.0.0.1:$PORT/" >/dev/null 2>&1; return 0; fi')
  lines.push('  return 0 # no probe tool: port check unavailable, not failed')
  lines.push('}')
  lines.push(`WAIT=${Math.min(input.startWaitSeconds, 300)}`)
  lines.push(`OBSERVE=${Math.min(input.observeSeconds, 120)}`)
  lines.push('i=0')
  lines.push('while [ $i -lt $WAIT ]; do')
  lines.push('  if check_process; then break; fi')
  lines.push('  sleep 1; i=$((i+1))')
  lines.push('done')
  lines.push('if ! check_process; then echo __HEALTH__ process-missing; exit 1; fi')
  lines.push('echo __HEALTH__ process-found $(ps -eo pid=,lstart=,args= | grep -F -- "$PATTERN" | grep -v grep | head -1)')
  for (const port of input.ports) {
    lines.push(`if ! check_port ${port}; then echo __HEALTH__ port-${port}-closed; exit 1; fi`)
    lines.push(`echo __HEALTH__ port-${port}-open`)
  }
  for (const url of input.httpUrls) {
    lines.push(`if command -v curl >/dev/null 2>&1; then if ! curl -sf -o /dev/null ${shq(url)}; then echo __HEALTH__ http-failed ${shq(url)}; exit 1; fi; echo __HEALTH__ http-ok ${shq(url)}; fi`)
  }
  lines.push(`sleep $OBSERVE`)
  lines.push('if ! check_process; then echo __HEALTH__ process-exited-during-observe; exit 1; fi')
  lines.push('echo __HEALTH__ ok')
  lines.push('exit 0')
  return lines.join('\n') + '\n'
}

export function parseHealthOutput(stdout: string): { ok: boolean; facts: string[] } {
  const facts = stdout.split('\n').filter((l) => l.startsWith('__HEALTH__')).map((l) => l.trim())
  const ok = facts.some((f) => f === '__HEALTH__ ok')
  return { ok, facts }
}

export function serviceConfigHash(services: Array<{ name: string; manager: string; managerId: string }>): string {
  return sha256(JSON.stringify(services))
}

function shq(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`
}

export function assertFrozenCommit(currentHead: string | null, frozenCommit: string): void {
  if (currentHead !== frozenCommit) {
    throw err('conflict', 'deployment', `HEAD ${currentHead ?? 'null'} no longer matches frozen target ${frozenCommit}`)
  }
}
