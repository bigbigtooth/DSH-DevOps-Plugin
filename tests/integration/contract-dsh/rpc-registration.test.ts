import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNEL } from '../../../src/contracts/api.ts'
import { buildRuntime } from '../../../src/host/adapters/dsh/runtime.ts'

type RpcHandler = (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>

class WebServerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }
}

class ConnectionService extends Service {
  readonly routes = new Map<string, RpcHandler>()
  readonly callerContexts: unknown[] = []

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc(): { handle(channel: string, handler: RpcHandler): () => void } {
    // Accessing rpc through the injected service proxy must preserve the
    // callback context; this also verifies that webServer is in the inject list.
    const caller = this.ctx as unknown as { fiber?: { runtime?: unknown }; webServer: WebServerService }
    if (!caller.fiber?.runtime) throw new Error('rpc getter was not evaluated in an injected context')
    void caller.webServer
    this.callerContexts.push(caller)
    return {
      handle: (channel, handler) => {
        this.routes.set(channel, handler)
        return () => {
          this.routes.delete(channel)
        }
      },
    }
  }

  async invoke(channel: string, endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const handler = this.routes.get(channel)
    if (!handler) throw new Error(`RPC route is not registered: ${channel}`)
    return handler(endpoint, payload, signal)
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function waitForRoute(connection: ConnectionService): Promise<void> {
  for (let attempt = 0; attempt < 20 && connection.routes.size === 0; attempt += 1) await tick()
}

/**
 * Fallback-path doubles: a connection service whose rpc.handle rejects exactly
 * like the real dsh-client-connection under the shipped web composition
 * (strict inject enforcement rejects its internal owner.webServer read), plus
 * a webServer that records prefix routes so the fallback mount can be driven
 * over the documented Connection envelope.
 */
class RejectingConnectionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc(): { handle(channel: string, handler: RpcHandler): () => void } {
    // Mirrors the observed failure of HostConnectionService.register(): the
    // strict webServer read throws before any route is mounted, which is what
    // makes browser RPC calls fall through to the SPA fallback (HTTP 405).
    throw new Error('cannot get property "webServer" without inject')
  }

  requestRejection(request: { headers?: Record<string, string | string[] | undefined> }): number | undefined {
    const auth = request.headers?.['x-test-auth']
    if (auth === 'deny') return 403
    if (auth === undefined) return 401
    return undefined
  }
}

class RoutingWebServerService extends Service {
  readonly prefixRoutes = new Map<string, { handler: (req: unknown, res: unknown) => Promise<void> | void }>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }): () => void {
    if (route.kind !== 'prefix') throw new Error(`unexpected route kind ${route.kind}`)
    this.prefixRoutes.set(route.path, route)
    return () => {
      this.prefixRoutes.delete(route.path)
    }
  }
}

interface CapturedResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function mockResponse(): { res: unknown; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' }
  return {
    captured,
    res: {
      writeHead(status: number, headers?: Record<string, string>) {
        captured.status = status
        if (headers) Object.assign(captured.headers, headers)
      },
      end(body?: string) {
        if (body !== undefined) captured.body += body
      },
    },
  }
}

interface MockRequestSpec {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
}

/** A node-request double whose buffered body is delivered on demand. */
function mockRequest(spec: MockRequestSpec = {}): { req: unknown; deliver(): void } {
  const { method = 'POST', url = `${RPC_CHANNEL}/servers.list`, headers = { 'content-type': 'application/json', 'x-test-auth': 'ok' }, body = '' } = spec
  const listeners = new Map<string, Array<(arg?: unknown) => void>>()
  const req = {
    method,
    url,
    headers,
    on(event: string, listener: (arg?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
    removeListener(event: string, listener: (arg?: unknown) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener))
      return req
    },
  }
  return {
    req,
    deliver() {
      for (const listener of listeners.get('data') ?? []) listener(Buffer.from(body, 'utf8'))
      for (const listener of listeners.get('end') ?? []) listener()
    },
  }
}

/** Drive the fallback route; the buffered body is delivered once readBody has subscribed. */
async function dispatch(route: { handler: (req: unknown, res: unknown) => Promise<void> | void }, mock: { req: unknown; deliver(): void }): Promise<CapturedResponse> {
  const { res, captured } = mockResponse()
  const promise = route.handler(mock.req, res)
  queueMicrotask(() => mock.deliver())
  await promise
  return captured
}

function envelopeOf(captured: CapturedResponse): { type: string; rpcId: string; result: { ok: boolean; value?: unknown; error?: { code: string; details: Record<string, unknown> } } } {
  return JSON.parse(captured.body)
}

describe('host RPC fallback when rpc.handle is rejected by the composition', () => {
  it('mounts the channel on webServer and speaks the Connection envelope end-to-end', async () => {
    const ctx = new Context()
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-rpc-fallback-'))
    const handler = async (endpoint: string, payload: unknown): Promise<unknown> => {
      if (endpoint === 'servers.fail') {
        return { ok: false, error: { code: 'auth-failed', message: 'boom', scope: 'ssh', retryable: false, details: {} } }
      }
      return { ok: true, value: { endpoint, payload } }
    }

    try {
      const plugin = await ctx.plugin(async (pluginCtx) => {
        const runtime = buildRuntime(pluginCtx, { dataDir, modelRef: null })
        await runtime.registerRpc(RPC_CHANNEL, handler)
      })

      const web = new RoutingWebServerService(ctx)
      new RejectingConnectionService(ctx)
      for (let attempt = 0; attempt < 50 && web.prefixRoutes.size === 0; attempt += 1) await tick()
      expect(web.prefixRoutes.size).toBe(1)
      const route = web.prefixRoutes.get(RPC_CHANNEL)!

      // happy path: 200 + server-response envelope, payload parsed from body
      const ok = await dispatch(route, mockRequest({ body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'servers.list', payload: { a: 1 } }) }))
      expect(ok.status).toBe(200)
      expect(ok.headers['content-type']).toBe('application/json')
      const okEnvelope = envelopeOf(ok)
      expect(okEnvelope).toMatchObject({ type: 'server-response', rpcId: 'r1' })
      expect(okEnvelope.result).toEqual({ ok: true, value: { endpoint: 'servers.list', payload: { a: 1 } } })

      // error envelope keeps details (browser parseConnectionResponse requires it)
      const fail = await dispatch(route, mockRequest({ url: `${RPC_CHANNEL}/servers.fail`, body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'servers.fail', payload: {} }) }))
      expect(fail.status).toBe(200)
      const failEnvelope = envelopeOf(fail)
      expect(failEnvelope.rpcId).toBe('r2')
      expect(failEnvelope.result.ok).toBe(false)
      expect(failEnvelope.result.error?.code).toBe('auth-failed')
      expect(failEnvelope.result.error?.details).toEqual({})

      // method/endpoint mismatch is a gateway envelope error, not a transport failure
      const mismatch = await dispatch(route, mockRequest({ body: JSON.stringify({ type: 'client-request', rpcId: 'r3', method: 'other.endpoint', payload: {} }) }))
      expect(mismatch.status).toBe(200)
      expect(envelopeOf(mismatch).result.error?.code).toBe('gateway/bad-request')

      await plugin.dispose()
      expect(web.prefixRoutes.size).toBe(0)
    } finally {
      await ctx.fiber.dispose().catch(() => undefined)
    }
  })

  it('keeps the documented non-200 semantics: fence, method, content type, endpoint', async () => {
    const ctx = new Context()
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-rpc-fallback-2-'))
    const handler = async (): Promise<unknown> => ({ ok: true, value: null })

    try {
      const plugin = await ctx.plugin(async (pluginCtx) => {
        const runtime = buildRuntime(pluginCtx, { dataDir, modelRef: null })
        await runtime.registerRpc(RPC_CHANNEL, handler)
      })

      const web = new RoutingWebServerService(ctx)
      new RejectingConnectionService(ctx)
      for (let attempt = 0; attempt < 50 && web.prefixRoutes.size === 0; attempt += 1) await tick()
      const route = web.prefixRoutes.get(RPC_CHANNEL)!

      // auth fence first (401 without browser credentials, 403 forbidden)
      const unauthorized = await dispatch(route, mockRequest({ headers: { 'content-type': 'application/json' } }))
      expect(unauthorized.status).toBe(401)
      const forbidden = await dispatch(route, mockRequest({ headers: { 'content-type': 'application/json', 'x-test-auth': 'deny' } }))
      expect(forbidden.status).toBe(403)

      // non-POST and malformed endpoint paths are 404 (a well-formed but
      // unknown endpoint is a dispatcher-level not-found envelope, not a
      // transport 404 — matching the platform's rpcFetchHandler)
      expect((await dispatch(route, mockRequest({ method: 'GET' }))).status).toBe(404)
      expect((await dispatch(route, mockRequest({ url: `${RPC_CHANNEL}/no~such` }))).status).toBe(404)

      // wrong content type is 415
      expect((await dispatch(route, mockRequest({ headers: { 'content-type': 'text/plain', 'x-test-auth': 'ok' } }))).status).toBe(415)

      await plugin.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => undefined)
    }
  })
})

describe('host RPC registration on real Cordis', () => {
  it('waits for delayed dependencies, forwards calls, and cleans up on plugin unload', async () => {
    const ctx = new Context()
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-rpc-contract-'))
    const handlerCalls: Array<{ endpoint: string; payload: unknown; signal: AbortSignal }> = []
    const payload = { serverId: 'server-1' }
    const signal = new AbortController().signal
    const handler = async (endpoint: string, request: unknown, requestSignal?: AbortSignal) => {
      if (!requestSignal) throw new Error('RPC handler did not receive an AbortSignal')
      handlerCalls.push({ endpoint, payload: request, signal: requestSignal })
      return { endpoint, payload: request, signal: requestSignal }
    }

    try {
      const plugin = ctx.plugin(async (pluginCtx) => {
        const runtime = buildRuntime(pluginCtx, { dataDir, modelRef: null })
        await runtime.registerRpc(RPC_CHANNEL, handler)
      })
      await plugin

      // Neither dependency is ready yet, so registration must remain pending.
      expect(ctx.get('connection')).toBeUndefined()
      expect(ctx.get('webServer')).toBeUndefined()

      new WebServerService(ctx)
      await tick()
      expect(ctx.get('webServer')).toBeDefined()

      const connection = new ConnectionService(ctx)
      await waitForRoute(connection)
      expect(connection.routes.size).toBe(1)
      expect(connection.callerContexts).toHaveLength(1)

      const response = await connection.invoke(RPC_CHANNEL, 'servers.verify', payload, signal)
      expect(response).toEqual({ endpoint: 'servers.verify', payload, signal })
      expect(handlerCalls).toEqual([{ endpoint: 'servers.verify', payload, signal }])

      await plugin.dispose()
      expect(connection.routes.size).toBe(0)
    } finally {
      await ctx.fiber.dispose().catch(() => undefined)
    }
  })
})
