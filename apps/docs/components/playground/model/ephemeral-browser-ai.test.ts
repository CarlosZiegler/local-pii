import type { LanguageModel } from "ai"
import { describe, expect, it, vi } from "vitest"
import { createEphemeralBrowserAIModel } from "./ephemeral-browser-ai"

type V4Model = Extract<LanguageModel, { specificationVersion: "v4" }>

function delegate(chunks = ["one", "two"]) {
  const destroySession = vi.fn()
  const model = {
    specificationVersion: "v4",
    provider: "browser-ai",
    modelId: "text",
    supportedUrls: {},
    sessionManager: { destroySession },
    doGenerate: vi.fn(async () => ({ content: [] })),
    doStream: vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
    })),
  }
  return { destroySession, model }
}

describe("ephemeral Browser AI model", () => {
  it("creates and destroys a separate provider model for every generation", async () => {
    const first = delegate()
    const second = delegate()
    const createModel = vi
      .fn()
      .mockReturnValueOnce(first.model)
      .mockReturnValueOnce(second.model)
    const model = createEphemeralBrowserAIModel({ createModel }) as V4Model

    await model.doGenerate({ prompt: [] })
    await model.doGenerate({ prompt: [] })

    expect(createModel).toHaveBeenCalledTimes(2)
    expect(first.destroySession).toHaveBeenCalledOnce()
    expect(second.destroySession).toHaveBeenCalledOnce()
  })

  it("releases the provider session after a stream is consumed or cancelled", async () => {
    const complete = delegate()
    const cancelled = delegate()
    const createModel = vi
      .fn()
      .mockReturnValueOnce(complete.model)
      .mockReturnValueOnce(cancelled.model)
    const model = createEphemeralBrowserAIModel({ createModel }) as V4Model

    const first = await model.doStream({ prompt: [] })
    const firstReader = first.stream.getReader()
    while (!(await firstReader.read()).done) {}

    const second = await model.doStream({ prompt: [] })
    await second.stream.cancel("stop")

    expect(complete.destroySession).toHaveBeenCalledOnce()
    expect(cancelled.destroySession).toHaveBeenCalledOnce()
  })
})
