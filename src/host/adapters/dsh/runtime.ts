/**
 * DSH host runtime adapter: bridges the real Cordis context (duck-typed to
 * avoid build-time coupling to unpublished host packages) to the plugin's
 * ports. Every capability degrades EXPLICITLY — a missing host service is
 * logged loudly and the corresponding business state reports `unavailable`;
 * nothing silently fakes success.
 */
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { DOMAIN_TABLE_NAMES } from '../../repository/ops-repository.ts'
import type { StoragePort, KvDomain, EffectOwner, AgentBridge, StructuredAgentResult, ModelPort } from '../ports.ts'
import { MemoryStorage } from '../memory.ts'
import { FileStorage } from '../file-storage.ts'
import { err, OpsError } from '../../../contracts/errors.ts'
import { registerRpcFallback, type FallbackServices } from './rpc-route.ts'

export interface DshRuntimeConfig {
  dataDir: string
  modelRef: string | null
  controllerId?: string
}

export interface HostRuntime {
  storage: StoragePort
  agentBridge: AgentBridge | null
  model: ModelPort
  controllerId: string
  degraded: string[]
  /** host LLM runtime handle; null when ctx.llm is absent (AI steps report unavailable) */
  llm: LlmRuntimeLike | null
  registerRpc: (channel: string, handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>) => Promise<void>
  registerEffect: (setup: () => (() => void) | void) => void
}

/** Cross-process single-controller lock for one data dir. */
export class ControllerLock {
  private path: string
  private heartbeat: ReturnType<typeof setInterval> | null = null
  constructor(dataDir: string, readonly controllerId: string) {
    this.path = join(dataDir, 'controller.lock')
  }
  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    if (existsSync(this.path)) {
      try {
        const existing = JSON.parse(readFileSync(this.path, 'utf8')) as { controllerId: string; at: number }
        const fresh = Date.now() - existing.at < 30_000
        if (fresh && existing.controllerId !== this.controllerId) {
          throw err('conflict', 'repository', `another controller (${existing.controllerId}) is active on this data directory`, {
            details: { activeController: existing.controllerId },
          })
        }
      } catch (e) {
        if (OpsError.is(e)) throw e
      }
    }
    this.write()
    this.heartbeat = setInterval(() => this.write(), 10_000)
    this.heartbeat.unref?.()
  }
  private write(): void {
    writeFileSync(this.path, JSON.stringify({ controllerId: this.controllerId, at: Date.now() }), { flag: 'w' })
  }
  release(): void {
    this.heartbeat?.unref?.()
    clearInterval(this.heartbeat ?? undefined)
    this.heartbeat = null
    try {
      if (existsSync(this.path)) unlinkSync(this.path)
    } catch {
      /* best effort */
    }
  }
}

/**
 * Read an OPTIONAL host service.
 *
 * `ctx.storageDomain` and friends are Cordis proxy properties that THROW
 * ("cannot get property \"storageDomain\" without inject") unless the service
 * is declared in the plugin's `inject` list. This plugin is deliberately
 * degrade-capable: a missing host service must produce a loud degraded mode,
 * not a refused load. `ctx.get(name)` is the documented uninjected read — it
 * returns `undefined` when the service is absent — so every optional host
 * service is read through it here.
 */
/**
 * Map a logical domain name to a host-legal storage unit name
 * (`^[a-z][a-z0-9_]*$` — letters, digits and underscores only).
 *
 * Derived from the DSH storage contract, not guessed: a hyphenated name is
 * rejected by `validateDescriptor` as a malformed medium.
 */
export function toStorageUnitName(name: string): string {
  const spaced = name
    // camelCase boundary → underscore, so "inspectionRuns" → "inspection_runs"
    // rather than "inspectionruns" (distinct logical names stay distinct).
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
  return spaced.length > 0 ? spaced : 'dsh_plugin'
}

/**
 * Optional service probe. Host loader compositions may install strict
 * `internal/get` policies where even `ctx.get`-shaped access is guarded —
 * ANY throw here means "capability not grantable in this composition" and
 * becomes a degraded marker, never a plugin-load failure.
 */
function optionalService<T>(ctx: Context, name: string, degraded: string[]): T | undefined {
  try {
    const get = (ctx as unknown as { get?: (n: string, strict?: boolean) => unknown }).get
    if (typeof get !== 'function') {
      // fall back to a guarded property read for compositions without .get
      return (ctx as unknown as Record<string, unknown>)[name] as T | undefined
    }
    return get.call(ctx, name) as T | undefined
  } catch (e) {
    degraded.push(`service "${name}" not accessible in this composition (${e instanceof Error ? e.message : String(e)})`)
    return undefined
  }
}

/** Logger probe with the same guard; falls back to console so errors stay visible. */
export function safeLogger(ctx: Context): { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void } {
  const noop = () => undefined
  try {
    const logger = (ctx as unknown as Record<string, unknown>)['logger'] as
      | { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void }
      | undefined
    if (logger) {
      return {
        info: typeof logger.info === 'function' ? logger.info.bind(logger) : noop,
        warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
        error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop,
      }
    }
  } catch {
    /* fall through to console */
  }
  return console
}

/** Build the runtime from a DSH Web host context. */
export function buildRuntime(ctx: Context, config: DshRuntimeConfig): HostRuntime {
  const degraded: string[] = []

  // ---- storage: host domain facility → file-backed explicit fallback ----
  let storage: StoragePort
  const storageDomain = optionalService<{ open(spec: unknown): Promise<KvDomain> }>(ctx, 'storageDomain', degraded)
  if (storageDomain && typeof storageDomain.open === 'function') {
    storage = {
      openDomain: async (name) => {
        // Host storage accepts only `^[a-z][a-z0-9_]*$` unit AND table names,
        // while this plugin's logical names are "dsh-devops" and camelCase
        // record names. Both are mapped at this boundary; the host rejects the
        // descriptor as "invalid unit/table name" otherwise and the whole
        // plugin load is refused.
        const hostTables = new Map(DOMAIN_TABLE_NAMES.map((table) => [table, toStorageUnitName(table)]))
        if (new Set(hostTables.values()).size !== hostTables.size) {
          throw new Error('[dsh-devops] internal error: storage table names collide after sanitization')
        }
        const domain = await storageDomain.open({
          name: toStorageUnitName(name),
          version: 1,
          // Every table the repository queries must be DECLARED here: the host
          // builds its table map from these keys and `domain.table()` throws
          // "declares no table" for anything absent. Records are validated per
          // record against the zod schemas in src/contracts/entities.ts by the
          // repository, so the storage-level schema stays permissive.
          tables: Object.fromEntries(
            DOMAIN_TABLE_NAMES.map((table) => [toStorageUnitName(table), { valueSchema: z.record(z.string(), z.unknown()) }]),
          ),
        })
        // Present the host domain under the plugin's LOGICAL table names, so
        // business code keeps saying `table('inspectionRuns')`.
        return {
          ...domain,
          table: <V,>(tableName: string) => domain.table<V>(hostTables.get(tableName) ?? toStorageUnitName(tableName)),
        } as KvDomain
      },
    }
  } else {
    degraded.push('storageDomain unavailable — using file-backed store (explicit degraded mode)')
    mkdirSync(config.dataDir, { recursive: true })
    storage = new FileStorage(join(config.dataDir, 'storage'))
  }

  // ---- model ----
  const model: ModelPort = {
    resolve: async (modelRef) => modelRef ?? config.modelRef,
  }

  // ---- agent bridge: drive one-shot model calls through the host LLM runtime ----
  // The public `ctx.agents` handle is `{ id }` only — concrete driving belongs
  // to a loop/session we do not own, so a plugin cannot submit-and-await on it
  // (it fails 'not drivable'). Every AI feature here (log discovery, inspection
  // analysis, deploy repair) is a single prompt whose context is already inline
  // in the task text and needs no tools, so `ctx.llm.stream` — a bare provider
  // dispatch with no session, parent, or agent-loop — is the correct, robust
  // seam. Null when the host exposes no LLM runtime; callers then report the AI
  // step unavailable (never faked).
  let agentBridge: AgentBridge | null = null
  const llm = optionalService<LlmRuntimeLike>(ctx, 'llm', degraded)
  if (llm && typeof llm.stream === 'function') {
    agentBridge = createDshAgentBridge(llm)
  } else {
    degraded.push('ctx.llm unavailable — AI inspection/deploy/log-discovery steps report unavailable (never faked)')
  }

  return {
    storage,
    agentBridge,
    model,
    controllerId: config.controllerId ?? `ctrl_${process.pid}_${Date.now().toString(36)}`,
    degraded,
    llm: typeof llm?.stream === 'function' ? llm : null,
    registerRpc: async (channel, handler) => {
      // Connection binds channel registrations to the calling fiber and reads
      // that fiber's webServer. Both services must be injected; a nested
      // plugin (rather than ctx.inject) also handles late service activation.
      // rpc.handle is the platform path; when the host composition rejects its
      // internal webServer read (strict inject enforcement — see rpc-route.ts),
      // the same channel is mounted directly on webServer as a fallback.
      ctx.plugin({
        inject: ['connection', 'webServer'],
        apply: (rpcCtx) => {
          const services = rpcCtx as unknown as {
            connection: {
              rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>): (() => void | Promise<void>) | void }
              requestRejection(request: unknown): number | undefined
            }
          } & Pick<FallbackServices, 'webServer'>
          let dispose: (() => void) | undefined
          try {
            const upstream = services.connection.rpc.handle(channel, (endpoint, payload, signal) => handler(endpoint, payload, signal))
            if (typeof upstream === 'function') dispose = () => void upstream()
          } catch (e) {
            // Not routed through `degraded` (already logged by the caller at
            // build time); console matches safeLogger's fallback sink so the
            // composition change stays visible in host logs.
            console.warn(`[dsh-devops] connection.rpc.handle rejected (${e instanceof Error ? e.message : String(e)}) — mounting ${channel} directly on webServer (fallback path)`)
            dispose = registerRpcFallback(services, channel, handler)
          }
          if (dispose) rpcCtx.effect(() => dispose as () => void)
        },
      })
    },
    registerEffect: (setup) => {
      ctx.effect?.(() => {
        const dispose = setup()
        return () => {
          void dispose?.()
        }
      })
    },
  }
}

/**
 * Minimal structural view of the host LLM runtime's one-shot streaming API.
 * Duck-typed so the plugin never compiles against an unpublished host package:
 * `stream(request)` dispatches a single provider/model call and yields chunks
 * (text deltas, a terminal finish reason). No session, parent agent, or agent
 * loop is involved, so it cannot hit the 'not drivable' wall the `ctx.agents`
 * handle does.
 */
interface LlmStreamChunkLike {
  type: string
  text?: string
  block?: { type?: string; text?: string }
  reason?: { kind?: string; failure?: unknown }
}

/** One entry of the host LLM runtime's configurable-provider directory. */
export interface LlmProviderEntryLike {
  provider?: string
  id?: string
  [key: string]: unknown
}

export interface LlmModelEntryLike {
  provider?: string
  id?: string
  name?: string
}

/**
 * Minimal structural view of the host LLM runtime. Besides `stream`, the
 * runtime exposes its provider directory (`listConfigurableProviders`) and a
 * per-provider model catalog (`listModels`) — both optional so older hosts
 * still satisfy the face; the settings UI degrades to a free-text field when
 * they are missing.
 */
export interface LlmRuntimeLike {
  stream(options: unknown): AsyncIterable<LlmStreamChunkLike>
  listConfigurableProviders?(): LlmProviderEntryLike[]
  listModels?(provider: string): Promise<Array<LlmModelEntryLike | string>>
}

/**
 * Split a plugin `modelRef` into the provider route and model id the LLM
 * runtime needs to dispatch a call (`provider/model`, e.g. `my9router/Free`).
 * A bare id with no provider cannot select an adapter, so it returns
 * `undefined` and the caller surfaces an honest model-unavailable error rather
 * than guessing a route.
 */
function modelRouteFromRef(modelRef: string | null | undefined): { provider: string; model: string } | undefined {
  const ref = modelRef?.trim()
  if (!ref) return undefined
  const slash = ref.indexOf('/')
  if (slash > 0 && slash < ref.length - 1) {
    return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }
  }
  return undefined
}

function describeLlmFailure(failure: unknown): string {
  if (!failure) return ''
  if (failure instanceof Error) return failure.message
  if (typeof failure === 'string') return failure
  if (typeof failure === 'object') {
    const rec = failure as Record<string, unknown>
    const message = rec['message'] ?? rec['error'] ?? rec['reason']
    if (typeof message === 'string') return message
    try {
      return JSON.stringify(failure)
    } catch {
      /* fall through */
    }
  }
  return String(failure)
}

/**
 * Host AI bridge backed by a single streaming model call. Every consumer
 * (log discovery, inspection analysis, deploy repair) hands the model one
 * self-contained prompt whose data is already inline and expects one JSON
 * answer back, so no tools are wired — a bare text completion is exactly the
 * right capability. The final text is validated by the caller-supplied
 * `validate`; a schema miss or an errored/aborted stream is reported as a
 * structured failure, never a fabricated success.
 */
export function createDshAgentBridge(llm: LlmRuntimeLike): AgentBridge {
  return {
    async run(spec, validate): Promise<StructuredAgentResult> {
      const route = modelRouteFromRef(spec.model)
      if (!route) {
        return {
          ok: false,
          payload: null,
          rawText: '',
          requestCount: 0,
          error: `model ref "${spec.model ?? ''}" is not a provider/model route the LLM runtime can dispatch`,
        }
      }
      const controller = new AbortController()
      const timeoutMs = spec.timeoutMs ?? 240_000
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()
      let deltaText = ''
      let blockText = ''
      let failureDetail = ''
      try {
        const request = {
          provider: route.provider,
          model: route.model,
          messages: [
            {
              id: `dsh-devops-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
              role: 'user',
              content: [{ type: 'text', text: spec.task }],
              source: { kind: 'user' },
            },
          ],
          signal: controller.signal,
        }
        for await (const chunk of llm.stream(request)) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            deltaText += chunk.text
          } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
            blockText += chunk.block.text
          } else if (chunk.type === 'finish') {
            const kind = chunk.reason?.kind
            if (kind === 'error' || kind === 'aborted') failureDetail = describeLlmFailure(chunk.reason?.failure)
          }
        }
      } catch (e) {
        return { ok: false, payload: null, rawText: deltaText || blockText, requestCount: 1, error: e instanceof Error ? e.message : String(e) }
      } finally {
        clearTimeout(timer)
      }
      // prefer incremental deltas; fall back to the assembled text block for
      // adapters that surface the finished block without emitting deltas.
      const text = deltaText.trim() ? deltaText : blockText
      if (!text.trim()) {
        return { ok: false, payload: null, rawText: text, requestCount: 1, error: failureDetail || 'model produced no text' }
      }
      if (failureDetail) {
        // the stream carried partial text but ended in an error/abort; keep the
        // partial output for the caller while flagging the terminal failure.
        const verdict = validate(text)
        if (!verdict.ok) {
          return { ok: false, payload: null, rawText: text, requestCount: 1, error: verdict.error }
        }
        return { ok: false, payload: verdict.value, rawText: text, requestCount: 1, error: failureDetail }
      }
      const verdict = validate(text)
      if (!verdict.ok) {
        return { ok: false, payload: null, rawText: text, requestCount: 1, error: verdict.error }
      }
      return { ok: true, payload: verdict.value, rawText: text, requestCount: 1 }
    },
    async cancel(sessionId) {
      void sessionId
      // one-shot calls settle with their stream/timeout; nothing to persist
    },
  }
}

/** Exported for tests: memory storage double. */
export { MemoryStorage }
