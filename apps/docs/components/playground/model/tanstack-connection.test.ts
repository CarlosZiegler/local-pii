import { EventType, type ModelMessage } from "@tanstack/ai/client"
import { createAnonymizer } from "local-pii"
import { piiConnection } from "local-pii/tanstack"
import { describe, expect, it } from "vitest"
import { createFakeBrowserRuntime } from "./fake-runtime"
import {
  createBrowserConnection,
  UnsupportedPromptMessageError,
} from "./tanstack-connection"

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
    expect(chunks[0]).toMatchObject({ threadId: "thread-1", runId: "run-1" })
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
})
