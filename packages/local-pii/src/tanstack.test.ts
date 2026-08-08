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

function barrier(parties: number): () => Promise<void> {
  let arrivals = 0
  let release: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return async () => {
    arrivals += 1
    if (arrivals === parties) release?.()
    await ready
  }
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
    const toolInput = { email: "ana@acme.com" }
    const toolOutput = { owner: "ana@acme.com" }
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
      {
        id: "ana@acme.com-assistant-control-id",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "ana@acme.com-tool-control-id",
            name: "ana@acme.com-tool-control-name",
            arguments: '{"email":"ana@acme.com"}',
            input: toolInput,
            output: toolOutput,
            state: "complete",
          },
          {
            type: "tool-result",
            toolCallId: "ana@acme.com-tool-control-id",
            content: '{"owner":"ana@acme.com"}',
            state: "error",
            error: "Could not notify ana@acme.com",
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
    const toolMessage = protectedUi[1] as UIMessage
    const toolCallPart = toolMessage.parts[0]!
    const toolResultPart = toolMessage.parts[1]!
    expect(toolMessage.id).toBe("ana@acme.com-assistant-control-id")
    expect("id" in toolCallPart ? toolCallPart.id : "").toBe(
      "ana@acme.com-tool-control-id"
    )
    expect("name" in toolCallPart ? toolCallPart.name : "").toBe(
      "ana@acme.com-tool-control-name"
    )
    expect(
      "arguments" in toolCallPart ? toolCallPart.arguments : ""
    ).not.toContain("ana@acme.com")
    expect("input" in toolCallPart ? toolCallPart.input : undefined).toEqual({
      email: expect.stringMatching(TOKEN),
    })
    expect("output" in toolCallPart ? toolCallPart.output : undefined).toEqual({
      owner: expect.stringMatching(TOKEN),
    })
    expect(
      "content" in toolResultPart ? toolResultPart.content : ""
    ).not.toContain("ana@acme.com")
    expect("error" in toolResultPart ? toolResultPart.error : "").not.toContain(
      "ana@acme.com"
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
    expect(protectedModel[1]!.toolCalls).not.toBe(modelMessages[1]!.toolCalls)
    expect(protectedModel[1]!.toolCalls?.[0]?.function.arguments).not.toContain(
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

  it("normalizes cumulative-only provider content before restoration", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const inner: ConnectConnectionAdapter = {
      connect(messages) {
        const content = (messages[0] as ModelMessage).content as string
        const placeholder = content.match(TOKEN)?.[0]
        expect(placeholder).toBeDefined()

        return (async function* () {
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "message-1",
            delta: "",
            content: `Answer ${placeholder!.slice(0, 5)}`,
          } satisfies StreamChunk
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "message-1",
            delta: "",
            content: `Answer ${placeholder!}`,
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
        { role: "user", content: "Email ana@acme.com" },
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

    expect(output).toBe("Answer ana@acme.com")
    expect(
      chunks
        .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
        .every((chunk) => !("content" in chunk))
    ).toBe(true)
  })

  it("restores interleaved tool arguments and final tool values by call ID", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const first = (await session.anonymize("ana@acme.com")).redactedText
    const second = (await session.anonymize("bia@acme.com")).redactedText
    const firstToken = first.match(TOKEN)?.[0]
    const secondToken = second.match(TOKEN)?.[0]
    expect(firstToken).toBeDefined()
    expect(secondToken).toBeDefined()
    const metadata = { schema: "must-stay", owner: "ana@acme.com-control" }
    const rawEvent = { provider: "must-stay" }

    const inner: ConnectConnectionAdapter = {
      connect() {
        const argsA = `{"email":"${firstToken!}"}`
        const argsB = `{"email":"${secondToken!}"}`
        return (async function* () {
          yield {
            type: EventType.TOOL_CALL_START,
            toolCallId: "tool-a",
            toolCallName: "lookup-a",
            toolName: "lookup-a",
            parentMessageId: "message-1",
            metadata,
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_START,
            toolCallId: "tool-b",
            toolCallName: "lookup-b",
            toolName: "lookup-b",
            parentMessageId: "message-1",
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "tool-a",
            delta: argsA.slice(0, 15),
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "tool-b",
            delta: "",
            args: argsB.slice(0, 12),
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "tool-a",
            delta: argsA.slice(15),
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "tool-b",
            delta: "",
            args: argsB,
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId: "tool-a",
            toolCallName: "lookup-a",
            toolName: "lookup-a",
            input: { email: firstToken },
            output: { owner: firstToken },
            result: JSON.stringify({ notified: firstToken }),
            state: "output-available",
            rawEvent,
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId: "tool-b",
            toolCallName: "lookup-b",
            toolName: "lookup-b",
            input: { email: secondToken },
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_RESULT,
            messageId: "message-1",
            toolCallId: "tool-b",
            content: JSON.stringify({ notified: secondToken }),
            role: "tool",
            state: "output-available",
          } satisfies StreamChunk
          yield {
            type: EventType.RUN_FINISHED,
            threadId: "thread-1",
            runId: "run-1",
          } satisfies StreamChunk
        })()
      },
    }

    const chunks = await collect(
      piiConnection(inner, { session }).connect([
        { role: "user", content: "Run both lookups" },
      ])
    )
    const restoredArgs = (toolCallId: string) =>
      chunks
        .filter(
          (
            chunk
          ): chunk is Extract<
            StreamChunk,
            { type: EventType.TOOL_CALL_ARGS }
          > =>
            chunk.type === EventType.TOOL_CALL_ARGS &&
            chunk.toolCallId === toolCallId
        )
        .map((chunk) => chunk.delta)
        .join("")

    expect(JSON.parse(restoredArgs("tool-a"))).toEqual({
      email: "ana@acme.com",
    })
    expect(JSON.parse(restoredArgs("tool-b"))).toEqual({
      email: "bia@acme.com",
    })
    expect(
      chunks
        .filter((chunk) => chunk.type === EventType.TOOL_CALL_ARGS)
        .every((chunk) => !("args" in chunk))
    ).toBe(true)
    const endA = chunks.find(
      (chunk) =>
        chunk.type === EventType.TOOL_CALL_END && chunk.toolCallId === "tool-a"
    ) as Extract<StreamChunk, { type: "TOOL_CALL_END" }>
    expect(endA).toMatchObject({
      toolCallId: "tool-a",
      toolCallName: "lookup-a",
      toolName: "lookup-a",
      input: { email: "ana@acme.com" },
      output: { owner: "ana@acme.com" },
      state: "output-available",
    })
    expect(JSON.parse(endA.result as string)).toEqual({
      notified: "ana@acme.com",
    })
    expect(endA.rawEvent).toBe(rawEvent)
    const resultB = chunks.find(
      (chunk) =>
        chunk.type === EventType.TOOL_CALL_RESULT &&
        chunk.toolCallId === "tool-b"
    ) as Extract<StreamChunk, { type: "TOOL_CALL_RESULT" }>
    expect(JSON.parse(resultB.content)).toEqual({
      notified: "bia@acme.com",
    })
    expect(resultB).toMatchObject({
      messageId: "message-1",
      toolCallId: "tool-b",
      role: "tool",
      state: "output-available",
    })
    expect(
      chunks.find(
        (chunk) =>
          chunk.type === EventType.TOOL_CALL_START &&
          chunk.toolCallId === "tool-a"
      )
    ).toMatchObject({
      toolCallName: "lookup-a",
      toolName: "lookup-a",
      metadata,
    })
  })

  it("keeps streamed tool argument JSON valid for escaped PII", async () => {
    const original = 'Ana "Boss"\\Support\nLine'
    const session = createAnonymizer({
      dictionary: [{ value: original, type: "CUSTOM" }],
      placeholders: token(),
    }).createSession()
    const protectedName = (await session.anonymize(original)).redactedText
    const placeholder = protectedName.match(TOKEN)?.[0]
    expect(placeholder).toBeDefined()
    const args = JSON.stringify({ name: placeholder })
    const inner: ConnectConnectionAdapter = {
      connect: () =>
        (async function* () {
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "tool-1",
            delta: args.slice(0, 13),
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "tool-1",
            delta: args.slice(13),
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId: "tool-1",
          } satisfies StreamChunk
        })(),
    }

    const chunks = await collect(
      piiConnection(inner, { session }).connect([
        { role: "user", content: "Run tool" },
      ])
    )
    const restoredArgs = chunks
      .filter((chunk) => chunk.type === EventType.TOOL_CALL_ARGS)
      .map((chunk) => chunk.delta)
      .join("")

    expect(JSON.parse(restoredArgs)).toEqual({ name: original })
  })

  it("isolates overlapping message and tool buffers while retaining stable tokens", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const waitForText = barrier(2)
    const waitForTool = barrier(2)
    const protectedByRun = new Map<string, string>()
    const inner: ConnectConnectionAdapter = {
      connect(messages, data) {
        const label = (data as { label: string }).label
        const protectedMessage = (messages[0] as ModelMessage).content as string
        const placeholder = protectedMessage.match(TOKEN)?.[0]
        expect(placeholder).toBeDefined()
        protectedByRun.set(label, placeholder!)
        const args = `{"email":"${placeholder!}"}`

        return (async function* () {
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "shared-message-id",
            delta: `${label}:${placeholder!.slice(0, 7)}`,
          } satisfies StreamChunk
          await waitForText()
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "shared-message-id",
            delta: placeholder!.slice(7),
          } satisfies StreamChunk
          yield {
            type: EventType.TEXT_MESSAGE_END,
            messageId: "shared-message-id",
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_START,
            toolCallId: "shared-tool-id",
            toolCallName: "lookup",
            toolName: "lookup",
            parentMessageId: "shared-message-id",
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "shared-tool-id",
            delta: args.slice(0, 14),
          } satisfies StreamChunk
          await waitForTool()
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "shared-tool-id",
            delta: args.slice(14),
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId: "shared-tool-id",
            input: { email: placeholder },
          } satisfies StreamChunk
          yield {
            type: EventType.RUN_FINISHED,
            threadId: `thread-${label}`,
            runId: `run-${label}`,
          } satisfies StreamChunk
        })()
      },
    }
    const wrapped = piiConnection(inner, { session })

    const [runA, runB] = await Promise.all([
      collect(
        wrapped.connect([{ role: "user", content: "Email ana@acme.com" }], {
          label: "A",
        })
      ),
      collect(
        wrapped.connect([{ role: "user", content: "Email bia@acme.com" }], {
          label: "B",
        })
      ),
    ])
    const textFor = (chunks: StreamChunk[]) =>
      chunks
        .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((chunk) => chunk.delta)
        .join("")
    const argsFor = (chunks: StreamChunk[]) =>
      chunks
        .filter((chunk) => chunk.type === EventType.TOOL_CALL_ARGS)
        .map((chunk) => chunk.delta)
        .join("")

    expect(textFor(runA)).toBe("A:ana@acme.com")
    expect(textFor(runB)).toBe("B:bia@acme.com")
    expect(JSON.parse(argsFor(runA))).toEqual({ email: "ana@acme.com" })
    expect(JSON.parse(argsFor(runB))).toEqual({ email: "bia@acme.com" })

    let repeatedToken = ""
    const stableInner: ConnectConnectionAdapter = {
      connect(messages) {
        repeatedToken =
          ((messages[0] as ModelMessage).content as string).match(TOKEN)?.[0] ??
          ""
        return emptyStream()
      },
    }
    await collect(
      piiConnection(stableInner, { session }).connect([
        { role: "user", content: "Again ana@acme.com" },
      ])
    )
    expect(repeatedToken).toBe(protectedByRun.get("A"))
  })

  it("flushes safe tails in source order before successful termination", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const protectedEmail = (await session.anonymize("ana@acme.com"))
      .redactedText
    const placeholder = protectedEmail.match(TOKEN)?.[0]
    expect(placeholder).toBeDefined()
    const inner: ConnectConnectionAdapter = {
      connect() {
        return (async function* () {
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "tool-1",
            delta: `{"email":"${placeholder!}"}`,
          } satisfies StreamChunk
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "message-1",
            delta: `Done ${placeholder!}`,
          } satisfies StreamChunk
          yield {
            type: EventType.RUN_FINISHED,
            threadId: "thread-1",
            runId: "run-1",
          } satisfies StreamChunk
        })()
      },
    }

    const chunks = await collect(
      piiConnection(inner, { session }).connect([
        { role: "user", content: "hello" },
      ])
    )
    const terminal = chunks.findIndex(
      (chunk) => chunk.type === EventType.RUN_FINISHED
    )
    const finalToolDelta = chunks
      .map(
        (chunk) =>
          chunk.type === EventType.TOOL_CALL_ARGS && chunk.delta.includes("@")
      )
      .lastIndexOf(true)
    const finalTextDelta = chunks
      .map(
        (chunk) =>
          chunk.type === EventType.TEXT_MESSAGE_CONTENT &&
          chunk.delta.includes("@")
      )
      .lastIndexOf(true)

    expect(finalToolDelta).toBeGreaterThan(-1)
    expect(finalTextDelta).toBeGreaterThan(finalToolDelta)
    expect(terminal).toBeGreaterThan(finalTextDelta)
  })

  it("drops an incomplete placeholder suffix on normal bare completion", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const protectedEmail = (await session.anonymize("ana@acme.com"))
      .redactedText
    const placeholder = protectedEmail.match(TOKEN)?.[0]
    expect(placeholder).toBeDefined()
    const inner: ConnectConnectionAdapter = {
      connect: () =>
        (async function* () {
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "message-1",
            delta: `Safe text ${placeholder!.slice(0, 8)}`,
          } satisfies StreamChunk
        })(),
    }

    const chunks = await collect(
      piiConnection(inner, { session }).connect([
        { role: "user", content: "hello" },
      ])
    )
    const output = chunks
      .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((chunk) => chunk.delta)
      .join("")

    expect(output).toBe("Safe text ")
    expect(output).not.toContain(placeholder!.slice(0, 8))
  })

  it("discards buffered tails on RUN_ERROR, throw, and abort", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const protectedEmail = (await session.anonymize("ana@acme.com"))
      .redactedText
    const placeholder = protectedEmail.match(TOKEN)?.[0]
    expect(placeholder).toBeDefined()
    const partial = placeholder!.slice(0, 8)

    const runErrorChunks = await collect(
      piiConnection(
        {
          connect: () =>
            (async function* () {
              yield {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "message-1",
                delta: partial,
              } satisfies StreamChunk
              yield {
                type: EventType.RUN_ERROR,
                message: "provider failed",
              } satisfies StreamChunk
            })(),
        },
        { session }
      ).connect([{ role: "user", content: "hello" }])
    )
    expect(JSON.stringify(runErrorChunks)).not.toContain(partial)

    const providerError = new Error("provider failed")
    const throwing = piiConnection(
      {
        connect: () =>
          (async function* () {
            yield {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: "tool-1",
              delta: partial,
            } satisfies StreamChunk
            throw providerError
          })(),
      },
      { session }
    )
      .connect([{ role: "user", content: "hello" }])
      [Symbol.asyncIterator]()
    expect((await throwing.next()).value).not.toMatchObject({ delta: partial })
    await expect(throwing.next()).rejects.toBe(providerError)

    const controller = new AbortController()
    let upstreamClosed = false
    const abortReason = new Error("stop")
    const aborting = piiConnection(
      {
        connect: () =>
          (async function* () {
            try {
              yield {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "message-1",
                delta: partial,
              } satisfies StreamChunk
              yield {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "message-1",
                delta: "unread",
              } satisfies StreamChunk
            } finally {
              upstreamClosed = true
            }
          })(),
      },
      { session }
    )
      .connect(
        [{ role: "user", content: "hello" }],
        undefined,
        controller.signal
      )
      [Symbol.asyncIterator]()
    expect((await aborting.next()).value).not.toMatchObject({ delta: partial })
    controller.abort(abortReason)
    await expect(aborting.next()).rejects.toBe(abortReason)
    expect(upstreamClosed).toBe(true)
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
