const done = (): IteratorResult<string> => ({
  done: true,
  value: undefined,
})

/** Internal settlement handle used by runtime disposal barriers. */
export const generationSettlement = Symbol("generationSettlement")

type ManagedIterator = AsyncIterator<string> & {
  readonly [generationSettlement]?: Promise<void>
}

/**
 * Wrap one generation with explicit iterator state. A consumer return or
 * abort closes a pending next immediately while upstream return and resource
 * cleanup continue in the background until the disposal barrier observes them.
 */
export function managedGeneration(
  open: () => Promise<AsyncIterator<string>>,
  signal?: AbortSignal,
  onSettled?: () => Promise<void> | void
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let started = false
      let closed = false
      let completed = false
      let closeReason: unknown
      let primaryError: unknown
      let hasPrimaryError = false
      let pendingErrorDelivered = false
      let upstream: AsyncIterator<string> | undefined
      let opening: Promise<AsyncIterator<string>> | undefined
      let upstreamReturn: Promise<void> | undefined
      let cleanup: Promise<void> | undefined
      let pendingNext:
        | {
            resolve: (result: IteratorResult<string>) => void
            reject: (reason: unknown) => void
          }
        | undefined
      let pumping = false
      let resolveSettled!: () => void
      let rejectSettled!: (reason: unknown) => void
      const settled = new Promise<void>((resolve, reject) => {
        resolveSettled = resolve
        rejectSettled = reject
      })
      void settled.catch(() => undefined)

      const beginUpstreamReturn = (): Promise<void> => {
        if (upstreamReturn) return upstreamReturn
        upstreamReturn = (async () => {
          let source = upstream
          if (!source && opening) {
            try {
              source = await opening
            } catch {
              return
            }
          }
          if (source?.return) {
            await source.return(
              closeReason !== undefined ? closeReason : primaryError
            )
          }
        })()
        return upstreamReturn
      }

      const settle = (): Promise<void> => {
        if (cleanup) return cleanup
        cleanup = (async () => {
          let cleanupError: unknown
          let cleanupFailed = false
          try {
            if (!completed) await beginUpstreamReturn()
          } catch (error) {
            cleanupError = error
            cleanupFailed = true
          }
          try {
            await onSettled?.()
          } catch (error) {
            if (!cleanupFailed) cleanupError = error
            cleanupFailed = true
          }
          // A generation error, including an explicit undefined rejection,
          // remains primary over cleanup failures.
          if (!hasPrimaryError && cleanupFailed) {
            throw cleanupError
          }
        })().then(
          () => {
            resolveSettled()
          },
          (error) => {
            rejectSettled(error)
            throw error
          }
        )
        // Keep a rejection handler attached so late cleanup cannot become an
        // unhandled loser; the iterator return and runtime disposal each
        // observe the same settlement outcome.
        void cleanup.catch(() => undefined)
        return cleanup
      }

      const rejectPending = (reason: unknown) => {
        const pending = pendingNext
        pendingNext = undefined
        pending?.reject(reason)
      }

      const resolvePending = (result: IteratorResult<string>) => {
        const pending = pendingNext
        pendingNext = undefined
        pending?.resolve(result)
      }

      const closeForAbort = (reason: unknown) => {
        if (closed) return
        closed = true
        closeReason = reason
        primaryError = reason
        hasPrimaryError = true
        const hadPendingNext = pendingNext !== undefined
        rejectPending(reason)
        if (hadPendingNext) pendingErrorDelivered = true
        signal?.removeEventListener("abort", onAbort)
        void settle()
      }

      const closeForReturn = (
        reason: unknown
      ): Promise<IteratorResult<string>> => {
        if (!closed) {
          closed = true
          closeReason = reason
          resolvePending(done())
          signal?.removeEventListener("abort", onAbort)
          // Consumer cancellation must await the full cleanup chain, even
          // when the source resolves after return. The pending next above
          // still settles immediately; runtime disposal independently tracks
          // this same settlement promise as its barrier.
          const cleanupPromise = settle()
          return cleanupPromise.then(() => done())
        }
        if (cleanup) return cleanup.then(() => done())
        return Promise.resolve(done())
      }

      const fail = (error: unknown) => {
        if (closed) return
        closed = true
        primaryError = error
        hasPrimaryError = true
        pendingErrorDelivered = true
        rejectPending(error)
        signal?.removeEventListener("abort", onAbort)
        void settle()
      }

      const ensureOpen = (): Promise<AsyncIterator<string>> => {
        if (opening) return opening
        opening = Promise.resolve()
          .then(open)
          .then(
            (source) => {
              upstream = source
              if (closed) void beginUpstreamReturn()
              return source
            },
            (error) => {
              if (!closed) fail(error)
              throw error
            }
          )
        return opening
      }

      const pump = async () => {
        if (pumping || closed) return
        pumping = true
        try {
          const source = await ensureOpen()
          if (closed) return
          const result = await source.next()
          if (closed) return
          if (result.done) {
            completed = true
            closed = true
            signal?.removeEventListener("abort", onAbort)
            try {
              await settle()
              resolvePending(done())
            } catch (error) {
              primaryError = error
              hasPrimaryError = true
              const hadPendingNext = pendingNext !== undefined
              rejectPending(error)
              if (hadPendingNext) pendingErrorDelivered = true
            }
            return
          }
          resolvePending(result)
        } catch (error) {
          if (!closed) fail(error)
        } finally {
          pumping = false
        }
      }

      const onAbort = () => closeForAbort(signal?.reason)

      const iterator: ManagedIterator = {
        [generationSettlement]: settled,
        next() {
          if (closed) {
            if (hasPrimaryError && !pendingErrorDelivered) {
              pendingErrorDelivered = true
              return Promise.reject(primaryError)
            }
            return Promise.resolve(done())
          }
          if (!started) {
            started = true
            if (signal?.aborted) {
              closeForAbort(signal.reason)
              if (!pendingErrorDelivered) {
                pendingErrorDelivered = true
                return Promise.reject(primaryError)
              }
              return Promise.resolve(done())
            }
            signal?.addEventListener("abort", onAbort, { once: true })
          }
          if (pendingNext) {
            return Promise.reject(
              new TypeError("A generation next call is already pending")
            )
          }
          const promise = new Promise<IteratorResult<string>>(
            (resolve, reject) => {
              pendingNext = { resolve, reject }
            }
          )
          void pump()
          return promise
        },
        return(reason?: unknown) {
          return closeForReturn(reason)
        },
        throw(error?: unknown) {
          fail(error)
          return Promise.reject(error)
        },
      }
      return iterator
    },
  }
}

/** Track each iterator independently until its managed cleanup has settled. */
export function trackActiveGeneration(
  source: AsyncIterable<string>,
  active: Set<Promise<void>>
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]() as ManagedIterator
      const settlement = iterator[generationSettlement] ?? Promise.resolve()
      let tracked = false
      let release!: () => void
      let rejectActive!: (reason: unknown) => void
      const activeRunWithRejection = new Promise<void>((resolve, reject) => {
        release = resolve
        rejectActive = reject
      })
      void activeRunWithRejection.catch(() => undefined)
      const track = () => {
        if (tracked) return
        tracked = true
        active.add(activeRunWithRejection)
        void settlement.then(
          () => {
            release()
            active.delete(activeRunWithRejection)
          },
          (error) => {
            rejectActive(error)
            // Retain rejected settlement promises so a later runtime dispose
            // cannot lose a late cleanup failure from its barrier.
          }
        )
      }
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        next(...args: [] | [undefined]) {
          track()
          return iterator.next(...args)
        },
        return(reason?: unknown) {
          track()
          return iterator.return?.(reason) ?? Promise.resolve(done())
        },
        throw(error?: unknown) {
          track()
          return (
            iterator.throw?.(error) ??
            Promise.reject(error ?? new Error("The generation cannot throw"))
          )
        },
      }
    },
  }
}

/** Await every run present at disposal start, then report the first failure. */
export async function waitForActiveGenerations(
  active: ReadonlySet<Promise<void>>
): Promise<void> {
  const outcomes = await Promise.allSettled([...active])
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
  )
  if (failure) throw failure.reason
}
