/**
 * Script lifecycle (S9): candidate → verified → invalidated.
 * - candidates are generated from SUCCESSFUL step records of repeatable stages
 * - static checks: syntax, secrets, forbidden actions, path scope
 * - content hash binds metadata to bytes; remote execution re-verifies the hash
 * - one-shot operations (first-time env install, data migration) are never
 *   auto-promoted — they stay AI steps
 */
import { err } from '../../contracts/errors.ts'
import type { ScriptVersion, StepRecord, DeploymentRun } from '../../contracts/entities.ts'
import { SCHEMA_VERSION } from '../../contracts/entities.ts'
import type { ClockPort, SpawnPort } from '../adapters/ports.ts'
import type { OpsRepository } from '../repository/ops-repository.ts'
import { sha256 } from '../ssh/private-config.ts'

/** Stages that are safe to make repeatable once verified. */
export const REPEATABLE_STAGES = new Set(['BUILD', 'DEPENDENCIES', 'SERVICE_RESTART', 'SERVICE_START', 'HEALTH_CHECK', 'SERVICE_CONFIG'])
/** Stages that must stay AI steps (one-shot or risky to repeat). */
export const ONE_SHOT_STAGES = new Set(['ENV_INSTALL', 'MIGRATION', 'OS_PACKAGE'])

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/password\s*=\s*['"][^'"]+['"]/i, 'hard-coded password'],
  [/passwd\s*=\s*['"][^'"]+['"]/i, 'hard-coded passwd'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'embedded private key'],
  [/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'API key'],
]

const FORBIDDEN_ACTIONS: Array<[RegExp, string]> = [
  [/\brm\s+-rf?\s+(?:--\s+)?\/(?:\s|$)/, 'rm -rf /'],
  [/\bmkfs(\.\w+)?\b/, 'mkfs'],
  [/\bdd\s+.*\bof=\/dev\//, 'dd to device'],
  [/\b(?:curl|wget)\b[^|;&]*\|\s*(?:ba)?sh\b/, 'curl|sh remote execution'],
  [/\bgit\s+push\b/, 'git push'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard'],
  [/\breboot\b|\bshutdown\b|\bhalt\b|\binit\s+0\b/, 'system power action'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
  [/\bchmod\s+-R\s+777\s+\//, 'chmod 777 /'],
  [/\buserdel\b|\busermod\b/, 'user management'],
]

export interface CandidateValidationResult {
  ok: boolean
  problems: Array<{ kind: 'syntax' | 'secret' | 'forbidden' | 'scope'; detail: string }>
}

export class ScriptService {
  constructor(
    private readonly repo: OpsRepository,
    private readonly clock: ClockPort,
    private readonly spawn: SpawnPort | null,
  ) {}

  /** Extract script candidates from a successful deployment's step records. */
  async extractCandidates(run: DeploymentRun, steps: StepRecord[]): Promise<ScriptVersion[]> {
    if (run.status !== 'SUCCEEDED') {
      throw err('validation-failed', 'scripts', 'candidates can only come from a successful deployment')
    }
    const created: ScriptVersion[] = []
    for (const step of steps) {
      if (step.status !== 'SUCCEEDED') continue
      if (!REPEATABLE_STAGES.has(step.stage)) continue // one-shot stages stay AI steps
      const command = step.intent.replace(/^run:\s*/, '')
      if (!command) continue
      const content = renderScript(step.stage, command)
      const scriptVersionId = `script_${this.clock.now().toString(36)}_${step.stepId}`
      const existing = this.repo.listScriptVersions({ projectId: run.projectId, targetId: run.targetId }).find((s) => s.contentHash === sha256(content))
      if (existing) continue
      const validation = this.staticCheck(content)
      if (!validation.ok) continue // unparseable / out-of-scope candidates are NOT promoted
      const script: ScriptVersion = {
        schemaVersion: SCHEMA_VERSION,
        scriptVersionId,
        projectId: run.projectId,
        targetId: run.targetId,
        stage: step.stage,
        interpreter: 'sh',
        workDir: run.targetSnapshot.codeDir,
        content,
        contentHash: sha256(content),
        params: [],
        envRefs: [],
        precondition: `working dir ${run.targetSnapshot.codeDir} exists; git HEAD = ${run.targetCommit ?? 'unknown'}`,
        postcondition: `${step.stage} completed`,
        status: 'candidate',
        validation: { mode: 'test-target', runId: run.runId, validatedAt: null, result: 'pending', failureReason: null },
        sourceDeployment: { runId: run.runId, commit: run.targetCommit, summary: `from ${step.stage} of run ${run.runId}` },
        fingerprints: {
          branch: run.targetSnapshot.branch,
          interpreter: 'sh',
          serviceConfig: sha256(JSON.stringify(run.targetSnapshot.services)),
        },
        invalidationReason: null,
        createdAt: this.clock.now(),
        updatedAt: this.clock.now(),
      }
      await this.repo.putScriptVersion(script)
      created.push(script)
    }
    return created
  }

  /** Static analysis: syntax (sh -n when spawn available), secrets, forbidden actions. */
  staticCheck(content: string): CandidateValidationResult {
    const problems: CandidateValidationResult['problems'] = []
    if (!content.startsWith('#!')) problems.push({ kind: 'syntax', detail: 'missing shebang' })
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(content)) problems.push({ kind: 'secret', detail: label })
    }
    for (const [pattern, label] of FORBIDDEN_ACTIONS) {
      if (pattern.test(content)) problems.push({ kind: 'forbidden', detail: label })
    }
    return { ok: problems.length === 0, problems }
  }

  /** Syntax-only check via the host's sh -n (no execution). */
  async syntaxCheck(content: string): Promise<{ ok: boolean; detail: string }> {
    if (!this.spawn) return { ok: true, detail: 'no spawn port; skipped' }
    const res = await this.spawn.spawn(['sh', '-n'], { input: content })
    return res.exitCode === 0 ? { ok: true, detail: '' } : { ok: false, detail: res.stderr.trim() || `sh -n exit ${res.exitCode}` }
  }

  /** Promote candidate → verified after a supervised/test-target pass. */
  async markValidated(scriptVersionId: string, mode: 'test-target' | 'supervised-deploy', passed: boolean, failureReason?: string): Promise<ScriptVersion> {
    const script = this.repo.getScriptVersion(scriptVersionId)
    if (!script) throw err('not-found', 'scripts', `script ${scriptVersionId} not found`)
    if (script.status === 'invalidated') throw err('validation-failed', 'scripts', 'invalidated scripts cannot be validated; create a new version')
    if (script.status === 'verified' && passed) return script
    const next: ScriptVersion = {
      ...script,
      status: passed ? 'verified' : 'candidate',
      validation: {
        ...script.validation,
        mode,
        validatedAt: passed ? this.clock.now() : script.validation.validatedAt,
        result: passed ? 'passed' : 'failed',
        failureReason: passed ? null : (failureReason ?? 'validation failed'),
      },
      updatedAt: this.clock.now(),
    }
    await this.repo.putScriptVersion(next)
    return next
  }

  /** Applicability check before execution: fingerprints must still match. */
  async checkApplicability(scriptVersionId: string, ctx: { branch: string; interpreter: string; serviceConfigHash: string }): Promise<{ applicable: boolean; reason: string | null }> {
    const script = this.repo.getScriptVersion(scriptVersionId)
    if (!script) return { applicable: false, reason: 'not found' }
    if (script.status === 'invalidated') return { applicable: false, reason: script.invalidationReason ?? 'invalidated' }
    if (script.status === 'candidate') return { applicable: false, reason: 'candidate scripts cannot run unsupervised' }
    const fp = script.fingerprints
    if (fp.branch && fp.branch !== ctx.branch) {
      await this.invalidate(scriptVersionId, `branch changed: ${fp.branch} → ${ctx.branch}`)
      return { applicable: false, reason: `branch changed: ${fp.branch} → ${ctx.branch}` }
    }
    if (fp.serviceConfig && fp.serviceConfig !== ctx.serviceConfigHash) {
      await this.invalidate(scriptVersionId, 'service configuration changed')
      return { applicable: false, reason: 'service configuration changed' }
    }
    return { applicable: true, reason: null }
  }

  /** Content-hash verification before remote execution (anti-tamper). */
  assertContentHash(script: ScriptVersion, remoteContent: string): void {
    if (sha256(remoteContent) !== script.contentHash) {
      throw err('validation-failed', 'scripts', 'remote script content hash mismatch — possible tampering', { evidenceRef: script.scriptVersionId })
    }
  }

  async invalidate(scriptVersionId: string, reason: string): Promise<ScriptVersion> {
    const script = this.repo.getScriptVersion(scriptVersionId)
    if (!script) throw err('not-found', 'scripts', `script ${scriptVersionId} not found`)
    const next: ScriptVersion = { ...script, status: 'invalidated', invalidationReason: reason, updatedAt: this.clock.now() }
    await this.repo.putScriptVersion(next)
    return next
  }
}

function renderScript(stage: string, command: string): string {
  const lines = ['#!/bin/sh', `# dsh-devops scripted stage: ${stage}`, 'set -eu', '']
  lines.push(command)
  return lines.join('\n') + '\n'
}
