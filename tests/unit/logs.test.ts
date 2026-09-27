import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryStorage } from '../../src/host/adapters/memory.ts'
import { OpsRepository } from '../../src/host/repository/ops-repository.ts'
import {
  parseSupervisorConfig,
  resolveSupervisorCandidates,
  validateCandidate,
  toLogSource,
  boundedSearchPaths,
} from '../../src/host/logs/discovery.ts'
import { LogService, discoveryExcerpt } from '../../src/host/logs/log-service.ts'
import type { SshTransport, AgentBridge, ClockPort, RemoteFileInfo, StructuredAgentResult } from '../../src/host/adapters/ports.ts'
import type { LogSource } from '../../src/contracts/entities.ts'
import { SCHEMA_VERSION } from '../../src/contracts/entities.ts'

function fixedClock(): ClockPort {
  let t = 1000
  return { now: () => (t += 10) }
}

async function freshRepo(): Promise<OpsRepository> {
  const storage = new MemoryStorage()
  return new OpsRepository({ domain: await storage.openDomain('dsh-devops'), clock: fixedClock(), controllerId: 'c' })
}

const SUPERVISOR_CONF = `
[program:webapp]
directory=/srv/app
command=/srv/app/venv/bin/gunicorn app:app
stdout_logfile=/var/log/webapp/out.log
stderr_logfile=/var/log/webapp/err.log

[program:worker]
command=/srv/app/worker
stdout_logfile=/var/log/webapp/worker.log
redirect_stderr=true

[program:silent]
command=/srv/app/silent
stdout_logfile=NONE

[program:auto]
command=/srv/app/auto
stdout_logfile=AUTO

[include]
files=/etc/supervisor/conf.d/*.conf
`

describe('supervisor discovery (S6)', () => {
  it('parses programs, per-stream paths, redirect and include', () => {
    const parsed = parseSupervisorConfig(SUPERVISOR_CONF, '/etc/supervisord.conf')
    expect(parsed.programs.map((p) => p.name)).toEqual(['webapp', 'worker', 'silent', 'auto'])
    expect(parsed.programs[0]!.stdout).toBe('/var/log/webapp/out.log')
    expect(parsed.programs[0]!.stderr).toBe('/var/log/webapp/err.log')
    expect(parsed.programs[1]!.redirect).toBe(true)
    expect(parsed.includes).toEqual(['/etc/supervisor/conf.d/*.conf'])
  })

  it('resolves merged/none/AUTO into distinct candidate statuses (no faked files)', () => {
    const parsed = parseSupervisorConfig(SUPERVISOR_CONF, '/etc/supervisord.conf')
    const cands = resolveSupervisorCandidates(parsed, '/etc/supervisord.conf')
    const web = cands.filter((c) => c.service === 'webapp')
    expect(web.map((c) => c.status)).toEqual(['file', 'file'])
    const worker = cands.find((c) => c.service === 'worker')!
    expect(worker.status).toBe('merged')
    expect(worker.path).toBe('/var/log/webapp/worker.log')
    const silent = cands.find((c) => c.service === 'silent')!
    expect(silent.status).toBe('none')
    const auto = cands.find((c) => c.service === 'auto')!
    expect(auto.status).toBe('none')
  })

  it('validates candidates against the real filesystem: missing and devices are explicit', async () => {
    const stat = async (path: string): Promise<{ size: number; identity: string } | null> =>
      path === '/var/log/webapp/out.log' ? { size: 1234, identity: '1:99' } : null
    const missing = await validateCandidate({ service: 'x', path: '/var/log/gone.log', origin: 'o' }, { stat })
    expect(missing.status).toBe('missing')
    const dev = await validateCandidate({ service: 'x', path: '/dev/null', origin: 'o' }, { stat })
    expect(dev.status).toBe('unsupported')
    const active = await validateCandidate({ service: 'x', path: '/var/log/webapp/out.log', origin: 'o' }, { stat })
    expect(active.status).toBe('active')
    expect(active.fileIdentity).toBe('1:99')
  })

  it('bounded search only looks at configured entry points', () => {
    const paths = boundedSearchPaths('/srv/app')
    expect(paths).toContain('/etc/supervisor/conf.d')
    expect(paths.every((p) => p.startsWith('/srv/app') || p.startsWith('/etc/supervisor'))).toBe(true)
  })
})

// ---------- incremental reading + AI analysis ----------

class FakeLogTransport implements Partial<SshTransport> {
  files = new Map<string, { content: string; identity: string }>()
  truncates = new Set<string>()

  async stat(serverId: string, path: string): Promise<RemoteFileInfo | null> {
    const f = this.files.get(path)
    if (!f) return null
    return { path, size: f.content.length, mtimeMs: 0, identity: f.identity }
  }

  async readFileRange(serverId: string, path: string, offset: number, maxBytes: number): Promise<{ data: string; eof: boolean; fileSize: number; identity: string }> {
    const f = this.files.get(path)
    if (!f) return { data: '', eof: true, fileSize: 0, identity: 'missing' }
    const data = f.content.slice(offset, offset + maxBytes)
    return { data, eof: offset + data.length >= f.content.length, fileSize: f.content.length, identity: f.identity }
  }
}

class FakeLogAgent implements AgentBridge {
  failFirst = false
  attempts = 0
  lastTask = ''
  fragmentIds: string[] = []
  async run(spec: { task: string }, validate: (payload: unknown) => { ok: true; value: unknown } | { ok: false; error: string }): Promise<StructuredAgentResult> {
    this.attempts++
    this.lastTask = spec.task
    if (this.failFirst && this.attempts === 1) {
      return { ok: false, payload: null, rawText: 'boom', requestCount: 1, error: 'model exploded' }
    }
    // one anomaly with a verbatim excerpt from the fragment
    const excerpt = 'ERROR OOM at startup'
    const fragmentId = this.fragmentIds.shift() ?? (spec as unknown as { sessionId: string }).sessionId.split(':').pop() ?? ''
    const verdict = validate(JSON.stringify({
      anomalies: [{ fragmentId, severity: 'critical', summary: 'OOM detected', excerpt, suggestion: 'increase memory' }],
    }))
    if (!verdict.ok) return { ok: false, payload: null, rawText: '', requestCount: 1, error: verdict.error }
    return { ok: true, payload: verdict.value, rawText: '', requestCount: 1 }
  }
  async cancel(): Promise<void> {}
}

async function makeSource(repo: OpsRepository, over: Partial<LogSource> = {}): Promise<LogSource> {
  const source = toLogSource(
    { service: 'webapp', path: '/var/log/webapp/out.log', origin: 'supervisor:[program:webapp] stdout_logfile', status: 'active', statusReason: '', fileIdentity: null },
    { projectId: 'p1', serverId: 's1', now: 1, fingerprint: 'cfg-fp', userDefined: false },
  )
  const merged = { ...source, ...over }
  await repo.putLogSource(merged)
  return merged
}

describe('log reading + analysis (S6)', () => {
  let repo: OpsRepository
  let transport: FakeLogTransport
  let agent: FakeLogAgent
  let svc: LogService

  beforeEach(async () => {
    repo = await freshRepo()
    transport = new FakeLogTransport()
    agent = new FakeLogAgent()
    svc = new LogService({ transport: transport as unknown as SshTransport, repo, clock: fixedClock(), agentBridge: agent, modelRef: 'deepseek/chat' })
  })

  it('first read takes a bounded fragment; cursor advances; no AI → unread analysis stays pending', async () => {
    transport.files.set('/var/log/webapp/out.log', { content: 'line\n'.repeat(2000), identity: '1:10' })
    const source = await makeSource(repo)
    const { fragments } = await svc.readSource(source)
    expect(fragments).toHaveLength(1)
    expect(fragments[0]!.startOffset).toBe(0)
    expect(fragments[0]!.endOffset).toBeLessThanOrEqual(1024 * 1024)
    const updated = repo.getLogSource(source.sourceId)!
    expect(updated.readCursor).toBe(fragments[0]!.endOffset)
    // without model, fragment stays pending (retryable), NOT analyzed-complete
    const accepted = await svc.analyzePending(updated, null)
    expect(accepted.accepted).toBe(0)
    expect(accepted.failed).toBe(1)
    expect(repo.listLogFragments(source.sourceId)[0]!.analysisState).toBe('pending')
  })

  it('second read is incremental from the byte cursor', async () => {
    transport.files.set('/var/log/webapp/out.log', { content: 'a'.repeat(1000), identity: '1:10' })
    const source = await makeSource(repo)
    await svc.readSource(source)
    transport.files.set('/var/log/webapp/out.log', { content: 'a'.repeat(1000) + 'NEW-LINES', identity: '1:10' })
    const { fragments } = await svc.readSource(repo.getLogSource(source.sourceId)!)
    expect(fragments[0]!.startOffset).toBe(1000)
    expect(fragments[0]!.content).toBe('NEW-LINES')
  })

  it('rotation creates a new generation with an explicit gap', async () => {
    transport.files.set('/var/log/webapp/out.log', { content: 'x'.repeat(500), identity: '1:10' })
    const source = await makeSource(repo)
    await svc.readSource(source)
    // rotate: new identity, smaller file
    transport.files.set('/var/log/webapp/out.log', { content: 'fresh log\n', identity: '1:99' })
    const { fragments, gap } = await svc.readSource(repo.getLogSource(source.sourceId)!)
    const updated = repo.getLogSource(source.sourceId)!
    expect(updated.generation).toBe(1)
    expect(updated.readCursor).toBe(fragments[0]!.endOffset)
    expect(gap).toBeGreaterThanOrEqual(0)
    expect(fragments[0]!.gapBeforeBytes).toBeGreaterThanOrEqual(0)
  })

  it('truncation resets the cursor with a visible gap marker', async () => {
    transport.files.set('/var/log/webapp/out.log', { content: 'x'.repeat(500), identity: '1:10' })
    const source = await makeSource(repo)
    await svc.readSource(source)
    transport.files.set('/var/log/webapp/out.log', { content: 'short', identity: '1:10' })
    const { gap } = await svc.readSource(repo.getLogSource(source.sourceId)!)
    expect(gap).toBe(495)
    const updated = repo.getLogSource(source.sourceId)!
    expect(updated.truncatedAtDiscovery).toBe(true)
  })

  it('AI failure is retryable — same fragment re-analyzed, no data skipped', async () => {
    transport.files.set('/var/log/webapp/out.log', { content: 'ERROR OOM at startup\n', identity: '1:10' })
    const source = await makeSource(repo)
    const { fragments } = await svc.readSource(source)
    agent.failFirst = true
    const first = await svc.analyzePending(source, null)
    expect(first.accepted).toBe(0)
    expect(first.failed).toBe(1)
    // retry succeeds on the SAME fragment
    const second = await svc.analyzePending(repo.getLogSource(source.sourceId)!, null)
    expect(second.accepted).toBe(1)
    expect(repo.listLogFragments(source.sourceId)[0]!.analysisState).toBe('complete')
    void fragments
  })

  it('accepted reports advance analysis and create deduped alerts with counts', async () => {
    transport.files.set('/var/log/webapp/out.log', { content: 'ERROR OOM at startup\n', identity: '1:10' })
    const source = await makeSource(repo)
    await svc.readSource(source)
    await svc.analyzePending(source, null)
    // same anomaly recurs in a NEW fragment
    transport.files.set('/var/log/webapp/out.log', { content: 'ERROR OOM at startup\nERROR OOM at startup\n', identity: '1:10' })
    await svc.readSource(repo.getLogSource(source.sourceId)!)
    await svc.analyzePending(repo.getLogSource(source.sourceId)!, null)
    const alerts = repo.listAlerts({})
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.count).toBe(2)
    expect(alerts[0]!.evidenceRef).toBeTruthy()
  })

  it('excerpt fabrication is rejected: evidence must exist verbatim in the fragment', async () => {
    transport.files.set('/var/log/webapp/out.log', { content: 'all normal here\n', identity: '1:10' })
    const source = await makeSource(repo)
    await svc.readSource(source)
    agent.lastTask = ''
    // FakeLogAgent always uses the OOM excerpt, which is NOT in this fragment
    const result = await svc.analyzePending(source, null)
    expect(result.accepted).toBe(0)
    const fragment = repo.listLogFragments(source.sourceId)[0]!
    expect(fragment.analysisState).toBe('pending')
    expect(fragment.analysisError).toMatch(/excerpt not found/)
  })

  it('file deletion is explicit, never silently normal', async () => {
    const source = await makeSource(repo)
    // no file at all
    const { fragments } = await svc.readSource(source)
    expect(fragments).toHaveLength(0)
    expect(repo.getLogSource(source.sourceId)!.status).toBe('missing')
  })

  it('ignored sources are refused', async () => {
    const source = await makeSource(repo, { ignored: true })
    await expect(svc.checkSource(source, null)).rejects.toThrow(/ignored/)
  })
})

// ---------- AI-assisted log discovery (#5) ----------

class DiscoverTransport implements Partial<SshTransport> {
  files = new Map<string, string>()
  dirs = new Map<string, Array<{ name: string; isDir: boolean }>>()
  async stat(_s: string, path: string): Promise<RemoteFileInfo | null> {
    const c = this.files.get(path)
    if (c === undefined) return null
    return { path, size: c.length, mtimeMs: 0, identity: `i:${path}` }
  }
  async readFileRange(_s: string, path: string, offset: number, maxBytes: number) {
    const c = this.files.get(path) ?? ''
    const data = c.slice(offset, offset + maxBytes)
    return { data, eof: offset + data.length >= c.length, fileSize: c.length, identity: `i:${path}` }
  }
  async listDir(_s: string, dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
    return this.dirs.get(dir) ?? []
  }
  async execute(): Promise<{ exitCode: number; signal: null; stdout: string; stderr: string; connectionLost: boolean; truncated: boolean }> {
    return { exitCode: 0, signal: null, stdout: '', stderr: '', connectionLost: false, truncated: false }
  }
}

class PlanAgent implements AgentBridge {
  calls = 0
  constructor(private readonly plan: Array<{ path: string; service?: string }>) {}
  async run(_spec: { task: string }, validate: (payload: unknown) => { ok: true; value: unknown } | { ok: false; error: string }): Promise<StructuredAgentResult> {
    this.calls++
    const verdict = validate(JSON.stringify({ logs: this.plan }))
    return verdict.ok
      ? { ok: true, payload: verdict.value, rawText: '', requestCount: 1 }
      : { ok: false, payload: null, rawText: '', requestCount: 1, error: verdict.error }
  }
  async cancel(): Promise<void> {}
}

describe('AI-assisted discovery (IMPROVE #5)', () => {
  const codeDir = '/srv/app'
  function seedTransport(): DiscoverTransport {
    const t = new DiscoverTransport()
    // the project manifest is the evidence the AI reads; the log it points at exists
    t.files.set(`${codeDir}/package.json`, '{"name":"shop","scripts":{"start":"node server.js"}}')
    t.files.set(`${codeDir}/logs/app.log`, 'INFO boot\n')
    t.dirs.set(codeDir, [{ name: 'package.json', isDir: false }, { name: 'server.js', isDir: false }, { name: 'logs', isDir: true }])
    return t
  }

  it('with a model, registers the AI-proposed app log as an active source', async () => {
    const repo = await freshRepo()
    const transport = seedTransport()
    const agent = new PlanAgent([{ path: `${codeDir}/logs/app.log`, service: 'app' }])
    const svc = new LogService({ transport: transport as unknown as SshTransport, repo, clock: fixedClock(), agentBridge: agent, modelRef: 'deepseek/chat' })
    const { sources } = await svc.discoverProject({ projectId: 'p1', serverId: 's1', codeDir })
    expect(agent.calls).toBe(1)
    const ai = sources.find((s) => s.path === `${codeDir}/logs/app.log`)
    expect(ai).toBeDefined()
    expect(ai!.status).toBe('active')
    expect(ai!.configOrigin).toBe('AI 代码/配置分析')
  })

  it('a hallucinated AI path degrades to an explicit missing source, never a fake active one', async () => {
    const repo = await freshRepo()
    const transport = seedTransport()
    const agent = new PlanAgent([{ path: `${codeDir}/logs/does-not-exist.log` }])
    const svc = new LogService({ transport: transport as unknown as SshTransport, repo, clock: fixedClock(), agentBridge: agent, modelRef: 'deepseek/chat' })
    const { sources } = await svc.discoverProject({ projectId: 'p1', serverId: 's1', codeDir })
    const ghost = sources.find((s) => s.path === `${codeDir}/logs/does-not-exist.log`)
    expect(ghost?.status).toBe('missing')
  })

  it('without a model the AI step is skipped entirely (deterministic fallback, bridge never called)', async () => {
    const repo = await freshRepo()
    const transport = seedTransport()
    const agent = new PlanAgent([{ path: `${codeDir}/logs/app.log`, service: 'app' }])
    // bridge present but modelRef null → the guard fails, aiProposeLogPaths must not run
    const svc = new LogService({ transport: transport as unknown as SshTransport, repo, clock: fixedClock(), agentBridge: agent, modelRef: null })
    await svc.discoverProject({ projectId: 'p1', serverId: 's1', codeDir })
    expect(agent.calls).toBe(0)
  })
})

describe('discoveryExcerpt (AI corpus builder)', () => {
  it('passes a small file through whole', () => {
    const text = 'LOGGING = { "filename": "/srv/app/logs/a.log" }'
    expect(discoveryExcerpt(text)).toBe(text)
  })

  it('keeps a LOGGING dict that lives far below an early import logging', () => {
    // early generic 'logging' import must NOT win over the real LOGGING block
    const early = 'import logging\nlogger = logging.getLogger(__name__)\n'.padEnd(9000, 'x')
    const tail = 'LOGGING = {\n  "handlers": {"file": {"class": "logging.FileHandler", "filename": BASE_DIR / "logs" / "app.log"}},\n}'
    const out = discoveryExcerpt(early + tail)
    expect(out.length).toBeLessThanOrEqual(6500)
    expect(out).toContain('LOGGING =')
    expect(out).toContain('app.log')
  })

  it('falls back to the head when no logging-config keyword is present', () => {
    const text = 'a'.repeat(10000)
    const out = discoveryExcerpt(text)
    expect(out).toBe('a'.repeat(2500))
  })
})
