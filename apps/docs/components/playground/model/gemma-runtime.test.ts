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
  tokens: readonly string[] = ["one ", "two ", "three"],
  failure?: Error,
  stuckAfterFirst = false
) {
  const env: { experimental_useCrossOriginStorage?: boolean } = {}
  const promptMessages: Array<{ role: string; content: string }> = []
  const criteria: FakeStoppingCriteria[] = []
  let disposed = false
  let generationFailure = failure
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
        for (const [index, value] of tokens.entries()) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          if (options.stopping_criteria[0]?.interrupted) break
          options.streamer.emit(value)
          if (stuckAfterFirst && index === 0) {
            await new Promise<void>(() => {})
          }
        }
        if (generationFailure) {
          const error = generationFailure
          generationFailure = undefined
          throw error
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

  it("rejects unsupported compatibility roles before loading artifacts", async () => {
    const fake = fakeTransformers()
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })

    await expect(
      factory.create({
        initialPrompts: [{ role: "tool" as never, content: "Unsupported" }],
      })
    ).rejects.toThrow("tool")

    const session = await factory.create()
    expect(() =>
      session.promptStreaming([
        { role: "tool" as never, content: "Unsupported" },
        { role: "user", content: "Current" },
      ])
    ).toThrow("tool")
    await expect(
      session.append([{ role: "tool" as never, content: "Unsupported" }])
    ).rejects.toThrow("tool")
    expect(fake.loadTransformers).not.toHaveBeenCalled()
  })

  it("rejects oversized compatibility context before loading artifacts", async () => {
    const fake = fakeTransformers()
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const oversized = "x".repeat(32_768 * 4 + 1)

    await expect(
      factory.create({ initialPrompts: [{ role: "user", content: oversized }] })
    ).rejects.toMatchObject({ name: "QuotaExceededError" })

    const session = await factory.create()
    expect(() => session.promptStreaming(oversized)).toThrow(
      expect.objectContaining({ name: "QuotaExceededError" })
    )
    await expect(session.append(oversized)).rejects.toMatchObject({
      name: "QuotaExceededError",
    })
    expect(fake.loadTransformers).not.toHaveBeenCalled()
  })

  it("evicts oldest post-initial pairs and dispatches both overflow events", async () => {
    const turn = "u".repeat(8_000 * 4)
    const answer = "a".repeat(8_000 * 4)
    const fake = fakeTransformers([answer])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create({
      initialPrompts: [{ role: "system", content: "Keep this anchor" }],
    })
    const contextOverflow = vi.fn()
    const quotaOverflow = vi.fn()
    const contextEvent = vi.fn()
    const quotaEvent = vi.fn()
    session.oncontextoverflow = contextOverflow
    session.onquotaoverflow = quotaOverflow
    session.addEventListener("contextoverflow", contextEvent)
    session.addEventListener("quotaoverflow", quotaEvent)

    await session.prompt(turn)
    await session.prompt(turn)
    await session.prompt(turn)

    expect(contextOverflow).toHaveBeenCalledOnce()
    expect(quotaOverflow).toHaveBeenCalledOnce()
    expect(contextEvent).toHaveBeenCalledOnce()
    expect(quotaEvent).toHaveBeenCalledOnce()
    expect(session.contextUsage).toBeLessThanOrEqual(session.contextWindow)
    expect(fake.promptMessages.map(({ role }) => role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ])
    expect(fake.promptMessages[1]?.content).toBe(turn)
    expect(fake.promptMessages[2]?.content).toBe(answer)
    expect(fake.promptMessages[3]?.content).toBe(turn)
  })

  it("evicts oldest post-initial pairs from append without acquiring the model", async () => {
    const turn = "u".repeat(8_000 * 4)
    const answer = "a".repeat(8_000 * 4)
    const fake = fakeTransformers()
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create({
      initialPrompts: [{ role: "system", content: "Keep this anchor" }],
    })
    const contextOverflow = vi.fn()
    const quotaOverflow = vi.fn()
    session.oncontextoverflow = contextOverflow
    session.onquotaoverflow = quotaOverflow

    await session.append([
      { role: "user", content: turn },
      { role: "assistant", content: answer },
    ])
    await session.append([
      { role: "user", content: turn },
      { role: "assistant", content: answer },
    ])
    await session.append([
      { role: "user", content: turn },
      { role: "assistant", content: answer },
    ])

    expect(contextOverflow).toHaveBeenCalledOnce()
    expect(quotaOverflow).toHaveBeenCalledOnce()
    expect(session.contextUsage).toBeLessThanOrEqual(session.contextWindow)
    expect(fake.loadTransformers).not.toHaveBeenCalled()
  })

  it("rejects an overlapping prompt before acquisition and preserves causal history", async () => {
    const fake = fakeTransformers(["answer "])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()
    const first = session.promptStreaming("First question")
    const firstReader = first.getReader()

    await expect(firstReader.read()).resolves.toEqual({
      done: false,
      value: "answer ",
    })
    expect(() => session.promptStreaming("Overlapping question")).toThrow(
      "active"
    )
    expect(fake.promptMessages).toHaveLength(1)

    await expect(firstReader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    })

    const third = session.promptStreaming("After first")
    const thirdReader = third.getReader()
    while (!(await thirdReader.read()).done) {
      // Drain the post-settlement prompt.
    }

    expect(fake.promptMessages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "answer " },
      { role: "user", content: "After first" },
    ])
  })

  it("rejects prompt overlap while promptStreaming is active", async () => {
    const fake = fakeTransformers(["answer "])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()
    const first = session.promptStreaming("First question")
    const firstReader = first.getReader()

    await expect(firstReader.read()).resolves.toEqual({
      done: false,
      value: "answer ",
    })
    await expect(session.prompt("Overlapping question")).rejects.toMatchObject({
      name: "InvalidStateError",
    })
    expect(fake.promptMessages).toHaveLength(1)

    await expect(firstReader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    })
    await expect(session.prompt("After first")).resolves.toBe("answer ")
  })

  it("measures supplied turns without requiring room in anchored history", async () => {
    const fake = fakeTransformers()
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create({
      initialPrompts: [
        { role: "system", content: "x".repeat((32_768 - 8) * 4) },
      ],
    })

    await expect(session.measureContextUsage("12345678")).resolves.toBe(2)
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

  it("does not dispose shared artifacts when compatibility destroy closes a session", async () => {
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

    expect(fake.dispose).not.toHaveBeenCalled()
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

  it("preserves every preceding array-form turn in the compatibility bridge", async () => {
    const fake = fakeTransformers(["ok"])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()
    const stream = session.promptStreaming([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Current question" },
    ])
    expect(stream).toBeInstanceOf(ReadableStream)
    const reader = stream.getReader()
    while (!(await reader.read()).done) {
      // Drain the compatibility stream so the tokenizer is invoked.
    }

    expect(fake.promptMessages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Current question" },
    ])
  })

  it("commits a successful prompt and assistant response to the next turn", async () => {
    const fake = fakeTransformers(["answer "])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()

    await expect(session.prompt("First question")).resolves.toBe("answer ")
    expect(session.contextWindow).toBe(32_768)
    expect(session.inputQuota).toBe(32_768)
    expect(session.contextUsage).toBe(
      Math.ceil("First questionanswer ".length / 4)
    )
    await expect(session.measureContextUsage("Second question")).resolves.toBe(
      Math.ceil("Second question".length / 4)
    )
    const clone = await session.clone()
    await expect(clone.prompt("Clone question")).resolves.toBe("answer ")
    expect(fake.promptMessages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "answer " },
      { role: "user", content: "Clone question" },
    ])
    clone.destroy()
    const second = session.promptStreaming("Second question")
    const reader = second.getReader()
    while (!(await reader.read()).done) {
      // Drain the second successful prompt.
    }

    expect(fake.promptMessages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "answer " },
      { role: "user", content: "Second question" },
    ])
  })

  it("does not commit a failed prompt to session history", async () => {
    const failure = new Error("generation failed")
    const fake = fakeTransformers(["partial "], failure)
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()

    await expect(session.prompt("Failed question")).rejects.toBe(failure)

    const next = session.promptStreaming("Next question")
    const reader = next.getReader()
    while (!(await reader.read()).done) {
      // Drain the next prompt after the failed one.
    }
    expect(fake.promptMessages).toEqual([
      { role: "user", content: "Next question" },
    ])
  })

  it("exposes the synchronous native LanguageModel session surface", async () => {
    const fake = fakeTransformers(["ok"])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()

    const initialStream = session.promptStreaming("Current")
    expect(initialStream).toBeInstanceOf(ReadableStream)
    const initialReader = initialStream.getReader()
    while (!(await initialReader.read()).done) {
      // Drain the shape-check prompt before starting another prompt.
    }
    await expect(session.prompt("Current")).resolves.toBe("ok")
    await expect(
      session.measureContextUsage("Current")
    ).resolves.toBeGreaterThan(0)
    await expect(session.measureInputUsage("Current")).resolves.toBeGreaterThan(
      0
    )
    await expect(session.append("Earlier")).resolves.toBeUndefined()
    await expect(session.clone()).resolves.toMatchObject({
      prompt: expect.any(Function),
      promptStreaming: expect.any(Function),
      measureContextUsage: expect.any(Function),
    })
    session.destroy()
  })

  it("keeps the compatibility runtime alive after a warm session is destroyed", async () => {
    const fake = fakeTransformers(["ok"])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const warmSession = await factory.create()
    warmSession.destroy()

    const session = await factory.create()
    const stream = await session.promptStreaming("Current question")
    const reader = stream.getReader()
    while (!(await reader.read()).done) {
      // Drain the later session after activation's warm session is destroyed.
    }

    expect(fake.dispose).not.toHaveBeenCalled()
  })

  it("destroys only the compatibility session's active iterator", async () => {
    const fake = fakeTransformers()
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const firstSession = await factory.create()
    const secondSession = await factory.create()
    const firstStream = await firstSession.promptStreaming("First")
    const firstReader = firstStream.getReader()
    await expect(firstReader.read()).resolves.toEqual({
      done: false,
      value: "one ",
    })

    firstSession.destroy()

    const secondStream = await secondSession.promptStreaming("Second")
    const secondReader = secondStream.getReader()
    while (!(await secondReader.read()).done) {
      // The second session remains usable while the first is being destroyed.
    }
    expect(fake.dispose).not.toHaveBeenCalled()
  })

  it("aborts an active compatibility reader when its session is destroyed", async () => {
    const fake = fakeTransformers(["one ", "two ", "three"])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()
    const stream = await session.promptStreaming("Current")
    const reader = stream.getReader()

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: "one ",
    })
    const pending = reader.read()

    session.destroy()

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
    })
  })

  it("keeps a not-yet-pulled compatibility reader aborted after destroy", async () => {
    const fake = fakeTransformers(["one "])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()
    const stream = session.promptStreaming("Current")

    session.destroy()

    const reader = stream.getReader()
    await expect(reader.read()).rejects.toMatchObject({
      name: "AbortError",
    })
  })

  it("keeps a sibling compatibility session usable after one is destroyed", async () => {
    const fake = fakeTransformers(["one ", "two ", "three"])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const first = await factory.create()
    const second = await factory.create()
    const firstStream = await first.promptStreaming("First")
    const firstReader = firstStream.getReader()
    await expect(firstReader.read()).resolves.toEqual({
      done: false,
      value: "one ",
    })
    const firstPending = firstReader.read()

    const secondStream = await second.promptStreaming("Second")
    const secondReader = secondStream.getReader()
    first.destroy()

    await expect(firstPending).rejects.toMatchObject({ name: "AbortError" })
    await expect(secondReader.read()).resolves.toEqual({
      done: false,
      value: "one ",
    })
    second.destroy()
  })

  it("preserves the caller abort reason through compatibility composition", async () => {
    const fake = fakeTransformers(["one ", "two ", "three"])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()
    const abort = new AbortController()
    const stream = await session.promptStreaming("Current", {
      signal: abort.signal,
    })
    const reader = stream.getReader()
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: "one ",
    })
    const pending = reader.read()
    const reason = new DOMException("Caller stopped", "AbortError")

    abort.abort(reason)

    await expect(pending).rejects.toBe(reason)
    session.destroy()
  })

  it("does not commit an aborted prompt to session history", async () => {
    const fake = fakeTransformers(["partial ", "later "])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()
    const abort = new AbortController()
    const stream = session.promptStreaming("Aborted question", {
      signal: abort.signal,
    })
    const reader = stream.getReader()
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: "partial ",
    })
    const pending = reader.read()
    abort.abort(new DOMException("Stopped", "AbortError"))
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })

    const next = session.promptStreaming("Next question")
    const nextReader = next.getReader()
    while (!(await nextReader.read()).done) {
      // Drain the next prompt after the aborted one.
    }
    expect(fake.promptMessages).toEqual([
      { role: "user", content: "Next question" },
    ])
  })

  it("surfaces an abort before an ignored generator cleanup settles", async () => {
    const fake = fakeTransformers(["partial ", "never"], undefined, true)
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()
    const abort = new AbortController()
    const stream = session.promptStreaming("Stuck question", {
      signal: abort.signal,
    })
    const reader = stream.getReader()
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: "partial ",
    })
    const pending = reader.read()
    const reason = new DOMException("Caller stopped", "AbortError")
    abort.abort(reason)

    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (error) => error
      ),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 100)),
    ])
    expect(outcome).toBe(reason)
    session.destroy()
  })

  it("does not commit a cancelled prompt to session history", async () => {
    const fake = fakeTransformers(["partial ", "later "])
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const session = await factory.create()
    const stream = session.promptStreaming("Cancelled question")
    const reader = stream.getReader()
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: "partial ",
    })
    await reader.cancel("cancelled")

    const next = session.promptStreaming("Next question")
    const nextReader = next.getReader()
    while (!(await nextReader.read()).done) {
      // Drain the next prompt after the cancelled one.
    }
    expect(fake.promptMessages).toEqual([
      { role: "user", content: "Next question" },
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
