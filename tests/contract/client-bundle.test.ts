/**
 * Contract test for the BUILT client bundle (`dist/client/client.js`).
 *
 * The web host never imports this file as a module. Its browser side executes
 * each client bundle as a plain script whose only job is to call
 * `window.__ModuleLoader__.load({ id, factory })`, then materializes the plugin
 * by calling `factory(require)` on first import and handing the RESULT to
 * `cordis`'s `Loader.unwrapExports` → `registry.plugin`.
 *
 * `registry.plugin` accepts only a function or an object carrying `apply`.
 * `unwrapExports` returns `exports.default ?? exports`, so a factory that
 * never assigns `exports.apply` yields a plain object — which is exactly the
 * "invalid plugin, expect function or object with an 'apply' method" boot
 * failure. Nothing else in the suite executes the bundle, so this test is the
 * only guard on the hand-written wrapper in `scripts/build.mjs`.
 */
import { describe, expect, it, beforeAll, onTestFinished } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRequire } from 'node:module'
import { Context, Service } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'

const runtimeRequire = createRequire(import.meta.url)
const root = new URL('../..', import.meta.url).pathname
const bundlePath = join(root, 'dist/client/client.js')

/** Always rebuild so this contract cannot accidentally exercise stale dist output. */
function ensureBundle(): string {
  execFileSync('node', [join(root, 'scripts/build.mjs')], { stdio: 'ignore' })
  return readFileSync(bundlePath, 'utf8')
}

interface Captured {
  id: string
  factory: (require: (spec: string) => unknown) => unknown
}

/** Execute the bundle in a minimal browser sandbox and capture its registration. */
function captureRegistration(code: string): Captured {
  let captured: Captured | undefined
  const sandbox: Record<string, unknown> = {
    window: { __ModuleLoader__: { load: (spec: Captured) => { captured = spec } } },
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  if (!captured) throw new Error('bundle never called window.__ModuleLoader__.load')
  return captured
}

interface ElementLike {
  type: unknown
  props: Record<string, unknown>
}

interface Registration {
  options: Record<string, unknown>
  component: unknown
  disposed: boolean
}

/** A real Cordis service whose inject cleanup belongs to the active plugin fiber. */
class SlotsService extends Service {
  readonly injected: string[] = []
  readonly registrations: Registration[] = []

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(slot: string, factory: () => () => void): void {
    this.injected.push(slot)
    const dispose = factory()
    this.ctx.effect(() => dispose, `slots.inject(${slot})`)
  }

  register(options: Record<string, unknown>, component: unknown): () => void {
    if (options.name === 'main' && !options.key) {
      throw new Error('keyed main slot registration requires options.key')
    }
    const registration: Registration = { options, component, disposed: false }
    this.registrations.push(registration)
    return () => {
      registration.disposed = true
    }
  }
}

class ConnectionService extends Service {
  readonly rpc = {
    call: async () => ({
      ok: false as const,
      error: { code: 'test', message: 'test connection', scope: 'test', retryable: true },
    }),
  }

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }
}

class LayoutService extends Service {
  readonly selected: Array<string | null> = []

  constructor(ctx: Context) {
    super(ctx, 'layout')
  }

  selectPanel(id: string | null): void {
    this.selected.push(id)
  }
}

function findElement(node: unknown, predicate: (element: ElementLike) => boolean): ElementLike | undefined {
  if (!node || typeof node !== 'object') return undefined
  const candidate = node as Partial<ElementLike>
  if ('type' in candidate && 'props' in candidate && candidate.props && predicate(candidate as ElementLike)) {
    return candidate as ElementLike
  }
  const children = (candidate.props as Record<string, unknown> | undefined)?.children
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElement(child, predicate)
      if (found) return found
    }
  } else {
    return findElement(children, predicate)
  }
  return undefined
}

function registerServices(ctx: Context): { slots: SlotsService; layout: LayoutService } {
  const slots = new SlotsService(ctx)
  new ConnectionService(ctx)
  const layout = new LayoutService(ctx)
  // Match the web host's strict loader policy: a plugin may only read services
  // listed in its Cordis `inject` declaration.
  ;(ctx.events as unknown as { on: (event: string, fn: (ctx: Context, name: string, error: Error, next: () => unknown) => unknown) => void }).on(
    'internal/get',
    (accessCtx: Context, name: string, _error: Error, next: () => unknown) => {
      if (name in accessCtx.fiber.inject) return next()
      throw _error
    },
  )
  return { slots, layout }
}

describe('built client bundle honours the DSH module-loader contract (S-web)', () => {
  let code: string

  beforeAll(() => {
    code = ensureBundle()
  })

  it('registers itself under its own package id', () => {
    const captured = captureRegistration(code)
    expect(captured.id).toBe('dsh-devops')
    expect(typeof captured.factory).toBe('function')
  })

  it('materializes an export the cordis registry accepts as a plugin', () => {
    const captured = captureRegistration(code)
    const exports = captured.factory(runtimeRequire) as Record<string, unknown>

    // registry.resolve() accepts a function, or an object with a callable apply.
    const asPlugin = exports as { default?: unknown; apply?: unknown }
    const unwrapped = asPlugin.default ?? exports
    const acceptable =
      typeof unwrapped === 'function' ||
      (typeof unwrapped === 'object' && unwrapped !== null && typeof (unwrapped as { apply?: unknown }).apply === 'function')

    expect(
      acceptable,
      `loader would reject this export shape and abort web boot with ` +
        `"invalid plugin, expect function or object with an 'apply' method, received object". ` +
        `Received keys: ${JSON.stringify(Object.keys(exports))}`,
    ).toBe(true)
  })

  it('exports apply and the declared inject list', () => {
    const captured = captureRegistration(code)
    const exports = captured.factory(runtimeRequire) as { apply?: unknown; inject?: unknown }
    expect(typeof exports.apply).toBe('function')
    expect(exports.inject).toEqual(['slots', 'connection', 'layout'])
  })

  it('loads through real cordis, wires all slots, navigates, and disposes cleanly', async () => {
    const captured = captureRegistration(code)
    const exports = captured.factory(runtimeRequire) as { apply: (ctx: unknown) => void; inject: string[] }
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const { slots, layout } = registerServices(ctx)

    const fiber = ctx.plugin(exports)
    await expect(fiber).resolves.toBeDefined()

    expect(slots.injected).toEqual(['sidebar.footer.action', 'sidebar.panellist', 'main'])
    expect(slots.registrations.map((r) => r.options.name)).toEqual(['sidebar.footer.action', 'sidebar.panellist', 'main'])
    // the panellist row and the main panel must address the same panel id
    const panelId = slots.registrations.find((r) => r.options.name === 'sidebar.panellist')?.options.id
    expect(panelId).toBeTruthy()
    expect(slots.registrations.find((r) => r.options.name === 'main')?.options.key).toBe(panelId)
    const panelList = slots.registrations.find((r) => r.options.name === 'sidebar.panellist')
    expect(typeof panelList?.component).toBe('function')
    // entry icon is a stroke SVG now (was the ⚙︎ text glyph)
    expect(renderToStaticMarkup(createElement(panelList!.component as ComponentType))).toContain('<svg')

    const footer = slots.registrations.find((r) => r.options.name === 'sidebar.footer.action')
    const footerButton = typeof footer?.component === 'function'
      ? footer.component({ wide: true }) as ElementLike
      : undefined
    expect(footerButton?.type).toBe('button')
    ;(footerButton?.props.onClick as (() => void) | undefined)?.()
    expect(layout.selected).toEqual(['dsh-devops-panel'])

    const main = slots.registrations.find((r) => r.options.name === 'main')
    const panel = typeof main?.component === 'function' ? main.component() : undefined
    const backButton = findElement(panel, (element) => element.type === 'button' && typeof element.props.onClick === 'function')
    expect(backButton).toBeDefined()
    ;(backButton?.props.onClick as (() => void) | undefined)?.()
    expect(layout.selected).toEqual(['dsh-devops-panel', null])

    await fiber.dispose()
    expect(slots.registrations.every((r) => r.disposed)).toBe(true)
  })

  it('makes an underdeclared local plugin fail at the real Cordis injection guard', async () => {
    const captured = captureRegistration(code)
    const exports = captured.factory(runtimeRequire) as { apply: (ctx: unknown) => void; inject: string[] }
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    registerServices(ctx)

    const underdeclared = { ...exports, inject: ['slots'] }
    const fiber = ctx.plugin(underdeclared)
    let startupError: unknown
    try {
      await fiber
    } catch (error) {
      startupError = error
    }
    expect(startupError).toBeInstanceOf(Error)
    expect((startupError as Error).message).toContain('cannot get property "connection" without inject')
  })
})
