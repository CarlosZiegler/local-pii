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
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        signal?.throwIfAborted()
        const protectedMessages = await protectTanStackMessages(
          options.session,
          messages
        )
        signal?.throwIfAborted()
        assertTanStackArrayPrototypeStable()
        const upstream = TRUSTED_REFLECT_APPLY(pinnedConnect, inner, [
          protectedMessages,
          data,
          signal,
          runContext,
        ])
        yield* restoreTanStackStream(options.session, upstream, signal)
      },
    }
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
      restoreTanStackStream(
        options.session,
        TRUSTED_REFLECT_APPLY(pinnedJoinRun, inner, [runId, signal]),
        signal
      )
  }

  return wrapped
}
