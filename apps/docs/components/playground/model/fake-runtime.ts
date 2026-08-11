import { assertProtectedBrowserRequest } from "./protected-request"
import type {
  BrowserGenerationRuntime,
  ProtectedBrowserRequest,
  RuntimeDisclosure,
} from "./types"
import { managedGeneration } from "./browser-generation-runtime"

export interface FakeBrowserRuntimeOptions {
  readonly chunks?: readonly string[]
  readonly disclosure?: RuntimeDisclosure
}

export interface FakeBrowserGenerationRuntime extends BrowserGenerationRuntime {
  readonly acquired: number
  readonly released: number
  readonly requests: readonly ProtectedBrowserRequest[]
}

const FAKE_DISCLOSURE: RuntimeDisclosure = {
  label: "Deterministic fake",
  model: "Deterministic fake",
  source: "docs test runtime",
  artifacts: { kind: "browser-managed" },
}

/** A deterministic adapter used to exercise runtime and adapter lifecycles. */
export function createFakeBrowserRuntime(
  options: FakeBrowserRuntimeOptions = {}
): FakeBrowserGenerationRuntime {
  const chunks = [...(options.chunks ?? ["one", "two"])]
  const requests: ProtectedBrowserRequest[] = []
  let acquired = 0
  let released = 0
  let disposed = false
  const active = new Set<Promise<void>>()

  const runtime: FakeBrowserGenerationRuntime = {
    id: "fake",
    disclosure: options.disclosure ?? FAKE_DISCLOSURE,
    get acquired() {
      return acquired
    },
    get released() {
      return released
    },
    requests,
    generate(input) {
      assertProtectedBrowserRequest(input)
      if (disposed) throw new Error("The fake browser runtime is disposed")
      requests.push(input)
      let release!: () => void
      const settled = new Promise<void>((resolve) => {
        release = resolve
      })
      let started = false

      const generation = managedGeneration(
        async () => {
          acquired += 1
          let index = 0
          return {
            async next() {
              if (index >= chunks.length)
                return { done: true, value: undefined }
              return { done: false, value: chunks[index++]! }
            },
            async return() {
              return { done: true, value: undefined }
            },
          }
        },
        input.signal,
        () => {
          released += 1
          release()
          active.delete(settled)
        }
      )
      return {
        [Symbol.asyncIterator]() {
          const iterator = generation[Symbol.asyncIterator]()
          return {
            [Symbol.asyncIterator]() {
              return this
            },
            next(...args: [] | [undefined]) {
              if (!started) {
                started = true
                active.add(settled)
              }
              return iterator.next(...args)
            },
            return(reason?: unknown) {
              return (
                iterator.return?.(reason) ??
                Promise.resolve({ done: true, value: undefined })
              )
            },
            throw(error?: unknown) {
              return (
                iterator.throw?.(error) ??
                Promise.reject(
                  error ?? new Error("The generation cannot throw")
                )
              )
            },
          }
        },
      }
    },
    async dispose() {
      disposed = true
      await Promise.all([...active])
    },
  }
  return runtime
}

export const createFakeRuntime = createFakeBrowserRuntime
