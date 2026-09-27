import { describe, expect, it } from 'vitest'
import { OpsClient, OpsStore, newRequestId } from '../../src/client/model.ts'
import type { ConnectionFace } from '../../src/client/model.ts'
import { RPC_CHANNEL } from '../../src/contracts/api.ts'

function makeConnection(): { face: ConnectionFace; calls: Array<{ channel: string; endpoint: string; payload: unknown; signal?: AbortSignal }> } {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown; signal?: AbortSignal }> = []
  const face: ConnectionFace = {
    rpc: {
      async call(channel, endpoint, payload, signal) {
        if (channel !== RPC_CHANNEL) throw new Error(`unexpected RPC channel: ${channel}`)
        calls.push({ channel, endpoint, payload, signal })
        if (endpoint === 'servers.list') return { ok: true, value: [{ id: 's1', alias: 'web' }] }
        if (endpoint === 'projects.list') return { ok: true, value: [] }
        if (endpoint === 'deploy.list') {
          return { ok: true, value: [{ runId: 'r1', status: 'RUNNING' }, { runId: 'r2', status: 'SUCCEEDED' }] }
        }
        if (endpoint === 'deploy.events') {
          const after = (payload as { afterSequence: number }).afterSequence
          // simulate out-of-order arrival: [3, 2] for after=1
          const all = [
            { sequence: 1, type: 'START' },
            { sequence: 2, type: 'STAGE' },
            { sequence: 3, type: 'COMMIT' },
          ]
          return { ok: true, value: all.filter((e) => e.sequence > after).reverse() }
        }
        return { ok: true, value: {} }
      },
    },
  }
  return { face, calls }
}

describe('client model (S11)', () => {
  it('offline connection yields retryable failure, not a fake empty success', async () => {
    const client = new OpsClient(null)
    const res = await client.call('servers.list', {})
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('offline')
  })

  it('uses the exact RPC channel and forwards verify payload and AbortSignal unchanged', async () => {
    const { face, calls } = makeConnection()
    await expect(face.rpc.call(`${RPC_CHANNEL}/extra`, 'servers.list', {}, new AbortController().signal)).rejects.toThrow(
      `unexpected RPC channel: ${RPC_CHANNEL}/extra`,
    )

    const payload = {
      alias: 'staging',
      host: 'example.test',
      port: 22,
      user: 'root',
      authKind: 'password',
      secret: 'secret',
    } as const
    const signal = new AbortController().signal
    const result = await new OpsClient(face).call('servers.verify', payload, signal)

    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ channel: RPC_CHANNEL, endpoint: 'servers.verify', payload, signal }])
  })

  it('store refresh snapshots', async () => {
    const { face } = makeConnection()
    const client = new OpsClient(face)
    const store = new OpsStore()
    await store.refresh(client)
    expect(store.getState().loaded).toBe(true)
    expect(store.getState().servers).toHaveLength(1)
    expect(store.getState().offline).toBe(false)
  })

  it('active run filtering and event replay cursors ignore out-of-order duplicates', async () => {
    const { face } = makeConnection()
    const client = new OpsClient(face)
    const store = new OpsStore()
    await store.refreshRuns(client)
    expect(store.getState().activeRuns.map((r) => r.runId)).toEqual(['r1'])
    const first = await store.replayEvents(client, 'r1')
    expect(first.map((e) => e.sequence)).toEqual([1, 2, 3])
    expect(store.getState().eventCursors['r1']).toBe(3)
    // replay again: cursor prevents reprocessing older events
    const second = await store.replayEvents(client, 'r1')
    expect(second).toHaveLength(0)
  })

  it('browser request ids are unique (client-generated requestId for idempotency)', () => {
    const a = newRequestId()
    const b = newRequestId()
    expect(a).not.toBe(b)
  })
})
