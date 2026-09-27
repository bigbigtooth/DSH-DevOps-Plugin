/**
 * Generate the plugin-private OpenSSH configuration. Every system-level
 *回落 point is explicitly closed: user/system config, default identities,
 * agent forwarding, known_hosts, control sockets. The generated file is the
 * ONLY configuration the transport loads (`ssh -F`).
 */
import { createHash } from 'node:crypto'
import { err } from '../../contracts/errors.ts'
import type { Server } from '../../contracts/entities.ts'

export interface PrivateConfigInput {
  host: string
  port: number
  user: string
  authKind: 'password' | 'privatekey' | 'privatekey-passphrase'
  /** absolute path to a private key file (for privatekey auths) */
  identityFile?: string
  jumpHosts?: Array<{ alias: string; host: string; port: number; user: string }>
  extraOptions?: Record<string, string>
  /** absolute paths inside the plugin private dir */
  knownHostsFile: string
  connectTimeoutSeconds?: number
}

/** POSIX single-quote escaping for values embedded in the config file. */
function q(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`
}

export function renderPrivateConfig(input: PrivateConfigInput): string {
  const lines: string[] = []
  const timeout = input.connectTimeoutSeconds ?? 15
  // host aliases are deterministic and plugin-namespaced
  lines.push(`Host dsh-devops-jump-*`)
  lines.push(`  Include none`)
  lines.push('')
  let jumpIndex = 0
  for (const jump of input.jumpHosts ?? []) {
    lines.push(`Host dsh-devops-jump-${jumpIndex}`)
    lines.push(`  HostName ${q(jump.host)}`)
    lines.push(`  Port ${jump.port}`)
    lines.push(`  User ${q(jump.user)}`)
    pushCommonIsolation(lines, input.knownHostsFile, timeout)
    jumpIndex++
  }
  lines.push(`Host dsh-devops-target`)
  lines.push(`  HostName ${q(input.host)}`)
  lines.push(`  Port ${input.port}`)
  lines.push(`  User ${q(input.user)}`)
  if (jumpIndex > 0) {
    lines.push(`  ProxyJump ${Array.from({ length: jumpIndex }, (_, i) => `dsh-devops-jump-${i}`).join(',')}`)
  }
  switch (input.authKind) {
    case 'password':
      lines.push(`  PreferredAuthentications password,keyboard-interactive`)
      lines.push(`  PubkeyAuthentication no`)
      break
    case 'privatekey':
      if (!input.identityFile) throw err('validation-failed', 'ssh', 'privatekey auth requires an identity file')
      lines.push(`  IdentityFile ${q(input.identityFile)}`)
      lines.push(`  PreferredAuthentications publickey`)
      break
    case 'privatekey-passphrase':
      if (!input.identityFile) throw err('validation-failed', 'ssh', 'privatekey auth requires an identity file')
      lines.push(`  IdentityFile ${q(input.identityFile)}`)
      lines.push(`  PreferredAuthentications publickey`)
      break
  }
  pushCommonIsolation(lines, input.knownHostsFile, timeout)
  for (const [k, v] of Object.entries(input.extraOptions ?? {})) {
    // only validated keys reach here (parser allowlist)
    lines.push(`  ${k} ${q(v)}`)
  }
  return lines.join('\n') + '\n'
}

function pushCommonIsolation(lines: string[], knownHostsFile: string, timeout: number): void {
  lines.push(`  UserKnownHostsFile ${q(knownHostsFile)}`)
  lines.push(`  GlobalKnownHostsFile /dev/null`)
  lines.push(`  StrictHostKeyChecking yes`)
  lines.push(`  IdentitiesOnly yes`)
  lines.push(`  IdentityAgent none`)
  lines.push(`  ForwardAgent no`)
  lines.push(`  ForwardX11 no`)
  lines.push(`  ControlMaster no`)
  lines.push(`  ControlPath none`)
  lines.push(`  BatchMode no`)
  lines.push(`  LogLevel ERROR`)
  lines.push(`  ConnectTimeout ${timeout}`)
}

/** Stable hash binding a config (excluding mutable verify state) for tickets. */
export function configHash(server: Pick<Server, 'alias' | 'endpoint' | 'sshOptions' | 'credentialRefs'>): string {
  const canonical = JSON.stringify({
    alias: server.alias,
    endpoint: server.endpoint,
    ssh: server.sshOptions,
    creds: server.credentialRefs.slice().sort(),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
