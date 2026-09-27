/**
 * dsh-devops client module. Loaded by the DSH web module loader as
 * window.__ModuleLoader__.load({ id: 'dsh-devops', factory }).
 *
 * UI integration (verified against the installed host):
 * - entry button in `sidebar.footer.action` (rendered above Settings)
 * - a full business panel registered on the keyed `main` slot with our own id
 * - a `sidebar.panellist` row addressing the same panel id
 * - open via ctx.layout.selectPanel(<id>); close via selectPanel(null) which
 *   returns to the Conversation — the chat view is never replaced blindly
 */
import { createElement } from 'react'
import { OpsClient, OpsStore, type ConnectionFace } from './model.ts'
import { OpsApp } from './pages/app.tsx'
import { Icon } from './icons.tsx'
import { ANIM_STYLE_ID, ANIM_CSS } from './theme.ts'

const name = 'dsh-devops'
// Cordis guards direct service reads, including reads inside UI callbacks.
const inject = ['slots', 'connection', 'layout']

const PANEL_ID = 'dsh-devops-panel'

/** Install the keyframes/hover stylesheet once; removed on dispose. */
function injectAnimStyles(): () => void {
  // structural DOM access — the project tsconfig intentionally has no DOM lib
  interface StyleLike { id: string; textContent: string; remove(): void }
  interface DocLike {
    getElementById(id: string): StyleLike | null
    createElement(tag: string): StyleLike
    head: { appendChild(node: StyleLike): unknown }
  }
  const doc = (globalThis as { document?: DocLike }).document
  if (!doc) return () => undefined
  let style = doc.getElementById(ANIM_STYLE_ID)
  if (!style) {
    style = doc.createElement('style')
    style.id = ANIM_STYLE_ID
    style.textContent = ANIM_CSS
    doc.head.appendChild(style)
  }
  const installed = style
  return () => {
    installed.remove()
  }
}

interface SlotsLike {
  inject(slot: string, factory: () => () => void): void
  register(options: Record<string, unknown>, component: unknown): (() => void) | void
}

interface CtxLike {
  slots: SlotsLike
  layout?: { selectPanel(id: string | null): void }
  connection?: unknown
  on(event: string, fn: () => void): void
  effect(fn: () => () => void): void
}

function apply(ctx: CtxLike): void {
  const client = new OpsClient(((ctx as { connection?: unknown }).connection ?? null) as ConnectionFace | null)
  const store = new OpsStore()
  ctx.effect(injectAnimStyles)


  // Panel guard: while the user has the panel open, re-select it if it
  // disappears — persistedStack in app.tsx restores the exact view.
  let wantPanel = false
  const openPanel = () => {
    wantPanel = true
    ctx.layout?.selectPanel?.(PANEL_ID)
  }
  const closePanel = () => {
    wantPanel = false
    ctx.layout?.selectPanel?.(null)
  }
  ctx.effect(() => {
    // timers via structural access: sandboxed hosts may not define them
    const g = globalThis as {
      setInterval?: (fn: () => void, ms: number) => unknown
      clearInterval?: (t: unknown) => void
      document?: { querySelector(sel: string): unknown }
    }
    if (typeof g.setInterval !== 'function') return () => undefined
    const timer = g.setInterval(() => {
      if (!wantPanel) return
      if (!g.document?.querySelector('[data-dsh-devops-panel]')) ctx.layout?.selectPanel?.(PANEL_ID)
    }, 2000)
    return () => g.clearInterval?.(timer)
  })

  // footer action — the entry above Settings
  ctx.slots.inject('sidebar.footer.action', () => {
    const off = ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'dsh-devops',
        order: 10,
        label: '远程运维',
      },
      (ownerProps: { wide?: boolean } = {}) =>
        createElement(
          'button',
          {
            title: '远程运维',
            'aria-label': '远程运维',
            onClick: openPanel,
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: ownerProps.wide ? 6 : 0,
              width: '100%',
              padding: ownerProps.wide ? '6px 10px' : '6px',
              borderRadius: 8,
              border: '1px solid rgba(128,128,128,.3)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 12,
            },
          },
          createElement(Icon, { name: 'terminal', size: 16 }),
          ownerProps.wide ? '远程运维' : null,
        ),
    )
    return () => {
      off?.()
    }
  })

  // sidebar panel row addressing our main panel
  ctx.slots.inject('sidebar.panellist', () => {
    const off = ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 50,
        label: '远程运维',
      },
      () => createElement(Icon, { name: 'terminal', size: 16 }),
    )
    return () => {
      off?.()
    }
  })

  // main panel content; returning to chat = selectPanel(null)
  ctx.slots.inject('main', () => {
    const off = ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        label: '远程运维',
      },
      () =>
        createElement(
          'div',
          { 'data-dsh-devops-panel': 'true', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
          createElement(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 16px',
                borderBottom: '1px solid rgba(128,128,128,.25)',
                fontWeight: 600,
              },
            },
            createElement('span', null, '远程运维'),
            createElement(
              'button',
              {
                onClick: closePanel,
                style: { border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' },
              },
              '返回会话',
            ),
          ),
          createElement(
            'div',
            { style: { flex: 1, minHeight: 0, overflow: 'auto' } },
            createElement(OpsApp, { client, store }),
          ),
        ),
    )
    return () => {
      off?.()
    }
  })

  // client-side hygiene: reconnect refreshes the snapshot (never re-dispatches)
  ctx.on('connection/reset', () => {
    void store.refresh(client)
  })
  ctx.effect(() => () => undefined)
}

export { name, inject, apply }
