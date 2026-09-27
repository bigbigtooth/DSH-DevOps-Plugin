/**
 * Private vault: authenticated encryption (AES-256-GCM) for SSH/Git/sudo
 * secrets. Key material comes from an independent KeyProvider; envelopes are
 * versioned so key rotation keeps old records readable. Plaintext never lands
 * in logs, DTOs, scripts, or model context — `redact` scrubs outputs.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { err } from '../../contracts/errors.ts'
import type { KeyProvider } from '../adapters/ports.ts'

export type CredentialKind = 'ssh-password' | 'ssh-passphrase' | 'git' | 'sudo'

interface Envelope {
  v: number
  iv: string
  ct: string
  tag: string
}

export class Vault {
  constructor(private readonly keys: KeyProvider) {}

  /** Key version a new credential record should be written with. */
  async currentKeyVersion(): Promise<number> {
    return (await this.keys.current()).version
  }

  async encrypt(plaintext: string): Promise<string> {
    const { version, key } = await this.keys.current()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const envelope: Envelope = {
      v: version,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
    }
    return `enc1:${JSON.stringify(envelope)}`
  }

  async decrypt(envelopeText: string): Promise<string> {
    if (!envelopeText.startsWith('enc1:')) {
      throw err('validation-failed', 'vault', 'unknown envelope format')
    }
    let env: Envelope
    try {
      env = JSON.parse(envelopeText.slice(5)) as Envelope
    } catch {
      throw err('validation-failed', 'vault', 'corrupt envelope')
    }
    let key: Buffer
    try {
      key = await this.keys.version(env.v)
    } catch {
      throw err(
        'validation-failed',
        'vault',
        `key version ${env.v} unavailable; credential cannot be decrypted`,
        { details: { keyVersion: env.v } },
      )
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8')
    } catch {
      throw err('validation-failed', 'vault', 'decryption failed: tampered data or wrong key')
    }
  }
}

/** File-backed key provider with 0600 permission; key file stores random 32-byte keys per version. */
export class FileKeyProvider implements KeyProvider {
  private cache = new Map<number, Buffer>()
  constructor(
    private readonly readFile: (path: string) => Promise<Buffer>,
    private readonly writeFile: (path: string, data: Buffer) => Promise<void>,
    private readonly keyPath: string,
  ) {}

  async current(): Promise<{ version: number; key: Buffer }> {
    const raw = await this.loadStore()
    const latest = raw.length
    return { version: latest, key: await this.version(latest) }
  }

  async version(v: number): Promise<Buffer> {
    const cached = this.cache.get(v)
    if (cached) return cached
    const raw = await this.loadStore()
    const key = raw[v - 1]
    if (!key) throw new Error(`key version ${v} not found`)
    this.cache.set(v, key)
    return key
  }

  /** Store format: newline-separated base64 keys; appending rotates versions. */
  private storeCache: Buffer[] | null = null
  private async loadStore(): Promise<Buffer[]> {
    if (this.storeCache) return this.storeCache
    let raw: Buffer
    try {
      raw = await this.readFile(this.keyPath)
    } catch {
      const key = randomBytes(32)
      await this.writeFile(this.keyPath, key)
      this.storeCache = [key]
      this.cache.set(1, key)
      return this.storeCache
    }
    const keys = raw
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => Buffer.from(l, 'base64'))
    this.storeCache = keys
    keys.forEach((k, i) => this.cache.set(i + 1, k))
    return keys
  }
}

/** Test/development key provider: deterministic in-memory keys. */
export class MemoryKeyProvider implements KeyProvider {
  private keys: Buffer[] = [createHash('sha256').update('dsh-devops-test-key-1').digest()]
  async current(): Promise<{ version: number; key: Buffer }> {
    return { version: this.keys.length, key: this.keys[this.keys.length - 1]! }
  }
  async version(v: number): Promise<Buffer> {
    const key = this.keys[v - 1]
    if (!key) throw new Error(`key version ${v} not found`)
    return key
  }
  rotate(): void {
    this.keys.push(createHash('sha256').update(`dsh-devops-test-key-${this.keys.length + 1}`).digest())
  }
}

// ---------- redaction ----------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sshpass\s+(?:-[a-zA-Z]\s+)*-p\s+\S+/g, 'sshpass -p ***'],
  [/password[=:]\s*[^\s&"']+/gi, 'password=***'],
  [/passwd[=:]\s*[^\s&"']+/gi, 'passwd=***'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***private-key***'],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Redact with a cap for model-facing / persisted output tails. */
export function redactAndClamp(text: string, maxChars = 4000): string {
  const redacted = redactSecrets(text)
  if (redacted.length <= maxChars) return redacted
  return `${redacted.slice(0, maxChars)}…[truncated ${redacted.length - maxChars} chars]`
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
