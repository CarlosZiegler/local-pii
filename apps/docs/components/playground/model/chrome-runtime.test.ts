import { describe, expect, it, vi } from "vitest"
import {
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
