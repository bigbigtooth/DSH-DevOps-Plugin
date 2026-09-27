import { describe, expect, it } from 'vitest'
import { nextStatus, canTransition, failOrReconcile, isTerminal, InvalidTransitionError } from '../../src/contracts/deployment-state.ts'
import { OPS_ERROR_CODES, OpsError, err } from '../../src/contracts/errors.ts'
import { serverSchema, deploymentRunSchema, logSourceSchema, scriptVersionSchema } from '../../src/contracts/entities.ts'
import { apiEndpoints, projectEditableSchema } from '../../src/contracts/api.ts'

describe('deployment state machine', () => {
  it('QUEUED → RUNNING → SUCCEEDED', () => {
    expect(nextStatus('QUEUED', 'START')).toBe('RUNNING')
    expect(nextStatus('RUNNING', 'SUCCEED')).toBe('SUCCEEDED')
  })

  it('RUNNING → REPAIRING → RUNNING or FAILED', () => {
    expect(nextStatus('RUNNING', 'ENTER_REPAIR')).toBe('REPAIRING')
    expect(nextStatus('REPAIRING', 'RESUME_FROM_REPAIR')).toBe('RUNNING')
    expect(nextStatus('REPAIRING', 'FAIL')).toBe('FAILED')
  })

  it('stop path: STOPPING → STOPPED only after confirmation', () => {
    expect(nextStatus('RUNNING', 'REQUEST_STOP')).toBe('STOPPING')
    expect(nextStatus('QUEUED', 'REQUEST_STOP')).toBe('STOPPING')
    expect(nextStatus('REPAIRING', 'AUTO_STOP')).toBe('STOPPING')
    expect(nextStatus('STOPPING', 'CONFIRM_STOPPED')).toBe('STOPPED')
  })

  it('unknown outcome routes to RECONCILE_REQUIRED from RUNNING/REPAIRING/STOPPING', () => {
    expect(nextStatus('RUNNING', 'ENTER_RECONCILE')).toBe('RECONCILE_REQUIRED')
    expect(nextStatus('REPAIRING', 'ENTER_RECONCILE')).toBe('RECONCILE_REQUIRED')
    expect(nextStatus('STOPPING', 'ENTER_RECONCILE')).toBe('RECONCILE_REQUIRED')
  })

  it('RECONCILE_REQUIRED resolves by continue or archive', () => {
    expect(nextStatus('RECONCILE_REQUIRED', 'RESOLVE_RECONCILE_CONTINUE')).toBe('RUNNING')
    expect(nextStatus('RECONCILE_REQUIRED', 'RESOLVE_RECONCILE_ARCHIVE')).toBe('FAILED')
  })

  it('terminal states accept nothing', () => {
    for (const s of ['SUCCEEDED', 'FAILED', 'STOPPED'] as const) {
      expect(canTransition(s, 'START')).toBe(false)
      expect(canTransition(s, 'SUCCEED')).toBe(false)
    }
    expect(isTerminal('SUCCEEDED')).toBe(true)
    expect(isTerminal('RUNNING')).toBe(false)
  })

  it('illegal transitions throw a loud error', () => {
    expect(() => nextStatus('QUEUED', 'SUCCEED')).toThrow(InvalidTransitionError)
    expect(() => nextStatus('STOPPED', 'START')).toThrow(InvalidTransitionError)
  })

  it('FAIL with unknown dispatches must route to reconcile', () => {
    expect(failOrReconcile(0)).toBe('FAIL')
    expect(failOrReconcile(1)).toBe('ENTER_RECONCILE')
    expect(failOrReconcile(3)).toBe('ENTER_RECONCILE')
  })
})

describe('error contract', () => {
  it('covers the plan-required failure classes', () => {
    for (const required of ['auth-failed', 'host-fingerprint-changed', 'permission-denied', 'capability-unsupported', 'model-unavailable', 'partial-analysis', 'git-diverged', 'task-occupied', 'result-unknown', 'health-check-failed']) {
      expect(OPS_ERROR_CODES).toContain(required)
    }
  })

  it('errors serialize with code/message/scope/retryable/evidenceRef', () => {
    const e = err('task-occupied', 'repository', 'occupied', { retryable: true, evidenceRef: 'run1' })
    const json = e.toJSON()
    expect(json.code).toBe('task-occupied')
    expect(json.scope).toBe('repository')
    expect(json.retryable).toBe(true)
    expect(json.evidenceRef).toBe('run1')
    expect(OpsError.is(e)).toBe(true)
    expect(OpsError.is(new Error('x'))).toBe(false)
  })
})

describe('entity schemas reject malformed records', () => {
  it('server requires revision ≥ 1 and valid options', () => {
    const base = {
      schemaVersion: 1,
      id: 'srv1',
      revision: 1,
      alias: 'web-1',
      endpoint: 'root@h:22',
      sshOptions: { host: 'h', port: 22, user: 'root', authKind: 'password', jumpHosts: [], extraOptions: {} },
      credentialRefs: ['c1'],
      configHash: 'abc',
      hostFingerprint: 'ssh-ed25519 SHA256:xyz',
      capabilities: { platform: 'unknown', osRelease: '', arch: '', shell: '', probes: {}, probedAt: null },
      createdAt: 1,
      updatedAt: 1,
    }
    expect(serverSchema.safeParse(base).success).toBe(true)
    expect(serverSchema.safeParse({ ...base, revision: 0 }).success).toBe(false)
    expect(serverSchema.safeParse({ ...base, sshOptions: { ...base.sshOptions, port: 0 } }).success).toBe(false)
    expect(serverSchema.safeParse({ ...base, credentialRefs: 'c1' }).success).toBe(false)
  })

  it('deployment run rejects unknown status', () => {
    const run = {
      schemaVersion: 1,
      runId: 'r1',
      requestId: 'q1',
      projectId: 'p1',
      targetId: 't1',
      kind: 'update',
      status: 'RUNNING',
      targetSnapshot: { targetId: 't1', serverId: 's1', codeDir: '/app', repoUrl: 'git@x:y.git', branch: 'main', services: [], healthCheck: null, configRevision: 1 },
      createdAt: 1,
      updatedAt: 1,
    }
    expect(deploymentRunSchema.safeParse(run).success).toBe(true)
    expect(deploymentRunSchema.safeParse({ ...run, status: 'MAYBE' }).success).toBe(false)
  })

  it('log source and script version validate', () => {
    expect(logSourceSchema.safeParse({
      schemaVersion: 1, sourceId: 'l1', projectId: 'p', serverId: 's', service: 'api',
      configOrigin: 'supervisor', path: '/var/log/api.log', status: 'active', discoveredAt: 1,
    }).success).toBe(true)
    expect(scriptVersionSchema.safeParse({
      schemaVersion: 1, scriptVersionId: 'sv1', projectId: 'p', targetId: 't', stage: 'BUILD',
      workDir: '/app', content: '#!/bin/sh\necho hi\n', contentHash: 'x', status: 'candidate',
      sourceDeployment: { runId: 'r1' }, createdAt: 1, updatedAt: 1,
    }).success).toBe(true)
  })
})

describe('api contract', () => {
  it('has all plan-required endpoint groups', () => {
    const names = Object.keys(apiEndpoints)
    expect(names.filter((n) => n.startsWith('servers.')).length).toBeGreaterThanOrEqual(5)
    expect(names).toContain('monitoring.inspect')
    expect(names).toContain('deploy.create')
    expect(names).toContain('deploy.reconcile')
    expect(names).toContain('scripts.list')
  })

  it('editable project requires at least one target', () => {
    expect(projectEditableSchema.safeParse({ name: 'p', repoUrl: 'git@x:y.git', branch: 'main', targets: [] }).success).toBe(false)
    expect(projectEditableSchema.safeParse({ name: 'p', repoUrl: 'git@x:y.git', branch: 'main', targets: [{ serverId: 's', codeDir: '/app' }] }).success).toBe(true)
  })
})
