/**
 * Server lifecycle (S2): normalize → fingerprint confirm → temp credentials →
 * real SSH login → read-only probe → short-lived verification ticket → save.
 * - failure or cancellation never creates a Server record
 * - the ticket binds config hash + credential versions + fingerprint; changed
 *   parameters, expiry, or reuse force a fresh verification
 * - editing credentials keeps the old config usable until the NEW one verifies
 * - occupied servers cannot be deleted or have credentials switched
 */
import { createHash } from 'node:crypto'
import { err } from '../../contracts/errors.ts'
import type { Server } from '../../contracts/entities.ts'
import { SCHEMA_VERSION, serverCapabilitiesSchema } from '../../contracts/entities.ts'
import type { SshTransport, VerifyOptions, ClockPort } from '../adapters/ports.ts'
import type { OpsRepository } from '../repository/ops-repository.ts'
import type { Vault } from '../vault/vault.ts'
import { configHash } from '../ssh/private-config.ts'
import { parseSshCommand } from '../ssh/parse.ts'
import { resolveLocalSshConfig } from '../ssh/local-config.ts'

export const TICKET_TTL_MS = 10 * 60 * 1000

/** Ticket payload = the binding checked in addFromTicket + the probed capabilities. */
interface TicketPayload {
  fingerprint: string
  expiresAt: number
  issuedAt: number
  host: string
  hostKeyEntryRaw?: string
  capabilities?: Server['capabilities']
}

export interface VerifyDraft {
  alias: string
  commandLine?: string
  host?: string
  port?: number
  user?: string
  authKind?: 'password' | 'privatekey' | 'privatekey-passphrase'
  secret?: string
  jumpHosts?: Array<{ host: string; port: number; user: string; secret?: string }>
}

export interface NormalizedDraft {
  alias: string
  host: string
  port: number
  user: string
  authKind: 'password' | 'privatekey' | 'privatekey-passphrase'
  secret: string
  /** PEM for key auth (from the draft) */
  identityPem?: string
  jumpHosts: Array<{ host: string; port: number; user: string; secret?: string }>
  extraOptions: Record<string, string>
}

export class ServerService {
  constructor(
    private readonly repo: OpsRepository,
    private readonly transport: SshTransport,
    private readonly vault: Vault,
    private readonly clock: ClockPort,
    private readonly resolveCommand: typeof resolveLocalSshConfig = resolveLocalSshConfig,
  ) {}

  /** Normalize a draft (structured fields or `ssh ...` command line). */
  normalize(draft: VerifyDraft): NormalizedDraft {
    let base: NormalizedDraft
    if (draft.commandLine) {
      const parsed = parseSshCommand(draft.commandLine)
      base = {
        alias: draft.alias,
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        authKind: parsed.authKind,
        secret: draft.secret ?? '',
        identityPem: draft.secret?.includes('PRIVATE KEY') ? draft.secret : undefined,
        jumpHosts: parsed.jumpHosts.map((j) => ({ host: j.host, port: j.port, user: j.user })),
        extraOptions: parsed.extraOptions,
      }
    } else {
      if (!draft.host) throw err('validation-failed', 'ssh', 'host is required')
      base = {
        alias: draft.alias,
        host: draft.host,
        port: draft.port ?? 22,
        user: draft.user ?? 'root',
        authKind: draft.authKind ?? 'password',
        secret: draft.secret ?? '',
        identityPem: draft.secret?.includes('PRIVATE KEY') ? draft.secret : undefined,
        jumpHosts: draft.jumpHosts ?? [],
        extraOptions: {},
      }
    }
    if (!base.alias.trim()) throw err('validation-failed', 'ssh', 'alias is required')
    return base
  }

  private async resolveDraft(draft: VerifyDraft): Promise<NormalizedDraft> {
    const normalized = this.normalize(draft)
    if (!draft.commandLine) return normalized
    const local = await this.resolveCommand(draft.commandLine, !draft.secret)
    return {
      ...normalized,
      host: local.host,
      user: local.user,
      port: local.port,
      ...(local.identityPem ? {
        authKind: 'privatekey' as const,
        identityPem: local.identityPem,
        secret: local.identityPem,
      } : {}),
    }
  }

  /** Real login + read-only probe; returns a fingerprint for UI confirmation. */
  async verify(draft: VerifyDraft, expectedFingerprint?: string): Promise<{ ticket: string; fingerprint: string; capabilities: Record<string, unknown> }> {
    const n = await this.resolveDraft(draft)
    const opts: VerifyOptions = {
      host: n.host,
      port: n.port,
      user: n.user,
      authKind: n.authKind,
      secret: n.secret,
      jumpHosts: n.jumpHosts,
      timeoutMs: 30_000,
    }
    if (expectedFingerprint) {
      opts.expectedFingerprint = expectedFingerprint
      const stored = this.findKnownFingerprint(n)
      if (stored) opts.expectedFingerprint = stored
    } else {
      opts.acceptUnknownFingerprint = true
    }
    const result = await this.transport.verify(opts)
    // 完整探测结果随票走：保存时直接落库 capabilities，服务器卡片才能
    // 显示真实系统名+版本号（此前探测结果被丢弃，落库永远是 unknown）
    const capabilities: Server['capabilities'] = {
      platform: result.platform,
      osRelease: result.osRelease,
      arch: result.arch,
      shell: result.shell,
      probes: {},
      probedAt: this.clock.now(),
    }
    // short-lived ticket binding the verified bytes
    const now = this.clock.now()
    const normalizedForHash = { ...n, secret: '' }
    const payload = {
      host: normalizedForHash.host,
      port: normalizedForHash.port,
      user: normalizedForHash.user,
      authKind: normalizedForHash.authKind,
      jump: normalizedForHash.jumpHosts.map((j) => `${j.user}@${j.host}:${j.port}`).join(','),
      secretHash: createHash('sha256').update(n.secret).digest('hex'),
      fingerprint: result.fingerprint,
      hostKeyEntryRaw: result.hostKeyEntry,
      credentialVersions: this.credentialVersionsFor(n),
      issuedAt: now,
      expiresAt: now + TICKET_TTL_MS,
      capabilities,
    }
    const ticket = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return { ticket, fingerprint: result.fingerprint, capabilities }
  }

  private credentialVersionsFor(n: NormalizedDraft): Array<{ ref: string; keyVersion: number }> {
    const ref = this.credentialRefFor(n)
    const record = this.repo.getCredential(ref)
    return record ? [{ ref, keyVersion: record.keyVersion }] : []
  }

  private credentialRefFor(n: NormalizedDraft): string {
    return `cred_${createHash('sha256').update(`${n.user}@${n.host}:${n.port}`).digest('hex').slice(0, 16)}`
  }

  /** Persist from a valid ticket; re-verifies the binding before creating. */
  async addFromTicket(draft: VerifyDraft, ticket: string, confirmedFingerprint: string): Promise<Server> {
    const binding = this.decodeTicket(ticket)
    if (binding.expiresAt < this.clock.now()) throw err('validation-failed', 'ssh', 'verification ticket expired; verify again')
    const n = await this.resolveDraft(draft)
    // the ticket was issued for EXACTLY this config — any change invalidates it
    const now = this.clock.now()
    const expectedBinding = {
      host: n.host,
      port: n.port,
      user: n.user,
      authKind: n.authKind,
      jump: n.jumpHosts.map((j) => `${j.user}@${j.host}:${j.port}`).join(','),
      secretHash: createHash('sha256').update(n.secret).digest('hex'),
    }
    for (const [key, value] of Object.entries(expectedBinding)) {
      const bound = (binding as unknown as Record<string, unknown>)[key]
      if (bound !== undefined && bound !== value) {
        throw err('validation-failed', 'ssh', `verification ticket does not match the draft (${key} changed after verify); verify again`, {
          details: { [key]: value },
        })
      }
    }
    const fingerprint = binding.fingerprint
    if (fingerprint !== confirmedFingerprint) {
      throw err('host-fingerprint-changed', 'ssh', 'confirmed fingerprint does not match the verified one')
    }
    const id = `srv_${createHash('sha256').update(`${n.user}@${n.host}:${n.port}:${n.alias}`).digest('hex').slice(0, 16)}`
    const credentialRef = this.credentialRefFor(n)
    // store credentials (encrypted) only now — verification secrets never persist elsewhere
    let identityPem: string | null = null
    if (n.authKind === 'password') {
      await this.repo.putCredential({
        schemaVersion: SCHEMA_VERSION,
        ref: credentialRef,
        kind: 'ssh-password',
        encryptedValue: await this.vault.encrypt(n.secret),
        keyVersion: await this.vault.currentKeyVersion(),
        updatedAt: now,
      })
    } else if (n.authKind === 'privatekey-passphrase') {
      await this.repo.putCredential({
        schemaVersion: SCHEMA_VERSION,
        ref: credentialRef,
        kind: 'ssh-passphrase',
        encryptedValue: await this.vault.encrypt(n.secret),
        keyVersion: await this.vault.currentKeyVersion(),
        updatedAt: now,
      })
    }
    if (n.authKind !== 'password' && n.identityPem) {
      identityPem = n.identityPem
      await this.repo.putCredential({
        schemaVersion: SCHEMA_VERSION,
        ref: `${credentialRef}:key`,
        kind: 'ssh-privatekey',
        encryptedValue: await this.vault.encrypt(n.identityPem),
        keyVersion: await this.vault.currentKeyVersion(),
        updatedAt: now,
      })
    }
    const server: Server = {
      schemaVersion: SCHEMA_VERSION,
      id,
      revision: 1,
      alias: n.alias,
      endpoint: `${n.user}@${n.host}:${n.port}`,
      sshOptions: {
        host: n.host,
        port: n.port,
        user: n.user,
        authKind: n.authKind,
        jumpHosts: n.jumpHosts.map((j) => ({ host: j.host, port: j.port, user: j.user, credentialRef: this.credentialRefFor({ ...n, host: j.host, user: j.user, port: j.port }) })),
        extraOptions: n.extraOptions,
      },
      credentialRefs: n.authKind === 'privatekey' ? [`${credentialRef}:key`] : n.authKind === 'privatekey-passphrase' ? [credentialRef, `${credentialRef}:key`] : [credentialRef],
      configHash: configHash({
        alias: n.alias,
        endpoint: `${n.user}@${n.host}:${n.port}`,
        sshOptions: { host: n.host, port: n.port, user: n.user, authKind: n.authKind, jumpHosts: [], extraOptions: n.extraOptions },
        credentialRefs: [credentialRef],
      }),
      hostFingerprint: fingerprint,
      // 随票携带的 verify 探测结果；旧票/解析失败回退 unknown（采集路径会再回填）
      capabilities: this.capabilitiesFromTicket(binding),
      createdAt: now,
      updatedAt: now,
    }
    await this.repo.putServer(server)
    this.transport.materializeServer?.(server.id, server, binding.hostKeyEntryRaw ?? '', identityPem)
    return server
  }

  /** 票内的探测结果（本服务自己签发）；缺省或形状不符一律回退全 unknown。 */
  private capabilitiesFromTicket(binding: TicketPayload): Server['capabilities'] {
    const fallback: Server['capabilities'] = { platform: 'unknown', osRelease: '', arch: '', shell: '', probes: {}, probedAt: null }
    try {
      return binding.capabilities ? serverCapabilitiesSchema.parse(binding.capabilities) : fallback
    } catch {
      return fallback
    }
  }

  /**
   * 采集路径的探测回填：老数据/早期版本保存的服务器 capabilities 落库时是
   * 全 unknown（探测结果曾被丢弃），这里借一次只读 SSH probe 补齐并落库；
   * 成功一次后不再重复。probe 失败只保留旧值，绝不阻断调用方的采集流程。
   */
  async ensureProbedCapabilities(serverId: string): Promise<Server['capabilities']> {
    const server = this.repo.getServer(serverId)
    if (!server) throw err('not-found', 'ssh', `server ${serverId} not found`)
    const cap = server.capabilities
    if (cap.probedAt && cap.platform !== 'unknown' && cap.osRelease) return cap
    try {
      const probed = await this.transport.probe(serverId)
      const next: Server['capabilities'] = {
        platform: probed.platform,
        osRelease: probed.osRelease,
        arch: probed.arch,
        shell: probed.shell,
        probes: { ...probed.tools },
        probedAt: this.clock.now(),
      }
      await this.repo.putServer({ ...server, revision: server.revision + 1, capabilities: next })
      return next
    } catch {
      return cap
    }
  }

  /** Update connection config or credentials: new config must verify first. */
  async updateServer(serverId: string, draft: VerifyDraft, ticket: string | null, confirmedFingerprint: string | null): Promise<Server> {
    const existing = this.repo.getServer(serverId)
    if (!existing) throw err('not-found', 'ssh', `server ${serverId} not found`)
    const exec = this.repo.getServerExecState(serverId)
    if (exec?.occupiedByRunId) throw err('task-occupied', 'ssh', 'server has an active task; cannot switch connection')
    if (!ticket || !confirmedFingerprint) {
      throw err('validation-failed', 'ssh', 'connection changes require a fresh verification')
    }
    const oldCredRefs = existing.credentialRefs.slice()
    const updated = await this.addFromTicket({ ...draft, alias: draft.alias || existing.alias }, ticket, confirmedFingerprint)
    // keep record identity, bump revision; old credential stays until here
    const merged: Server = { ...updated, id: existing.id, revision: existing.revision + 1, createdAt: existing.createdAt, capabilities: existing.capabilities }
    const configChanged = existing.configHash !== merged.configHash
    await this.repo.putServer(merged)
    if (configChanged) {
      for (const ref of oldCredRefs) {
        if (!merged.credentialRefs.includes(ref)) await this.repo.deleteCredential(ref)
      }
    }
    return merged
  }

  async removeServer(serverId: string): Promise<void> {
    const existing = this.repo.getServer(serverId)
    if (!existing) throw err('not-found', 'ssh', `server ${serverId} not found`)
    await this.repo.deleteServer(serverId) // repo enforces project references
  }

  /** Restart-safety probe: decrypt + login again with stored credentials. */
  async healthCheck(serverId: string): Promise<{ ok: boolean; reason: string | null }> {
    const server = this.repo.getServer(serverId)
    if (!server) return { ok: false, reason: 'not found' }
    if (server.sshOptions.authKind !== 'password' && server.sshOptions.authKind !== 'privatekey-passphrase') {
      return { ok: true, reason: null }
    }
    const ref = server.credentialRefs[0]
    if (!ref) return { ok: false, reason: 'credential missing' }
    const record = this.repo.getCredential(ref)
    if (!record) return { ok: false, reason: 'credential record missing' }
    try {
      await this.vault.decrypt(record.encryptedValue)
      return { ok: true, reason: null }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'decrypt failed' }
    }
  }

  private findKnownFingerprint(n: NormalizedDraft): string | null {
    for (const server of this.repo.listServers()) {
      if (server.sshOptions.host === n.host && server.sshOptions.port === n.port) return server.hostFingerprint
    }
    return null
  }

  private decodeTicket(ticket: string): TicketPayload {
    try {
      return JSON.parse(Buffer.from(ticket, 'base64url').toString('utf8'))
    } catch {
      throw err('validation-failed', 'ssh', 'invalid verification ticket')
    }
  }
}
