/**
 * 设置页的 AI 模型配置（provider/model）。
 *
 * 宿主 `settings` 服务的 `installSection` 会把注册的 namespace 渲染到设置页，
 * 表单控件由 Schemastery schema 驱动。本模块负责把宿主 LLM runtime 的
 * provider 目录 + 每家模型目录折叠成 `provider/model` 选项列表，并构建对应
 * schema；LLM 服务缺席或枚举失败时降级为自由文本（诚实可用，不臆造选项）。
 */
import type { LlmProviderEntryLike, LlmRuntimeLike } from './runtime.ts'

/** duck-type 面：只声明用到的 Schemastery 子集，避免编译期依赖宿主包。 */
export interface SchemaLike {
  description(text: string): unknown
  default(value: unknown): unknown
}
export interface SchemasteryLike {
  object(fields: Record<string, unknown>): unknown
  string(): SchemaLike
  union(options: string[]): SchemaLike
}

/** 宿主 settings 服务的安装节面（仅声明用到的方法）。 */
export interface SettingsFace {
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: {
      setSource(source: () => unknown): void
      onChange(): void
    },
  ): void
}

/** 从宿主 LLM runtime 折叠出全部 `provider/model` 选项；失败返回空表。 */
export async function enumerateModelChoices(llm: LlmRuntimeLike | null | undefined): Promise<string[]> {
  if (!llm || typeof llm.listConfigurableProviders !== 'function' || typeof llm.listModels !== 'function') return []
  const out: string[] = []
  try {
    const providers = llm.listConfigurableProviders()
    for (const entry of providers as LlmProviderEntryLike[]) {
      const provider = String(entry?.provider ?? entry?.id ?? '').trim()
      if (!provider) continue
      try {
        const models = await llm.listModels(provider)
        for (const model of models) {
          const id = (typeof model === 'string' ? model : String(model?.id ?? '')).trim()
          if (id) out.push(`${provider}/${id}`)
        }
      } catch {
        // 单个 provider 的模型目录不可用：跳过，不影响其余 provider
      }
    }
  } catch {
    return []
  }
  return [...new Set(out)]
}

/**
 * 构建设置页 schema。有选项 → 单选下拉（当前值不在目录中时并入选项，
 * 保证存量配置合法）；拿不到目录 → 自由文本。值即 `modelRef` 原文，
 * 与组合配置（cordis patch）共用同一存储键。
 */
export function buildModelSectionSchema(z: SchemasteryLike, choices: string[], current: string | null): unknown {
  const options = [...choices]
  if (current && !options.includes(current)) options.unshift(current)
  const hasOptions = options.length > 0
  const modelField = (hasOptions ? z.union(options) : z.string()) as SchemaLike
  modelField.description(
    hasOptions
      ? `AI 使用的模型（provider/model）。可选：${options.join('、')}`
      : 'AI 使用的模型（provider/model，如 my9router/Free）',
  )
  if (current) modelField.default(current)
  else if (hasOptions) modelField.default(options[0]!)
  return z.object({ modelRef: modelField })
}
