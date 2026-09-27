/**
 * Agent output contract. Every batch must name the processes it actually
 * analyzed; findings must reference real process identities. The server —
 * never the model — decides coverage and validity.
 */
import { z } from 'zod'

export const inspectionReportSchema = z.object({
  /** start tokens of the processes this batch actually analyzed */
  analyzed: z.array(z.string()),
  findings: z
    .array(
      z.object({
        processStartTokens: z.array(z.string()).default([]),
        severity: z.enum(['info', 'warning', 'critical']),
        summary: z.string().min(1),
        evidence: z.string().min(1),
        suggestion: z.string().default(''),
      }),
    )
    .default([]),
})

export type InspectionReport = z.infer<typeof inspectionReportSchema>

export function renderInspectionTask(input: {
  snapshotId: string
  batchId: string
  /** process rows WITH a compact ref id (p0, p1, …) — refs contain no spaces */
  processes: Array<{ ref: string; startToken: string; pid: number; name: string; user: string; rssBytes: number | null; cpuPercent: number | null; state: string }>
  focus: string[]
  expectedStates: Array<{ match: string; expected: string }>
  thresholds: { cpuPercent: number | null; rssBytes: number | null }
  naturalLanguage: string
}): string {
  const lines: string[] = []
  lines.push(`你是服务器进程巡检员。以下是一次进程快照的第 ${input.batchId} 批（快照 ${input.snapshotId}）。`)
  lines.push('逐条分析每个进程是否异常（意外退出状态、异常资源占用、非预期名称等）。')
  if (input.focus.length) lines.push(`重点关注：${input.focus.join('、')}。其余进程仍需覆盖，不得遗漏。`)
  for (const e of input.expectedStates) lines.push(`预期状态：匹配 ${e.match} 的进程应为 ${e.expected}。`)
  if (input.thresholds.cpuPercent !== null) lines.push(`CPU 阈值：${input.thresholds.cpuPercent}%（单核口径，可超过 100）。`)
  if (input.thresholds.rssBytes !== null) lines.push(`内存阈值：${(input.thresholds.rssBytes / 1048576).toFixed(0)} MiB。`)
  if (input.naturalLanguage) lines.push(`用户附加检查要求：${input.naturalLanguage}`)
  lines.push('')
  lines.push('进程列表（ref 为唯一引用 id，报告中只能引用这些 ref）：')
  for (const p of input.processes) {
    lines.push(
      `- ${p.ref} | pid=${p.pid} | ${p.name} | user=${p.user} | rss=${p.rssBytes === null ? 'n/a' : Math.round(p.rssBytes / 1024) + 'MiB'} | cpu=${p.cpuPercent === null ? 'n/a' : p.cpuPercent.toFixed(1) + '%'} | state=${p.state}`,
    )
  }
  lines.push('')
  lines.push('只输出 JSON（不要 markdown）：{"analyzed": ["<ref>", ...], "findings": [{"processStartTokens": [...], "severity": "info|warning|critical", "summary": "...", "evidence": "引用列表中的事实", "suggestion": "..."}]}')
  lines.push('analyzed 必须包含本批全部分析过的 ref；证据只能来自上面的事实数据。没有异常就返回空 findings。')
  return lines.join('\n')
}
