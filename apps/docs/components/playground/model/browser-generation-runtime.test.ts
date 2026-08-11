import { describe, expect, it, vi } from "vitest"
import { managedGeneration } from "./browser-generation-runtime"
import { createFakeBrowserRuntime } from "./fake-runtime"
import { createProtectedBrowserRequest } from "./protected-request"

async function collect(source: AsyncIterable<string>): Promise<string> {
  let output = ""
  for await (const chunk of source) output += chunk
  return output
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("managedGeneration", () => {
  it("does not acquire when already aborted", async () => {
    const abort = new AbortController()
    const open = vi.fn()
    const settled = vi.fn()
    abort.abort(new Error("before acquisition"))

    await expect(
      collect(managedGeneration(open, abort.signal, settled))
    ).rejects.toThrow("before acquisition")
    expect(open).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledOnce()
  })

  it("returns the source and settles on consumer return", async () => {
    const returned = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }))
    const iterator: AsyncIterator<string> = {
      next: vi.fn(async () => ({ done: false, value: "one" })),
      return: returned,
    }
    const source = managedGeneration(async () => iterator)
    const reader = source[Symbol.asyncIterator]()

    await expect(reader.next()).resolves.toEqual({ done: false, value: "one" })
    await reader.return?.("stop")
    expect(returned).toHaveBeenCalledWith("stop")
  })

  it("returns the source on abort while next is pending", async () => {
    const abort = new AbortController()
    const pending = deferred<IteratorResult<string>>()
    const returned = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }))
    const iterator: AsyncIterator<string> = {
      next: () => pending.promise,
      return: returned,
    }
    const reader = managedGeneration(async () => iterator, abort.signal)[
      Symbol.asyncIterator
    ]()
    const next = reader.next()
    abort.abort(new Error("stop"))

    await expect(next).rejects.toThrow("stop")
    expect(returned).toHaveBeenCalledWith(expect.any(Error))
  })

  it("rejects promptly when abort interrupts a pending open", async () => {
    const abort = new AbortController()
    const opening = deferred<AsyncIterator<string>>()
    const settled = vi.fn()
    const reader = managedGeneration(
      () => opening.promise,
      abort.signal,
      settled
    )[Symbol.asyncIterator]()
    const next = reader.next()
    const reason = new Error("stop opening")

    abort.abort(reason)

    await expect(next).rejects.toBe(reason)
    expect(settled).toHaveBeenCalledOnce()
    opening.resolve({
      next: async () => ({ done: true, value: undefined }),
    })
  })

  it("freezes the marked request and rejects a non-leading system turn", () => {
    const request = createProtectedBrowserRequest({
      protectedHistory: [{ role: "user", protectedContent: "Earlier" }],
      protectedContent: "Current",
    })

    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.protectedHistory)).toBe(true)
    expect(Object.isFrozen(request.protectedHistory[0])).toBe(true)
    expect(() => {
      ;(request as { protectedContent: string }).protectedContent = "changed"
    }).toThrow()
    expect(() => {
      ;(request.protectedHistory as unknown as { role: "system" }[])[0]!.role =
        "system"
    }).toThrow()
    expect(() =>
      createProtectedBrowserRequest({
        protectedHistory: [
          { role: "user", protectedContent: "Earlier" },
          { role: "system", protectedContent: "late" },
        ],
        protectedContent: "Current",
      })
    ).toThrow("leading system")
  })

  it("preserves a generation error over cleanup failure", async () => {
    const generationError = new Error("generation")
    const cleanupError = new Error("cleanup")
    const iterator: AsyncIterator<string> = {
      next: vi.fn(async () => {
        throw generationError
      }),
      return: vi.fn(async () => {
        throw cleanupError
      }),
    }
    await expect(
      collect(
        managedGeneration(
          async () => iterator,
          undefined,
          () => {
            throw cleanupError
          }
        )
      )
    ).rejects.toBe(generationError)
    expect(iterator.return).toHaveBeenCalled()
  })

  it("reports cleanup failure after normal completion", async () => {
    const cleanupError = new Error("cleanup")
    const iterator: AsyncIterator<string> = {
      next: vi.fn(async () => ({ done: true as const, value: undefined })),
    }
    await expect(
      collect(
        managedGeneration(
          async () => iterator,
          undefined,
          () => {
            throw cleanupError
          }
        )
      )
    ).rejects.toBe(cleanupError)
  })

  it("waits for an active deterministic fake run before disposal", async () => {
    const runtime = createFakeBrowserRuntime({ chunks: ["one", "two"] })
    const source = runtime.generate(
      createProtectedBrowserRequest({
        protectedHistory: [],
        protectedContent: "current",
      })
    )
    const reader = source[Symbol.asyncIterator]()
    await expect(reader.next()).resolves.toEqual({ done: false, value: "one" })
    let disposed = false
    const disposal = runtime.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    await reader.return?.("stop")
    await disposal
    expect(disposed).toBe(true)
    expect(runtime.acquired).toBe(1)
    expect(runtime.released).toBe(1)
  })

  it("does not treat an unstarted generation as active", async () => {
    const runtime = createFakeBrowserRuntime()
    runtime.generate(
      createProtectedBrowserRequest({
        protectedHistory: [],
        protectedContent: "current",
      })
    )
    await expect(runtime.dispose()).resolves.toBeUndefined()
  })

  it("settles an iterator returned before its source is opened", async () => {
    const runtime = createFakeBrowserRuntime()
    const reader = runtime
      .generate(
        createProtectedBrowserRequest({
          protectedHistory: [],
          protectedContent: "current",
        })
      )
      [Symbol.asyncIterator]()
    await reader.return?.("stop")
    await expect(runtime.dispose()).resolves.toBeUndefined()
    expect(runtime.acquired).toBe(0)
    expect(runtime.released).toBe(0)
  })
})
