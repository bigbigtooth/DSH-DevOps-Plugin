/**
 * Stable error vocabulary shared by Host services, the RPC layer and the Client.
 * Every failure is an OpsError: code + message + scope + retryable (+ evidenceRef).
 * Catching an exception and returning an empty list is never a success path.
 */

export const OPS_ERROR_CODES = [
  'auth-failed',
  'host-fingerprint-changed',
  'permission-denied',
  'capability-unsupported',
  'model-unavailable',
  'partial-analysis',
  'git-diverged',
  'task-occupied',
  'result-unknown',
  'health-check-failed',
  'validation-failed',
  'not-found',
  'conflict',
  'storage-failed',
  'timeout',
  'cancelled',
  'internal',
] as const

export type OpsErrorCode = (typeof OPS_ERROR_CODES)[number]

export type OpsErrorScope =
  | 'ssh'
  | 'vault'
  | 'repository'
  | 'execution'
  | 'probes'
  | 'inspection'
  | 'logs'
  | 'scheduler'
  | 'deployment'
  | 'scripts'
  | 'api'
  | 'agent'

export interface OpsErrorShape {
  code: OpsErrorCode
  message: string
  scope: OpsErrorScope
  retryable: boolean
  evidenceRef?: string
  details?: Record<string, unknown>
}

export class OpsError extends Error {
  readonly code: OpsErrorCode
  readonly scope: OpsErrorScope
  readonly retryable: boolean
  readonly evidenceRef?: string
  readonly details?: Record<string, unknown>

  constructor(shape: OpsErrorShape) {
    super(shape.message)
    this.name = 'OpsError'
    this.code = shape.code
    this.scope = shape.scope
    this.retryable = shape.retryable
    this.evidenceRef = shape.evidenceRef
    this.details = shape.details
  }

  toJSON(): OpsErrorShape {
    return {
      code: this.code,
      message: this.message,
      scope: this.scope,
      retryable: this.retryable,
      ...(this.evidenceRef ? { evidenceRef: this.evidenceRef } : {}),
      ...(this.details ? { details: this.details } : {}),
    }
  }

  static is(value: unknown): value is OpsError {
    return value instanceof OpsError
  }
}

export function err(
  code: OpsErrorCode,
  scope: OpsErrorScope,
  message: string,
  opts: { retryable?: boolean; evidenceRef?: string; details?: Record<string, unknown> } = {},
): OpsError {
  return new OpsError({
    code,
    message,
    scope,
    retryable: opts.retryable ?? false,
    ...(opts.evidenceRef ? { evidenceRef: opts.evidenceRef } : {}),
    ...(opts.details ? { details: opts.details } : {}),
  })
}
