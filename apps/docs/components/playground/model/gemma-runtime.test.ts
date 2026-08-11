import { describe, expect, it, vi } from "vitest"
import { createGemmaBrowserRuntime } from "./gemma-runtime"
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

function fakeTransformers(tokens = ["one ", "two ", "three"] as const) {
  const env: { experimental_useCrossOriginStorage?: boolean } = {}
  const promptMessages: Array<{ role: string; content: string }> = []
  const criteria: FakeStoppingCriteria[] = []
  const generator = Object.assign(
    vi.fn(
      async (
        _prompt: string,
        options: {
          stopping_criteria: FakeStoppingCriteria[]
          streamer: FakeTextStreamer
        }
      ) => {
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
})
