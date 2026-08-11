import { describe, expect, it, vi } from "vitest"
import { createChromeBrowserRuntime } from "./chrome-runtime"
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
    const promptStreaming = vi.fn(
      () =>
        new ReadableStream<string>({
          start() {},
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
    abort.abort(new Error("stop"))

    await expect(pending).rejects.toThrow("stop")
    await expect(runtime.dispose()).resolves.toBeUndefined()
    expect(destroy).toHaveBeenCalledOnce()
    expect(promptStreaming).toHaveBeenCalledWith("Current", {
      signal: abort.signal,
    })
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
