/**
 * Deployment state machine (PLAN S10). `stage` and `status` are independent.
 * Success = required steps + the ORIGINAL health check passed. Stop and failure
 * do not imply rollback.
 */
import type { DeploymentStatus } from './entities.ts'

export type DeploymentEvent =
  | 'START' // QUEUED → RUNNING
  | 'ENTER_REPAIR' // RUNNING → REPAIRING
  | 'RESUME_FROM_REPAIR' // REPAIRING → RUNNING
  | 'SUCCEED' // RUNNING → SUCCEEDED
  | 'FAIL' // → FAILED (only allowed when no dispatch is unknown)
  | 'REQUEST_STOP' // → STOPPING
  | 'CONFIRM_STOPPED' // STOPPING → STOPPED
  | 'ENTER_RECONCILE' // → RECONCILE_REQUIRED (dispatched, outcome unknown)
  | 'RESOLVE_RECONCILE_CONTINUE' // RECONCILE_REQUIRED → RUNNING (facts queried; user confirmed)
  | 'RESOLVE_RECONCILE_ARCHIVE' // RECONCILE_REQUIRED → FAILED/STOPPED (facts queried; closed)
  | 'AUTO_STOP' // timeout → STOPPING

const TRANSITIONS: Record<DeploymentStatus, Partial<Record<DeploymentEvent, DeploymentStatus>>> = {
  QUEUED: {
    START: 'RUNNING',
    REQUEST_STOP: 'STOPPING',
    FAIL: 'FAILED',
  },
  RUNNING: {
    ENTER_REPAIR: 'REPAIRING',
    SUCCEED: 'SUCCEEDED',
    FAIL: 'FAILED',
    REQUEST_STOP: 'STOPPING',
    AUTO_STOP: 'STOPPING',
    ENTER_RECONCILE: 'RECONCILE_REQUIRED',
  },
  REPAIRING: {
    RESUME_FROM_REPAIR: 'RUNNING',
    FAIL: 'FAILED',
    REQUEST_STOP: 'STOPPING',
    AUTO_STOP: 'STOPPING',
    ENTER_RECONCILE: 'RECONCILE_REQUIRED',
  },
  STOPPING: {
    CONFIRM_STOPPED: 'STOPPED',
    ENTER_RECONCILE: 'RECONCILE_REQUIRED',
  },
  RECONCILE_REQUIRED: {
    RESOLVE_RECONCILE_CONTINUE: 'RUNNING',
    RESOLVE_RECONCILE_ARCHIVE: 'FAILED',
  },
  SUCCEEDED: {},
  FAILED: {},
  STOPPED: {},
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: DeploymentStatus,
    public readonly event: DeploymentEvent,
  ) {
    super(`invalid deployment transition: ${from} --${event}--> (not allowed)`)
    this.name = 'InvalidTransitionError'
  }
}

export function nextStatus(from: DeploymentStatus, event: DeploymentEvent): DeploymentStatus {
  const to = TRANSITIONS[from][event]
  if (!to) throw new InvalidTransitionError(from, event)
  return to
}

export function canTransition(from: DeploymentStatus, event: DeploymentEvent): boolean {
  return TRANSITIONS[from][event] !== undefined
}

/**
 * FAIL is only legal when every dispatched step has a confirmed outcome.
 * `unknownDispatches > 0` must route to ENTER_RECONCILE instead.
 */
export function failOrReconcile(unknownDispatches: number): DeploymentEvent {
  return unknownDispatches > 0 ? 'ENTER_RECONCILE' : 'FAIL'
}

/** Terminal statuses that release server occupancy. */
export function isTerminal(status: DeploymentStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'STOPPED'
}
