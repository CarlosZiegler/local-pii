/**
 * Shared TanStack iterator operation arbitration.
 *
 * Private to the acquisition lazy wrapper (`tanstack.ts`) and the restoration
 * stream (`tanstack-stream.ts`). Not a public package surface.
 */

import { trustedApply } from "./tanstack-trusted"

// ---------------------------------------------------------------------------
// Trusted array primitives (shared by acquisition + restoration)
// ---------------------------------------------------------------------------

const TRUSTED_ARRAY_FIND_INDEX = Array.prototype.findIndex
const TRUSTED_ARRAY_PUSH = Array.prototype.push
const TRUSTED_ARRAY_SHIFT = Array.prototype.shift
const TRUSTED_ARRAY_SOME = Array.prototype.some
const TRUSTED_ARRAY_SPLICE = Array.prototype.splice

export function trustedArrayPush<T>(items: T[], item: T): number {
  return trustedApply(TRUSTED_ARRAY_PUSH, items, [item]) as number
}

export function trustedArrayShift<T>(items: T[]): T | undefined {
  return trustedApply(TRUSTED_ARRAY_SHIFT, items, []) as T | undefined
}

export function trustedArraySome<T>(
  items: readonly T[],
  predicate: (item: T, index: number, array: readonly T[]) => boolean
): boolean {
  return trustedApply(TRUSTED_ARRAY_SOME, items, [predicate]) as boolean
}

export function trustedArrayFindIndex<T>(
  items: readonly T[],
  predicate: (item: T, index: number, array: readonly T[]) => boolean
): number {
  return trustedApply(TRUSTED_ARRAY_FIND_INDEX, items, [predicate]) as number
}

export function trustedArraySplice<T>(
  items: T[],
  start: number,
  deleteCount?: number
): T[] {
  return trustedApply(
    TRUSTED_ARRAY_SPLICE,
    items,
    deleteCount === undefined ? [start] : [start, deleteCount]
  ) as T[]
}

export function trustedArrayClear<T>(items: T[]): void {
  trustedArraySplice(items, 0)
}

// ---------------------------------------------------------------------------
// Named private control bridge (recoverable-next + concurrent-throw)
// ---------------------------------------------------------------------------

/**
 * Outcome of unwrapping a rejection that may be a recoverable next control
 * signal from a concurrent throw recovery path.
 */
export type TanStackRecoverableNext =
  | { readonly recoverable: true; readonly value: unknown }
  | { readonly recoverable: false; readonly value: unknown }

/**
 * Private bridge between the acquisition wrapper and the restoration stream.
 *
 * Replaces the previous free-floating WeakMap side channels for:
 * - recoverable next rejections (throw recovery must not terminal-close)
 * - concurrent throw arming (outer throw marks the inner iterator)
 */
export interface TanStackIteratorControlBridge {
  createRecoverableNextError(cause: unknown): object
  unwrapRecoverableNext(error: unknown): TanStackRecoverableNext
  armConcurrentThrow(iterator: AsyncIterator<unknown>, arm: () => void): void
  markConcurrentThrow(iterator: AsyncIterator<unknown>): void
}

const recoverableNextErrors = new WeakMap<object, unknown>()
const concurrentThrowArms = new WeakMap<object, () => void>()

export const tanStackIteratorControl: TanStackIteratorControlBridge = {
  createRecoverableNextError(cause) {
    const marker = Object.create(null) as object
    recoverableNextErrors.set(marker, cause)
    return marker
  },
  unwrapRecoverableNext(error) {
    if (
      (typeof error === "object" && error !== null) ||
      typeof error === "function"
    ) {
      if (recoverableNextErrors.has(error)) {
        return {
          recoverable: true as const,
          value: recoverableNextErrors.get(error),
        }
      }
    }
    return { recoverable: false as const, value: error }
  },
  armConcurrentThrow(iterator, arm) {
    concurrentThrowArms.set(iterator as object, arm)
  },
  markConcurrentThrow(iterator) {
    concurrentThrowArms.get(iterator as object)?.()
  },
}

// ---------------------------------------------------------------------------
// Discriminated next-operation phases
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a public `next` operation.
 *
 * Replaces overlapping optional flags (`preempted`, `waitingSource`,
 * `preemptedSettled`, `preemptedTerminal`). Production resolve/reject paths
 * transition through `settleNextPhase` / `settlePreemptedNextPhase`; the
 * public-promise settlement guard is derived from this phase via
 * `isNextSettled`.
 */
export type TanStackNextPhase =
  | { readonly phase: "queued" }
  | { readonly phase: "active"; readonly waitingSource: boolean }
  | { readonly phase: "preempted"; readonly settled: false }
  | {
      readonly phase: "preempted"
      readonly settled: true
      readonly terminal: boolean
    }
  | { readonly phase: "settled" }

export function queuedNextPhase(): TanStackNextPhase {
  return { phase: "queued" }
}

export function activateNextPhase(phase: TanStackNextPhase): TanStackNextPhase {
  if (phase.phase !== "queued") return phase
  return { phase: "active", waitingSource: false }
}

export function markNextWaitingSource(
  phase: TanStackNextPhase
): TanStackNextPhase {
  if (phase.phase !== "active") return phase
  return { phase: "active", waitingSource: true }
}

export function clearNextWaitingSource(
  phase: TanStackNextPhase
): TanStackNextPhase {
  if (phase.phase !== "active") return phase
  return { phase: "active", waitingSource: false }
}

/**
 * Preempt a next that is still outstanding. Idempotent once preempted/settled.
 */
export function preemptNextPhase(phase: TanStackNextPhase): TanStackNextPhase {
  if (isNextSettled(phase)) return phase
  if (phase.phase === "preempted") return phase
  return { phase: "preempted", settled: false }
}

/**
 * Settle a preempted next's public promise (recoverable or terminal).
 * No-op unless the phase is preempted and still unsettled.
 */
export function settlePreemptedNextPhase(
  phase: TanStackNextPhase,
  terminal: boolean
): TanStackNextPhase {
  if (phase.phase !== "preempted" || phase.settled) return phase
  return { phase: "preempted", settled: true, terminal }
}

/**
 * Mark a non-preempted next's public promise as settled.
 * Idempotent for any already-settled form (including preempted-settled).
 */
export function settleNextPhase(phase: TanStackNextPhase): TanStackNextPhase {
  if (isNextSettled(phase)) return phase
  return { phase: "settled" }
}

/**
 * Transition a next phase when its public promise is resolved or rejected.
 * Preempted unsettled ops keep the preempted-settled form (with terminal bit);
 * all other outstanding ops become `phase: "settled"`.
 */
export function settlePublicNextPhase(
  phase: TanStackNextPhase,
  terminal = true
): TanStackNextPhase {
  if (isNextSettled(phase)) return phase
  if (isNextPreemptedUnsettled(phase))
    return settlePreemptedNextPhase(phase, terminal)
  return settleNextPhase(phase)
}

/** True when the public next promise has already been delivered. */
export function isNextSettled(phase: TanStackNextPhase): boolean {
  return (
    phase.phase === "settled" ||
    (phase.phase === "preempted" && phase.settled === true)
  )
}

export function isNextPreempted(phase: TanStackNextPhase): boolean {
  return phase.phase === "preempted"
}

export function isNextPreemptedUnsettled(phase: TanStackNextPhase): boolean {
  return phase.phase === "preempted" && phase.settled === false
}

export function isNextPreemptedSettled(phase: TanStackNextPhase): boolean {
  return phase.phase === "preempted" && phase.settled === true
}

export function isNextWaitingSource(phase: TanStackNextPhase): boolean {
  return phase.phase === "active" && phase.waitingSource
}

/** True when a throw may preempt this next (active and already on the source). */
export function canPreemptWaitingNext(phase: TanStackNextPhase): boolean {
  return phase.phase === "active" && phase.waitingSource
}

// ---------------------------------------------------------------------------
// Discriminated throw-operation phases
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a public `throw` operation.
 *
 * Replaces overlapping optional flags (`canceled`, `concurrent`, `completed`).
 */
export type TanStackThrowPhase =
  | { readonly phase: "queued"; readonly concurrent: boolean }
  | { readonly phase: "active"; readonly concurrent: boolean }
  | { readonly phase: "completed"; readonly concurrent: boolean }
  | { readonly phase: "canceled"; readonly concurrent: boolean }

export function queuedThrowPhase(concurrent: boolean): TanStackThrowPhase {
  return { phase: "queued", concurrent }
}

export function activateThrowPhase(
  phase: TanStackThrowPhase
): TanStackThrowPhase {
  if (phase.phase !== "queued") return phase
  return { phase: "active", concurrent: phase.concurrent }
}

export function completeThrowPhase(
  phase: TanStackThrowPhase
): TanStackThrowPhase {
  if (phase.phase === "canceled") return phase
  return { phase: "completed", concurrent: phase.concurrent }
}

export function cancelThrowPhase(
  phase: TanStackThrowPhase
): TanStackThrowPhase {
  return { phase: "canceled", concurrent: phase.concurrent }
}

export function isThrowConcurrent(phase: TanStackThrowPhase): boolean {
  return phase.concurrent
}

export function isThrowCanceled(phase: TanStackThrowPhase): boolean {
  return phase.phase === "canceled"
}

export function isThrowCompleted(phase: TanStackThrowPhase): boolean {
  return phase.phase === "completed"
}

// ---------------------------------------------------------------------------
// Active ownership slot (replaces singleton active + assisted side fields)
// ---------------------------------------------------------------------------

/**
 * Explicit ownership of the currently executing operation.
 *
 * Acquisition may assist a queued `next` while a `throw` is active; restoration
 * does not use the assisted slot.
 */
export type TanStackActiveSlot<TNext, TThrow> =
  | { readonly kind: "idle" }
  | {
      readonly kind: "next"
      readonly operation: TNext
      readonly assisted: boolean
    }
  | {
      readonly kind: "throw"
      readonly operation: TThrow
      readonly assistedNext?: TNext
    }

export function idleActiveSlot<TNext, TThrow>(): TanStackActiveSlot<
  TNext,
  TThrow
> {
  return { kind: "idle" }
}

export function nextActiveSlot<TNext, TThrow>(
  operation: TNext,
  assisted = false
): TanStackActiveSlot<TNext, TThrow> {
  return { kind: "next", operation, assisted }
}

export function throwActiveSlot<TNext, TThrow>(
  operation: TThrow,
  assistedNext?: TNext
): TanStackActiveSlot<TNext, TThrow> {
  if (assistedNext === undefined) return { kind: "throw", operation }
  return { kind: "throw", operation, assistedNext }
}

export function withAssistedNext<TNext, TThrow>(
  slot: TanStackActiveSlot<TNext, TThrow>,
  assistedNext: TNext
): TanStackActiveSlot<TNext, TThrow> {
  if (slot.kind !== "throw") return slot
  return { kind: "throw", operation: slot.operation, assistedNext }
}

export function clearAssistedNext<TNext, TThrow>(
  slot: TanStackActiveSlot<TNext, TThrow>
): TanStackActiveSlot<TNext, TThrow> {
  if (slot.kind !== "throw") return slot
  return { kind: "throw", operation: slot.operation }
}

// ---------------------------------------------------------------------------
// Shared operation-queue helpers
// ---------------------------------------------------------------------------

export function hasQueuedKind<T extends { kind: string }>(
  operations: readonly T[],
  kind: T["kind"]
): boolean {
  return trustedArraySome(operations, (operation) => operation.kind === kind)
}

export function findQueuedIndexByKind<T extends { kind: string }>(
  operations: readonly T[],
  kind: T["kind"]
): number {
  return trustedArrayFindIndex(
    operations,
    (operation) => operation.kind === kind
  )
}

export function takeQueuedByKind<T extends { kind: string }>(
  operations: T[],
  kind: T["kind"]
): T | undefined {
  const index = findQueuedIndexByKind(operations, kind)
  if (index < 0) return undefined
  return trustedArraySplice(operations, index, 1)[0]
}

export function shiftQueuedOperation<T>(operations: T[]): T | undefined {
  return trustedArrayShift(operations)
}

export function enqueueOperation<T>(operations: T[], operation: T): void {
  trustedArrayPush(operations, operation)
}

export function discardQueuedOperations<T>(operations: T[]): void {
  trustedArrayClear(operations)
}

/**
 * A new throw is concurrent when another throw is already active/queued, or
 * when the restoration bridge was armed by the acquisition wrapper.
 */
export function detectConcurrentThrow<T extends { kind: string }>(
  operations: readonly T[],
  activeIsThrow: boolean,
  armed = false
): boolean {
  return (
    armed || activeIsThrow || hasQueuedKind(operations, "throw" as T["kind"])
  )
}
