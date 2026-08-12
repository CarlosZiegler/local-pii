import { describe, expect, it } from "vitest"
import {
  activateNextPhase,
  activateThrowPhase,
  canPreemptWaitingNext,
  cancelThrowPhase,
  clearAssistedNext,
  clearNextWaitingSource,
  completeThrowPhase,
  detectConcurrentThrow,
  discardQueuedOperations,
  enqueueOperation,
  findQueuedIndexByKind,
  hasQueuedKind,
  idleActiveSlot,
  isNextPreempted,
  isNextPreemptedSettled,
  isNextPreemptedUnsettled,
  isNextSettled,
  isNextWaitingSource,
  isThrowCanceled,
  isThrowCompleted,
  isThrowConcurrent,
  markNextWaitingSource,
  nextActiveSlot,
  preemptNextPhase,
  queuedNextPhase,
  queuedThrowPhase,
  settleNextPhase,
  settlePreemptedNextPhase,
  settlePublicNextPhase,
  shiftQueuedOperation,
  takeQueuedByKind,
  tanStackIteratorControl,
  throwActiveSlot,
  trustedArrayClear,
  trustedArrayFindIndex,
  trustedArrayPush,
  trustedArrayShift,
  trustedArraySome,
  trustedArraySplice,
  withAssistedNext,
  type TanStackActiveSlot,
} from "./tanstack-arbitration"

describe("tanstack arbitration trusted array primitives", () => {
  it("pushes, shifts, splices, and clears without relying on instance methods", () => {
    const items: number[] = []
    trustedArrayPush(items, 1)
    trustedArrayPush(items, 2)
    trustedArrayPush(items, 3)
    expect(items).toEqual([1, 2, 3])
    expect(trustedArrayShift(items)).toBe(1)
    expect(trustedArraySplice(items, 0, 1)).toEqual([2])
    expect(items).toEqual([3])
    trustedArrayClear(items)
    expect(items).toEqual([])
  })

  it("finds and tests via trusted some/findIndex", () => {
    const items = [{ kind: "next" }, { kind: "throw" }, { kind: "next" }]
    expect(trustedArraySome(items, (item) => item.kind === "throw")).toBe(true)
    expect(trustedArrayFindIndex(items, (item) => item.kind === "throw")).toBe(
      1
    )
    expect(trustedArrayFindIndex(items, (item) => item.kind === "return")).toBe(
      -1
    )
  })
})

describe("tanstack arbitration next phase transitions", () => {
  it("activates a queued next and tracks waiting-source", () => {
    let phase = queuedNextPhase()
    expect(phase).toEqual({ phase: "queued" })
    expect(canPreemptWaitingNext(phase)).toBe(false)

    phase = activateNextPhase(phase)
    expect(phase).toEqual({ phase: "active", waitingSource: false })
    expect(isNextWaitingSource(phase)).toBe(false)
    expect(canPreemptWaitingNext(phase)).toBe(false)

    phase = markNextWaitingSource(phase)
    expect(isNextWaitingSource(phase)).toBe(true)
    expect(canPreemptWaitingNext(phase)).toBe(true)

    phase = clearNextWaitingSource(phase)
    expect(isNextWaitingSource(phase)).toBe(false)
    expect(canPreemptWaitingNext(phase)).toBe(false)
  })

  it("preempts an active waiting next and settles recoverable vs terminal", () => {
    let phase = markNextWaitingSource(activateNextPhase(queuedNextPhase()))
    phase = preemptNextPhase(phase)
    expect(isNextPreempted(phase)).toBe(true)
    expect(isNextPreemptedUnsettled(phase)).toBe(true)
    expect(isNextPreemptedSettled(phase)).toBe(false)

    const recoverable = settlePreemptedNextPhase(phase, false)
    expect(recoverable).toEqual({
      phase: "preempted",
      settled: true,
      terminal: false,
    })
    expect(isNextPreemptedSettled(recoverable)).toBe(true)

    // Settling an already-settled preempted phase is a no-op.
    expect(settlePreemptedNextPhase(recoverable, true)).toBe(recoverable)

    let terminalPath = markNextWaitingSource(
      activateNextPhase(queuedNextPhase())
    )
    terminalPath = preemptNextPhase(terminalPath)
    terminalPath = settlePreemptedNextPhase(terminalPath, true)
    expect(terminalPath).toEqual({
      phase: "preempted",
      settled: true,
      terminal: true,
    })
  })

  it("ignores re-preempt and refuses to preempt a settled next", () => {
    const settled = settleNextPhase(activateNextPhase(queuedNextPhase()))
    expect(settled).toEqual({ phase: "settled" })
    expect(isNextSettled(settled)).toBe(true)
    expect(preemptNextPhase(settled)).toBe(settled)

    let phase = preemptNextPhase(activateNextPhase(queuedNextPhase()))
    const again = preemptNextPhase(phase)
    expect(again).toBe(phase)
    expect(isNextPreemptedUnsettled(again)).toBe(true)
  })

  it("settles public next promises through the phase model", () => {
    // Normal resolve path: active → settled
    let normal = activateNextPhase(queuedNextPhase())
    expect(isNextSettled(normal)).toBe(false)
    normal = settlePublicNextPhase(normal)
    expect(normal).toEqual({ phase: "settled" })
    expect(isNextSettled(normal)).toBe(true)
    // Idempotent.
    expect(settlePublicNextPhase(normal)).toBe(normal)
    expect(settleNextPhase(normal)).toBe(normal)

    // Recoverable preempted path keeps preempted form with terminal: false.
    let recovered = markNextWaitingSource(activateNextPhase(queuedNextPhase()))
    recovered = preemptNextPhase(recovered)
    recovered = settlePublicNextPhase(recovered, false)
    expect(recovered).toEqual({
      phase: "preempted",
      settled: true,
      terminal: false,
    })
    expect(isNextSettled(recovered)).toBe(true)
    expect(isNextPreemptedSettled(recovered)).toBe(true)
    // Already settled: terminal bit is not rewritten.
    expect(settlePublicNextPhase(recovered, true)).toBe(recovered)

    // Terminal preempted path (return/abort/fatal throw).
    let terminal = markNextWaitingSource(activateNextPhase(queuedNextPhase()))
    terminal = preemptNextPhase(terminal)
    terminal = settlePublicNextPhase(terminal, true)
    expect(terminal).toEqual({
      phase: "preempted",
      settled: true,
      terminal: true,
    })
    expect(isNextSettled(terminal)).toBe(true)
  })

  it("does not mark waiting-source on non-active phases", () => {
    const queued = queuedNextPhase()
    expect(markNextWaitingSource(queued)).toBe(queued)
    const preempted = preemptNextPhase(activateNextPhase(queuedNextPhase()))
    expect(markNextWaitingSource(preempted)).toBe(preempted)
  })
})

describe("tanstack arbitration throw phase transitions", () => {
  it("tracks concurrent queued → active → completed", () => {
    let phase = queuedThrowPhase(true)
    expect(isThrowConcurrent(phase)).toBe(true)
    expect(isThrowCompleted(phase)).toBe(false)
    expect(isThrowCanceled(phase)).toBe(false)

    phase = activateThrowPhase(phase)
    expect(phase).toEqual({ phase: "active", concurrent: true })
    phase = completeThrowPhase(phase)
    expect(isThrowCompleted(phase)).toBe(true)
    expect(isThrowConcurrent(phase)).toBe(true)
  })

  it("cancels a throw and ignores later completion", () => {
    let phase = activateThrowPhase(queuedThrowPhase(false))
    phase = cancelThrowPhase(phase)
    expect(isThrowCanceled(phase)).toBe(true)
    expect(completeThrowPhase(phase)).toBe(phase)
  })

  it("preserves concurrent flag across cancel", () => {
    const phase = cancelThrowPhase(queuedThrowPhase(true))
    expect(phase).toEqual({ phase: "canceled", concurrent: true })
  })
})

describe("tanstack arbitration active ownership slot", () => {
  type Next = { id: string }
  type Throw = { id: string }

  it("models idle, primary next, assisted next, and throw with assisted next", () => {
    let slot: TanStackActiveSlot<Next, Throw> = idleActiveSlot()
    expect(slot.kind).toBe("idle")

    const nextOp = { id: "n1" }
    slot = nextActiveSlot(nextOp)
    expect(slot).toEqual({ kind: "next", operation: nextOp, assisted: false })

    slot = nextActiveSlot(nextOp, true)
    expect(slot.kind === "next" && slot.assisted).toBe(true)

    const throwOp = { id: "t1" }
    slot = throwActiveSlot(throwOp)
    expect(slot).toEqual({ kind: "throw", operation: throwOp })

    const assisted = { id: "n2" }
    slot = withAssistedNext(slot, assisted)
    expect(slot).toEqual({
      kind: "throw",
      operation: throwOp,
      assistedNext: assisted,
    })

    slot = clearAssistedNext(slot)
    expect(slot).toEqual({ kind: "throw", operation: throwOp })
  })

  it("does not attach assisted next to a next slot", () => {
    const nextOp = { id: "n1" }
    const slot = nextActiveSlot<Next, Throw>(nextOp)
    expect(withAssistedNext(slot, { id: "n2" })).toBe(slot)
    expect(clearAssistedNext(slot)).toBe(slot)
  })
})

describe("tanstack arbitration operation queue helpers", () => {
  it("enqueues, detects kind, takes by kind, shifts, and discards", () => {
    type Op = { kind: "next" | "throw"; id: number }
    const operations: Op[] = []
    enqueueOperation(operations, { kind: "next", id: 1 })
    enqueueOperation(operations, { kind: "throw", id: 2 })
    enqueueOperation(operations, { kind: "next", id: 3 })

    expect(hasQueuedKind(operations, "throw")).toBe(true)
    expect(findQueuedIndexByKind(operations, "throw")).toBe(1)
    expect(takeQueuedByKind(operations, "throw")).toEqual({
      kind: "throw",
      id: 2,
    })
    expect(operations).toEqual([
      { kind: "next", id: 1 },
      { kind: "next", id: 3 },
    ])
    expect(shiftQueuedOperation(operations)).toEqual({ kind: "next", id: 1 })
    discardQueuedOperations(operations)
    expect(operations).toEqual([])
  })

  it("detects concurrent throws from active, queued, or armed bridge", () => {
    type Op = { kind: "next" | "throw" }
    const empty: Op[] = []
    expect(detectConcurrentThrow(empty, false, false)).toBe(false)
    expect(detectConcurrentThrow(empty, true, false)).toBe(true)
    expect(detectConcurrentThrow(empty, false, true)).toBe(true)
    expect(detectConcurrentThrow([{ kind: "throw" }], false, false)).toBe(true)
    expect(detectConcurrentThrow([{ kind: "next" }], false, false)).toBe(false)
  })
})

describe("tanstack arbitration control bridge", () => {
  it("creates and unwraps recoverable next errors without trusting spoofed markers", () => {
    const cause = new Error("recoverable cause")
    const marker = tanStackIteratorControl.createRecoverableNextError(cause)
    expect(tanStackIteratorControl.unwrapRecoverableNext(marker)).toEqual({
      recoverable: true,
      value: cause,
    })

    const spoofed = Object.assign(new Error("spoofed"), {
      [Symbol.for("local-pii.tanstack.recoverable-next")]: true,
      cause: new Error("wrong"),
    })
    expect(tanStackIteratorControl.unwrapRecoverableNext(spoofed)).toEqual({
      recoverable: false,
      value: spoofed,
    })

    expect(tanStackIteratorControl.unwrapRecoverableNext("plain")).toEqual({
      recoverable: false,
      value: "plain",
    })
  })

  it("arms and marks concurrent throw on an iterator object", () => {
    const iterator = {
      async next() {
        return { done: true as const, value: undefined }
      },
    }
    let armed = false
    tanStackIteratorControl.armConcurrentThrow(iterator, () => {
      armed = true
    })
    expect(armed).toBe(false)
    tanStackIteratorControl.markConcurrentThrow(iterator)
    expect(armed).toBe(true)

    // Unarmed iterators are a no-op.
    const other = {
      async next() {
        return { done: true as const, value: undefined }
      },
    }
    tanStackIteratorControl.markConcurrentThrow(other)
  })

  it("preserves exact error identity through recoverable unwrap", () => {
    const identity = Object.freeze({ token: 42 })
    const marker = tanStackIteratorControl.createRecoverableNextError(identity)
    const unwrapped = tanStackIteratorControl.unwrapRecoverableNext(marker)
    expect(unwrapped.recoverable).toBe(true)
    if (unwrapped.recoverable) expect(unwrapped.value).toBe(identity)
  })
})

describe("tanstack arbitration cross-layer ordering model", () => {
  /**
   * Models the acquisition-side decision table for a throw that preempts a
   * waiting next, then recovers (non-terminal) vs terminal-closes.
   */
  it("models recoverable recovery vs terminal close of a preempted next", () => {
    // Start: next is waiting on the source.
    let next = markNextWaitingSource(activateNextPhase(queuedNextPhase()))
    expect(canPreemptWaitingNext(next)).toBe(true)

    // Throw arrives and preempts.
    next = preemptNextPhase(next)
    let throwPhase = activateThrowPhase(queuedThrowPhase(false))

    // Recovery path: throw yields a non-done value → recoverable next.
    const recoverableCause = new Error("throw recovered")
    const recoverable =
      tanStackIteratorControl.createRecoverableNextError(recoverableCause)
    next = settlePreemptedNextPhase(next, false)
    throwPhase = completeThrowPhase(throwPhase)

    expect(isNextPreemptedSettled(next)).toBe(true)
    if (next.phase === "preempted" && next.settled) {
      expect(next.terminal).toBe(false)
    }
    expect(isThrowCompleted(throwPhase)).toBe(true)
    expect(tanStackIteratorControl.unwrapRecoverableNext(recoverable)).toEqual({
      recoverable: true,
      value: recoverableCause,
    })

    // Terminal path: abort/return settles preempted next as terminal.
    let terminalNext = markNextWaitingSource(
      activateNextPhase(queuedNextPhase())
    )
    terminalNext = preemptNextPhase(terminalNext)
    terminalNext = settlePreemptedNextPhase(terminalNext, true)
    if (terminalNext.phase === "preempted" && terminalNext.settled) {
      expect(terminalNext.terminal).toBe(true)
    }
  })

  it("models concurrent throw detection before arming the restoration iterator", () => {
    type Op = { kind: "next" | "throw" }
    const operations: Op[] = [{ kind: "next" }]
    // First throw is not concurrent.
    expect(detectConcurrentThrow(operations, false, false)).toBe(false)
    enqueueOperation(operations, { kind: "throw" })
    // Second throw while first is queued is concurrent.
    expect(detectConcurrentThrow(operations, false, false)).toBe(true)
    // Active throw also marks concurrent even with empty queue.
    expect(detectConcurrentThrow([], true, false)).toBe(true)
    // Bridge arm from acquisition markConcurrentThrow.
    expect(detectConcurrentThrow([], false, true)).toBe(true)
  })

  it("models retirement: preempted next cannot remain waiting-source", () => {
    let phase = markNextWaitingSource(activateNextPhase(queuedNextPhase()))
    phase = preemptNextPhase(phase)
    // After preemption, waiting-source is no longer a valid observation.
    expect(isNextWaitingSource(phase)).toBe(false)
    expect(canPreemptWaitingNext(phase)).toBe(false)
    // Source finish after preemption: clear is a no-op on preempted.
    expect(clearNextWaitingSource(phase)).toBe(phase)
  })
})
