/**
 * Parse a user-supplied `ssh ...` login command into allowed connection fields.
 * Allowed: host, port (-p), user (-l), identity file (-i → privatekey auth),
 * jump host (-J user@host:port). Everything else — tunnels (-L/-R/-D/-W),
 * background (-f/-N), config overrides (-F/-o with isolation-breaking keys),
 * remote commands, shell metacharacters — is REJECTED loudly, never ignored.
 */
import { err } from '../../contracts/errors.ts'

export interface ParsedSshCommand {
  host: string
  port: number
  user: string
  authKind: 'password' | 'privatekey' | 'privatekey-passphrase'
  identityFile?: string
  jumpHosts: Array<{ host: string; port: number; user: string }>
  /** recognized but isolation-managed options we allow the user to state */
  extraOptions: Record<string, string>
}

/** host tokens we refuse outright (shell/alias trickery) */
const HOST_DENY = /^\s*(\||&|;|`|\$\(|>|<|\\|'|"|\s)/

interface Token {
  kind: 'short' | 'long' | 'arg'
  value: string
}

function tokenize(input: string): Token[] {
  // shell-like split but no expansion: quotes group; metacharacters rejected later
  const tokens: Token[] = []
  let current = ''
  let hasCurrent = false
  let quote: '"' | "'" | null = null
  const flush = () => {
    if (hasCurrent) {
      tokens.push({ kind: 'arg', value: current })
      current = ''
      hasCurrent = false
    }
  }
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (quote === '"' && ch === '\\' && input[i + 1]) {
        i++
        current += input[i]
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      hasCurrent = true
    } else if (/\s/.test(ch)) {
      flush()
    } else if (ch === '\\' && input[i + 1]) {
      i++
      current += input[i]!
      hasCurrent = true
    } else if (ch === ';' || ch === '&' || ch === '|' || ch === '`') {
      throw err('validation-failed', 'ssh', `shell metacharacter ${JSON.stringify(ch)} is not allowed in a login command`)
    } else {
      current += ch
      hasCurrent = true
    }
  }
  flush()
  if (quote) throw err('validation-failed', 'ssh', 'unterminated quote in login command')
  return tokens
}

const SHORT_WITH_VALUE = new Set(['p', 'l', 'i', 'J', 'F', 'b', 'c', 'D', 'e', 'E', 'L', 'm', 'O', 'o', 'R', 'S', 'w', 'W'])

/** options that would bypass the plugin-private configuration */
const FORBIDDEN_LONG = new Set([
  'forward-agent',
  'control-master',
  'control-path',
  'proxycommand',
  'userknownhostsfile',
  'globalknownhostsfile',
  'identityagent',
  'remoteforward',
  'localforward',
  'dynamicforward',
  'exitonforwardfailure',
])

/** Validate first, then pass literal argv to OpenSSH for local config expansion. */
export function sshConfigArgs(input: string): string[] {
  parseSshCommand(input)
  return ['-G', ...tokenize(input.trim().slice(4)).map((token) => token.value)]
}

export function parseSshCommand(input: string): ParsedSshCommand {
  const trimmed = input.trim()
  if (!trimmed) throw err('validation-failed', 'ssh', 'empty login command')
  if (!trimmed.startsWith('ssh ') && trimmed !== 'ssh') {
    throw err('validation-failed', 'ssh', 'command must start with `ssh`')
  }
  if (HOST_DENY.test(trimmed.slice(4))) {
    throw err('validation-failed', 'ssh', 'command contains forbidden characters')
  }
  const tokens = tokenize(trimmed.slice(4))
  if (tokens.length === 0) throw err('validation-failed', 'ssh', 'missing destination')

  let host: string | null = null
  let port = 22
  let user = ''
  let identityFile: string | undefined
  let passphraseAuth = false
  const jumpHosts: ParsedSshCommand['jumpHosts'] = []
  const extraOptions: Record<string, string> = {}
  let sawSeparator = false

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (sawSeparator) throw err('validation-failed', 'ssh', 'remote commands are not allowed')
    if (tok.value === '--') {
      sawSeparator = true
      continue
    }
    if (tok.value.startsWith('--')) {
      const [name, inline] = tok.value.slice(2).split('=', 2)
      const next = () => (inline !== undefined ? inline : tokens[++i]?.value)
      switch (name) {
        case 'port':
          port = parsePort(next())
          break
        case 'login':
          user = requireValue(next(), '--login')
          break
        case 'identity':
          identityFile = requireValue(next(), '--identity')
          break
        case 'jump-host': {
          const j = requireValue(next(), '--jump-host')
          jumpHosts.push(parseJump(j))
          break
        }
        case 'askpass': // our own extension marker: passphrase key
          passphraseAuth = true
          break
        default:
          if (name && FORBIDDEN_LONG.has(name)) {
            throw err('validation-failed', 'ssh', `option --${name} bypasses the private configuration and is rejected`)
          }
          throw err('validation-failed', 'ssh', `unsupported option --${name ?? '?'}; allowed: address, port, user, private key, jump host`)
      }
      continue
    }
    if (tok.value.startsWith('-') && tok.value.length > 1) {
      const flag = tok.value.slice(1, 2)
      const inline = tok.value.slice(2)
      const next = () => (inline || tokens[++i]?.value)
      if (flag === 'p') {
        port = parsePort(next())
      } else if (flag === 'l') {
        user = requireValue(next(), '-l')
      } else if (flag === 'i') {
        identityFile = requireValue(next(), '-i')
      } else if (flag === 'J') {
        const spec = requireValue(next(), '-J')
        for (const part of spec.split(',')) jumpHosts.push(parseJump(part))
      } else if (flag === 'o') {
        const value = requireValue(next(), '-o')
        const [key, ...rest] = value.split('=')
        const k = (key ?? '').trim().toLowerCase()
        if (FORBIDDEN_LONG.has(k)) {
          throw err('validation-failed', 'ssh', `option ${key} bypasses the private configuration and is rejected`)
        }
        // only a tiny allowlist of harmless extras is recognized
        if (k === 'connecttimeout') extraOptions[k] = rest.join('=')
        else {
          throw err('validation-failed', 'ssh', `unsupported -o ${key}; only ConnectTimeout is allowed`)
        }
      } else if (['L', 'R', 'D', 'W', 'N', 'f', 'g', 'F', 'S', 'O', 'w', 'M'].includes(flag)) {
        throw err('validation-failed', 'ssh', `option -${flag} (tunnel/background/config override) is rejected`)
      } else {
        throw err('validation-failed', 'ssh', `unsupported option -${flag}; allowed: address, port, user, private key, jump host`)
      }
      continue
    }
    // destination; scp-style user@host accepted
    if (host !== null) {
      // second positional would be a remote command
      throw err('validation-failed', 'ssh', 'remote commands are not allowed')
    }
    const dest = tok.value
    const at = dest.lastIndexOf('@')
    if (at > 0) {
      user = dest.slice(0, at)
      host = dest.slice(at + 1)
    } else {
      host = dest
    }
  }
  void SHORT_WITH_VALUE

  if (!host) throw err('validation-failed', 'ssh', 'missing destination host')
  if (HOST_DENY.test(host) || host.includes('*') || host.includes('?')) {
    throw err('validation-failed', 'ssh', `invalid destination host ${JSON.stringify(host)}`)
  }
  const authKind: ParsedSshCommand['authKind'] = identityFile ? (passphraseAuth ? 'privatekey-passphrase' : 'privatekey') : 'password'
  return {
    host,
    port,
    user: user || '',
    authKind,
    ...(identityFile ? { identityFile } : {}),
    jumpHosts,
    extraOptions,
  }
}

function parsePort(v: string | undefined): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw err('validation-failed', 'ssh', `invalid port ${JSON.stringify(v)}`)
  return n
}

function requireValue(v: string | undefined, flag: string): string {
  if (v === undefined || v === '') throw err('validation-failed', 'ssh', `option ${flag} requires a value`)
  if (HOST_DENY.test(v)) throw err('validation-failed', 'ssh', `option ${flag} contains forbidden characters`)
  return v
}

function parseJump(spec: string): { host: string; port: number; user: string } {
  // [user@]host[:port]
  let rest = spec
  let user = ''
  const at = rest.lastIndexOf('@')
  if (at > 0) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  let port = 22
  const colon = rest.lastIndexOf(':')
  if (colon > 0) {
    port = parsePort(rest.slice(colon + 1))
    rest = rest.slice(0, colon)
  }
  if (!rest || HOST_DENY.test(rest)) throw err('validation-failed', 'ssh', `invalid jump host ${JSON.stringify(spec)}`)
  return { host: rest, port, user }
}
