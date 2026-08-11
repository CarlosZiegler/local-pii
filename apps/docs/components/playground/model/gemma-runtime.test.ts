import { describe, expect, it, vi } from "vitest"
import {
  createGemmaBrowserRuntime,
  createGemmaLanguageModelFactory,
} from "./gemma-runtime"
import { createProtectedBrowserRequest } from "./protected-request"

class FakeStoppingCriteria {
  interrupted = false

  interrupt() {
    this.interrupted = true
  }
}

class FakeTextStreamer {
  constructor(
    _tokenizer: unknown,
    private readonly options: { callback_function(value: string): void }
  ) {}

  emit(value: string) {
    this.options.callback_function(value)
  }
}

function fakeTransformers(
  tokens: readonly string[] = ["one ", "two ", "three"]
) {
  const env: { experimental_useCrossOriginStorage?: boolean } = {}
  const promptMessages: Array<{ role: string; content: string }> = []
  const criteria: FakeStoppingCriteria[] = []
  let disposed = false
  const dispose = vi.fn(async () => {
    disposed = true
  })
  const generator = Object.assign(
    vi.fn(
      async (
        _prompt: string,
        options: {
          stopping_criteria: FakeStoppingCriteria[]
          streamer: FakeTextStreamer
        }
      ) => {
        if (disposed) throw new Error("used disposed generator")
        criteria.push(options.stopping_criteria[0]!)
        for (const value of tokens) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          if (options.stopping_criteria[0]?.interrupted) break
          options.streamer.emit(value)
        }
      }
    ),
    {
      tokenizer: {
        apply_chat_template(
          messages: Array<{ role: string; content: string }>
        ) {
          promptMessages.splice(0, promptMessages.length, ...messages)
          return "formatted prompt"
        },
      },
      dispose,
    }
  )
  const pipeline = vi.fn(async () => generator)
  const loadTransformers = vi.fn(async () => ({
    env,
    InterruptableStoppingCriteria: FakeStoppingCriteria,
    pipeline,
    TextStreamer: FakeTextStreamer,
  }))
  return {
    criteria,
    env,
    generator,
    loadTransformers,
    pipeline,
    promptMessages,
    dispose,
  }
}

function request(signal?: AbortSignal) {
  return createProtectedBrowserRequest({
    protectedHistory: [
      { role: "user", protectedContent: "Earlier" },
      { role: "assistant", protectedContent: "Answer" },
    ],
    protectedContent: "Current",
    signal,
  })
}

async function collect(source: AsyncIterable<string>): Promise<string> {
  let output = ""
  for await (const chunk of source) output += chunk
  return output
}

describe("Gemma browser-generation runtime", () => {
  it("loads lazily once and formats supplied protected history per run", async () => {
    const fake = fakeTransformers()
    const runtime = createGemmaBrowserRuntime({
      loadTransformers: fake.loadTransformers,
    })

    expect(fake.loadTransformers).not.toHaveBeenCalled()
    await expect(collect(runtime.generate(request()))).resolves.toBe(
      "one two three"
    )
    await collect(runtime.generate(request()))

    expect(fake.loadTransformers).toHaveBeenCalledOnce()
    expect(fake.pipeline).toHaveBeenCalledOnce()
    expect(fake.pipeline).toHaveBeenCalledWith(
      "text-generation",
      "onnx-community/gemma-3-270m-it-ONNX",
      expect.objectContaining({
        device: "webgpu",
        dtype: "q4f16",
        revision: "2dbbfdb1b59bd034eb959428c6a7da9dd7ea27f0",
      })
    )
    expect(fake.env.experimental_useCrossOriginStorage).toBe(false)
    expect(fake.promptMessages).toEqual([
      { role: "user", content: "Earlier" },
      { role: "assistant", content: "Answer" },
      { role: "user", content: "Current" },
    ])
    expect(runtime.disclosure).toEqual({
      label: "Gemma 3 270M IT",
      model: "onnx-community/gemma-3-270m-it-ONNX",
      source: "Transformers.js browser runtime",
      artifacts: {
        kind: "explicit-download",
        approximateBytes: 293_284_073,
        origins: ["https://huggingface.co", "https://*.cdn.hf.co"],
      },
    })
    await runtime.dispose()
    await runtime.dispose()
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it("interrupts one criterion when its generation signal aborts", async () => {
    const fake = fakeTransformers()
    const runtime = createGemmaBrowserRuntime({
      loadTransformers: fake.loadTransformers,
    })
    const abort = new AbortController()
    const reader = runtime
      .generate(request(abort.signal))
      [Symbol.asyncIterator]()

    await expect(reader.next()).resolves.toEqual({ done: false, value: "one " })
    abort.abort(new DOMException("Stopped", "AbortError"))
    await expect(reader.next()).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(fake.criteria[0]?.interrupted).toBe(true))
  })

  it("interrupts generation when its iterator is returned", async () => {
    const fake = fakeTransformers()
    const runtime = createGemmaBrowserRuntime({
      loadTransformers: fake.loadTransformers,
    })
    const reader = runtime.generate(request())[Symbol.asyncIterator]()

    await expect(reader.next()).resolves.toEqual({ done: false, value: "one " })
    await reader.return?.("stop")
    expect(fake.criteria[0]?.interrupted).toBe(true)
  })

  it("rejects non-alternating protected history before loading artifacts", () => {
    const fake = fakeTransformers()
    const runtime = createGemmaBrowserRuntime({
      loadTransformers: fake.loadTransformers,
    })
    const malformed = createProtectedBrowserRequest({
      protectedHistory: [
        { role: "user", protectedContent: "first" },
        { role: "user", protectedContent: "second" },
      ],
      protectedContent: "current",
    })

    expect(() => runtime.generate(malformed)).toThrow("alternating")
    expect(fake.loadTransformers).not.toHaveBeenCalled()
  })

  it("waits for a deferred pipeline and disposes it once", async () => {
    const opening = deferred<unknown>()
    const fake = fakeTransformers()
    const loadTransformers = vi.fn(() => opening.promise)
    const runtime = createGemmaBrowserRuntime({ loadTransformers })
    const reader = runtime.generate(request())[Symbol.asyncIterator]()
    const next = reader.next()
    await vi.waitFor(() => expect(loadTransformers).toHaveBeenCalledOnce())
    const disposal = runtime.dispose()
    opening.resolve({
      env: fake.env,
      InterruptableStoppingCriteria: FakeStoppingCriteria,
      pipeline: fake.pipeline,
      TextStreamer: FakeTextStreamer,
    })
    await expect(next).rejects.toThrow("disposed")
    await disposal
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it("surfaces a pipeline disposal error without repeating disposal", async () => {
    const fake = fakeTransformers()
    const disposalError = new Error("pipeline disposal")
    fake.dispose.mockRejectedValue(disposalError)
    const runtime = createGemmaBrowserRuntime({
      loadTransformers: fake.loadTransformers,
    })
    await collect(runtime.generate(request()))
    await expect(runtime.dispose()).rejects.toBe(disposalError)
    await expect(runtime.dispose()).rejects.toBe(disposalError)
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it("observes compatibility destroy disposal failures without unhandled rejection", async () => {
    const fake = fakeTransformers(["ok"])
    const disposalError = new Error("destroy disposal")
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const model = await factory.create()
    const stream = await model.promptStreaming("Current question")
    const reader = stream.getReader()
    while (!(await reader.read()).done) {
      // Drain the stream so the shared pipeline is loaded before destroy.
    }
    fake.dispose.mockRejectedValue(disposalError)

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      model.destroy()
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }

    expect(fake.dispose).toHaveBeenCalledOnce()
    expect(unhandled).toEqual([])
  })

  it("memoizes a synchronous pipeline dispose throw", async () => {
    const fake = fakeTransformers(["ok"])
    const disposalError = new Error("synchronous disposal")
    fake.dispose.mockImplementation(() => {
      throw disposalError
    })
    const runtime = createGemmaBrowserRuntime({
      loadTransformers: fake.loadTransformers,
    })
    await collect(runtime.generate(request()))

    await expect(runtime.dispose()).rejects.toBe(disposalError)
    await expect(runtime.dispose()).rejects.toBe(disposalError)
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it("memoizes concurrent late-open and runtime disposal", async () => {
    const opening = deferred<unknown>()
    const fake = fakeTransformers(["ok"])
    const disposalError = new Error("concurrent disposal")
    fake.dispose.mockImplementation(() => {
      throw disposalError
    })
    const loadTransformers = vi.fn(() => opening.promise)
    const runtime = createGemmaBrowserRuntime({ loadTransformers })
    const reader = runtime.generate(request())[Symbol.asyncIterator]()
    const next = reader.next()
    await vi.waitFor(() => expect(loadTransformers).toHaveBeenCalledOnce())

    const disposal = runtime.dispose()
    opening.resolve({
      env: fake.env,
      InterruptableStoppingCriteria: FakeStoppingCriteria,
      pipeline: fake.pipeline,
      TextStreamer: FakeTextStreamer,
    })
    await expect(next).rejects.toBe(disposalError)
    await expect(disposal).rejects.toBe(disposalError)
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it("does not dispose the shared pipeline for one aborted run", async () => {
    const opening = deferred<unknown>()
    const fake = fakeTransformers()
    const loadTransformers = vi.fn(() => opening.promise)
    const runtime = createGemmaBrowserRuntime({ loadTransformers })
    const abort = new AbortController()
    const first = runtime
      .generate(request(abort.signal))
      [Symbol.asyncIterator]()
    const second = runtime.generate(request())[Symbol.asyncIterator]()
    const firstNext = first.next()
    const secondNext = second.next()
    await vi.waitFor(() => expect(loadTransformers).toHaveBeenCalledOnce())

    const reason = new DOMException("Stopped", "AbortError")
    abort.abort(reason)
    await expect(firstNext).rejects.toBe(reason)

    opening.resolve({
      env: fake.env,
      InterruptableStoppingCriteria: FakeStoppingCriteria,
      pipeline: fake.pipeline,
      TextStreamer: FakeTextStreamer,
    })
    await expect(secondNext).resolves.toEqual({
      done: false,
      value: "one ",
    })
    expect(fake.dispose).not.toHaveBeenCalled()
    await second.return?.("stop")
    await runtime.dispose()
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it("disposes the shared pipeline after all active runs settle", async () => {
    const opening = deferred<unknown>()
    const fake = fakeTransformers()
    const loadTransformers = vi.fn(() => opening.promise)
    const runtime = createGemmaBrowserRuntime({
      loadTransformers,
    })
    const abort = new AbortController()
    const first = runtime
      .generate(request(abort.signal))
      [Symbol.asyncIterator]()
    const second = runtime.generate(request())[Symbol.asyncIterator]()
    const firstNext = first.next()
    const secondNext = second.next()
    await vi.waitFor(() => expect(loadTransformers).toHaveBeenCalledOnce())

    // Both runs share a pending load. The first settles with its primary abort
    // error; disposal must still wait for the second late acquisition.
    abort.abort(new DOMException("Stopped", "AbortError"))
    await expect(firstNext).rejects.toMatchObject({ name: "AbortError" })
    const disposal = runtime.dispose()

    opening.resolve({
      env: fake.env,
      InterruptableStoppingCriteria: FakeStoppingCriteria,
      pipeline: fake.pipeline,
      TextStreamer: FakeTextStreamer,
    })
    await expect(secondNext).rejects.toThrow("disposed")
    await disposal
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it("preserves a leading system role through the compatibility bridge", async () => {
    const fake = fakeTransformers(["ok"])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const model = await factory.create({
      initialPrompts: [{ role: "system", content: "Follow these rules" }],
    })
    const stream = await model.promptStreaming("Current question")
    const reader = stream.getReader()
    while (!(await reader.read()).done) {
      // Drain the compatibility stream so the tokenizer is invoked.
    }

    expect(fake.promptMessages).toEqual([
      { role: "system", content: "Follow these rules" },
      { role: "user", content: "Current question" },
    ])
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
