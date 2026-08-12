import { managedGeneration } from "./model/browser-generation-runtime"
import type {
  BrowserGenerationRuntime,
  ProtectedBrowserRequest,
} from "./model/types"

export type GenerationOwner = "vercel" | "tanstack"

export interface GenerationGateSnapshot {
  readonly owner: GenerationOwner | null
}

export interface GenerationLease {
  readonly owner: GenerationOwner
  release(): void
}

export interface GenerationGate {
  tryAcquire(owner: GenerationOwner): GenerationLease
  getSnapshot(): GenerationGateSnapshot
  subscribe(listener: () => void): () => void
}

export class PlaygroundBusyError extends Error {
  override readonly name = "PlaygroundBusyError"

  constructor() {
    super("Another playground chat is generating")
  }
}

export function createGenerationGate(): GenerationGate {
  const listeners = new Set<() => void>()
  let owner: GenerationOwner | null = null
  let snapshot: GenerationGateSnapshot = Object.freeze({ owner })

  const publish = () => {
    snapshot = Object.freeze({ owner })
    for (const listener of listeners) listener()
  }

  return {
    tryAcquire(nextOwner) {
      if (owner !== null) throw new PlaygroundBusyError()
      owner = nextOwner
      publish()
      let released = false
      return {
        owner: nextOwner,
        release() {
          if (released) return
          released = true
          if (owner !== nextOwner) return
          owner = null
          publish()
        },
      }
    },
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * Decorate a runtime without moving gate state into the runtime. The source
 * runtime and its model-session cleanup remain authoritative; the lease is
 * released by the outer managed iterator after that cleanup settles.
 */
export function withPlaygroundGate(
  runtime: BrowserGenerationRuntime,
  gate: GenerationGate,
  owner: GenerationOwner
): BrowserGenerationRuntime {
  return {
    id: runtime.id,
    disclosure: runtime.disclosure,
    generate(input: ProtectedBrowserRequest) {
      let lease: GenerationLease | undefined
      return managedGeneration(
        async () => {
          lease = gate.tryAcquire(owner)
          const source = runtime.generate(input)
          return source[Symbol.asyncIterator]()
        },
        input.signal,
        () => {
          lease?.release()
        }
      )
    },
    dispose() {
      return runtime.dispose()
    },
  }
}
