/**
 * 面板内「AI 模型」设置界面。
 * DSH 设置页对第三方插件没有通用配置渲染（Models/Plugins 标签均为第一方
 * 手写面板），因此本插件在自身面板提供配置入口：级联下拉选择
 * provider → model，经 settings.model.get/set 读写宿主 modelRef——立即生效
 * （活引用），宿主 settings 服务在场时持久化（重启保留）。
 */
import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { OpsClient } from '../model.ts'
import { Icon } from '../icons.tsx'
import { colors, radii, resolveOpaqueDialogBase } from '../theme.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
function h(tag: any, props: any, ...children: any[]): ReactElement {
  return createElement(tag, props, ...children)
}

interface ProvidersResponse {
  modelRef: string | null
  providers: Array<{ id: string; models: string[] }>
}

const selectStyle: Record<string, string | number> = {
  padding: '11px 14px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`,
  background: 'transparent', color: 'inherit', fontSize: 15, fontWeight: 600, flex: 1, minWidth: 260, cursor: 'pointer',
}
const labelStyle: Record<string, string | number> = { fontSize: 14.5, width: 88, color: colors.muted, flexShrink: 0 }

export function AiModelSettingsModal({ client, onClose }: { client: OpsClient; onClose: () => void }): ReactElement {
  // 弹窗底色必须不透明：surface 是半透明的，直接垫在页面上会透出下层内容。
  // resolveOpaqueDialogBase 从宿主主题解析出不透明基色，再用 linear-gradient
  // 把半透明 surface 叠加其上（与部署进度弹窗同一方案）。
  const [dialogBg] = useState(resolveOpaqueDialogBase)
  const [data, setData] = useState<ProvidersResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    client.call('settings.model.get', {}).then((res) => {
      if (!alive) return
      if (!res.ok) {
        setLoadError(`${res.error.code}: ${res.error.message}`)
        return
      }
      const value = res.value as ProvidersResponse
      setData(value)
      const ref = value.modelRef ?? ''
      const slash = ref.indexOf('/')
      if (slash > 0) {
        setProvider(ref.slice(0, slash))
        setModel(ref.slice(slash + 1))
      } else if (value.providers[0]) {
        setProvider(value.providers[0].id)
        setModel(value.providers[0].models[0] ?? '')
      }
    }).catch((e: unknown) => {
      if (alive) setLoadError(e instanceof Error ? e.message : String(e))
    })
    return () => {
      alive = false
    }
  }, [client])

  const providerList = data?.providers ?? []
  const modelList = providerList.find((p) => p.id === provider)?.models ?? []
  const dirty = data !== null && (provider && model ? `${provider}/${model}` : null) !== (data.modelRef ?? null)

  const save = async (): Promise<void> => {
    const ref = provider && model ? `${provider}/${model}` : null
    setSaving(true)
    setMsg(null)
    const res = await client.call('settings.model.set', { modelRef: ref })
    setSaving(false)
    if (!res.ok) {
      setMsg({ ok: false, text: `保存失败：${res.error.message}` })
      return
    }
    setData((prev) => (prev ? { ...prev, modelRef: ref } : prev))
    setMsg({
      ok: true,
      text: res.value.persisted ? '已保存并立即生效（重启后保留）' : '已保存并立即生效（仅本会话：宿主 settings 服务不可用）',
    })
  }

  return h('div', {
    onClick: onClose,
    style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 },
  },
    h('div', {
      className: 'dsh-anim-card',
      onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
      style: {
        width: 'min(680px, 94vw)', border: `1px solid ${colors.border}`, borderRadius: radii.lg,
        padding: '24px 28px', boxShadow: '0 12px 40px rgba(0,0,0,.35)',
        background: `linear-gradient(${colors.surface}, ${colors.surface}), ${dialogBg}`,
        display: 'flex', flexDirection: 'column', gap: 18,
      },
    },
      // header
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
        h(Icon, { name: 'cpu', size: 26, color: colors.primary }),
        h('div', { style: { fontWeight: 700, fontSize: 19 } }, 'AI 模型设置'),
        h('span', { style: { flex: 1 } }),
        h('button', { className: 'dsh-btn', onClick: onClose, style: { padding: '7px 16px', borderRadius: radii.sm, border: `1px solid ${colors.borderStrong}`, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 14 } }, '关闭'),
      ),
      h('div', { style: { fontSize: 14.5, color: colors.muted } },
        '首次 AI 部署、巡检与修复所用模型。保存后立即生效，无需重启。'),

      loadError ? h('div', { style: { color: colors.err, fontSize: 14 } }, `读取失败：${loadError}`) : null,

      // provider / model cascading selects
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' } },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
          h('span', { style: labelStyle }, 'Provider'),
          h('select', {
            value: provider,
            onChange: (e: { target: { value: string } }) => {
              setProvider(e.target.value)
              setModel(providerList.find((p) => p.id === e.target.value)?.models[0] ?? '')
            },
            style: selectStyle,
          },
            providerList.length === 0 ? h('option', { value: '' }, data ? '（宿主未暴露任何 provider）' : '加载中…') : null,
            providerList.map((p) => h('option', { key: p.id, value: p.id }, p.id)),
          ),
        ),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
          h('span', { style: labelStyle }, 'Model'),
          modelList.length > 0
            ? h('select', { value: model, onChange: (e: { target: { value: string } }) => setModel(e.target.value), style: selectStyle },
                modelList.map((m) => h('option', { key: m, value: m }, m)))
            : h('input', { value: model, onChange: (e: { target: { value: string } }) => setModel(e.target.value), placeholder: '模型 id', style: { ...selectStyle, cursor: 'text' } }),
        ),
      ),

      // current + actions
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, borderTop: `1px solid ${colors.border}`, paddingTop: 16 } },
        h('span', { style: { fontSize: 14.5, color: colors.muted } },
          '当前：',
          h('b', { style: { fontSize: 15 } }, data?.modelRef ?? '（未配置）')),
        h('span', { style: { flex: 1 } }),
        msg ? h('span', { style: { fontSize: 13.5, color: msg.ok ? colors.ok : colors.err } }, msg.text) : null,
        h('button', {
          className: 'dsh-btn',
          disabled: saving || !dirty,
          onClick: () => void save(),
          style: { padding: '10px 26px', borderRadius: radii.sm, border: `1px solid ${colors.primaryBorder}`, background: colors.primarySoft, color: 'inherit', cursor: saving || !dirty ? 'default' : 'pointer', fontWeight: 700, fontSize: 15, opacity: saving || !dirty ? 0.6 : 1 },
        }, saving ? '保存中…' : '保存'),
      ),
    ),
  )
}
