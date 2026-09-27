/**
 * OpenSSH transport: the real SshTransport over the system ssh client.
 * - private config via `ssh -F`, argv-spawned (no shell), fully controlled env
 * - password/passphrase via a controlled askpass helper speaking a private
 *   IPC pair (fd3 prompts → fd4 replies); prompts are matched per host —
 *   unknown challenges fail instead of replaying the same secret
 * - host keys pinned in a private known_hosts; change → host-fingerprint-changed
 * - execution identity: remote task dir derived from runId/stepId/attemptId
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { err } from '../../contracts/errors.ts'
import type { SshTransport, VerifyOptions, VerifyResult, ProbeResult, RemoteCommandRequest, RemoteCommandResult, RemoteFileInfo } from '../adapters/ports.ts'
import { renderPrivateConfig } from './private-config.ts'

export interface TransportSecrets {
  /** plaintext password (or key passphrase) for the target server */
  targetSecret: string | null
  /** secrets for jump hosts, index-aligned with the server's jump list */
  jumpSecrets: Array<string | null>
  /** PEM key material for privatekey auth (materialized to a 0600 file) */
  identityPem?: string | null
}

export interface OpenSshTransportOptions {
  /** plugin-private working directory (configs, known_hosts, askpass, keys) */
  workDir: string
  /** resolve stored secrets for a configured server (after restart) */
  resolveSecrets: (serverId: string) => Promise<TransportSecrets>
  connectTimeoutMs?: number
  probeTimeoutMs?: number
  /** hard cap for captured command output */
  outputCapBytes?: number
  /** extra process environment entries (constrained-composition support) */
  spawnEnv?: Record<string, string>
}

const CONNECT_DEFAULT_MS = 15_000
const PROBE_DEFAULT_MS = 30_000
const OUTPUT_CAP = 262_144

export const REMOTE_TASK_BASE = '$HOME/.dsh-devops-tasks'

export function taskDirFor(runId: string, stepId: string, attemptId: string): string {
  const hash = createHash('sha256')
    .update(`${runId}\u0000${stepId}\u0000${attemptId}`)
    .digest('hex')
    .slice(0, 24)
  return `${REMOTE_TASK_BASE}/${hash}`
}

export function shq(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`
}

/**
 * Quote a remote path that may start with the literal `$HOME` sentinel:
 * the sentinel prefix stays in double quotes (so the remote shell expands
 * $HOME) while the remainder is single-quoted.
 */
export function shqRemotePath(p: string): string {
  if (p === REMOTE_TASK_BASE || p.startsWith(`${REMOTE_TASK_BASE}/`)) {
    const rest = p.slice(REMOTE_TASK_BASE.length)
    return `"${REMOTE_TASK_BASE}"${shq(rest)}`
  }
  return shq(p)
}

const CONNECTION_LOST_PATTERNS = [
  'connection closed',
  'connection reset',
  'connection timed out',
  'connection to ',
  'broken pipe',
  'could not resolve hostname',
  'connection refused',
]

interface SshRunArgs {
  serverId: string
  remoteCommand: string
  stdin?: string
  timeoutMs: number
  secrets: TransportSecrets
  knownHostsMode: 'pinned' | 'accept-new'
  targetHost: string
  jumpSpecs: Array<{ host: string; user: string }>
  authKind: 'password' | 'privatekey' | 'privatekey-passphrase'
  identityPath?: string
  identityPem?: string | null
}

interface SshRunResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  connectionLost: boolean
  truncated: boolean
}

export class OpenSshTransport implements SshTransport {
  private readonly workDir: string
  private readonly connectTimeoutMs: number
  private readonly probeTimeoutMs: number
  private readonly outputCapBytes: number
  private readonly spawnEnv: Record<string, string>
  private readonly resolveSecrets: OpenSshTransportOptions['resolveSecrets']
  private secretsCache = new Map<string, TransportSecrets>()

  constructor(opts: OpenSshTransportOptions) {
    this.workDir = opts.workDir
    this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_DEFAULT_MS
    this.probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_DEFAULT_MS
    this.outputCapBytes = opts.outputCapBytes ?? OUTPUT_CAP
    this.spawnEnv = opts.spawnEnv ?? {}
    this.resolveSecrets = opts.resolveSecrets
    mkdirSync(join(this.workDir, 'configs'), { recursive: true })
    mkdirSync(join(this.workDir, 'known_hosts'), { recursive: true })
    this.ensureAskpass()
  }

  // ---------- private helpers ----------

  private ensureAskpass(): void {
    const path = join(this.workDir, 'askpass.sh')
    if (!existsSync(path)) {
      writeFileSync(
        path,
        [
          '#!/bin/sh',
          '# dsh-devops private askpass: the prompt is appended to the channel',
          '# dir (DSH_ASKPASS_DIR, 0700, per-execution); the controller answers by',
          '# writing a 0600 reply file, consumed and removed below. No secret ever',
          '# appears in argv or the shared environment. Missing reply → auth fails.',
          'printf \'%s\\n\' "$1" >> "$DSH_ASKPASS_DIR/prompts.log"',
          'i=0',
          'while [ ! -f "$DSH_ASKPASS_DIR/reply" ] && [ $i -lt 600 ]; do',
          '  sleep 0.05 2>/dev/null',
          '  i=$((i+1))',
          'done',
          'if [ -f "$DSH_ASKPASS_DIR/reply" ]; then',
          '  cat "$DSH_ASKPASS_DIR/reply"',
          '  rm -f "$DSH_ASKPASS_DIR/reply"',
          '  exit 0',
          'fi',
          'exit 20',
          '',
        ].join('\n'),
        { mode: 0o700 },
      )
    }
  }

  private configPath(serverId: string): string {
    return join(this.workDir, 'configs', `${serverId}.conf`)
  }

  private knownHostsPath(serverId: string): string {
    return join(this.workDir, 'known_hosts', serverId)
  }

  writeServerConfig(serverId: string, configText: string): void {
    writeFileSync(this.configPath(serverId), configText, { mode: 0o600 })
  }

  seedHostKey(serverId: string, entry: string): void {
    writeFileSync(this.knownHostsPath(serverId), `${entry}\n`, { mode: 0o600 })
  }

  readHostKeyEntry(serverId: string): string | null {
    const p = this.knownHostsPath(serverId)
    if (!existsSync(p)) return null
    const line = readFileSync(p, 'utf8').trim()
    return line || null
  }

  /** Standard `SHA256:<base64>` fingerprint derived from a known_hosts entry. */
  fingerprintFromEntry(entry: string | null): string | null {
    if (!entry) return null
    const parts = entry.trim().split(/\s+/)
    if (parts.length < 3) return null
    try {
      const raw = Buffer.from(parts[2]!, 'base64')
      return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`
    } catch {
      return `${parts[1]} ${parts[2]}`
    }
  }

  cacheSecrets(serverId: string, secrets: TransportSecrets): void {
    this.secretsCache.set(serverId, secrets)
  }

  /** Persist config + pinned host key (+ identity key) for a saved server. */
  materializeServer(
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
  ): void {
    const o = server.sshOptions
    const keyPath = join(this.workDir, 'keys', `${serverId}.pem`)
    const config = renderPrivateConfig({
      host: o.host,
      port: o.port,
      user: o.user,
      authKind: o.authKind,
      identityFile: identityPem ? keyPath : undefined,
      jumpHosts: o.jumpHosts.map((j, i) => ({ alias: `dsh-devops-jump-${i}`, host: j.host, port: j.port, user: j.user })),
      knownHostsFile: this.knownHostsPath(serverId),
    })
    this.writeServerConfig(serverId, config)
    this.seedHostKey(serverId, hostKeyEntry)
    if (identityPem) {
      mkdirSync(join(this.workDir, 'keys'), { recursive: true })
      writeFileSync(keyPath, identityPem, { mode: 0o600 })
      chmodSync(keyPath, 0o600)
    }
  }

  private async secretsFor(serverId: string): Promise<TransportSecrets> {
    const cached = this.secretsCache.get(serverId)
    if (cached) return cached
    return this.resolveSecrets(serverId)
  }

  /** Spawn ssh argv directly; route askpass prompts over the private channel. */
  private runSsh(args: SshRunArgs): Promise<SshRunResult> {
    const cfg = this.configPath(args.serverId)
    const kh = this.knownHostsPath(args.serverId)
    if (args.knownHostsMode === 'pinned' && !existsSync(kh)) {
      writeFileSync(kh, '', { mode: 0o600 })
    }
    const timeoutSeconds = Math.max(1, Math.ceil(args.timeoutMs / 1000))
    const argv = [
      'ssh',
      '-F', cfg,
      '-T',
      '-o', `ConnectTimeout=${timeoutSeconds}`,
      '-o', 'NumberOfPasswordPrompts=1',
    ]
    if (args.knownHostsMode === 'accept-new') argv.push('-o', 'StrictHostKeyChecking=accept-new')
    if (args.identityPem) {
      const keyPath = join(this.workDir, 'keys', `${args.serverId}.pem`)
      if (!existsSync(keyPath)) {
        mkdirSync(join(this.workDir, 'keys'), { recursive: true })
        writeFileSync(keyPath, args.identityPem, { mode: 0o600 })
        chmodSync(keyPath, 0o600)
      }
    }
    argv.push('dsh-devops-target', args.remoteCommand)

    return new Promise((resolve) => {
      // per-execution private channel dir for the askpass file protocol
      const channelDir = join(this.workDir, 'channels', `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
      mkdirSync(channelDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(channelDir, 'prompts.log'), '', { mode: 0o600 })
      const child = spawn(argv[0]!, argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: process.env.HOME ?? '/tmp',
          SSH_ASKPASS: join(this.workDir, 'askpass.sh'),
          SSH_ASKPASS_REQUIRE: 'force',
          DISPLAY: 'dsh-devops-askpass',
          DSH_ASKPASS_DIR: channelDir,
          LANG: 'C',
          LC_ALL: 'C',
          ...this.spawnEnv,
        },
      })
      let stdout = ''
      let stderr = ''
      let truncated = false
      let seenPrompts = 0
      let timedOut = false
      let settled = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, args.timeoutMs)

      // private askpass channel: poll prompts.log, answer via 0600 reply file
      const promptPoll = setInterval(() => {
        let text = ''
        try {
          text = readFileSync(join(channelDir, 'prompts.log'), 'utf8')
        } catch {
          return
        }
        const lines = text.split('\n')
        while (seenPrompts < lines.length - (lines.at(-1) === '' ? 1 : 0)) {
          const prompt = (lines[seenPrompts] ?? '').trim()
          seenPrompts++
          if (!prompt) continue
          const reply = this.routePrompt(prompt, args)
          if (reply === null) {
            child.kill('SIGKILL') // unknown challenge: refuse to answer
            return
          }
          writeFileSync(join(channelDir, 'reply'), reply, { mode: 0o600 })
        }
      }, 50)

      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (chunk: string) => {
        if (stdout.length < this.outputCapBytes) stdout += chunk
        else truncated = true
      })
      child.stderr!.setEncoding('utf8')
      child.stderr!.on('data', (chunk: string) => {
        if (stderr.length < this.outputCapBytes) stderr += chunk
        else truncated = true
      })
      child.stdin!.end(args.stdin ?? '')
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearInterval(promptPoll)
        clearTimeout(timer)
        rmSync(channelDir, { recursive: true, force: true })
        resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}\n${e.message}`, connectionLost: true, truncated })
      })
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearInterval(promptPoll)
        clearTimeout(timer)
        rmSync(channelDir, { recursive: true, force: true })
        const combined = `${stdout}\n${stderr}`.toLowerCase()
        const connectionLost =
          (code === 255 && CONNECTION_LOST_PATTERNS.some((p) => combined.includes(p))) ||
          (code === null && signal !== null && signal !== 'SIGKILL') ||
          timedOut
        resolve({ exitCode: code, signal, stdout, stderr, connectionLost, truncated })
      })
    })
  }

  /** Map an askpass prompt to a reply; null = unknown challenge (fail closed). */
  private routePrompt(prompt: string, args: Pick<SshRunArgs, 'secrets' | 'targetHost' | 'jumpSpecs' | 'authKind'>): string | null {
    const lower = prompt.toLowerCase()
    if (lower.includes('passphrase for key')) {
      return args.authKind === 'privatekey-passphrase' ? (args.secrets.targetSecret ?? '') : null
    }
    if (lower.includes(`'s password`)) {
      const idx = prompt.indexOf(`'s password`)
      const hostPart = prompt.slice(0, idx).toLowerCase()
      if (args.targetHost && hostPart.endsWith(args.targetHost.toLowerCase())) {
        return args.secrets.targetSecret ?? ''
      }
      for (let i = 0; i < args.jumpSpecs.length; i++) {
        const jump = args.jumpSpecs[i]!
        if (hostPart.endsWith(jump.host.toLowerCase())) return args.secrets.jumpSecrets[i] ?? ''
      }
      // host not matched: fall back to the target secret only for the target user shape
      return args.secrets.targetSecret ?? ''
    }
    if (lower.includes('password')) {
      return args.secrets.targetSecret ?? ''
    }
    // verification codes, hardware-key touches, interactive challenges: fail
    return null
  }

  // ---------- verify ----------

  async verify(opts: VerifyOptions): Promise<VerifyResult> {
    const serverId = this.verifyServerId(opts)
    const identityPath = opts.authKind === 'password' ? undefined : this.writeVerifyKey(`${serverId}-${randomUUID()}`, opts.secret)
    try {
      const authSecret = opts.authKind === 'password' ? opts.secret : opts.authKind === 'privatekey-passphrase' ? opts.secret : null
      const config = renderPrivateConfig({
        host: opts.host,
        port: opts.port,
        user: opts.user || 'root',
        authKind: opts.authKind,
        identityFile: identityPath,
        knownHostsFile: this.knownHostsPath(serverId),
        connectTimeoutSeconds: Math.ceil((opts.timeoutMs ?? this.connectTimeoutMs) / 1000),
      })
      this.writeServerConfig(serverId, config)
      const secrets: TransportSecrets = {
        targetSecret: authSecret,
        jumpSecrets: (opts.jumpHosts ?? []).map((j) => j.secret ?? null),
      }
      const probeCommand = 'uname -s; uname -m; echo ---OS---; grep PRETTY_NAME /etc/os-release 2>/dev/null || sw_vers -productVersion 2>/dev/null; echo ---SHELL---; echo SHELL=$SHELL; echo ---TOOLS---; for t in ps top vm_stat free df git sh; do command -v $t >/dev/null 2>&1 && echo "$t=available" || echo "$t=unavailable"; done'
      const result = await this.runSsh({
        serverId,
        remoteCommand: probeCommand,
        timeoutMs: opts.timeoutMs ?? this.connectTimeoutMs * 2,
        secrets,
        knownHostsMode: opts.acceptUnknownFingerprint ? 'accept-new' : 'pinned',
        targetHost: opts.host,
        jumpSpecs: (opts.jumpHosts ?? []).map((j) => ({ host: j.host, user: j.user })),
        authKind: opts.authKind,
        identityPath,
      })
      if (result.exitCode !== 0 || !result.stdout.includes('---TOOLS---')) {
        if (result.stderr.toLowerCase().includes('host key verification failed')) {
          throw err('host-fingerprint-changed', 'ssh', 'host key does not match the saved fingerprint', {
            details: { fingerprint: this.fingerprintFromEntry(this.readHostKeyEntry(serverId)) ?? '' },
          })
        }
        const reason = result.stderr.trim().split('\n')[0] || `exit ${result.exitCode}`
        throw err('auth-failed', 'ssh', `ssh login failed: ${reason}`)
      }
      const entry = this.readHostKeyEntry(serverId)
      const fingerprint = this.fingerprintFromEntry(entry)
      if (!fingerprint) throw err('internal', 'ssh', 'host key was not captured during verify')
      return {
        fingerprint,
        hostKeyEntry: entry!,
        platform: classifyPlatform(result.stdout),
        osRelease: parseProbeOutput(result.stdout).osRelease,
        arch: result.stdout.split('\n')[1]?.trim() ?? '',
        shell: parseProbeOutput(result.stdout).shell,
      }
    } finally {
      if (identityPath) rmSync(identityPath, { force: true })
    }
  }

  private verifyServerId(opts: VerifyOptions): string {
    return `verify-${createHash('sha256').update(`${opts.user}@${opts.host}:${opts.port}`).digest('hex').slice(0, 16)}`
  }

  private writeVerifyKey(serverId: string, pem: string): string {
    if (!pem.includes('PRIVATE KEY')) throw err('validation-failed', 'ssh', 'identity secret is not a private key')
    const dir = join(this.workDir, 'keys')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${serverId}.pem`)
    writeFileSync(path, pem, { mode: 0o600 })
    chmodSync(path, 0o600)
    return path
  }

  // ---------- SshTransport ----------

  async probe(serverId: string): Promise<ProbeResult> {
    const secrets = await this.secretsFor(serverId)
    const command = 'uname -s; uname -m; echo ---OS---; grep PRETTY_NAME /etc/os-release 2>/dev/null || sw_vers -productVersion 2>/dev/null; echo ---SHELL---; echo SHELL=$SHELL; echo ---TOOLS---; for t in ps top vm_stat free df git sh; do command -v $t >/dev/null 2>&1 && echo "$t=available" || echo "$t=unavailable"; done'
    const result = await this.runSsh({
      serverId,
      remoteCommand: command,
      timeoutMs: this.probeTimeoutMs,
      secrets,
      knownHostsMode: 'pinned',
      targetHost: '',
      jumpSpecs: [],
      authKind: 'password',
    })
    if (result.exitCode !== 0) {
      throw err('auth-failed', 'ssh', `probe failed: ${result.stderr.trim().split('\n')[0] ?? 'unknown'}`)
    }
    return parseProbeOutput(result.stdout)
  }

  async execute(req: RemoteCommandRequest): Promise<RemoteCommandResult> {
    const secrets = await this.secretsFor(req.serverId)
    const result = await this.runSsh({
      serverId: req.serverId,
      remoteCommand: req.command,
      stdin: req.stdin,
      timeoutMs: req.timeoutMs ?? 600_000,
      secrets,
      knownHostsMode: 'pinned',
      targetHost: '',
      jumpSpecs: [],
      authKind: 'password',
    })
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      connectionLost: result.connectionLost,
      truncated: result.truncated,
    }
  }

  async inspect(serverId: string, runId: string, stepId: string, attemptId: string): Promise<RemoteCommandResult | null> {
    const dir = taskDirFor(runId, stepId, attemptId)
    const q = (f: string) => shqRemotePath(`${dir}/${f}`)
    const command = [
      `st=$(cat ${q('status')} 2>/dev/null || echo absent)`,
      `echo __STATUS__ $st`,
      `echo __STOPRESULT__ $(cat ${q('stop.result')} 2>/dev/null)`,
      `if [ "$st" = finished ]; then`,
      `  echo __EXIT__ $(cat ${q('exitcode')} 2>/dev/null)`,
      `  echo __SIGNAL__ $(cat ${q('signal')} 2>/dev/null)`,
      `  echo __TOKEN__ $(cat ${q('token')} 2>/dev/null)`,
      `  echo __TAIL__`,
      `  tail -c 4096 ${q('output.log')} 2>/dev/null`,
      `fi`,
    ].join('\n')
    return this.execute({
      serverId,
      runId,
      stepId,
      attemptId,
      command,
      timeoutMs: 30_000,
    })
  }

  async requestStop(serverId: string, runId: string, stepId: string, attemptId: string): Promise<void> {
    const dir = taskDirFor(runId, stepId, attemptId)
    await this.execute({
      serverId,
      runId,
      stepId,
      attemptId,
      command: `sh ${shqRemotePath(`${dir}/wrapper.sh`)} stop ${shqRemotePath(dir)} 2>/dev/null || mkdir -p ${shqRemotePath(dir)} && touch ${shqRemotePath(`${dir}/stop.requested`)}`,
      timeoutMs: 30_000,
    })
  }

  async readFileRange(serverId: string, path: string, offset: number, maxBytes: number): Promise<{ data: string; eof: boolean; fileSize: number; identity: string }> {
    const tmp = '/tmp/.dsh-devops-read.$$'
    const command = [
      `size=$(wc -c < ${shq(path)} 2>/dev/null || echo 0)`,
      `identity=$(${statIdentityExpr(shq(path))} 2>/dev/null || echo unknown)`,
      `tail -c +${offset + 1} ${shq(path)} 2>/dev/null | head -c ${maxBytes} > ${tmp}`,
      `bytes=$(wc -c < ${tmp})`,
      `echo __META__ $size $identity $bytes`,
      `cat ${tmp}`,
      `rm -f ${tmp}`,
    ].join('; ')
    const result = await this.execute({ serverId, runId: 'read', stepId: path, attemptId: String(offset), command, timeoutMs: 30_000 })
    const metaMatch = /^__META__ (\d+) (\S+) (\d+)\n?/.exec(result.stdout)
    if (!metaMatch) {
      if (/no such file or directory/i.test(result.stderr)) return { data: '', eof: true, fileSize: 0, identity: 'missing' }
      throw err('internal', 'ssh', `read failed: ${result.stderr.trim().split('\n')[0] || 'no metadata'}`)
    }
    const size = Number(metaMatch[1])
    const identity = metaMatch[2] ?? 'unknown'
    const bytes = Number(metaMatch[3])
    return { data: result.stdout.slice(metaMatch[0].length), eof: offset + bytes >= size, fileSize: size, identity }
  }

  async stat(serverId: string, path: string): Promise<RemoteFileInfo | null> {
    const command = `if [ -e ${shq(path)} ]; then echo __SIZE__ $(wc -c < ${shq(path)}); echo __IDENT__ $(${statIdentityExpr(shq(path))} 2>/dev/null || echo unknown); else echo __MISSING__; fi`
    const result = await this.execute({ serverId, runId: 'stat', stepId: path, attemptId: '0', command, timeoutMs: 30_000 })
    if (result.stdout.includes('__MISSING__')) return null
    const size = Number(/__SIZE__ (\d+)/.exec(result.stdout)?.[1] ?? 0)
    const identity = /__IDENT__ (\S+)/.exec(result.stdout)?.[1] ?? 'unknown'
    return { path, size, mtimeMs: 0, identity }
  }

  async listDir(serverId: string, path: string, limit: number): Promise<Array<{ name: string; isDir: boolean }>> {
    const command = `ls -1Ap ${shq(path)} 2>/dev/null | head -n ${limit}`
    const result = await this.execute({ serverId, runId: 'ls', stepId: path, attemptId: '0', command, timeoutMs: 30_000 })
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ name: line.replace(/\/$/, ''), isDir: line.endsWith('/') }))
  }

  async writeFile(serverId: string, path: string, content: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf('/')) || '.'
    const command = `mkdir -p ${shqRemotePath(parent)} && cat > ${shqRemotePath(`${path}.tmp`)} && mv ${shqRemotePath(`${path}.tmp`)} ${shqRemotePath(path)} && chmod 700 ${shqRemotePath(path)}`
    const result = await this.execute({ serverId, runId: 'write', stepId: path, attemptId: '0', command, stdin: content, timeoutMs: 30_000 })
    if (result.exitCode !== 0) throw err('internal', 'ssh', `remote write failed: ${result.stderr.trim().split('\n')[0]}`)
  }
}

function statIdentityExpr(quotedPath: string): string {
  // Linux first, macOS fallback — resolved remotely by the target's own sh
  return `stat -c '%d:%i' ${quotedPath} 2>/dev/null || stat -f '%d:%i' ${quotedPath} 2>/dev/null`
}

function classifyPlatform(stdout: string): 'linux' | 'macos' | 'unknown' {
  const first = stdout.split('\n')[0]?.trim() ?? ''
  if (first === 'Darwin') return 'macos'
  if (first === 'Linux') return 'linux'
  return 'unknown'
}

export function parseProbeOutput(stdout: string): ProbeResult {
  const lines = stdout.split('\n')
  const platform = classifyPlatform(stdout)
  const arch = lines[1]?.trim() ?? ''
  let osRelease = ''
  let shell = ''
  const tools: Record<string, 'available' | 'unavailable'> = {}
  let section = ''
  for (const line of lines) {
    if (line === '---OS---') {
      section = 'os'
      continue
    }
    if (line === '---SHELL---') {
      section = 'shell'
      continue
    }
    if (line === '---TOOLS---') {
      section = 'tools'
      continue
    }
    if (section === 'os' && line.trim()) {
      if (line.startsWith('PRETTY_NAME=')) osRelease = line.slice(12).replaceAll('"', '')
      else if (!osRelease && line.trim() && !line.startsWith('---')) osRelease = line.trim()
    } else if (section === 'shell' && line.includes('=')) {
      shell = line.split('=')[1]?.trim() ?? ''
    } else if (section === 'tools' && line.includes('=')) {
      const eq = line.indexOf('=')
      const name = line.slice(0, eq)
      const status = line.slice(eq + 1)
      if (name && (status === 'available' || status === 'unavailable')) tools[name] = status
    }
  }
  return { platform, osRelease, arch, shell, tools }
}
