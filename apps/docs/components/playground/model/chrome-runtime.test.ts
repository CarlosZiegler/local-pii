import { describe, expect, it, vi } from "vitest"
import {
  CHROME_TEXT_EXPECTATIONS,
  createChromeBrowserRuntime,
  discoverChromePromptFactory,
  type ChromePromptSession,
} from "./chrome-runtime"
import { createProtectedBrowserRequest } from "./protected-request"

async function collect(source: AsyncIterable<string>): Promise<string> {
  let output = ""
  for await (const chunk of source) output += chunk
  return output
}

function request(signal?: AbortSignal) {
  return createProtectedBrowserRequest({
    protectedHistory: [{ role: "user", protectedContent: "Earlier" }],
    protectedContent: "Current",
    signal,
  })
}

describe("Chrome browser-generation runtime", () => {
  it("discovers a class-shaped Chrome LanguageModel without writing to it", () => {
    class NativeLanguageModel {
      static create = vi.fn()
      static availability = vi.fn()
    }
    try {
      vi.stubGlobal("LanguageModel", NativeLanguageModel)
      expect(discoverChromePromptFactory()).toBe(NativeLanguageModel)

      vi.stubGlobal("LanguageModel", function malformed() {})
      expect(discoverChromePromptFactory()).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("rejects a create-only global as unavailable", () => {
    class CreateOnlyLanguageModel {
      static create = vi.fn()
    }
    try {
      vi.stubGlobal("LanguageModel", CreateOnlyLanguageModel)
      expect(discoverChromePromptFactory()).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("creates one Prompt API session with protected initial prompts", async () => {
    const destroy = vi.fn()
    const promptStreaming = vi.fn(
      () =>
        new ReadableStream<string>({
          start(controller) {
            controller.enqueue("one")
            controller.enqueue("two")
            controller.close()
          },
        })
    )
    const create = vi.fn(async () => ({ destroy, promptStreaming }))
    const runtime = createChromeBrowserRuntime({ create })

    await expect(collect(runtime.generate(request()))).resolves.toBe("onetwo")
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith({
      ...CHROME_TEXT_EXPECTATIONS,
      initialPrompts: [{ role: "user", content: "Earlier" }],
    })
    expect(promptStreaming).toHaveBeenCalledWith("Current", {})
    expect(destroy).toHaveBeenCalledOnce()
  })

  it("destroys a session when the generation is cancelled", async () => {
    const abort = new AbortController()
    const destroy = vi.fn()
    const streamCancel = vi.fn()
    const promptStreaming = vi.fn(
      () =>
        new ReadableStream<string>({
          cancel: streamCancel,
        })
    )
    const runtime = createChromeBrowserRuntime({
      create: vi.fn(async () => ({
        destroy,
        promptStreaming,
      })),
    })
    const iterator = runtime
      .generate(request(abort.signal))
      [Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => expect(promptStreaming).toHaveBeenCalledOnce())
    const reason = new Error("stop")
    abort.abort(reason)

    await expect(pending).rejects.toBe(reason)
    await expect(runtime.dispose()).resolves.toBeUndefined()
    expect(destroy).toHaveBeenCalledOnce()
    expect(streamCancel).toHaveBeenCalledWith(reason)
    expect(promptStreaming).toHaveBeenCalledWith("Current", {
      signal: abort.signal,
    })
  })

  it("waits for every active cleanup before reporting the first failure", async () => {
    const firstError = new Error("first destroy")
    const releaseSecond = deferred<void>()
    const destroyFirst = vi.fn(async () => {
      throw firstError
    })
    const destroySecond = vi.fn(async () => {
      await releaseSecond.promise
    })
    let created = 0
    const create = vi.fn(async () => {
      created += 1
      const destroy = created === 1 ? destroyFirst : destroySecond
      return {
        destroy,
        promptStreaming: () => ({
          next: () => new Promise<IteratorResult<string>>(() => {}),
          return: async () => ({ done: true as const, value: undefined }),
          [Symbol.asyncIterator]() {
            return this
          },
        }),
      }
    })
    const runtime = createChromeBrowserRuntime({ create })
    const first = runtime.generate(request())[Symbol.asyncIterator]()
    const second = runtime.generate(request())[Symbol.asyncIterator]()
    const firstNext = first.next()
    const secondNext = second.next()
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))

    const firstReturn = first.return?.("first")
    await expect(firstReturn).rejects.toBe(firstError)
    await expect(firstNext).resolves.toEqual({ done: true, value: undefined })

    const disposal = runtime.dispose()
    let disposed = false
    void disposal.catch(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)

    const secondReturn = second.return?.("second")
    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseSecond.resolve()
    await expect(secondReturn).resolves.toEqual({
      done: true,
      value: undefined,
    })
    await expect(secondNext).resolves.toEqual({ done: true, value: undefined })
    await expect(disposal).rejects.toBe(firstError)
    expect(destroyFirst).toHaveBeenCalledOnce()
    expect(destroySecond).toHaveBeenCalledOnce()
  })

  it("destroys a late-created session after disposal", async () => {
    const opening = deferred<ChromePromptSession>()
    const destroy = vi.fn()
    const promptStreaming = vi.fn(
      () =>
        new ReadableStream<string>({
          start(controller) {
            controller.close()
          },
        })
    )
    const create = vi.fn(async () => opening.promise)
    const runtime = createChromeBrowserRuntime({ create })
    const reader = runtime.generate(request())[Symbol.asyncIterator]()
    const next = reader.next()
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    const disposal = runtime.dispose()
    opening.resolve({ destroy, promptStreaming })
    await expect(next).rejects.toThrow("disposed")
    await disposal
    expect(promptStreaming).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it("rejects an unmarked request before factory acquisition", () => {
    const create = vi.fn()
    const runtime = createChromeBrowserRuntime({ create })
    const input = {
      protectedHistory: [],
      protectedContent: "already protected",
    }

    expect(() => runtime.generate(input)).toThrow(
      "minted by the protected adapter"
    )
    expect(create).not.toHaveBeenCalled()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
