import {
  EventType,
  type ModelMessage,
  type StreamChunk,
} from "@tanstack/ai/client"
import type { RunAgentInputContext } from "@tanstack/ai-client"
import { createAnonymizer } from "local-pii"
import { piiConnection } from "local-pii/tanstack"
import { describe, expect, it, vi } from "vitest"
import { createFakeBrowserRuntime } from "./fake-runtime"
import { managedGeneration } from "./browser-generation-runtime"
import {
  createBrowserConnection,
  UnsupportedPromptMessageError,
} from "./tanstack-connection"
import type { BrowserGenerationRuntime } from "./types"

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

describe("createBrowserConnection", () => {
  it("mints one protected request and emits a complete AG-UI lifecycle", async () => {
    const runtime = createFakeBrowserRuntime({ chunks: ["Hello ", "there"] })
    const messages: ModelMessage[] = [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Latest question" },
    ]

    const chunks = await collect(
      createBrowserConnection(runtime).connect(messages, undefined, undefined, {
        threadId: "thread-1",
        runId: "run-1",
        parentRunId: "parent-1",
      })
    )

    expect(runtime.requests).toHaveLength(1)
    expect(runtime.requests[0]).toMatchObject({
      protectedHistory: [
        { role: "user", protectedContent: "First question" },
        { role: "assistant", protectedContent: "First answer" },
      ],
      protectedContent: "Latest question",
    })
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
    expect(chunks[0]).toMatchObject({
      threadId: "thread-1",
      runId: "run-1",
      parentRunId: "parent-1",
    })
    expect(chunks.at(-1)).toMatchObject({
      threadId: "thread-1",
      runId: "run-1",
    })
    expect(runtime.acquired).toBe(1)
    expect(runtime.released).toBe(1)
  })

  it("rejects unsupported or missing final user text before acquisition", async () => {
    const runtime = createFakeBrowserRuntime()
    const connection = createBrowserConnection(runtime)

    await expect(
      collect(
        connection.connect([
          { role: "assistant", content: "No final user prompt" },
        ])
      )
    ).rejects.toThrow(UnsupportedPromptMessageError)
    expect(runtime.acquired).toBe(0)
  })

  it("protects TanStack messages before minting the browser request", async () => {
    const runtime = createFakeBrowserRuntime({ chunks: ["ok"] })
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@example.com" }],
    }).createSession()
    const messages: ModelMessage[] = [
      { role: "user", content: "Email ana@example.com" },
      { role: "user", content: "Current" },
    ]
    const source = piiConnection(createBrowserConnection(runtime), { session })

    await collect(source.connect(messages))

    expect(runtime.requests[0]?.protectedHistory[0]?.protectedContent).not.toBe(
      "Email ana@example.com"
    )
    expect(messages[0]).toEqual({
      role: "user",
      content: "Email ana@example.com",
    })
  })

  it("includes run identity on errors", async () => {
    const runtime: BrowserGenerationRuntime = {
      id: "failing",
      disclosure: {
        label: "test",
        model: "test",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate() {
        return (async function* (): AsyncGenerator<string> {
          throw new Error("generation failed")
        })()
      },
      dispose: async () => {},
    }
    const context: RunAgentInputContext = {
      threadId: "thread-error",
      runId: "run-error",
      parentRunId: "parent-error",
    }
    const chunks: StreamChunk[] = []
    for await (const chunk of createBrowserConnection(runtime).connect(
      [{ role: "user", content: "Current" }],
      undefined,
      undefined,
      context
    )) {
      chunks.push(chunk)
    }
    expect(chunks.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      threadId: "thread-error",
      runId: "run-error",
    })
  })

  it("waits for generation cleanup before publishing an abort error", async () => {
    const abort = new AbortController()
    const releaseCleanup = deferred<void>()
    const returned = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }))
    const settled = vi.fn(async () => {
      await releaseCleanup.promise
    })
    const runtime: BrowserGenerationRuntime = {
      id: "abort-cleanup",
      disclosure: {
        label: "test",
        model: "test",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate(input) {
        return managedGeneration(
          async () => ({
            next: () => new Promise<IteratorResult<string>>(() => {}),
            return: returned,
          }),
          input.signal,
          settled
        )
      },
      dispose: async () => {},
    }
    const signal = abort.signal
    const source = createBrowserConnection(runtime).connect(
      [{ role: "user", content: "Current" }],
      undefined,
      signal,
      { threadId: "thread-abort", runId: "run-abort" }
    )
    const iterator = source[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: EventType.RUN_STARTED },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: EventType.TEXT_MESSAGE_START },
    })

    const terminal = iterator.next()
    const reason = new DOMException("Stopped", "AbortError")
    abort.abort(reason)
    await vi.waitFor(() => expect(returned).toHaveBeenCalledWith(reason))

    let published = false
    void terminal.then(() => {
      published = true
    })
    await Promise.resolve()
    expect(published).toBe(false)
    expect(settled).toHaveBeenCalledOnce()

    releaseCleanup.resolve()
    await expect(terminal).resolves.toMatchObject({
      value: {
        type: EventType.RUN_ERROR,
        threadId: "thread-abort",
        runId: "run-abort",
        message: "AbortError: Stopped",
      },
    })
  })

  it("propagates inner cleanup failure when the consumer returns early", async () => {
    const cleanupError = new Error("early cleanup")
    let pulls = 0
    const runtime: BrowserGenerationRuntime = {
      id: "early-return-cleanup",
      disclosure: {
        label: "test",
        model: "test",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate() {
        return managedGeneration(
          async () => ({
            next: async () => {
              pulls += 1
              if (pulls === 1) return { done: false, value: "chunk" }
              return new Promise<IteratorResult<string>>(() => {})
            },
            return: async () => ({ done: true as const, value: undefined }),
          }),
          undefined,
          () => {
            throw cleanupError
          }
        )
      },
      dispose: async () => {},
    }
    const iterator = createBrowserConnection(runtime)
      .connect([{ role: "user", content: "Current" }])
      [Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: EventType.TEXT_MESSAGE_CONTENT, delta: "chunk" },
    })

    await expect(iterator.return?.()).rejects.toBe(cleanupError)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
