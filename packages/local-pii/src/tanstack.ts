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
  initialize: (isClosed: () => boolean) => Promise<AsyncIterator<T> | undefined>
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let closed = false
      let delegate: AsyncIterator<T> | undefined
      let initialization: Promise<AsyncIterator<T> | undefined> | undefined

      const ensureDelegate = () => {
        if (!initialization) {
          initialization = initialize(() => closed).then((current) => {
            delegate = current
            return current
          })
        }
        return initialization
      }

      const close = (value?: unknown) => {
        const current = delegate
        if (current) {
          let result: PromiseLike<IteratorResult<T>> | undefined
          try {
            result = current.return?.(value)
          } catch (error) {
            return Promise.reject(error)
          }
          return Promise.resolve(result ?? completed<T>(value)).then(() =>
            completed<T>(value)
          )
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

      const iterator: AsyncIterator<T> & AsyncIterable<T> = {
        next(value?: unknown) {
          if (closed) return Promise.resolve(completed<T>())
          return ensureDelegate().then((current) => {
            if (closed || !current) return completed<T>()
            return Promise.resolve(current.next(value))
          })
        },
        return(value?: unknown) {
          if (closed) return Promise.resolve(completed<T>(value))
          closed = true
          return close(value)
        },
        throw(error?: unknown) {
          if (closed) return Promise.resolve(completed<T>())
          closed = true
          return close(error)
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
    })
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
      })
  }

  return wrapped
}
