import type { BrowserGenerationRuntime } from "./model/types"

export interface PrivateConversationReset {
  blockSubmissions(blocked: boolean): void
  abortActiveRun(): void
  stopFramework(): Promise<Error | undefined>
  awaitRunSettlement(): Promise<void>
  awaitRuntimeCleanup(): Promise<void>
  clearFramework(): void
  clearFrameworkError(): void
  clearOldSession(): void
  clearInspection(): void
  createNewSession(): void
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function isAbort(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "AbortError"
  )
}

/** Reset one private conversation while preserving the first non-abort error. */
export async function resetPrivateConversation(
  actions: PrivateConversationReset
): Promise<Error | undefined> {
  let failure: Error | undefined
  const capture = (cause: unknown) => {
    if (!failure && !isAbort(cause)) failure = asError(cause)
  }
  const run = (action: () => void) => {
    try {
      action()
    } catch (cause) {
      capture(cause)
    }
  }

  run(() => actions.blockSubmissions(true))
  run(actions.abortActiveRun)
  try {
    const stopFailure = await actions.stopFramework()
    if (stopFailure) capture(stopFailure)
  } catch (cause) {
    capture(cause)
  }
  try {
    await actions.awaitRunSettlement()
  } catch (cause) {
    capture(cause)
  }
  try {
    await actions.awaitRuntimeCleanup()
  } catch (cause) {
    capture(cause)
  }
  run(actions.clearFramework)
  run(actions.clearFrameworkError)
  run(actions.clearOldSession)
  run(actions.clearInspection)
  run(actions.createNewSession)
  run(() => actions.blockSubmissions(false))
  return failure
}

export interface GenerationRun {
  readonly id: string
  readonly signal: AbortSignal
  recordFailure(cause: unknown): void
  track(settlement: PromiseLike<void>): void
  settle(): void
  abort(reason?: unknown): void
}

export interface GenerationRunRegistry {
  begin(): GenerationRun
  settle(runId: string): void
  abort(runId: string, reason?: unknown): void
  isCurrent(runId: string): boolean
  waitForActive(): Promise<void>
}

/** Record runtime/cleanup failures against the run that created a request. */
export function recordGenerationRunFailures(
  runtime: BrowserGenerationRuntime,
  getRun: () => GenerationRun | null
): BrowserGenerationRuntime {
  return {
    id: runtime.id,
    disclosure: runtime.disclosure,
    generate(input) {
      const run = getRun()
      let source: AsyncIterable<string>
      try {
        source = runtime.generate(input)
      } catch (cause) {
        run?.recordFailure(cause)
        throw cause
      }
      return {
        [Symbol.asyncIterator]() {
          const upstream = source[Symbol.asyncIterator]()
          let terminal = false
          let resolveTerminal!: () => void
          let rejectTerminal!: (cause: unknown) => void
          const settlement = new Promise<void>((resolve, reject) => {
            resolveTerminal = resolve
            rejectTerminal = reject
          })
          void settlement.catch(() => undefined)
          run?.track(settlement)
          const record = (cause: unknown): never => {
            run?.recordFailure(cause)
            throw cause
          }
          const complete = (result: IteratorResult<string>) => {
            if (result.done && !terminal) {
              terminal = true
              resolveTerminal()
            }
            return result
          }
          const fail = (cause: unknown): never => {
            if (!terminal) {
              terminal = true
              rejectTerminal(cause)
            }
            return record(cause)
          }
          const rejectFailure = (
            cause: unknown
          ): Promise<IteratorResult<string>> => {
            if (!terminal) {
              terminal = true
              rejectTerminal(cause)
            }
            run?.recordFailure(cause)
            return Promise.reject(cause)
          }
          return {
            next(...args: [] | [undefined]) {
              try {
                return Promise.resolve(upstream.next(...args)).then(
                  complete,
                  fail
                )
              } catch (cause) {
                return rejectFailure(cause)
              }
            },
            return(reason?: unknown) {
              try {
                return Promise.resolve(
                  upstream.return?.(reason) ?? {
                    done: true as const,
                    value: undefined,
                  }
                ).then(complete, fail)
              } catch (cause) {
                return rejectFailure(cause)
              }
            },
            throw(error?: unknown) {
              try {
                return Promise.resolve(
                  upstream.throw?.(error) ?? Promise.reject(error)
                ).then(complete, fail)
              } catch (cause) {
                return rejectFailure(cause)
              }
            },
          }
        },
      }
    },
    dispose() {
      return runtime.dispose()
    },
  }
}

export function createGenerationRunRegistry(): GenerationRunRegistry {
  let nextId = 0
  let active:
    (GenerationRun & { readonly settlement: Promise<void> }) | undefined

  return {
    begin() {
      active?.abort(
        new DOMException("A newer generation started", "AbortError")
      )
      let resolveSettlement!: () => void
      let rejectSettlement!: (reason: unknown) => void
      let failure: unknown
      let hasFailure = false
      let settled = false
      const settlement = new Promise<void>((resolve, reject) => {
        resolveSettlement = resolve
        rejectSettlement = reject
      })
      void settlement.catch(() => undefined)
      const controller = new AbortController()
      let settleRequested = false
      let pendingSettlements = 0
      const finishIfReady = () => {
        if (settled || !settleRequested || pendingSettlements !== 0) return
        settled = true
        if (hasFailure) rejectSettlement(failure)
        else resolveSettlement()
        if (active?.id === run.id) active = undefined
      }
      const run: GenerationRun & { readonly settlement: Promise<void> } = {
        id: `run-${++nextId}`,
        signal: controller.signal,
        settlement,
        recordFailure(cause) {
          if (!settled && !hasFailure && !isAbort(cause)) {
            failure = cause
            hasFailure = true
          }
        },
        track(pending) {
          if (settled) return
          pendingSettlements += 1
          void Promise.resolve(pending).then(
            () => {
              pendingSettlements -= 1
              finishIfReady()
            },
            (cause) => {
              run.recordFailure(cause)
              pendingSettlements -= 1
              finishIfReady()
            }
          )
        },
        settle() {
          settleRequested = true
          finishIfReady()
        },
        abort(reason = new DOMException("Generation cancelled", "AbortError")) {
          if (!controller.signal.aborted) controller.abort(reason)
        },
      }
      active = run
      return run
    },
    settle(runId) {
      if (active?.id === runId) active.settle()
    },
    abort(runId, reason) {
      if (active?.id === runId) active.abort(reason)
    },
    isCurrent(runId) {
      return active?.id === runId
    },
    async waitForActive() {
      const current = active
      if (current) await current.settlement
    },
  }
}
