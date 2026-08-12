import { describe, expect, it, vi } from "vitest"
import type {
  BrowserGenerationRuntime,
  ProtectedBrowserRequest,
} from "./model/types"
import { createProtectedBrowserRequest } from "./model/protected-request"
import {
  createGenerationGate,
  PlaygroundBusyError,
  withPlaygroundGate,
} from "./generation-gate"

function request(signal?: AbortSignal): ProtectedBrowserRequest {
  return createProtectedBrowserRequest({
    protectedHistory: [],
    protectedContent: "protected content",
    signal,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function runtime(
  open: () => Promise<AsyncIterator<string>>
): BrowserGenerationRuntime {
  return {
    id: "test",
    disclosure: {
      label: "Test",
      model: "test",
      source: "test",
      artifacts: { kind: "browser-managed" },
    },
    generate: vi.fn(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => open().then((iterator) => iterator.next()),
        }
      },
    })),
    dispose: vi.fn(async () => undefined),
  }
}

describe("generation gate", () => {
  it("rejects a racing owner synchronously and releases idempotently", () => {
    const gate = createGenerationGate()
    const changes: unknown[] = []
    gate.subscribe(() => changes.push(gate.getSnapshot()))

    const lease = gate.tryAcquire("vercel")
    expect(gate.getSnapshot()).toEqual({ owner: "vercel" })
    expect(() => gate.tryAcquire("tanstack")).toThrow(PlaygroundBusyError)
    lease.release()
    lease.release()
    expect(gate.getSnapshot()).toEqual({ owner: null })
    expect(changes).toHaveLength(2)
  })

  it("does not retain sessions, histories, or mappings", () => {
    const gate = createGenerationGate()
    expect(JSON.stringify(gate)).not.toMatch(/session|history|mapping/i)
    expect(Object.keys(gate)).not.toEqual(
      expect.arrayContaining(["session", "history", "mapping"])
    )
  })

  it("acquires only when the decorated iterator starts", async () => {
    const gate = createGenerationGate()
    const pending = deferred<AsyncIterator<string>>()
    const source = runtime(() => pending.promise)
    const wrapped = withPlaygroundGate(source, gate, "vercel")
    const abort = new AbortController()
    const generation = wrapped.generate(request(abort.signal))

    expect(gate.getSnapshot()).toEqual({ owner: null })
    const iterator = generation[Symbol.asyncIterator]()
    expect(gate.getSnapshot()).toEqual({ owner: null })
    const next = iterator.next()
    await vi.waitFor(() =>
      expect(gate.getSnapshot()).toEqual({ owner: "vercel" })
    )
    expect(() =>
      withPlaygroundGate(source, gate, "tanstack").generate(request())
    ).not.toThrow()
    const racing = withPlaygroundGate(source, gate, "tanstack").generate(
      request()
    )
    await expect(racing[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
      PlaygroundBusyError
    )
    pending.resolve({
      next: async () => ({ done: true, value: undefined }),
      return: async () => ({ done: true, value: undefined }),
    })
    await next
    expect(gate.getSnapshot()).toEqual({ owner: null })
  })

  it("keeps the gate busy until upstream return cleanup settles", async () => {
    const gate = createGenerationGate()
    const cleanup = deferred<void>()
    const returned = vi.fn(async () => {
      await cleanup.promise
      return { done: true as const, value: undefined }
    })
    const source: BrowserGenerationRuntime = {
      id: "cleanup",
      disclosure: {
        label: "Cleanup",
        model: "cleanup",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate: vi.fn(() => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: false, value: "chunk" }),
            return: returned,
          }
        },
      })),
      dispose: vi.fn(async () => undefined),
    }
    const abort = new AbortController()
    const iterator = withPlaygroundGate(source, gate, "vercel")
      .generate(request(abort.signal))
      [Symbol.asyncIterator]()
    await iterator.next()
    const close = iterator.return?.("stop")
    await vi.waitFor(() => expect(returned).toHaveBeenCalled())
    expect(gate.getSnapshot()).toEqual({ owner: "vercel" })
    cleanup.resolve()
    await close
    expect(gate.getSnapshot()).toEqual({ owner: null })
  })

  it("does not let a rejected sibling iterator release the active lease", async () => {
    const gate = createGenerationGate()
    const pending = deferred<IteratorResult<string>>()
    const source: BrowserGenerationRuntime = {
      id: "sibling",
      disclosure: {
        label: "Sibling",
        model: "sibling",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => pending.promise,
            return: async () => ({ done: true, value: undefined }),
          }
        },
      }),
      dispose: async () => undefined,
    }
    const generated = withPlaygroundGate(source, gate, "vercel").generate(
      request()
    )
    const first = generated[Symbol.asyncIterator]()
    const second = generated[Symbol.asyncIterator]()
    const firstNext = first.next()
    await vi.waitFor(() =>
      expect(gate.getSnapshot()).toEqual({ owner: "vercel" })
    )

    await expect(second.next()).rejects.toBeInstanceOf(PlaygroundBusyError)
    expect(gate.getSnapshot()).toEqual({ owner: "vercel" })
    expect(() => gate.tryAcquire("tanstack")).toThrow(PlaygroundBusyError)

    pending.resolve({ done: true, value: undefined })
    await firstNext
    expect(gate.getSnapshot()).toEqual({ owner: null })
  })
})
