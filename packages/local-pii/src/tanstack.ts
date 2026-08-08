import type { StreamChunk } from "@tanstack/ai/client"
import type { ConnectConnectionAdapter } from "@tanstack/ai-client"
import type { PiiSession } from "./session"
import { protectTanStackMessages } from "./tanstack-content"
import { restoreTanStackStream } from "./tanstack-stream"

export interface PiiConnectionOptions {
  /** One caller-owned session per conversation or thread. */
  session: PiiSession
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
  const connect = (
    ...args: Parameters<T["connect"]>
  ): ReturnType<T["connect"]> => {
    const [messages, data, signal, runContext] = args
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        signal?.throwIfAborted()
        const protectedMessages = await protectTanStackMessages(
          options.session,
          messages
        )
        signal?.throwIfAborted()
        const upstream = inner.connect(
          protectedMessages,
          data,
          signal,
          runContext
        )
        yield* restoreTanStackStream(options.session, upstream, signal)
      },
    }
    return stream as unknown as ReturnType<T["connect"]>
  }

  const wrapped: ConnectConnectionAdapter = {
    connect: connect as unknown as ConnectConnectionAdapter["connect"],
  }

  if (inner.hydrate) {
    wrapped.hydrate = (...args) => inner.hydrate!(...args)
  }
  if (inner.hydrateGeneration) {
    wrapped.hydrateGeneration = (...args) => inner.hydrateGeneration!(...args)
  }
  if (inner.joinRun) {
    wrapped.joinRun = (runId, signal) =>
      restoreTanStackStream(
        options.session,
        inner.joinRun!(runId, signal),
        signal
      )
  }

  return wrapped
}
