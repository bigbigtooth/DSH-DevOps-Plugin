import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { err } from '../../contracts/errors.ts'
import { parseSshCommand, sshConfigArgs } from './parse.ts'

const execFileAsync = promisify(execFile)

export interface LocalSshConfig {
  host: string
  port: number
  user: string
  identityPem?: string
}

/** Resolve local aliases without connecting or inheriting their transport options. */
export async function resolveLocalSshConfig(
  commandLine: string,
  loadIdentity: boolean,
  options: { configFile?: string } = {},
): Promise<LocalSshConfig> {
  const parsed = parseSshCommand(commandLine)
  const args = sshConfigArgs(commandLine)
  if (options.configFile) args.splice(1, 0, '-F', options.configFile)
  const { stdout } = await execFileAsync('ssh', args, { timeout: 5000, maxBuffer: 1024 * 1024 })
  const values = new Map<string, string[]>()
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(' ')
    if (at < 0) continue
    const key = line.slice(0, at)
    values.set(key, [...(values.get(key) ?? []), line.slice(at + 1).trim()])
  }
  const host = values.get('hostname')?.[0]
  const user = values.get('user')?.[0]
  const port = Number(values.get('port')?.[0])
  if (!host || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw err('validation-failed', 'ssh', 'OpenSSH returned an incomplete host configuration')
  }
  // These cannot be copied into the private transport without importing
  // additional credentials or executing an arbitrary local proxy command.
  if (values.get('proxycommand')?.some((v) => v !== 'none')) {
    throw err('validation-failed', 'ssh', 'ProxyCommand from SSH config is not supported by the private transport')
  }
  if (values.get('proxyjump')?.some((v) => v !== 'none') && parsed.jumpHosts.length === 0) {
    throw err('validation-failed', 'ssh', 'ProxyJump from SSH config requires an explicit jump-host configuration')
  }
  const result: LocalSshConfig = { host, user, port }
  if (!loadIdentity) return result

  for (const file of values.get('identityfile') ?? []) {
    if (file === 'none') continue
    const expanded = file.replace(/^~(?=\/)/, homedir())
      .replace(/%[dhrp%]/g, (token) => ({ '%d': homedir(), '%h': host, '%r': user, '%p': String(port), '%%': '%' })[token]!)
    if (/%[A-Za-z]/.test(expanded)) continue
    let pem: string
    try {
      pem = await readFile(resolve(expanded), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err('validation-failed', 'ssh', 'Cannot read the configured SSH identity file')
    }
    if (!/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(pem)) continue
    result.identityPem = pem
    break
  }
  if (parsed.identityFile && !result.identityPem) {
    throw err('validation-failed', 'ssh', 'The specified SSH identity file does not contain a readable private key')
  }
  return result
}
