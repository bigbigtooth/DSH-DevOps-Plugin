/**
 * Fallback registration for the `/dsh-devops` RPC channel.
 *
 * `connection.rpc.handle(channel, handler)` is the platform extension point,
 * but dsh-client-connection 0.1.5-rc.2 reads `owner.webServer` inside
 * register() via strict Cordis property access; under the real DSH web
 * composition (plugin loader present) that read throws
 * "cannot get property \"webServer\" without inject" from the consumer's
 * shadow context, the channel route never mounts, and every browser RPC call
 * falls through to the SPA fallback, which answers POST with HTTP 405.
 *
 * When `rpc.handle` throws, this module mounts the same channel directly on
 * `webServer`: the Host/Origin + browser-auth fence comes from the connection
 * service's public `requestRejection`, and the wire protocol is the documented
 * Connection envelope (client-request / server-response) implemented inline.
 */
import type { ApiDispatcher } from '../../api/devops-api.ts'

/** Duck-typed view of the host services this fallback needs. */
export interface FallbackServices {
  connection: { requestRejection(request: unknown): number | undefined }
  webServer: {
    register(route: { kind: 'prefix'; path: string; handler: (req: NodeIncomingMessage, res: NodeServerResponse) => void | Promise<void> }): () => void
  }
}

export interface NodeIncomingMessage {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: never[]) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
}

export interface NodeServerResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): unknown
}

const MAX_BODY_BYTES = 8 * 1024 * 1024
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.split('/').some((s) => s === '' || s === '.' || s === '..' || !ENDPOINT_SEGMENT.test(s))) return undefined
  return endpoint
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function respond(res: NodeServerResponse, status: number, body: string, json = false): void {
  res.writeHead(status, json ? { 'content-type': 'application/json' } : undefined)
  res.end(body)
}

function envelope(rpcId: string, result: unknown): string {
  return JSON.stringify({ type: 'server-response', rpcId, result })
}

function readBody(req: NodeIncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('error', onError)
        reject(new Error('payload too large'))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => resolve(Buffer.concat(chunks).toString('utf8'))
    const onError = (e: Error) => reject(e)
    req.on('data', onData as never)
    req.on('end', onEnd as never)
    req.on('error', onError as never)
  })
}

/**
 * Register the channel prefix route directly on webServer, fencing each
 * request through the connection service's public rejection check. Semantics
 * mirror dsh-client-connection's rpcFetchHandler: 404 non-POST / unknown
 * endpoint, 415 wrong content type, 400 non-JSON body, 200 envelope for
 * validated calls (including business errors), 500 only for bridge faults.
 */
export function registerRpcFallback(svc: FallbackServices, channel: string, handler: ApiDispatcher): () => void {
  const route = {
    kind: 'prefix' as const,
    path: channel,
    handler: async (req: NodeIncomingMessage, res: NodeServerResponse): Promise<void> => {
      try {
        const rejection = svc.connection.requestRejection(req)
        if (rejection !== undefined) {
          respond(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        const endpoint = endpointFromPath(channel, pathname)
        if (req.method !== 'POST' || endpoint === undefined) {
          respond(res, 404, 'not found')
          return
        }
        const contentType = req.headers['content-type']
        const header = Array.isArray(contentType) ? contentType[0] : contentType
        if (header?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          respond(res, 415, 'content type must be application/json')
          return
        }
        let body: string
        try {
          body = await readBody(req, MAX_BODY_BYTES)
        } catch {
          respond(res, 413, 'payload too large')
          return
        }
        let message: unknown
        try {
          message = JSON.parse(body)
        } catch {
          respond(res, 400, 'body is not JSON')
          return
        }
        if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
          respond(res, 400, 'invalid client-request message')
          return
        }
        if (message.method !== endpoint) {
          respond(res, 200, envelope(message.rpcId, {
            ok: false,
            error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} },
          }), true)
          return
        }
        const result = await handler(endpoint, isRecord(message.payload) ? message.payload : {})
        respond(res, 200, envelope(message.rpcId, result), true)
      } catch (e) {
        respond(res, 500, `handler failure: ${String(e)}`)
      }
    },
  }
  return svc.webServer.register(route)
}
