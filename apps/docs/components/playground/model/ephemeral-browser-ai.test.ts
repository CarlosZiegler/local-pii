import type { LanguageModel } from "ai"
import { describe, expect, it, vi } from "vitest"
import { createEphemeralBrowserAIModel } from "./ephemeral-browser-ai"
import type { BrowserModelRuntime } from "./types"

type V4Model = Extract<LanguageModel, { specificationVersion: "v4" }>

function delegate(chunks = ["one", "two"]) {
  const destroySession = vi.fn()
  const model = {
    specificationVersion: "v4" as const,
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
  it("exposes the fallback only for provider session creation and restores the global", async () => {
    const previous = { marker: "native" }
    const fallback = {
      availability: vi.fn(async () => "available" as const),
      create: vi.fn(),
      kind: "gemma-3-270m",
    } as BrowserModelRuntime
    const promptGlobal = globalThis as typeof globalThis & {
      LanguageModel?: unknown
    }
    const previousDescriptor = Object.getOwnPropertyDescriptor(
      promptGlobal,
      "LanguageModel"
    )
    Object.defineProperty(promptGlobal, "LanguageModel", {
      configurable: true,
      value: previous,
      writable: true,
    })
    const current = delegate()
    current.model.doGenerate.mockImplementation(async () => {
      expect(promptGlobal.LanguageModel).toBe(fallback)
      throw new Error("provider failed")
    })
    const model = createEphemeralBrowserAIModel({
      createModel: () => current.model as unknown as V4Model,
      runtime: fallback,
    }) as V4Model

    try {
      await expect(model.doGenerate({ prompt: [] })).rejects.toThrow(
        "provider failed"
      )
      expect(promptGlobal.LanguageModel).toBe(previous)
    } finally {
      if (previousDescriptor) {
        Object.defineProperty(
          promptGlobal,
          "LanguageModel",
          previousDescriptor
        )
      } else {
        Reflect.deleteProperty(promptGlobal, "LanguageModel")
      }
    }
  })

  it("serializes concurrent fallback scopes and restores the original global", async () => {
    const previous = { marker: "native" }
    const fallback = {
      availability: vi.fn(async () => "available" as const),
      create: vi.fn(),
      kind: "gemma-3-270m",
    } as BrowserModelRuntime
    const promptGlobal = globalThis as typeof globalThis & {
      LanguageModel?: unknown
    }
    const previousDescriptor = Object.getOwnPropertyDescriptor(
      promptGlobal,
      "LanguageModel"
    )
    Object.defineProperty(promptGlobal, "LanguageModel", {
      configurable: true,
      value: previous,
      writable: true,
    })
    const first = delegate()
    const second = delegate()
    let finishFirst = () => {}
    first.model.doGenerate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({ content: [] })
        })
    )
    second.model.doGenerate.mockImplementation(async () => {
      expect(promptGlobal.LanguageModel).toBe(fallback)
      return { content: [] }
    })
    const createModel = vi
      .fn()
      .mockReturnValueOnce(first.model)
      .mockReturnValueOnce(second.model)
    const model = createEphemeralBrowserAIModel({
      createModel,
      runtime: fallback,
    }) as V4Model

    try {
      const firstGeneration = model.doGenerate({ prompt: [] })
      await vi.waitFor(() => expect(first.model.doGenerate).toHaveBeenCalled())
      const secondGeneration = model.doGenerate({ prompt: [] })
      await Promise.resolve()

      expect(promptGlobal.LanguageModel).toBe(fallback)
      expect(second.model.doGenerate).not.toHaveBeenCalled()

      finishFirst()
      await firstGeneration
      await secondGeneration

      expect(second.model.doGenerate).toHaveBeenCalledOnce()
      expect(promptGlobal.LanguageModel).toBe(previous)
    } finally {
      if (previousDescriptor) {
        Object.defineProperty(
          promptGlobal,
          "LanguageModel",
          previousDescriptor
        )
      } else {
        Reflect.deleteProperty(promptGlobal, "LanguageModel")
      }
    }
  })

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
