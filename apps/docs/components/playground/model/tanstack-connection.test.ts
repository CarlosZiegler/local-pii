import {
  EventType,
  type ModelMessage,
  type StreamChunk,
} from "@tanstack/ai/client"
import { describe, expect, it, vi } from "vitest"
import type { BrowserModelRuntime } from "./types"
import { createPromptConnection } from "./tanstack-connection"

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

function fakeRuntime(chunks = ["Hello ", "there"]): {
  runtime: BrowserModelRuntime
  create: ReturnType<typeof vi.fn>
  promptStreaming: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
} {
  const destroy = vi.fn()
  const promptStreaming = vi.fn(
    (_prompt: LanguageModelPrompt, _options?: LanguageModelPromptOptions) =>
      new ReadableStream<string>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      })
  )
  const create = vi.fn(
    async () => ({ destroy, promptStreaming }) as unknown as LanguageModel
  )
  return {
    create,
    destroy,
    promptStreaming,
    runtime: { kind: "gemini-nano", create },
  }
}

describe("createPromptConnection", () => {
  it("converts history and emits a complete AG-UI text lifecycle", async () => {
    const fake = fakeRuntime()
    const messages: Array<ModelMessage> = [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Latest question" },
    ]

    const chunks = await collect(
      createPromptConnection(fake.runtime).connect(
        messages,
        undefined,
        undefined,
        { threadId: "thread-1", runId: "run-1" }
      )
    )

    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPrompts: [
          { role: "user", content: "First question" },
          { role: "assistant", content: "First answer" },
        ],
      })
    )
    expect(fake.promptStreaming).toHaveBeenCalledWith(
      "Latest question",
      expect.objectContaining({ signal: undefined })
    )
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(
      chunks
        .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((chunk) => chunk.delta)
        .join("")
    ).toBe("Hello there")
    expect(chunks[0]).toMatchObject({ threadId: "thread-1", runId: "run-1" })
    expect(chunks.at(-1)).toMatchObject({
      threadId: "thread-1",
      runId: "run-1",
    })
    expect(fake.destroy).toHaveBeenCalledOnce()
  })

  it("forwards abort and destroys the browser session", async () => {
    const controller = new AbortController()
    const destroy = vi.fn()
    const promptStreaming = vi.fn(
      (_prompt: LanguageModelPrompt, options?: LanguageModelPromptOptions) =>
        new ReadableStream<string>({
          start(stream) {
            options?.signal?.addEventListener("abort", () => {
              stream.error(options.signal?.reason)
            })
          },
        })
    )
    const create = vi.fn(
      async () => ({ destroy, promptStreaming }) as unknown as LanguageModel
    )
    const runtime: BrowserModelRuntime = { kind: "gemini-nano", create }
    const iterator = createPromptConnection(runtime)
      .connect(
        [{ role: "user", content: "Wait" }],
        undefined,
        controller.signal
      )
      [Symbol.asyncIterator]()

    expect((await iterator.next()).value).toMatchObject({
      type: EventType.RUN_STARTED,
    })
    expect((await iterator.next()).value).toMatchObject({
      type: EventType.TEXT_MESSAGE_START,
    })
    const pending = iterator.next()
    controller.abort(new Error("stop"))
    expect(await pending).toMatchObject({
      value: { type: EventType.RUN_ERROR, message: "stop" },
    })
    expect(await iterator.next()).toMatchObject({ done: true })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    )
    expect(destroy).toHaveBeenCalledOnce()
  })

  it("rejects unsupported or missing final user text before model creation", async () => {
    const fake = fakeRuntime()
    const connection = createPromptConnection(fake.runtime)

    await expect(
      collect(
        connection.connect([
          { role: "assistant", content: "No final user prompt" },
        ])
      )
    ).rejects.toThrow("final message")
    expect(fake.create).not.toHaveBeenCalled()
  })
})
