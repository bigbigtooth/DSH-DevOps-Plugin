import { describe, expect, it } from 'vitest'
import { Vault, MemoryKeyProvider, redactSecrets, redactAndClamp } from '../../src/host/vault/vault.ts'

describe('vault (S2)', () => {
  it('encrypt/decrypt round trip', async () => {
    const vault = new Vault(new MemoryKeyProvider())
    const enc = await vault.encrypt('hunter2')
    expect(enc).toMatch(/^enc1:/)
    expect(enc).not.toContain('hunter2')
    expect(await vault.decrypt(enc)).toBe('hunter2')
  })

  it('tampered ciphertext fails to decrypt', async () => {
    const vault = new Vault(new MemoryKeyProvider())
    const enc = await vault.encrypt('hunter2')
    const json = JSON.parse(enc.slice(5)) as { ct: string }
    json.ct = Buffer.from('garbage').toString('base64')
    await expect(vault.decrypt(`enc1:${JSON.stringify(json)}`)).rejects.toThrow()
  })

  it('old records stay decryptable after key rotation', async () => {
    const keys = new MemoryKeyProvider()
    const vault = new Vault(keys)
    const oldEnc = await vault.encrypt('v1-secret')
    keys.rotate()
    const newEnc = await vault.encrypt('v2-secret')
    expect(await vault.decrypt(oldEnc)).toBe('v1-secret')
    expect(await vault.decrypt(newEnc)).toBe('v2-secret')
    expect(await vault.currentKeyVersion()).toBe(2)
  })

  it('missing key version reports unusable credential instead of plaintext fallback', async () => {
    const keys = new MemoryKeyProvider()
    const vault = new Vault(keys)
    const enc = await vault.encrypt('secret')
    // fabricate an envelope referencing a nonexistent key version
    const json = JSON.parse(enc.slice(5)) as { v: number }
    json.v = 99
    await expect(vault.decrypt(`enc1:${JSON.stringify(json)}`)).rejects.toThrow(/key version 99/)
  })

  it('rejects unknown envelope formats', async () => {
    const vault = new Vault(new MemoryKeyProvider())
    await expect(vault.decrypt('plain-text')).rejects.toThrow(/envelope/)
  })
})

describe('redaction', () => {
  it('scrubs common secret shapes from outputs', () => {
    const input = 'sshpass -p "s3cret" running; password=hunter2 AKIAIOSFODNN7EXAMPLE\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'
    const out = redactSecrets(input)
    expect(out).not.toContain('s3cret')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(out).not.toContain('PRIVATE KEY-----\nabc')
  })

  it('clamps long model-facing output', () => {
    const out = redactAndClamp('x'.repeat(10000), 100)
    expect(out.length).toBeLessThan(200)
    expect(out).toContain('truncated')
  })
})
