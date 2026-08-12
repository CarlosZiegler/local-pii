import type { StreamChunk } from "@tanstack/ai/client"
import type { ConnectConnectionAdapter } from "@tanstack/ai-client"
import type { PiiSession } from "./session"
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
  hasQueuedKind,
  idleActiveSlot,
  isNextPreempted,
  isNextSettled,
  isThrowCanceled,
  isThrowCompleted,
  isThrowConcurrent,
  markNextWaitingSource,
  nextActiveSlot,
  preemptNextPhase,
  queuedNextPhase,
  queuedThrowPhase,
  settlePublicNextPhase,
  shiftQueuedOperation,
  takeQueuedByKind,
  tanStackIteratorControl,
  throwActiveSlot,
  withAssistedNext,
  type TanStackActiveSlot,
  type TanStackNextPhase,
  type TanStackThrowPhase,
} from "./tanstack-arbitration"
import {
  assertTanStackArrayPrototypeStable,
  protectTanStackMessages,
  UnsupportedTanStackSemanticContentError,
} from "./tanstack-content"
import { restoreTanStackStream } from "./tanstack-stream"

export { UnsupportedTanStackSemanticContentError }

const TRUSTED_REFLECT_APPLY = Reflect.apply

export interface PiiConnectionOptions {
  /** One caller-owned privacy session per private conversation. */
  session: PiiSession
}

function pinMethod<T>(read: () => T): T {
  assertTanStackArrayPrototypeStable()
  const method = read()
  assertTanStackArrayPrototypeStable()
  return method
}

function completed<T>(value?: unknown): IteratorResult<T> {
  return { done: true, value: value as T }
}

/**
 * Keep the public adapter's iterator in control of lifecycle calls. An
 * async-generator `yield*` wrapper queues `.return(value)` behind a pending
 * delegated `.next()`, which prevents abort/early-return cleanup from reaching
 * the upstream iterator promptly or with the caller's exact value.
 */
function lazyStream<T>(
  initialize: (
    isClosed: () => boolean
  ) => Promise<AsyncIterator<T> | undefined>,
  signal?: AbortSignal
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let closed = false
      let closeKind: "return" | "abort" | "throw" | undefined
      let closeReason: unknown
      let delegate: AsyncIterator<T> | undefined
      let initialization: Promise<AsyncIterator<T> | undefined> | undefined
      type NextOperation = {
        kind: "next"
        phase: TanStackNextPhase
        pending: {
          resolve: (result: IteratorResult<T>) => void
          reject: (error: unknown) => void
        }
        value?: unknown
      }
      type ThrowOperation = {
        kind: "throw"
        phase: TanStackThrowPhase
        error: unknown
        resolve: (result: IteratorResult<T>) => void
        reject: (error: unknown) => void
      }
      type Operation = NextOperation | ThrowOperation
      const pendingNext = new Set<NextOperation>()
      const operations: Operation[] = []
      const activeThrows = new Set<ThrowOperation>()
      let active: TanStackActiveSlot<NextOperation, ThrowOperation> =
        idleActiveSlot()
      let pump = () => {}
      let removeAbortListener = () => {}
      const detachAbortListener = () => {
        const remove = removeAbortListener
        removeAbortListener = () => {}
        remove()
      }

      const settlePending = (
        kind: "return" | "abort" | "throw",
        value?: unknown,
        recoverable = false
      ) => {
        const terminal = kind !== "throw" || !recoverable
        for (const operation of pendingNext) {
          if (isNextSettled(operation.phase)) continue
          operation.phase = settlePublicNextPhase(operation.phase, terminal)
          if (kind === "return") operation.pending.resolve(completed<T>())
          else
            operation.pending.reject(
              recoverable
                ? tanStackIteratorControl.createRecoverableNextError(value)
                : value
            )
        }
        pendingNext.clear()
      }

      const settleThrows = (
        kind: "return" | "abort" | "throw",
        value?: unknown
      ) => {
        activeThrows.forEach((operation) => {
          operation.phase = cancelThrowPhase(operation.phase)
          if (kind === "return") operation.resolve(completed<T>(value))
          else operation.reject(value)
        })
        activeThrows.clear()
      }

      const ensureDelegate = () => {
        if (!initialization) {
          initialization = initialize(() => closed).then(
            (current) => {
              delegate = current
              return current
            },
            (error) => {
              detachAbortListener()
              throw error
            }
          )
        }
        return initialization
      }

      const close = (value?: unknown, kind: "return" | "abort" = "return") => {
        const current = delegate
        if (current) {
          let result: PromiseLike<IteratorResult<T>> | undefined
          try {
            result = current.return?.(value)
          } catch (error) {
            return Promise.reject(error)
          }
          const cleanup = Promise.resolve(result ?? completed<T>(value))
          void cleanup.catch(() => undefined)
          if (kind === "abort") return Promise.resolve(completed<T>())
          return cleanup.then(() => completed<T>(value))
        }

        if (!initialization) return Promise.resolve(completed<T>(value))
        // Message protection may still be in flight. Closing synchronously
        // prevents acquisition after return; the initializer observes this
        // same state and resolves to no delegate. If a delegate was created in
        // this microtask, close it best-effort without delaying the caller.
        void initialization
          .then(
            (initialized) => initialized?.return?.(value),
            () => undefined
          )
          .catch(() => undefined)
        return Promise.resolve(completed<T>(value))
      }

      const abort = () => {
        if (closed) return
        closed = true
        closeKind = "abort"
        closeReason = signal?.reason
        discardQueuedOperations(operations)
        if (active.kind === "next") {
          active.operation.phase = preemptNextPhase(active.operation.phase)
        }
        active = idleActiveSlot()
        settleThrows("abort", closeReason)
        settlePending("abort", closeReason)
        detachAbortListener()
        void close(closeReason, "abort").catch(() => undefined)
      }

      if (signal) {
        if (signal.aborted) abort()
        else {
          signal.addEventListener("abort", abort, { once: true })
          removeAbortListener = () => signal.removeEventListener("abort", abort)
        }
      }

      const resolveNext = (
        operation: NextOperation,
        result: IteratorResult<T>,
        terminal = true
      ) => {
        if (isNextSettled(operation.phase)) return
        operation.phase = settlePublicNextPhase(operation.phase, terminal)
        pendingNext.delete(operation)
        operation.pending.resolve(result)
      }

      const rejectNext = (
        operation: NextOperation,
        error: unknown,
        terminal = true
      ) => {
        if (isNextSettled(operation.phase)) return
        operation.phase = settlePublicNextPhase(operation.phase, terminal)
        pendingNext.delete(operation)
        operation.pending.reject(error)
      }

      const closeAfterDone = (value: unknown) => {
        closed = true
        closeKind = "return"
        closeReason = value
        discardQueuedOperations(operations)
        settleThrows("return", value)
        settlePending("return")
        detachAbortListener()
      }

      const closeAfterError = (error: unknown) => {
        closed = true
        closeKind = "throw"
        closeReason = error
        discardQueuedOperations(operations)
        settleThrows("throw", error)
        settlePending("throw", error)
        detachAbortListener()
      }

      const failThrow = (operation: ThrowOperation, error: unknown) => {
        if (isThrowCanceled(operation.phase)) return
        activeThrows.delete(operation)
        closeAfterError(error)
        operation.reject(error)
      }

      const completeThrow = (
        operation: ThrowOperation,
        result: IteratorResult<T>
      ) => {
        if (isThrowCanceled(operation.phase)) return
        activeThrows.delete(operation)
        if (result.done) {
          closeAfterDone(result.value)
          operation.resolve(result)
          return
        }
        operation.resolve(result)
      }

      const completeAssistedNext = (operation: NextOperation) => {
        if (active.kind !== "throw" || active.assistedNext !== operation) return
        const throwOp = active.operation
        active = clearAssistedNext(active)
        if (isThrowCompleted(throwOp.phase)) {
          active = idleActiveSlot()
          pump()
        }
      }

      const failNext = (operation: NextOperation, error: unknown) => {
        const control = tanStackIteratorControl.unwrapRecoverableNext(error)
        if (control.recoverable) {
          rejectNext(operation, control.value, false)
          pump()
          return
        }
        if (isNextSettled(operation.phase)) return
        closeAfterError(error)
        rejectNext(operation, error)
      }

      const completeNext = (
        operation: NextOperation,
        result: IteratorResult<T>
      ) => {
        if (isNextPreempted(operation.phase) || isNextSettled(operation.phase))
          return
        if (result.done) {
          resolveNext(operation, result)
          closeAfterDone(result.value)
          return
        }
        resolveNext(operation, result)
      }

      const selectOperation = (): Operation | undefined =>
        shiftQueuedOperation(operations)

      const startNext = (operation: NextOperation, assisted: boolean) => {
        operation.phase = activateNextPhase(operation.phase)
        const delegated = Promise.resolve()
          .then(async () => {
            if (closed) {
              if (closeKind === "abort" || closeKind === "throw")
                throw closeReason
              return completed<T>()
            }
            const current = await ensureDelegate()
            if (closed) {
              if (closeKind === "abort" || closeKind === "throw")
                throw closeReason
              return completed<T>()
            }
            if (!current) return completed<T>()
            const result = current.next(operation.value)
            operation.phase = markNextWaitingSource(operation.phase)
            if (
              !assisted &&
              active.kind === "next" &&
              active.operation === operation &&
              hasQueuedKind(operations, "throw")
            ) {
              operation.phase = preemptNextPhase(operation.phase)
              active = idleActiveSlot()
              pump()
            }
            return result
          })
          .then(
            (result) => {
              operation.phase = clearNextWaitingSource(operation.phase)
              if (isNextPreempted(operation.phase)) {
                if (assisted) completeAssistedNext(operation)
                return result
              }
              if (
                !assisted &&
                active.kind === "next" &&
                active.operation === operation
              )
                active = idleActiveSlot()
              completeNext(operation, result)
              if (assisted) completeAssistedNext(operation)
              else pump()
              return result
            },
            (error: unknown) => {
              operation.phase = clearNextWaitingSource(operation.phase)
              if (isNextPreempted(operation.phase)) {
                const control =
                  tanStackIteratorControl.unwrapRecoverableNext(error)
                if (control.recoverable)
                  rejectNext(operation, control.value, false)
                else if (!isNextSettled(operation.phase))
                  failNext(operation, error)
                if (assisted) completeAssistedNext(operation)
                return Promise.reject(error)
              }
              if (
                !assisted &&
                active.kind === "next" &&
                active.operation === operation
              )
                active = idleActiveSlot()
              failNext(operation, error)
              if (assisted) completeAssistedNext(operation)
              else pump()
              return Promise.reject(error)
            }
          )
        void delegated.catch(() => undefined)
      }

      pump = () => {
        if (closed) return
        if (active.kind === "throw" && active.assistedNext === undefined) {
          const candidate = takeQueuedByKind(operations, "next")
          if (candidate?.kind === "next") {
            active = withAssistedNext(active, candidate)
            startNext(candidate, true)
          }
          return
        }
        if (active.kind !== "idle") return
        const operation = selectOperation()
        if (!operation) return

        if (operation.kind === "next") {
          active = nextActiveSlot(operation, false)
          startNext(operation, false)
          return
        }

        operation.phase = activateThrowPhase(operation.phase)
        active = throwActiveSlot(operation)
        const delegated = Promise.resolve()
          .then(async () => {
            if (closed) throw closeReason
            const current = delegate ?? (await ensureDelegate())
            if (!current?.throw) throw operation.error
            if (isThrowConcurrent(operation.phase))
              tanStackIteratorControl.markConcurrentThrow(current)
            return current.throw(operation.error)
          })
          .then(
            (result) => {
              operation.phase = completeThrowPhase(operation.phase)
              if (
                active.kind === "throw" &&
                active.operation === operation &&
                active.assistedNext === undefined
              )
                active = idleActiveSlot()
              completeThrow(operation, result)
              if (!(
                active.kind === "throw" &&
                active.operation === operation &&
                active.assistedNext !== undefined
              ))
                pump()
              return result
            },
            (error: unknown) => {
              operation.phase = completeThrowPhase(operation.phase)
              if (
                active.kind === "throw" &&
                active.operation === operation &&
                active.assistedNext === undefined
              )
                active = idleActiveSlot()
              failThrow(operation, error)
              if (!(
                active.kind === "throw" &&
                active.operation === operation &&
                active.assistedNext !== undefined
              ))
                pump()
              return Promise.reject(error)
            }
          )
        void delegated.catch(() => undefined)
      }

      const iterator: AsyncIterator<T> & AsyncIterable<T> = {
        next(value?: unknown) {
          if (closed) {
            if (closeKind === "abort" || closeKind === "throw")
              return Promise.reject(closeReason)
            return Promise.resolve(completed<T>())
          }
          let resolve!: (result: IteratorResult<T>) => void
          let reject!: (error: unknown) => void
          const pending = {
            resolve: (result: IteratorResult<T>) => resolve(result),
            reject: (error: unknown) => reject(error),
          }
          const operation: NextOperation = {
            kind: "next",
            phase: queuedNextPhase(),
            pending,
            value,
          }
          const result = new Promise<IteratorResult<T>>(
            (resolveResult, rejectResult) => {
              resolve = resolveResult
              reject = rejectResult
            }
          )
          pendingNext.add(operation)
          enqueueOperation(operations, operation)
          pump()
          return result
        },
        return(value?: unknown) {
          if (closed) return Promise.resolve(completed<T>(value))
          closed = true
          closeKind = "return"
          closeReason = value
          discardQueuedOperations(operations)
          if (active.kind === "next") {
            active.operation.phase = preemptNextPhase(active.operation.phase)
          }
          active = idleActiveSlot()
          settleThrows("return", value)
          settlePending("return")
          detachAbortListener()
          return close(value)
        },
        throw(error?: unknown) {
          if (closed) return Promise.reject(error)
          let resolve!: (result: IteratorResult<T>) => void
          let reject!: (throwError: unknown) => void
          const operation: ThrowOperation = {
            kind: "throw",
            phase: queuedThrowPhase(
              detectConcurrentThrow(operations, active.kind === "throw", false)
            ),
            error,
            resolve: (result: IteratorResult<T>) => resolve(result),
            reject: (throwError: unknown) => reject(throwError),
          }
          const result = new Promise<IteratorResult<T>>(
            (resolveResult, rejectResult) => {
              resolve = resolveResult
              reject = rejectResult
            }
          )
          activeThrows.add(operation)
          if (
            active.kind === "next" &&
            canPreemptWaitingNext(active.operation.phase)
          ) {
            active.operation.phase = preemptNextPhase(active.operation.phase)
            active = idleActiveSlot()
          }
          enqueueOperation(operations, operation)
          pump()
          void result.catch(() => undefined)
          return result
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
      return iterator
    },
  }
}

/**
 * Wrap a TanStack AI client connection without introducing a server transport.
 * Message semantics are protected before `connect`; streamed text is restored
 * on return. The supplied conversation session always remains caller-owned.
 */
export function piiConnection<T extends ConnectConnectionAdapter>(
  inner: T,
  options: PiiConnectionOptions
): ConnectConnectionAdapter {
  const pinnedConnect = pinMethod(() => inner.connect)
  const pinnedHydrate = pinMethod(() => inner.hydrate)
  const pinnedHydrateGeneration = pinMethod(() => inner.hydrateGeneration)
  const pinnedJoinRun = pinMethod(() => inner.joinRun)
  const connect = (
    ...args: Parameters<T["connect"]>
  ): ReturnType<T["connect"]> => {
    const messages = args[0]
    const data = args[1]
    const signal = args[2]
    const runContext = args[3]
    const stream: AsyncIterable<StreamChunk> = lazyStream(async (isClosed) => {
      signal?.throwIfAborted()
      const protectedMessages = await protectTanStackMessages(
        options.session,
        messages
      )
      signal?.throwIfAborted()
      if (isClosed()) return undefined
      assertTanStackArrayPrototypeStable()
      const upstream = TRUSTED_REFLECT_APPLY(pinnedConnect, inner, [
        protectedMessages,
        data,
        signal,
        runContext,
      ])
      return restoreTanStackStream(options.session, upstream, signal)[
        Symbol.asyncIterator
      ]()
    }, signal)
    return stream as unknown as ReturnType<T["connect"]>
  }

  const wrapped: ConnectConnectionAdapter = {
    connect: connect as unknown as ConnectConnectionAdapter["connect"],
  }

  if (pinnedHydrate) {
    wrapped.hydrate = (...args) =>
      TRUSTED_REFLECT_APPLY(pinnedHydrate, inner, args)
  }
  if (pinnedHydrateGeneration) {
    wrapped.hydrateGeneration = (...args) =>
      TRUSTED_REFLECT_APPLY(pinnedHydrateGeneration, inner, args)
  }
  if (pinnedJoinRun) {
    wrapped.joinRun = (runId, signal) =>
      lazyStream(async (isClosed) => {
        signal?.throwIfAborted()
        if (isClosed()) return undefined
        const upstream = TRUSTED_REFLECT_APPLY(pinnedJoinRun, inner, [
          runId,
          signal,
        ])
        return restoreTanStackStream(options.session, upstream, signal)[
          Symbol.asyncIterator
        ]()
      }, signal)
  }

  return wrapped
}
