/**
 * Host-integration contract tests.
 *
 * These lock the three defects that made the packaged plugin REFUSE TO LOAD on
 * a real DSH host while the whole existing suite stayed green — the tests all
 * ran against in-repo doubles, so nothing exercised the real loader's edges:
 *
 *  1. A bundle patch row without a `config` key hands `apply` a config of
 *     `undefined` (not `{}`), so a bare `z.object()` failed validation and the
 *     plugin tree aborted with "invalid config".
 *  2. Reading an undeclared service through the context proxy
 *     (`ctx.storageDomain`) THROWS "cannot get property … without inject"
 *     instead of yielding `undefined`; optional services must go through
 *     `ctx.get(name)`.
 *  3. Host storage backends accept only `^[a-z][a-z0-9_]*$` unit names, so the
 *     hyphenated logical domain name must be mapped before `openDomain`.
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../../src/index.ts'
import { toStorageUnitName, buildRuntime } from '../../src/host/adapters/dsh/runtime.ts'
import { RECORD_NAMES, DOMAIN_TABLE_NAMES } from '../../src/host/repository/ops-repository.ts'

describe('host integration: bundle config schema', () => {
  it('accepts an absent config (the loader forwards undefined, never {})', () => {
    const parsed = Config.parse(undefined)
    expect(parsed.dataDir).toContain('.dsh-devops')
    expect(parsed.modelRef).toBeNull()
    expect(parsed.batchBudgetTokens).toBe(8000)
    expect(parsed.retentionDays).toBe(30)
  })

  it('accepts an empty config object and still applies every default', () => {
    expect(Config.parse({})).toEqual(Config.parse(undefined))
  })

  it('honours explicit overrides and rejects malformed ones', () => {
    const parsed = Config.parse({ modelRef: 'deepseek-chat', retentionDays: 7 })
    expect(parsed.modelRef).toBe('deepseek-chat')
    expect(parsed.retentionDays).toBe(7)
    expect(() => Config.parse({ batchBudgetTokens: 1 })).toThrow()
  })

  it('reports the same failures through the standard-schema face cordis uses', () => {
    const ok = Config['~standard'].validate(undefined)
    expect('issues' in ok ? ok.issues : undefined).toBeUndefined()
  })
})

describe('host integration: optional service access', () => {
  /** A context stand-in with the two faces that matter: proxy reads and `get`. */
  const ctxWith = (services: Record<string, unknown>) =>
    ({
      get: (name: string) => services[name],
      effect: () => undefined,
    }) as never

  it('degrades loudly instead of throwing when no host service exists', () => {
    const runtime = buildRuntime(ctxWith({}), { dataDir: '/tmp/dsh-devops-test', modelRef: null })
    expect(runtime.agentBridge).toBeNull()
    expect(runtime.degraded.join('\n')).toMatch(/storageDomain unavailable/)
    expect(runtime.degraded.join('\n')).toMatch(/llm unavailable/)
  })

  it('drives a one-shot completion through ctx.llm.stream and returns the validated payload', async () => {
    const runtime = buildRuntime(ctxWith({
      llm: {
        // a text-delta stream the bridge should reassemble into JSON text
        stream: async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: '{"logs":' }
          yield { type: 'text-delta', index: 0, text: ' [{"path":"/srv/app/logs/a.log"}]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    }), { dataDir: '/tmp/dsh-devops-test-llm', modelRef: 'my9router/Free' })
    expect(runtime.agentBridge).not.toBeNull()
    const res = await runtime.agentBridge!.run(
      { sessionId: 's1', model: 'my9router/Free', task: 'analyze', toolNames: [] },
      (payload) => {
        try {
          return { ok: true as const, value: JSON.parse(String(payload)) }
        } catch {
          return { ok: false as const, error: 'bad json' }
        }
      },
    )
    expect(res.ok).toBe(true)
    expect(res.payload).toEqual({ logs: [{ path: '/srv/app/logs/a.log' }] })
  })

  it('reassembles an adapter that only emits the finished text block (no deltas)', async () => {
    const runtime = buildRuntime(ctxWith({
      llm: {
        stream: async function* () {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"ok":true}' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    }), { dataDir: '/tmp/dsh-devops-test-llm-block', modelRef: 'p/m' })
    const res = await runtime.agentBridge!.run(
      { sessionId: 's', model: 'p/m', task: 't', toolNames: [] },
      (payload) => {
        try {
          return { ok: true as const, value: JSON.parse(String(payload)) }
        } catch {
          return { ok: false as const, error: 'bad json' }
        }
      },
    )
    expect(res.ok).toBe(true)
    expect(res.payload).toEqual({ ok: true })
  })

  it('surfaces an errored/aborted stream as a structured failure, never a fake success', async () => {
    const runtime = buildRuntime(ctxWith({
      llm: {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 500' } } }
        },
      },
    }), { dataDir: '/tmp/dsh-devops-test-llm-err', modelRef: 'p/m' })
    const res = await runtime.agentBridge!.run(
      { sessionId: 's', model: 'p/m', task: 't', toolNames: [] },
      () => ({ ok: true as const, value: null }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/upstream 500/)
  })

  it('rejects a model ref with no provider route instead of guessing an adapter', async () => {
    const runtime = buildRuntime(ctxWith({
      llm: { stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } },
    }), { dataDir: '/tmp/dsh-devops-test-llm-route', modelRef: 'just-a-model' })
    const res = await runtime.agentBridge!.run(
      { sessionId: 's', model: 'just-a-model', task: 't', toolNames: [] },
      () => ({ ok: true as const, value: null }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/provider\/model/)
  })

  it('routes storageDomain through ctx.get, maps the unit name, declares every table', async () => {
    const seen: Array<{ name: string; tables: string[] }> = []
    const runtime = buildRuntime(
      ctxWith({
        storageDomain: {
          open: async (spec: { name: string; tables: Record<string, unknown> }) => {
            seen.push({ name: spec.name, tables: Object.keys(spec.tables) })
            return { get: () => undefined, put: () => undefined, delete: () => undefined, list: () => [] }
          },
        },
      }),
      { dataDir: '/tmp/dsh-devops-test', modelRef: null },
    )
    await runtime.storage.openDomain('dsh-devops')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.name).toBe('dsh_devops')
    // The host throws "declares no table '<name>'" for anything absent, and the
    // repository's FIRST action is iterating every record name — declared under
    // its host-legal (sanitized) name.
    expect(seen[0]!.tables).toEqual(expect.arrayContaining(RECORD_NAMES.map(toStorageUnitName)))
    expect(seen[0]!.tables).toEqual(expect.arrayContaining(['backup_servers', 'backup_deployment_runs']))
  })

  it('maps every host-visible table name to the storage name grammar', async () => {
    const HOST_NAME_RE = /^[a-z][a-z0-9_]*$/
    const seen: string[] = []
    const runtime = buildRuntime(
      ctxWith({
        storageDomain: {
          open: async (spec: { tables: Record<string, unknown> }) => {
            seen.push(...Object.keys(spec.tables))
            return { table: () => ({}) }
          },
        },
      }),
      { dataDir: '/tmp/dsh-devops-test', modelRef: null },
    )
    await runtime.storage.openDomain('dsh-devops')
    for (const table of seen) expect(table, table).toMatch(HOST_NAME_RE)
    expect(seen).toContain('inspection_runs')
    expect(seen).toContain('deployment_runs')
    expect(seen).toContain('backup_step_records')
    // Distinct logical names must not collide after sanitization.
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('keeps business code on logical table names across the boundary', async () => {
    const asked: string[] = []
    const runtime = buildRuntime(
      ctxWith({
        storageDomain: {
          open: async () => ({
            table: (hostName: string) => {
              asked.push(hostName)
              return { entries: () => [] }
            },
          }),
        },
      }),
      { dataDir: '/tmp/dsh-devops-test', modelRef: null },
    )
    const domain = await runtime.storage.openDomain('dsh-devops')
    domain.table('inspectionRuns')
    expect(asked).toEqual(['inspection_runs'])
  })

  it('opening the domain really exposes every table the repository queries', async () => {
    // A faithful stand-in for the host: only declared names resolve.
    const declared = new Map<string, unknown>()
    const runtime = buildRuntime(
      ctxWith({
        storageDomain: {
          open: async (spec: { name: string; tables: Record<string, unknown> }) => {
            for (const table of Object.keys(spec.tables)) declared.set(table, new Map())
            return {
              table: (name: string) => {
                const found = declared.get(name)
                if (found === undefined) throw new Error(`domain '${spec.name}' declares no table '${name}'`)
                return { entries: () => [], get: () => undefined, put: async () => undefined, update: async () => undefined, delete: async () => undefined }
              },
            }
          },
        },
      }),
      { dataDir: '/tmp/dsh-devops-test', modelRef: null },
    )
    const domain = await runtime.storage.openDomain('dsh-devops')
    for (const table of RECORD_NAMES) expect(() => domain.table(table)).not.toThrow()
    expect(() => domain.table('nope')).toThrow(/declares no table/)
  })

  it('does not trip the proxy when the context lacks a service entirely', () => {
    // A context without any `get` must still produce a usable degraded runtime.
    const bare = { effect: () => undefined } as never
    expect(() => buildRuntime(bare, { dataDir: '/tmp/dsh-devops-test', modelRef: null })).not.toThrow()
  })
})

describe('host integration: storage unit names', () => {
  const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

  it('maps this plugin\'s own hyphenated domain name to a legal unit name', () => {
    expect(toStorageUnitName('dsh-devops')).toBe('dsh_devops')
    expect(UNIT_NAME_RE.test(toStorageUnitName('dsh-devops'))).toBe(true)
  })

  it('keeps already-legal names unchanged and sanitizes the rest', () => {
    expect(toStorageUnitName('dsh_devops')).toBe('dsh_devops')
    expect(toStorageUnitName('DSH-DevOps')).toBe('dsh_dev_ops')
    expect(toStorageUnitName('inspectionRuns')).toBe('inspection_runs')
    expect(toStorageUnitName('a.b:c')).toBe('a_b_c')
    expect(UNIT_NAME_RE.test(toStorageUnitName('9-lives'))).toBe(true)
    expect(toStorageUnitName('---')).toBe('dsh_plugin')
  })
})
