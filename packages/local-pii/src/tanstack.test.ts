import {
  EventType,
  type ModelMessage,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai/client"
import type {
  ConnectConnectionAdapter,
  RunAgentInputContext,
} from "@tanstack/ai-client"
import { describe, expect, it, vi } from "vitest"
import { createAnonymizer } from "./anonymizer"
import { token } from "./placeholder/strategies"
import { piiConnection } from "./tanstack"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const value of iterable) output.push(value)
  return output
}

async function* emptyStream(): AsyncIterableIterator<StreamChunk> {
  return
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

describe("piiConnection message protection", () => {
  it("protects semantic UI and model content without mutating control fields", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const calls: Array<Parameters<ConnectConnectionAdapter["connect"]>> = []
    const inner: ConnectConnectionAdapter = {
      connect(messages, data, signal, runContext) {
        calls.push([messages, data, signal, runContext])
        return emptyStream()
      },
    }
    const wrapped = piiConnection(inner, { session })
    const createdAt = new Date("2026-08-08T08:00:00.000Z")
    const textMetadata = { trace: "ana@acme.com-must-stay" }
    const structuredData = { email: "ana@acme.com-ui-data-must-stay" }
    const imagePart = {
      type: "image" as const,
      source: {
        type: "url" as const,
        value: "https://cdn.example/ana@acme.com/avatar.png",
      },
      metadata: { alt: "ana@acme.com-must-stay" },
    }
    const uiMessages = deepFreeze<Array<UIMessage>>([
      {
        id: "ana@acme.com-control-id",
        role: "user",
        createdAt,
        parts: [
          {
            type: "text",
            content: "Email ana@acme.com or call +49 151 12345678",
            metadata: textMetadata,
          },
          imagePart,
          {
            type: "thinking",
            content: "Reasoning signature ana@acme.com stays untouched",
            signature: "ana@acme.com-signature",
          },
          {
            type: "structured-output",
            status: "complete",
            raw: '{"email":"ana@acme.com"}',
            data: structuredData,
          },
        ],
      },
    ])
    const uiSnapshot = structuredClone(uiMessages)
    const data = { locale: "ana@acme.com-control-data" }
    const runContext: RunAgentInputContext = {
      threadId: "ana@acme.com-thread",
      runId: "run-1",
      forwardedProps: { owner: "ana@acme.com-control-context" },
    }
    const controller = new AbortController()

    await collect(
      wrapped.connect(uiMessages, data, controller.signal, runContext)
    )

    const [protectedUi, receivedData, receivedSignal, receivedContext] =
      calls[0]!
    const ui = protectedUi[0] as UIMessage
    const text = ui.parts[0]!

    expect(text.type).toBe("text")
    expect("content" in text ? text.content : "").not.toContain("ana@acme.com")
    expect("content" in text ? text.content : "").toMatch(TOKEN)
    expect("metadata" in text ? text.metadata : undefined).toBe(textMetadata)
    expect(ui.id).toBe("ana@acme.com-control-id")
    expect(ui.role).toBe("user")
    expect(ui.createdAt).toBe(createdAt)
    expect(ui.parts[1]).toBe(imagePart)
    expect(ui.parts[2]).toBe(uiMessages[0]!.parts[2])
    const structured = ui.parts[3]!
    expect(structured.type).toBe("structured-output")
    expect("raw" in structured ? structured.raw : "").not.toContain(
      "ana@acme.com"
    )
    expect("raw" in structured ? structured.raw : "").toMatch(TOKEN)
    expect("data" in structured ? structured.data : undefined).toBe(
      structuredData
    )
    expect(receivedData).toBe(data)
    expect(receivedSignal).toBe(controller.signal)
    expect(receivedContext).toBe(runContext)
    expect(uiMessages).toEqual(uiSnapshot)

    const modelTextMetadata = { trace: "ana@acme.com-model-metadata" }
    const documentPart = {
      type: "document" as const,
      source: {
        type: "url" as const,
        value: "https://cdn.example/ana@acme.com/file.pdf",
      },
    }
    const modelMessages = deepFreeze<Array<ModelMessage>>([
      {
        id: "ana@acme.com-model-id",
        role: "user",
        name: "ana@acme.com-control-name",
        content: "Contact ana@acme.com",
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            content: "Call +49 151 12345678",
            metadata: modelTextMetadata,
          },
          documentPart,
        ],
        toolCalls: [
          {
            id: "ana@acme.com-tool-id",
            type: "function",
            function: {
              name: "ana@acme.com-control-tool-name",
              arguments: '{"email":"ana@acme.com"}',
            },
            metadata: { signature: "ana@acme.com-control-signature" },
          },
        ],
      },
    ])
    const modelSnapshot = structuredClone(modelMessages)

    await collect(wrapped.connect(modelMessages))

    const protectedModel = calls[1]![0] as Array<ModelMessage>
    expect(protectedModel[0]!.content).toMatch(TOKEN)
    expect(protectedModel[0]!.id).toBe("ana@acme.com-model-id")
    expect(protectedModel[0]!.name).toBe("ana@acme.com-control-name")
    const modelParts = protectedModel[1]!.content as Array<{
      type: string
      content?: string
      metadata?: unknown
    }>
    expect(modelParts[0]!.content).toMatch(TOKEN)
    expect(modelParts[0]!.metadata).toBe(modelTextMetadata)
    expect(modelParts[1]).toBe(documentPart)
    expect(protectedModel[1]!.toolCalls).toBe(modelMessages[1]!.toolCalls)
    expect(protectedModel[1]!.toolCalls?.[0]?.function.arguments).toContain(
      "ana@acme.com"
    )
    expect(protectedModel[1]!.toolCalls?.[0]?.id).toBe("ana@acme.com-tool-id")
    expect(protectedModel[1]!.toolCalls?.[0]?.function.name).toBe(
      "ana@acme.com-control-tool-name"
    )
    expect(protectedModel[1]!.toolCalls?.[0]?.metadata).toBe(
      modelMessages[1]!.toolCalls?.[0]?.metadata
    )
    expect(modelMessages).toEqual(modelSnapshot)
  })

  it("never clears the caller-owned conversation session", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const clear = vi.spyOn(session, "clear")
    const inner: ConnectConnectionAdapter = {
      connect: () => emptyStream(),
    }

    await collect(
      piiConnection(inner, { session }).connect([
        { role: "user", content: "Email ana@acme.com" },
      ])
    )

    expect(clear).not.toHaveBeenCalled()
    expect(Object.values(session.mapping)).toContain("ana@acme.com")
  })
})

describe("piiConnection text streaming", () => {
  it("restores text split across chunks and preserves protocol fields", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const chunks: StreamChunk[] = []
    const inner: ConnectConnectionAdapter = {
      connect(messages) {
        const content = (messages[0] as ModelMessage).content as string
        const placeholder = content.match(TOKEN)?.[0]
        expect(placeholder).toBeDefined()

        return (async function* () {
          yield {
            type: EventType.RUN_STARTED,
            threadId: "thread-1",
            runId: "run-1",
            model: "local-model",
          } satisfies StreamChunk
          yield {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "message-1",
            role: "assistant",
            model: "local-model",
          } satisfies StreamChunk
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "message-1",
            delta: `Answer ${placeholder!.slice(0, 5)}`,
            model: "local-model",
            content: "debug-content-must-stay",
          } satisfies StreamChunk
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "message-1",
            delta: placeholder!.slice(5),
            model: "local-model",
          } satisfies StreamChunk
          yield {
            type: EventType.TEXT_MESSAGE_END,
            messageId: "message-1",
            model: "local-model",
          } satisfies StreamChunk
          yield {
            type: EventType.RUN_FINISHED,
            threadId: "thread-1",
            runId: "run-1",
            model: "local-model",
          } satisfies StreamChunk
        })()
      },
    }

    chunks.push(
      ...(await collect(
        piiConnection(inner, { session }).connect([
          { role: "user", content: "Email ana@acme.com" },
        ])
      ))
    )

    const textChunks = chunks.filter(
      (
        chunk
      ): chunk is Extract<
        StreamChunk,
        { type: EventType.TEXT_MESSAGE_CONTENT }
      > => chunk.type === EventType.TEXT_MESSAGE_CONTENT
    )
    expect(textChunks.map((chunk) => chunk.delta).join("")).toBe(
      "Answer ana@acme.com"
    )
    expect(chunks[0]).toMatchObject({
      type: "RUN_STARTED",
      threadId: "thread-1",
      runId: "run-1",
      model: "local-model",
    })
    expect(
      chunks.find((chunk) => chunk.type === EventType.TEXT_MESSAGE_START)
    ).toMatchObject({ messageId: "message-1", role: "assistant" })
    expect(
      chunks.find((chunk) => chunk.type === EventType.TEXT_MESSAGE_END)
    ).toMatchObject({ messageId: "message-1", model: "local-model" })
    expect(chunks.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      threadId: "thread-1",
      runId: "run-1",
    })
    expect(textChunks[0]).toMatchObject({ model: "local-model" })
    expect(textChunks[0]).not.toHaveProperty("content")
  })

  it("restores text at every placeholder chunk boundary", async () => {
    const input = "Email ana@acme.com"
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const protectedInput = (await session.anonymize(input)).redactedText
    const placeholder = protectedInput.match(TOKEN)?.[0]
    expect(placeholder).toBeDefined()

    for (let split = 0; split <= placeholder!.length; split += 1) {
      const inner: ConnectConnectionAdapter = {
        connect(messages) {
          const content = (messages[0] as ModelMessage).content as string
          const wirePlaceholder = content.match(TOKEN)?.[0]
          return (async function* () {
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "message-1",
              delta: wirePlaceholder!.slice(0, split),
            } satisfies StreamChunk
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "message-1",
              delta: wirePlaceholder!.slice(split),
            } satisfies StreamChunk
            yield {
              type: EventType.TEXT_MESSAGE_END,
              messageId: "message-1",
            } satisfies StreamChunk
          })()
        },
      }

      const chunks = await collect(
        piiConnection(inner, { session }).connect([
          { role: "user", content: input },
        ])
      )
      const output = chunks
        .filter(
          (
            chunk
          ): chunk is Extract<
            StreamChunk,
            { type: EventType.TEXT_MESSAGE_CONTENT }
          > => chunk.type === EventType.TEXT_MESSAGE_CONTENT
        )
        .map((chunk) => chunk.delta)
        .join("")

      expect(output).toBe("ana@acme.com")
    }
  })

  it("forwards hydration, join, abort, and early iterator return", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const controller = new AbortController()
    const hydration = {
      messages: [] as Array<UIMessage>,
      activeRun: null,
      interrupts: null,
    }
    const generationHydration = {
      resumeSnapshot: null,
      activeRun: null,
    }
    let connectClosed = false
    const hydrate = vi.fn(async () => hydration)
    const hydrateGeneration = vi.fn(async () => generationHydration)
    const joinRun = vi.fn((_runId: string, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      return (async function* () {
        yield {
          type: EventType.RUN_FINISHED,
          threadId: "thread-1",
          runId: "run-1",
        } satisfies StreamChunk
      })()
    })
    const inner: ConnectConnectionAdapter = {
      connect(_messages, _data, signal) {
        expect(signal).toBe(controller.signal)
        return (async function* () {
          try {
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "message-1",
              delta: "first",
            } satisfies StreamChunk
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "message-1",
              delta: "unread",
            } satisfies StreamChunk
          } finally {
            connectClosed = true
          }
        })()
      },
      hydrate,
      hydrateGeneration,
      joinRun,
    }
    const wrapped = piiConnection(inner, { session })

    await expect(wrapped.hydrate?.("thread-1")).resolves.toBe(hydration)
    await expect(wrapped.hydrateGeneration?.("thread-1")).resolves.toBe(
      generationHydration
    )
    expect(await collect(wrapped.joinRun!("run-1", controller.signal))).toEqual(
      [
        expect.objectContaining({
          type: "RUN_FINISHED",
          runId: "run-1",
        }),
      ]
    )

    const iterator = wrapped
      .connect(
        [{ role: "user", content: "hello" }],
        undefined,
        controller.signal
      )
      [Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "TEXT_MESSAGE_CONTENT", delta: "first" },
    })
    await iterator.return?.()

    expect(connectClosed).toBe(true)
    expect(hydrate).toHaveBeenCalledWith("thread-1")
    expect(hydrateGeneration).toHaveBeenCalledWith("thread-1")
    expect(joinRun).toHaveBeenCalledWith("run-1", controller.signal)
  })
})
