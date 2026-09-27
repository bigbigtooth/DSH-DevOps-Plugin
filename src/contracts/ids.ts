/** Branded id types — string at runtime, distinct at compile time. */
declare const brand: unique symbol
export type Brand<T, B> = T & { readonly [brand]: B }

export type ServerId = Brand<string, 'ServerId'>
export type CredentialRef = Brand<string, 'CredentialRef'>
export type ProjectId = Brand<string, 'ProjectId'>
export type TargetId = Brand<string, 'TargetId'>
export type RunId = Brand<string, 'RunId'>
export type StepId = Brand<string, 'StepId'>
export type AttemptId = Brand<string, 'AttemptId'>
export type SnapshotId = Brand<string, 'SnapshotId'>
export type RequestId = Brand<string, 'RequestId'>
export type ScriptVersionId = Brand<string, 'ScriptVersionId'>
export type LogSourceId = Brand<string, 'LogSourceId'>
export type FragmentId = Brand<string, 'FragmentId'>
export type AlertId = Brand<string, 'AlertId'>
export type EventSequence = Brand<number, 'EventSequence'>

let counter = 0
/** Monotonic, process-local id generator with random prefix (collisions impossible for our use). */
export function newId(prefix: string): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`
}

export const asServerId = (v: string) => v as ServerId
export const asCredentialRef = (v: string) => v as CredentialRef
export const asProjectId = (v: string) => v as ProjectId
export const asTargetId = (v: string) => v as TargetId
export const asRunId = (v: string) => v as RunId
export const asStepId = (v: string) => v as StepId
export const asAttemptId = (v: string) => v as AttemptId
export const asSnapshotId = (v: string) => v as SnapshotId
export const asRequestId = (v: string) => v as RequestId
export const asScriptVersionId = (v: string) => v as ScriptVersionId
export const asLogSourceId = (v: string) => v as LogSourceId
export const asFragmentId = (v: string) => v as FragmentId
export const asAlertId = (v: string) => v as AlertId
