import { describe, expect, it, vi } from "vitest"
import { createGemmaLanguageModelFactory } from "./gemma-runtime"

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

function fakeTransformers(tokens = ["one ", "two ", "three"]) {
  let generated = 0
  let promptMessages: Array<{ role: string; content: string }> = []
  const progress = vi.fn()
  const generator = Object.assign(
    vi.fn(
      async (
        _prompt: string,
        options: {
          stopping_criteria: FakeStoppingCriteria[]
          streamer: FakeTextStreamer
        }
      ) => {
        for (const value of tokens) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          if (options.stopping_criteria[0]?.interrupted) break
          generated += 1
          options.streamer.emit(value)
        }
        return [{ generated_text: tokens.join("") }]
      }
    ),
    {
      tokenizer: {
        apply_chat_template(
          messages: Array<{ role: string; content: string }>
        ) {
          promptMessages = messages
          return "formatted prompt"
        },
      },
    }
  )
  const pipeline = vi.fn(
    async (
      _task: string,
      _model: string,
      options: { progress_callback(event: unknown): void }
    ) => {
      options.progress_callback({ progress: 50, status: "progress_total" })
      options.progress_callback({ status: "ready" })
      progress()
      return generator
    }
  )

  return {
    generated: () => generated,
    loadTransformers: vi.fn(async () => ({
      env: {},
      InterruptableStoppingCriteria: FakeStoppingCriteria,
      pipeline,
      TextStreamer: FakeTextStreamer,
    })),
    pipeline,
    progress,
    promptMessages: () => promptMessages,
  }
}

async function collect(stream: ReadableStream<string>): Promise<string> {
  let result = ""
  const reader = stream.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) break
    result += next.value
  }
  return result
}

describe("Gemma browser runtime", () => {
  it("loads once, reports progress, and formats the complete conversation", async () => {
    const fake = fakeTransformers()
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const loaded: number[] = []
    const model = await factory.create({
      initialPrompts: [{ role: "user", content: "Earlier" }],
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          loaded.push(event.loaded)
        })
      },
    })

    await expect(collect(model.promptStreaming("Now"))).resolves.toBe(
      "one two three"
    )
    await factory.create()

    expect(loaded).toEqual([0.5, 1])
    expect(fake.pipeline).toHaveBeenCalledOnce()
    expect(fake.promptMessages()).toEqual([
      { role: "user", content: "Earlier" },
      { role: "user", content: "Now" },
    ])
  })

  it("interrupts Transformers generation when the Prompt API signal aborts", async () => {
    const fake = fakeTransformers()
    const factory = await createGemmaLanguageModelFactory({
      loadTransformers: fake.loadTransformers,
    })
    const model = await factory.create()
    const abort = new AbortController()
    const reader = model
      .promptStreaming("Generate", { signal: abort.signal })
      .getReader()

    await expect(reader.read()).resolves.toEqual({ done: false, value: "one " })
    abort.abort(new DOMException("Stopped", "AbortError"))
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(fake.generated()).toBe(1))
  })
})
