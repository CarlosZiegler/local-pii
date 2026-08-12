import type { AnonymizeResult, PiiSession, RehydrateOptions } from "local-pii"
import { managedGeneration } from "./model/browser-generation-runtime"
import { assertProtectedBrowserRequest } from "./model/protected-request"
import type {
  BrowserGenerationRuntime,
  ProtectedBrowserRequest,
  ProtectedBrowserTurn,
} from "./model/types"

export interface PrivacyInspection {
  readonly generationRunId: string
  readonly counts: Readonly<Record<string, number>>
  readonly protectedHistory: readonly ProtectedBrowserTurn[]
  readonly protectedContent: string
}

export interface ProtectionObservation {
  record(path: readonly (string | number)[], result: AnonymizeResult): void
  commit(request: ProtectedBrowserRequest): PrivacyInspection | undefined
  discard(): void
}

export interface ProtectionObserver {
  readonly session: PiiSession
  begin(generationRunId: string): ProtectionObservation
  /** Capture the run that owns a request before an async seam can race it. */
  current(): ProtectionObservation | undefined
  commit(request: ProtectedBrowserRequest): PrivacyInspection | undefined
  discard(): void
}

type PublishInspection = (inspection: PrivacyInspection) => void

interface ActiveObservation extends ProtectionObservation {
  readonly generationRunId: string
  readonly counts: Record<string, number>
  active: boolean
}

function copyProtectedHistory(
  history: readonly ProtectedBrowserTurn[]
): readonly ProtectedBrowserTurn[] {
  const copy = history.map((turn) =>
    Object.freeze({
      role: turn.role,
      protectedContent: turn.protectedContent,
    })
  )
  return Object.freeze(copy)
}

function anonymizeJsonValue(
  value: unknown,
  path: readonly (string | number)[],
  anonymize: (
    text: string,
    path: readonly (string | number)[]
  ) => Promise<string>
): Promise<unknown> {
  if (typeof value === "string") {
    return value.length === 0 ? Promise.resolve(value) : anonymize(value, path)
  }
  if (Array.isArray(value)) {
    return (async () => {
      const output: unknown[] = []
      for (const [index, item] of value.entries()) {
        output.push(await anonymizeJsonValue(item, [...path, index], anonymize))
      }
      return output
    })()
  }
  if (value !== null && typeof value === "object") {
    return (async () => {
      const output: Record<string, unknown> = {}
      for (const key of Object.keys(value)) {
        const item = await anonymizeJsonValue(
          (value as Record<string, unknown>)[key],
          [...path, key],
          anonymize
        )
        // Defining the property avoids the legacy __proto__ setter while
        // keeping the same enumerable, writable plain-object contract as
        // local-pii's JSON helper.
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: item,
          writable: true,
        })
      }
      return output
    })()
  }
  return Promise.resolve(value)
}

/**
 * Observe the exact PiiSession calls used by a browser generation run.
 * Observation is deliberately separate from the private mapping: publishing
 * a committed generation run never copies or serializes that mapping.
 */
export function createProtectionObserver(
  base: PiiSession,
  publish: PublishInspection
): ProtectionObserver {
  let active: ActiveObservation | undefined

  const record = (
    observation: ActiveObservation,
    _path: readonly (string | number)[],
    result: AnonymizeResult
  ): void => {
    if (!observation.active || active !== observation) return
    for (const entity of result.entities) {
      observation.counts[entity.type] =
        (observation.counts[entity.type] ?? 0) + 1
    }
  }

  const anonymizeForObservation = async (
    text: string,
    path: readonly (string | number)[],
    observation: ActiveObservation | undefined
  ): Promise<string> => {
    const result = await base.anonymize(text)
    if (observation) record(observation, path, result)
    return result.redactedText
  }

  const observedSession: PiiSession = {
    anonymize(text) {
      return anonymizeResult(text, active)
    },
    anonymizeJson(value) {
      const observation = active
      return anonymizeJsonValue(value, [], (text, path) =>
        anonymizeForObservation(text, path, observation)
      )
    },
    rehydrate(text, opts?: RehydrateOptions) {
      return base.rehydrate(text, opts)
    },
    rehydrateJson(value, opts?: RehydrateOptions) {
      return base.rehydrateJson(value, opts)
    },
    get mapping() {
      return base.mapping
    },
    clear() {
      base.clear()
    },
  }

  async function anonymizeResult(
    text: string,
    observation: ActiveObservation | undefined
  ): Promise<AnonymizeResult> {
    const result = await base.anonymize(text)
    if (observation) record(observation, [], result)
    return result
  }

  const begin = (generationRunId: string): ProtectionObservation => {
    if (active) active.active = false
    const observation: ActiveObservation = {
      active: true,
      counts: Object.create(null) as Record<string, number>,
      generationRunId,
      record(path, result) {
        record(observation, path, result)
      },
      commit(request) {
        if (!observation.active || active !== observation) return undefined
        assertProtectedBrowserRequest(request)
        const counts = Object.freeze({ ...observation.counts })
        const inspection = Object.freeze({
          counts,
          generationRunId: observation.generationRunId,
          protectedContent: request.protectedContent,
          protectedHistory: copyProtectedHistory(request.protectedHistory),
        })
        observation.active = false
        if (active === observation) active = undefined
        publish(inspection)
        return inspection
      },
      discard() {
        observation.active = false
        if (active === observation) active = undefined
        for (const key of Object.keys(observation.counts)) {
          delete observation.counts[key]
        }
      },
    }
    active = observation
    return observation
  }

  const observer: ProtectionObserver = {
    begin,
    current() {
      return active
    },
    commit(request) {
      return active?.commit(request)
    },
    discard() {
      active?.discard()
    },
    session: observedSession,
  }
  return observer
}

/**
 * Commit only after the decorated runtime's first iterator operation reaches
 * its generation seam. This keeps a racing gate failure from publishing a
 * request that never reached the browser runtime.
 */
export function observeBrowserRuntime(
  runtime: BrowserGenerationRuntime,
  observer: ProtectionObserver
): BrowserGenerationRuntime {
  return {
    id: runtime.id,
    disclosure: runtime.disclosure,
    generate(input) {
      assertProtectedBrowserRequest(input)
      const observation = observer.current()
      return {
        [Symbol.asyncIterator]() {
          let naturalEnd = false
          const managed = managedGeneration(
            async () => {
              const source = runtime.generate(input)
              const upstream = source[Symbol.asyncIterator]()
              return {
                next(...args: [] | [undefined]) {
                  return Promise.resolve(upstream.next(...args)).then(
                    (result) => {
                      if (result.done) naturalEnd = true
                      return result
                    }
                  )
                },
                return(reason?: unknown) {
                  observation?.discard()
                  return (
                    upstream.return?.(reason) ??
                    Promise.resolve({ done: true, value: undefined })
                  )
                },
                throw(error?: unknown) {
                  observation?.discard()
                  return (
                    upstream.throw?.(error) ??
                    Promise.reject(
                      error ?? new Error("The generation cannot throw")
                    )
                  )
                },
              }
            },
            input.signal,
            () => {
              if (!naturalEnd) observation?.discard()
            }
          )[Symbol.asyncIterator]()

          return {
            next(...args: [] | [undefined]) {
              return managed.next(...args).then(
                (result) => {
                  if (result.done) observation?.commit(input)
                  return result
                },
                (error) => {
                  observation?.discard()
                  throw error
                }
              )
            },
            return(reason?: unknown) {
              observation?.discard()
              return (
                managed.return?.(reason) ??
                Promise.resolve({ done: true, value: undefined })
              )
            },
            throw(error?: unknown) {
              observation?.discard()
              return (
                managed.throw?.(error) ??
                Promise.reject(
                  error ?? new Error("The generation cannot throw")
                )
              )
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
