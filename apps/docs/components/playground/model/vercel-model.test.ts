import { createAnonymizer } from "local-pii"
import { withPii } from "local-pii/ai-sdk"
import type { LanguageModel } from "ai"
import { describe, expect, it, vi } from "vitest"
import { createFakeBrowserRuntime } from "./fake-runtime"
import { managedGeneration } from "./browser-generation-runtime"
import {
  createBrowserLanguageModel,
  UnsupportedBrowserModelInputError,
} from "./vercel-model"
import type { BrowserGenerationRuntime } from "./types"

type V4Model = Extract<LanguageModel, { specificationVersion: "v4" }>
type V4CallOptions = Parameters<V4Model["doGenerate"]>[0]

async function collect<T>(source: ReadableStream<T>): Promise<T[]> {
  const values: T[] = []
  const reader = source.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return values
    values.push(next.value)
  }
}

function options(): V4CallOptions {
  return {
    prompt: [
      { role: "system", content: "Answer concisely" },
      { role: "user", content: [{ type: "text", text: "Earlier" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier answer" }],
      },
      { role: "user", content: [{ type: "text", text: "Current" }] },
    ],
  }
}

describe("createBrowserLanguageModel", () => {
  it("passes only protected history/current content and streams v4 parts", async () => {
    const runtime = createFakeBrowserRuntime({ chunks: ["Hello ", "there"] })
    const modelOptions = options()
    const sourcePrompt = structuredClone(modelOptions.prompt)
    const session = createAnonymizer({ detectors: "none" }).createSession()
    const model = withPii(createBrowserLanguageModel(runtime), { session })

    const result = await model.doGenerate(modelOptions)
    expect(result.content).toEqual([{ type: "text", text: "Hello there" }])
    expect(runtime.requests[0]).toMatchObject({
      protectedHistory: [
        { role: "system", protectedContent: "Answer concisely" },
        { role: "user", protectedContent: "Earlier" },
        { role: "assistant", protectedContent: "Earlier answer" },
      ],
      protectedContent: "Current",
    })
    expect(modelOptions.prompt).toEqual(sourcePrompt)

    const parts = await collect((await model.doStream(modelOptions)).stream)
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ])
  })

  it("rejects files, tools, reasoning, and unsupported final prompts before runtime", async () => {
    const runtime = createFakeBrowserRuntime()
    const model = createBrowserLanguageModel(runtime)

    await expect(
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "file", data: "x" }] }],
      } as unknown as V4CallOptions)
    ).rejects.toThrow(UnsupportedBrowserModelInputError)
    await expect(model.doGenerate({ ...options(), tools: [] })).rejects.toThrow(
      UnsupportedBrowserModelInputError
    )
    await expect(
      model.doGenerate({ ...options(), reasoning: "low" })
    ).rejects.toThrow(UnsupportedBrowserModelInputError)
    expect(runtime.acquired).toBe(0)
  })

  it("does not write, delete, or define the Prompt API global", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "LanguageModel"
    )
    const runtime = createFakeBrowserRuntime({ chunks: ["done"] })
    const model = createBrowserLanguageModel(runtime)
    await model.doGenerate(options())
    expect(
      Object.getOwnPropertyDescriptor(globalThis, "LanguageModel")
    ).toEqual(descriptor)
  })

  it("returns the generation iterator when its v4 stream is cancelled", async () => {
    const pending = deferred<IteratorResult<string>>()
    const returned = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }))
    const runtime: BrowserGenerationRuntime = {
      id: "cancellable",
      disclosure: {
        label: "test",
        model: "test",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate() {
        return managedGeneration(async () => ({
          next: () => pending.promise,
          return: returned,
        }))
      },
      dispose: async () => {},
    }
    const model = createBrowserLanguageModel(runtime)
    const stream = (await model.doStream(options())).stream
    const reader = stream.getReader()
    await expect(reader.read()).resolves.toMatchObject({
      value: { type: "stream-start" },
    })
    const cancel = reader.cancel("stop")
    const outcome = await Promise.race([
      cancel.then(() => "cancelled" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 100)
      ),
    ])
    pending.resolve({ done: true, value: undefined })
    await cancel
    expect(outcome).toBe("cancelled")
    expect(returned).toHaveBeenCalledWith("stop")
  })

  it("awaits late-open cleanup when a v4 stream is cancelled", async () => {
    const opening = deferred<AsyncIterator<string>>()
    const returned = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }))
    const settled = vi.fn()
    const runtime: BrowserGenerationRuntime = {
      id: "late-open-cancellable",
      disclosure: {
        label: "test",
        model: "test",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate() {
        return managedGeneration(() => opening.promise, undefined, settled)
      },
      dispose: async () => {},
    }
    const model = createBrowserLanguageModel(runtime)
    const stream = (await model.doStream(options())).stream
    const reader = stream.getReader()
    await expect(reader.read()).resolves.toMatchObject({
      value: { type: "stream-start" },
    })

    const cancel = reader.cancel("stop")
    let cancelled = false
    void cancel.then(() => {
      cancelled = true
    })
    await Promise.resolve()
    expect(cancelled).toBe(false)
    expect(settled).not.toHaveBeenCalled()

    opening.resolve({
      next: async () => ({ done: true, value: undefined }),
      return: returned,
    })
    await cancel
    expect(returned).toHaveBeenCalledWith("stop")
    expect(settled).toHaveBeenCalledOnce()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
