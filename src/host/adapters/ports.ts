/**
 * Ports: the seams business modules depend on. Real DSH adapters (src/host/adapters/dsh)
 * and test fakes implement the same interfaces. Business code never imports host SDKs.
 */

// ---------- KV domain (mirrors dsh-storage-domain table semantics) ----------

export interface KvTable<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  keys(): IterableIterator<string>
  readonly size: number
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
  update(key: string, fn: (current: V) => V): Promise<V>
}

export interface KvDomain {
  table<V = unknown>(name: string): KvTable<V>
  close(): Promise<void>
}

export interface StoragePort {
  openDomain(name: string): Promise<KvDomain>
}

// ---------- Clock ----------

export interface ClockPort {
  now(): number
}

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now()
  }
}

export class ManualClock implements ClockPort {
  current: number
  private timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  constructor(start = 1_700_000_000_000) {
    this.current = start
  }
  now(): number {
    return this.current
  }
  advance(ms: number): void {
    const target = this.current + ms
    // fire timers in order
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.current = Math.max(this.current, due.at)
      due.fn()
      due.cancelled = true
    }
    this.current = target
  }
  setTimeout(fn: () => void, ms: number): () => void {
    const timer = { at: this.current + ms, fn, cancelled: false }
    this.timers.push(timer)
    return () => {
      timer.cancelled = true
    }
  }
}

/** Minimal timeout seam so modules stay testable without real timers. */
export interface TimerPort {
  setTimeout(fn: () => void, ms: number): () => void
}

export const systemTimers: TimerPort = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
}

// ---------- Effect ownership (cordis ctx.effect equivalent) ----------

export type Disposer = () => void | Promise<void>

export interface EffectOwner {
  /** Register a resource whose cleanup runs when the plugin unloads. */
  effect(setup: () => Disposer | void): void
}

export class FakeEffectOwner implements EffectOwner {
  private disposers: Disposer[] = []
  private disposed = false
  effect(setup: () => Disposer | void): void {
    if (this.disposed) throw new Error('effect owner already disposed')
    const d = setup()
    if (d) this.disposers.push(d)
  }
  async dispose(): Promise<void> {
    this.disposed = true
    // cordis semantics: reverse order; async disposers run concurrently — here serial is fine
    for (const d of this.disposers.reverse()) await d()
    this.disposers = []
  }
}

// ---------- SSH ----------

/** One remote command execution, identity-bound. */
export interface RemoteCommandRequest {
  serverId: string
  /** execution identity: repeat with same identity returns the original task */
  runId: string
  stepId: string
  attemptId: string
  command: string
  stdin?: string
  timeoutMs?: number
}

export interface RemoteCommandResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** transport died before outcome was confirmed */
  connectionLost: boolean
  truncated: boolean
}

export interface RemoteFileInfo {
  path: string
  size: number
  mtimeMs: number
  /** dev:inode or platform-stable identity */
  identity: string
}

export interface SshTransport {
  /** real login check; returns host key fingerprint; throws OpsError on failure */
  verify(opts: VerifyOptions): Promise<VerifyResult>
  /** read-only system probe (platform, kernel, tools) */
  probe(serverId: string): Promise<ProbeResult>
  /** identity-bound command execution */
  execute(req: RemoteCommandRequest): Promise<RemoteCommandResult>
  /** read a byte range of a remote file */
  readFileRange(serverId: string, path: string, offset: number, maxBytes: number): Promise<{ data: string; eof: boolean; fileSize: number; identity: string }>
  /** stat a remote file */
  stat(serverId: string, path: string): Promise<RemoteFileInfo | null>
  /** list directory entries (bounded) */
  listDir(serverId: string, path: string, limit: number): Promise<Array<{ name: string; isDir: boolean }>>
  /** write a file to the remote task dir (atomic via temp+rename) */
  writeFile(serverId: string, path: string, content: string): Promise<void>
  /**
   * Persist the private config, pinned host key and (optional) identity key
   * for a saved server so later auto-logins use exactly the verified bytes.
   */
  materializeServer?(
    serverId: string,
    server: {
      sshOptions: {
        host: string
        port: number
        user: string
        authKind: 'password' | 'privatekey' | 'privatekey-passphrase'
        jumpHosts: Array<{ host: string; port: number; user: string; credentialRef: string }>
        extraOptions: Record<string, string>
      }
    },
    hostKeyEntry: string,
    identityPem?: string | null,
  ): void
  /** request a controlled stop of an executing unit */
  requestStop(serverId: string, runId: string, stepId: string, attemptId: string): Promise<void>
  /** query a previously started unit's status WITHOUT side effects (reconcile) */
  inspect(serverId: string, runId: string, stepId: string, attemptId: string): Promise<RemoteCommandResult | null>
}

export interface VerifyOptions {
  host: string
  port: number
  user: string
  authKind: 'password' | 'privatekey' | 'privatekey-passphrase'
  secret: string
  jumpHosts?: Array<{ host: string; port: number; user: string; secret?: string }>
  /** expected fingerprint; mismatch throws host-fingerprint-changed */
  expectedFingerprint?: string
  /** accept and return the new fingerprint (first connect) */
  acceptUnknownFingerprint?: boolean
  timeoutMs?: number
}

export interface VerifyResult {
  fingerprint: string
  /** raw known_hosts line captured during the verified login */
  hostKeyEntry: string
  platform: 'linux' | 'macos' | 'unknown'
  osRelease: string
  arch: string
  shell: string
}

export interface ProbeResult {
  platform: 'linux' | 'macos' | 'unknown'
  osRelease: string
  arch: string
  shell: string
  tools: Record<string, 'available' | 'unavailable'>
}

// ---------- Agent bridge ----------

export interface AgentSessionSpec {
  /** stable session identity for the exclusive agent */
  sessionId: string
  model?: string
  /** max model requests for one task */
  maxRequests?: number
  /** task prompt */
  task: string
  /** only these named tools are available (whitelist, read-only for inspection) */
  toolNames: readonly string[]
  /** overall time budget */
  timeoutMs?: number
}

export interface StructuredAgentResult {
  ok: boolean
  /** validated JSON payload produced by the agent */
  payload: unknown
  rawText: string
  requestCount: number
  error?: string
}

export interface AgentBridge {
  /** create an exclusive scoped agent, submit the task, await structured output */
  run(spec: AgentSessionSpec, validate: (payload: unknown) => { ok: true; value: unknown } | { ok: false; error: string }): Promise<StructuredAgentResult>
  cancel(sessionId: string): Promise<void>
}

// ---------- Vault key provider ----------

export interface KeyProvider {
  /** current key material for encryption/decryption + its version */
  current(): Promise<{ version: number; key: Buffer }>
  /** fetch a specific version (for decryption of old records) */
  version(v: number): Promise<Buffer>
}

// ---------- Model availability ----------

export interface ModelPort {
  /** resolved model id for a ref, or null when not configured */
  resolve(modelRef: string | null): Promise<string | null>
}

// ---------- Process/exec primitives used by OpenSSH transport ----------

export interface SpawnResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
}

export interface SpawnPort {
  /** argv spawn without shell; env is fully controlled */
  spawn(argv: readonly string[], opts: { timeoutMs?: number; input?: string; env?: Record<string, string> }): Promise<SpawnResult>
}
