/**
 * Client state model: reads Host records as revision snapshots over the
 * authenticated /dsh-devops channel. Initial version = short polling for
 * active runs + event replay by sequence; the browser closing never cancels
 * accepted tasks (the request ends when the task ID is returned).
 */
import type { ApiEndpointName, ApiRequest, ApiResponse } from '../contracts/api.ts'
import { RPC_CHANNEL } from '../contracts/rpc.ts'

export interface ConnectionFace {
  rpc: {
    /**
     * The browser Connection client validates the server-response envelope and
     * returns failure errors as { code, message, details }; scope/retryable are
     * host-side enrichments that do not survive the wire, so all fields except
     * code/message are optional here.
     */
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown>; scope?: string; retryable?: boolean } }>
  }
}

export type CallResult<K extends ApiEndpointName> =
  | { ok: true; value: ApiResponse<K> }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown>; scope?: string; retryable?: boolean } }

export class OpsClient {
  private connection: ConnectionFace | null
  constructor(connection: ConnectionFace | null) {
    this.connection = connection
  }

  get available(): boolean {
    return this.connection !== null
  }

  async call<K extends ApiEndpointName>(endpoint: K, payload: ApiRequest<K>, signal?: AbortSignal): Promise<CallResult<K>> {
    if (!this.connection) {
      return { ok: false, error: { code: 'offline', message: 'host connection unavailable', scope: 'api', retryable: true } }
    }
    try {
      const result = await this.connection.rpc.call(RPC_CHANNEL, endpoint, payload ?? {}, signal)
      if (result.ok) return { ok: true, value: result.value as ApiResponse<K> }
      return { ok: false, error: result.error }
    } catch (e) {
      return { ok: false, error: { code: 'carrier', message: e instanceof Error ? e.message : String(e), scope: 'api', retryable: true } }
    }
  }
}

// ---------- store (framework-agnostic; React binds via useSyncExternalStore) ----------

export interface OpsState {
  loaded: boolean
  offline: boolean
  servers: Array<Record<string, unknown>>
  projects: Array<Record<string, unknown>>
  activeRuns: Array<Record<string, unknown>>
  lastError: string | null
  /** per-run event sequence high-water for replay */
  eventCursors: Record<string, number>
}

export class OpsStore {
  private state: OpsState = {
    loaded: false,
    offline: false,
    servers: [],
    projects: [],
    activeRuns: [],
    lastError: null,
    eventCursors: {},
  }
  private listeners = new Set<() => void>()

  getState = (): OpsState => this.state

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private patch(partial: Partial<OpsState>): void {
    // out-of-order or duplicate responses must not overwrite newer state:
    // patch only explicit fields, never whole replacements
    this.state = { ...this.state, ...partial }
    for (const fn of this.listeners) fn()
  }

  async refresh(client: OpsClient): Promise<void> {
    const servers = await client.call('servers.list', {})
    const projects = await client.call('projects.list', {})
    if (!servers.ok || !projects.ok) {
      const message = !servers.ok ? servers.error.message : !projects.ok ? projects.error.message : null
      this.patch({ offline: true, lastError: message })
      return
    }
    this.patch({ loaded: true, offline: false, servers: servers.value as Array<Record<string, unknown>>, projects: projects.value as Array<Record<string, unknown>>, lastError: null })
  }

  async refreshRuns(client: OpsClient): Promise<void> {
    const runs = await client.call('deploy.list', { limit: 50 })
    if (!runs.ok) return
    const active = (runs.value as Array<Record<string, unknown>>).filter((r) => !['SUCCEEDED', 'FAILED', 'STOPPED'].includes(String(r.status)))
    this.patch({ activeRuns: active })
  }

  /** Replay events after the stored cursor; out-of-order events are dropped. */
  async replayEvents(client: OpsClient, runId: string): Promise<Array<Record<string, unknown>>> {
    const cursor = this.state.eventCursors[runId] ?? 0
    const events = await client.call('deploy.events', { runId, afterSequence: cursor })
    if (!events.ok) return []
    const list = events.value as Array<{ sequence: number }>
    const fresh = list.filter((e) => e.sequence > cursor).sort((a, b) => a.sequence - b.sequence)
    const highest = fresh.length ? fresh[fresh.length - 1]!.sequence : cursor
    this.patch({ eventCursors: { ...this.state.eventCursors, [runId]: highest } })
    return fresh as Array<Record<string, unknown>>
  }
}

export function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c?.randomUUID) return c.randomUUID()
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
