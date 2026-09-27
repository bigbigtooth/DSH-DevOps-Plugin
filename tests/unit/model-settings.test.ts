/**
 * 设置页 AI 模型配置的纯逻辑：provider/model 选项枚举 + section schema 构建。
 * Schemastery 与 settings 服务都是 duck-type——这里用最小假体固化行为契约。
 */
import { describe, expect, it } from 'vitest'
import { buildModelSectionSchema, enumerateModelChoices, type SchemasteryLike } from '../../src/host/adapters/dsh/model-settings.ts'
import type { LlmRuntimeLike } from '../../src/host/adapters/dsh/runtime.ts'

function fakeZ() {
  const makeField = (kind: string) => {
    const f = {
      kind,
      desc: '',
      def: undefined as unknown,
      description(text: string) {
        f.desc = text
        return f
      },
      default(v: unknown) {
        f.def = v
        return f
      },
    }
    return f
  }
  const z = {
    object(fields: Record<string, unknown>) {
      return { type: 'object', fields }
    },
    string() {
      return makeField('string')
    },
    union(options: string[]) {
      return makeField(`union:${options.join('|')}`)
    },
  }
  return z
}

describe('enumerateModelChoices', () => {
  it('folds provider directory × model catalog into provider/model refs', async () => {
    const llm: LlmRuntimeLike = {
      stream: async function* () {},
      listConfigurableProviders: () => [{ provider: 'my9router' }, { provider: 'minimax-cn' }],
      listModels: async (provider) => (provider === 'my9router' ? [{ id: 'Free' }, { id: 'Coder' }] : [{ id: 'MiniMax-M3', name: 'MiniMax-M3' }]),
    }
    expect(await enumerateModelChoices(llm)).toEqual(['my9router/Free', 'my9router/Coder', 'minimax-cn/MiniMax-M3'])
  })

  it('returns [] when the llm face lacks enumeration or fails', async () => {
    expect(await enumerateModelChoices(null)).toEqual([])
    expect(await enumerateModelChoices({ stream: async function* () {} })).toEqual([])
    const broken: LlmRuntimeLike = {
      stream: async function* () {},
      listConfigurableProviders: () => {
        throw new Error('boom')
      },
      listModels: async () => [],
    }
    expect(await enumerateModelChoices(broken)).toEqual([])
  })

  it('skips a provider whose model catalog rejects and keeps the rest', async () => {
    const llm: LlmRuntimeLike = {
      stream: async function* () {},
      listConfigurableProviders: () => [{ provider: 'bad' }, { provider: 'good' }],
      listModels: async (provider) => {
        if (provider === 'bad') throw new Error('unavailable')
        return ['m1']
      },
    }
    expect(await enumerateModelChoices(llm)).toEqual(['good/m1'])
  })
})

describe('buildModelSectionSchema', () => {
  it('uses a union select with current value preserved when it is exotic', () => {
    const z = fakeZ()
    const schema = buildModelSectionSchema(z as unknown as SchemasteryLike, ['a/one', 'a/two'], 'x/legacy') as { fields: { modelRef: { kind: string; desc: string; def?: unknown } } }
    // 当前值不在目录中：并入选项首位，保证存量配置合法
    expect(schema.fields.modelRef.kind).toBe('union:x/legacy|a/one|a/two')
    expect(schema.fields.modelRef.def).toBe('x/legacy')
    expect(schema.fields.modelRef.desc).toContain('a/one')
  })

  it('falls back to a free-text field when no choices exist', () => {
    const z = fakeZ()
    const schema = buildModelSectionSchema(z as unknown as SchemasteryLike, [], null) as { fields: { modelRef: { kind: string; def?: unknown } } }
    expect(schema.fields.modelRef.kind).toBe('string')
    expect(schema.fields.modelRef.def).toBeUndefined()
  })

  it('defaults to the current modelRef when set', () => {
    const z = fakeZ()
    const schema = buildModelSectionSchema(z as unknown as SchemasteryLike, ['a/one', 'a/two'], 'a/two') as { fields: { modelRef: { kind: string; def?: unknown } } }
    expect(schema.fields.modelRef.kind).toBe('union:a/one|a/two')
    expect(schema.fields.modelRef.def).toBe('a/two')
  })
})
