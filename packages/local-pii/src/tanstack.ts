import type { StreamChunk } from "@tanstack/ai/client"
import type { ConnectConnectionAdapter } from "@tanstack/ai-client"
import type { PiiSession } from "./session"
import {
  assertTanStackArrayPrototypeStable,
  protectTanStackMessages,
  UnsupportedTanStackSemanticContentError,
} from "./tanstack-content"
import {
  markTanStackThrowConcurrent,
  unwrapRecoverableTanStackNext,
  recoverableTanStackNextError,
  restoreTanStackStream,
} from "./tanstack-stream"

export { UnsupportedTanStackSemanticContentError }

const TRUSTED_REFLECT_APPLY = Reflect.apply
const TRUSTED_ARRAY_FIND_INDEX = Array.prototype.findIndex
const TRUSTED_ARRAY_PUSH = Array.prototype.push
const TRUSTED_ARRAY_SHIFT = Array.prototype.shift
const TRUSTED_ARRAY_SOME = Array.prototype.some
const TRUSTED_ARRAY_SPLICE = Array.prototype.splice

function arrayFindIndex<T>(items: T[], predicate: (item: T) => boolean) {
  return TRUSTED_REFLECT_APPLY(TRUSTED_ARRAY_FIND_INDEX, items, [predicate])
}

function arrayPush<T>(items: T[], item: T) {
  TRUSTED_REFLECT_APPLY(TRUSTED_ARRAY_PUSH, items, [item])
}

function arrayShift<T>(items: T[]) {
  return TRUSTED_REFLECT_APPLY(TRUSTED_ARRAY_SHIFT, items, []) as T | undefined
}

function arraySome<T>(items: T[], predicate: (item: T) => boolean) {
  return TRUSTED_REFLECT_APPLY(TRUSTED_ARRAY_SOME, items, [predicate])
}

function arraySplice<T>(items: T[], start: number, deleteCount?: number) {
  return TRUSTED_REFLECT_APPLY(
    TRUSTED_ARRAY_SPLICE,
    items,
    deleteCount === undefined ? [start] : [start, deleteCount]
  ) as T[]
}

export interface PiiConnectionOptions {
  /** One caller-owned session per conversation or thread. */
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
      const pendingNext = new Set<{
        settled: boolean
        resolve: (result: IteratorResult<T>) => void
        reject: (error: unknown) => void
      }>()
      type NextOperation = {
        kind: "next"
        pending: {
          settled: boolean
          resolve: (result: IteratorResult<T>) => void
          reject: (error: unknown) => void
        }
        value?: unknown
        preempted?: boolean
        waitingSource?: boolean
      }
      type ThrowOperation = {
        kind: "throw"
        error: unknown
        canceled?: boolean
        concurrent?: boolean
        completed?: boolean
        resolve: (result: IteratorResult<T>) => void
        reject: (error: unknown) => void
      }
      type Operation = NextOperation | ThrowOperation
      const operations: Operation[] = []
      const activeThrows = new Set<ThrowOperation>()
      let activeOperation: Operation | undefined
      let activeAssistedNext: NextOperation | undefined
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
        for (const pending of pendingNext) {
          pending.settled = true
          if (kind === "return") pending.resolve(completed<T>())
          else
            pending.reject(
              recoverable ? recoverableTanStackNextError(value) : value
            )
        }
        pendingNext.clear()
      }

      const settleThrows = (
        kind: "return" | "abort" | "throw",
        value?: unknown
      ) => {
        activeThrows.forEach((operation) => {
          operation.canceled = true
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
        arraySplice(operations, 0)
        if (activeOperation?.kind === "next") activeOperation.preempted = true
        activeOperation = undefined
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
        result: IteratorResult<T>
      ) => {
        if (operation.pending.settled) return
        operation.pending.settled = true
        pendingNext.delete(operation.pending)
        operation.pending.resolve(result)
      }

      const rejectNext = (operation: NextOperation, error: unknown) => {
        if (operation.pending.settled) return
        operation.pending.settled = true
        pendingNext.delete(operation.pending)
        operation.pending.reject(error)
      }

      const closeAfterDone = (value: unknown) => {
        closed = true
        closeKind = "return"
        closeReason = value
        arraySplice(operations, 0)
        settleThrows("return", value)
        settlePending("return")
        detachAbortListener()
      }

      const closeAfterError = (error: unknown) => {
        closed = true
        closeKind = "throw"
        closeReason = error
        arraySplice(operations, 0)
        settleThrows("throw", error)
        settlePending("throw", error)
        detachAbortListener()
      }

      const failThrow = (operation: ThrowOperation, error: unknown) => {
        if (operation.canceled) return
        activeThrows.delete(operation)
        closeAfterError(error)
        operation.reject(error)
      }

      const completeThrow = (
        operation: ThrowOperation,
        result: IteratorResult<T>
      ) => {
        if (operation.canceled) return
        activeThrows.delete(operation)
        if (result.done) {
          closeAfterDone(result.value)
          operation.resolve(result)
          return
        }
        operation.resolve(result)
      }

      const completeAssistedNext = (operation: NextOperation) => {
        if (activeAssistedNext !== operation) return
        activeAssistedNext = undefined
        const active = activeOperation
        if (active?.kind === "throw" && active.completed) {
          activeOperation = undefined
          pump()
        }
      }

      const failNext = (operation: NextOperation, error: unknown) => {
        const control = unwrapRecoverableTanStackNext(error)
        if (control.recoverable) {
          rejectNext(operation, control.value)
          pump()
          return
        }
        if (operation.pending.settled) return
        closeAfterError(error)
        rejectNext(operation, error)
      }

      const completeNext = (
        operation: NextOperation,
        result: IteratorResult<T>
      ) => {
        if (operation.preempted || operation.pending.settled) return
        if (result.done) {
          resolveNext(operation, result)
          closeAfterDone(result.value)
          return
        }
        resolveNext(operation, result)
      }

      const selectOperation = (): Operation | undefined => arrayShift(operations)

      const startNext = (operation: NextOperation, assisted: boolean) => {
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
            operation.waitingSource = true
            if (
              !assisted &&
              activeOperation === operation &&
              arraySome(operations, (queued) => queued.kind === "throw")
            ) {
              operation.preempted = true
              activeOperation = undefined
              pump()
            }
            return result
          })
          .then(
            (result) => {
              operation.waitingSource = false
              if (operation.preempted) {
                if (assisted) completeAssistedNext(operation)
                return result
              }
              if (!assisted && activeOperation === operation)
                activeOperation = undefined
              completeNext(operation, result)
              if (assisted) completeAssistedNext(operation)
              else pump()
              return result
            },
            (error: unknown) => {
              operation.waitingSource = false
              if (operation.preempted) {
                const control = unwrapRecoverableTanStackNext(error)
                if (control.recoverable) rejectNext(operation, control.value)
                else if (!operation.pending.settled) failNext(operation, error)
                if (assisted) completeAssistedNext(operation)
                return Promise.reject(error)
              }
              if (!assisted && activeOperation === operation)
                activeOperation = undefined
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
        if (activeOperation?.kind === "throw" && !activeAssistedNext) {
          const nextIndex = arrayFindIndex(
            operations,
            (operation) => operation.kind === "next"
          )
          if (nextIndex >= 0) {
            const candidate = arraySplice(operations, nextIndex, 1)[0]
            if (candidate?.kind === "next") {
              activeAssistedNext = candidate
              startNext(candidate, true)
            }
          }
          return
        }
        if (activeOperation) return
        const operation = selectOperation()
        if (!operation) return
        activeOperation = operation

        if (operation.kind === "next") {
          startNext(operation, false)
          return
        }

        const delegated = Promise.resolve()
          .then(async () => {
            if (closed) throw closeReason
            const current = delegate ?? (await ensureDelegate())
            if (!current?.throw) throw operation.error
            if (operation.concurrent) markTanStackThrowConcurrent(current)
            return current.throw(operation.error)
          })
          .then(
            (result) => {
              operation.completed = true
              if (activeOperation === operation && !activeAssistedNext)
                activeOperation = undefined
              completeThrow(operation, result)
              if (!activeAssistedNext) pump()
              return result
            },
            (error: unknown) => {
              operation.completed = true
              if (activeOperation === operation && !activeAssistedNext)
                activeOperation = undefined
              failThrow(operation, error)
              if (!activeAssistedNext) pump()
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
            settled: false,
            resolve: (result: IteratorResult<T>) => resolve(result),
            reject: (error: unknown) => reject(error),
          }
          const operation: NextOperation = {
            kind: "next",
            pending,
            value,
          }
          const result = new Promise<IteratorResult<T>>(
            (resolveResult, rejectResult) => {
              resolve = resolveResult
              reject = rejectResult
            }
          )
          pendingNext.add(pending)
          arrayPush(operations, operation)
          pump()
          return result
        },
        return(value?: unknown) {
          if (closed) return Promise.resolve(completed<T>(value))
          closed = true
          closeKind = "return"
          closeReason = value
          arraySplice(operations, 0)
          if (activeOperation?.kind === "next") activeOperation.preempted = true
          activeOperation = undefined
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
            error,
            concurrent:
              activeOperation?.kind === "throw" ||
              arraySome(operations, (queued) => queued.kind === "throw"),
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
            activeOperation?.kind === "next" &&
            activeOperation.waitingSource &&
            !activeOperation.preempted
          ) {
            activeOperation.preempted = true
            activeOperation = undefined
          }
          arrayPush(operations, operation)
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
