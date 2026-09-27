/**
 * Default monitoring policies, shared by the API layer (lazy get) and the
 * scheduler (auto-ensure each tick so servers added before IMPROVE v0.2 —
 * or with wiped policies — are scheduled again instead of silently never
 * being collected).
 */
import { SCHEMA_VERSION } from '../../contracts/entities.ts'
import type { MonitoringPolicy } from '../../contracts/entities.ts'

export type PolicyKind = 'hardware' | 'process' | 'logs'

export const POLICY_KINDS: readonly PolicyKind[] = ['hardware', 'process', 'logs']

export function defaultPolicyInterval(kind: PolicyKind): number {
  const intervals: Record<PolicyKind, number> = { hardware: 60, process: 300, logs: 300 }
  return intervals[kind]!
}

export function defaultPolicy(serverId: string, kind: PolicyKind, now: number, intervalSeconds?: number): MonitoringPolicy {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `${serverId}:${kind}`,
    serverId,
    kind,
    enabled: true,
    intervalSeconds: intervalSeconds ?? defaultPolicyInterval(kind),
    modelRef: null,
    focusProcessesVersion: 1,
    focusProcesses: [],
    groupingRulesVersion: 1,
    groupingRules: [],
    expectedStatesVersion: 1,
    expectedStates: [],
    thresholdsVersion: 1,
    thresholds: { cpuPercent: null, rssBytes: null },
    logIncludeVersion: 1,
    logInclude: [],
    logIgnoreVersion: 1,
    logIgnore: [],
    scopeVersion: 1,
    scope: 'all',
    naturalLanguageVersion: 1,
    naturalLanguage: '',
    nextRunAt: null,
    updatedAt: now,
  }
}
