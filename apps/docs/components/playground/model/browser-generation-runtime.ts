/**
 * Wrap one generation iterator with the lifecycle rules shared by every
 * browser runtime. The upstream iterator is acquired lazily, returned on
 * abort/early return/error, and settled exactly once.
 */
export function managedGeneration(
  open: () => Promise<AsyncIterator<string>>,
  signal?: AbortSignal,
  onSettled?: () => Promise<void> | void
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let closeReason: unknown
      let upstream: AsyncIterator<string> | undefined
      let upstreamReturn: Promise<unknown> | undefined
      let settled = false
      let completed = false
      let primaryError: unknown
      let rejectAbort: ((reason: unknown) => void) | undefined
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject
      })

      const returnUpstream = async (reason?: unknown) => {
        if (upstreamReturn) return upstreamReturn
        if (!upstream?.return) return undefined
        upstreamReturn = Promise.resolve(upstream.return(reason)).then(
          () => undefined
        )
        return upstreamReturn
      }

      const onAbort = () => {
        const reason = signal?.reason
        closeReason = reason
        rejectAbort?.(reason)
        // Start returning the source immediately after rejecting the pending
        // next() call. This preserves the abort reason even if cancellation
        // resolves a browser stream with a final done result.
        void returnUpstream(reason).catch(() => undefined)
      }

      const settle = async () => {
        if (settled) return
        settled = true
        signal?.removeEventListener("abort", onAbort)

        let cleanupError: unknown
        try {
          if (!completed) await returnUpstream(closeReason ?? primaryError)
        } catch (error) {
          cleanupError = error
        }
        try {
          await onSettled?.()
        } catch (error) {
          cleanupError ??= error
        }
        // Errors from generation/abort always win over cleanup errors. An
        // otherwise successful generation still reports cleanup failures.
        if (primaryError === undefined && cleanupError !== undefined) {
          throw cleanupError
        }
      }

      const source = (async function* (): AsyncGenerator<string> {
        try {
          if (signal?.aborted) throw signal.reason
          signal?.addEventListener("abort", onAbort, { once: true })
          const opening = open()
          upstream = await Promise.race([opening, aborted])
          if (signal?.aborted) throw signal.reason

          while (true) {
            if (signal?.aborted) throw signal.reason
            const next = await Promise.race([upstream.next(), aborted])
            if (next.done) {
              completed = true
              return
            }
            yield next.value
          }
        } catch (error) {
          primaryError = error
          throw error
        } finally {
          await settle()
        }
      })()

      return {
        next: (...args: [] | [undefined]) => source.next(...args),
        return: async (reason?: unknown) => {
          closeReason = reason
          return source.return(reason)
        },
        throw: (error?: unknown) => source.throw(error),
      }
    },
  }
}
