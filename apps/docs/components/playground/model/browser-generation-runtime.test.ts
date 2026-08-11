import { describe, expect, it, vi } from "vitest"
import {
  managedGeneration,
  trackActiveGeneration,
} from "./browser-generation-runtime"
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

  it("returns the upstream concurrently with a pending next", async () => {
    const pending = deferred<IteratorResult<string>>()
    const returned = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }))
    const open = vi.fn(async () => ({
      next: () => pending.promise,
      return: returned,
    }))
    const reader = managedGeneration(open)[Symbol.asyncIterator]()
    const next = reader.next()
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    const close = reader.return?.("stop")
    await Promise.resolve()
    const returnedBeforeNextSettled = returned.mock.calls.length
    pending.resolve({ done: true, value: undefined })
    await close
    await next
    expect(returnedBeforeNextSettled).toBe(1)
    expect(returned).toHaveBeenCalledWith("stop")
  })

  it("awaits late-open cleanup from consumer return", async () => {
    const opening = deferred<AsyncIterator<string>>()
    const returned = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }))
    const settled = vi.fn()
    const reader = managedGeneration(() => opening.promise, undefined, settled)[
      Symbol.asyncIterator
    ]()
    const pendingNext = reader.next()
    const close = reader.return?.("stop")

    await Promise.resolve()
    let returnedClose = false
    void close?.then(() => {
      returnedClose = true
    })
    await Promise.resolve()
    expect(returnedClose).toBe(false)
    expect(settled).not.toHaveBeenCalled()

    opening.resolve({
      next: async () => ({ done: true, value: undefined }),
      return: returned,
    })
    await close
    await pendingNext
    expect(returned).toHaveBeenCalledWith("stop")
    expect(settled).toHaveBeenCalledOnce()
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

  it("awaits existing cleanup when return follows abort", async () => {
    const abort = new AbortController()
    const releaseReturn = deferred<void>()
    const returned = vi.fn(async () => {
      await releaseReturn.promise
      return { done: true as const, value: undefined }
    })
    const settled = vi.fn()
    const reader = managedGeneration(
      async () => ({
        next: () => new Promise<IteratorResult<string>>(() => {}),
        return: returned,
      }),
      abort.signal,
      settled
    )[Symbol.asyncIterator]()
    const pending = reader.next()
    const reason = new Error("abort first")
    abort.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(returned).toHaveBeenCalledWith(reason))

    const close = reader.return?.("return later")
    let closed = false
    void close?.then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(settled).not.toHaveBeenCalled()

    releaseReturn.resolve()
    await close
    expect(settled).toHaveBeenCalledOnce()
  })

  it("delivers an abort reason only to the pending next", async () => {
    const abort = new AbortController()
    const reader = managedGeneration(
      async () => ({
        next: () => new Promise<IteratorResult<string>>(() => {}),
        return: async () => ({ done: true as const, value: undefined }),
      }),
      abort.signal
    )[Symbol.asyncIterator]()
    const pending = reader.next()
    const reason = new Error("stop once")
    abort.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await expect(reader.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it("delivers an explicit throw only once", async () => {
    const reader = managedGeneration(async () => ({
      next: () => new Promise<IteratorResult<string>>(() => {}),
    }))[Symbol.asyncIterator]()
    const reason = new Error("explicit throw")

    await expect(reader.throw?.(reason)).rejects.toBe(reason)
    await expect(reader.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
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
    opening.resolve({
      next: async () => ({ done: true, value: undefined }),
    })
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
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

  it("rejects a signal missing the symmetric abort interface", () => {
    expect(() =>
      createProtectedBrowserRequest({
        protectedHistory: [],
        protectedContent: "Current",
        signal: {
          aborted: false,
          addEventListener() {},
        } as unknown as AbortSignal,
      })
    ).toThrow("AbortSignal")
  })

  it("surfaces late cleanup failure through return and the disposal barrier", async () => {
    const opening = deferred<AsyncIterator<string>>()
    const cleanupError = new Error("late cleanup")
    const active = new Set<Promise<void>>()
    const source = trackActiveGeneration(
      managedGeneration(
        () => opening.promise,
        undefined,
        () => {
          throw cleanupError
        }
      ),
      active
    )
    const reader = source[Symbol.asyncIterator]()
    const pending = reader.next()
    const close = reader.return?.("stop")
    const disposal = Promise.all([...active])

    opening.resolve({
      next: async () => ({ done: true, value: undefined }),
      return: async () => ({ done: true, value: undefined }),
    })
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await expect(close).rejects.toBe(cleanupError)
    await expect(disposal).rejects.toBe(cleanupError)
  })

  it("preserves an undefined upstream cleanup error over callback cleanup", async () => {
    const callbackError = new Error("callback cleanup")
    const reader = managedGeneration(
      async () => ({
        next: () => new Promise<IteratorResult<string>>(() => {}),
        return: async () => {
          throw undefined
        },
      }),
      undefined,
      () => {
        throw callbackError
      }
    )[Symbol.asyncIterator]()
    const pending = reader.next()
    const close = reader.return?.("stop")

    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await expect(close).rejects.toBeUndefined()
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

  it("delivers a terminal cleanup failure only once", async () => {
    const cleanupError = new Error("terminal cleanup")
    const reader = managedGeneration(
      async () => ({
        next: async () => ({ done: true as const, value: undefined }),
      }),
      undefined,
      () => {
        throw cleanupError
      }
    )[Symbol.asyncIterator]()

    await expect(reader.next()).rejects.toBe(cleanupError)
    await expect(reader.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it("preserves an undefined primary error over cleanup failure", async () => {
    const cleanupError = new Error("cleanup")
    const reader = managedGeneration(
      async () => ({
        async next(): Promise<IteratorResult<string>> {
          throw undefined
        },
        async return() {
          throw cleanupError
        },
      }),
      undefined,
      () => {
        throw cleanupError
      }
    )[Symbol.asyncIterator]()
    let caught: unknown = Symbol("not caught")
    try {
      await reader.next()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeUndefined()
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

  it("does not acquire an iterable created before disposal", async () => {
    const runtime = createFakeBrowserRuntime()
    const reader = runtime
      .generate(
        createProtectedBrowserRequest({
          protectedHistory: [],
          protectedContent: "current",
        })
      )
      [Symbol.asyncIterator]()
    await runtime.dispose()
    await expect(reader.next()).rejects.toThrow("disposed")
    expect(runtime.acquired).toBe(0)
  })

  it("tracks two iterators from one iterable independently", async () => {
    const runtime = createFakeBrowserRuntime({ chunks: ["one", "two"] })
    const source = runtime.generate(
      createProtectedBrowserRequest({
        protectedHistory: [],
        protectedContent: "current",
      })
    )
    const first = source[Symbol.asyncIterator]()
    const second = source[Symbol.asyncIterator]()
    await first.next()
    await second.next()
    const disposal = runtime.dispose()
    await Promise.resolve()
    await first.return?.("first")
    let settled = false
    void disposal.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await second.return?.("second")
    await disposal
    expect(runtime.acquired).toBe(2)
    expect(runtime.released).toBe(2)
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
