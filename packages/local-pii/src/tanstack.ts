import type { StreamChunk } from "@tanstack/ai/client"
import type { ConnectConnectionAdapter } from "@tanstack/ai-client"
import type { PiiSession } from "./session"
import {
  assertTanStackArrayPrototypeStable,
  protectTanStackMessages,
  UnsupportedTanStackSemanticContentError,
} from "./tanstack-content"
import { restoreTanStackStream } from "./tanstack-stream"

export { UnsupportedTanStackSemanticContentError }

const TRUSTED_REFLECT_APPLY = Reflect.apply
const RECOVERABLE_NEXT = Symbol.for("local-pii.tanstack.recoverable-next")

function unwrapRecoverableNext(error: unknown): {
  recoverable: boolean
  value: unknown
} {
  if (error !== null && typeof error === "object") {
    const candidate = error as Record<PropertyKey, unknown>
    if (candidate[RECOVERABLE_NEXT] === true)
      return { recoverable: true, value: candidate.cause }
  }
  return { recoverable: false, value: error }
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
      let nextTail: Promise<unknown> = Promise.resolve()
      const pendingNext = new Set<{
        resolve: (result: IteratorResult<T>) => void
        reject: (error: unknown) => void
      }>()
      let removeAbortListener = () => {}
      const detachAbortListener = () => {
        const remove = removeAbortListener
        removeAbortListener = () => {}
        remove()
      }

      const settlePending = (
        kind: "return" | "abort" | "throw",
        value?: unknown
      ) => {
        for (const pending of pendingNext) {
          if (kind === "return") pending.resolve(completed<T>())
          else pending.reject(value)
        }
        pendingNext.clear()
      }

      const exposeNext = (operation: Promise<IteratorResult<T>>) =>
        new Promise<IteratorResult<T>>((resolve, reject) => {
          const pending = { resolve, reject }
          pendingNext.add(pending)
          void operation.then(
            (result) => {
              if (pendingNext.delete(pending)) resolve(result)
            },
            (error: unknown) => {
              if (pendingNext.delete(pending)) reject(error)
            }
          )
        })

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

      const iterator: AsyncIterator<T> & AsyncIterable<T> = {
        next(value?: unknown) {
          if (closed) {
            if (closeKind === "abort" || closeKind === "throw")
              return Promise.reject(closeReason)
            return Promise.resolve(completed<T>())
          }
          const operation = nextTail
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
              return current.next(value)
            })
            .then(
              (result) => {
                if (result.done) detachAbortListener()
                return result
              },
              (error) => {
                const control = unwrapRecoverableNext(error)
                if (control.recoverable) throw control.value
                detachAbortListener()
                throw error
              }
            )
          nextTail = operation.then(
            () => undefined,
            () => undefined
          )
          return exposeNext(operation)
        },
        return(value?: unknown) {
          if (closed) return Promise.resolve(completed<T>(value))
          closed = true
          closeKind = "return"
          closeReason = value
          settlePending("return")
          detachAbortListener()
          return close(value)
        },
        throw(error?: unknown) {
          if (closed) return Promise.reject(error)
          const current = delegate
          if (current?.throw) {
            let result: PromiseLike<IteratorResult<T>>
            try {
              result = current.throw(error)
            } catch (throwError) {
              closed = true
              closeKind = "throw"
              closeReason = throwError
              settlePending("throw", throwError)
              detachAbortListener()
              return Promise.reject(throwError)
            }
            const throwing = Promise.resolve(result).then(
              (thrown) => {
                if (thrown.done) {
                  closed = true
                  closeKind = "return"
                  closeReason = thrown.value
                  settlePending("return")
                  detachAbortListener()
                }
                return thrown
              },
              (throwError) => {
                closed = true
                closeKind = "throw"
                closeReason = throwError
                settlePending("throw", throwError)
                detachAbortListener()
                throw throwError
              }
            )
            void throwing.catch(() => undefined)
            return throwing
          }

          closed = true
          closeKind = "throw"
          closeReason = error
          settlePending("throw", error)
          detachAbortListener()
          if (current?.return) {
            let cleanup: PromiseLike<IteratorResult<T>>
            try {
              cleanup = current.return(error)
            } catch {
              return Promise.reject(error)
            }
            return Promise.resolve(cleanup).then(
              () => Promise.reject(error),
              () => Promise.reject(error)
            )
          }

          if (initialization) {
            void initialization
              .then((initialized) => initialized?.throw?.(error))
              .catch(() => undefined)
          }
          return Promise.reject(error)
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
