import {
  EventType,
  type ContentPart,
  type MessagePart,
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
import {
  piiConnection,
  UnsupportedTanStackSemanticContentError,
} from "./tanstack"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const value of iterable) output.push(value)
  return output
}

function emptyStream(): AsyncIterableIterator<StreamChunk> {
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return { done: true as const, value: undefined }
    },
  }
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
  it("rejects getter-backed semantic fields without invoking getters or mutating the session", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const anonymize = vi.spyOn(session, "anonymize")
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    let modelGetterCalls = 0
    const modelMessage = {
      role: "user" as const,
      get content() {
        modelGetterCalls += 1
        throw new Error("model secret")
      },
    } as unknown as ModelMessage

    await expect(
      collect(wrapped.connect([modelMessage]))
    ).rejects.toMatchObject({
      name: "UnsupportedTanStackSemanticContentError",
      path: [0, "content"],
      discriminant: "<accessor>",
    })
    expect(modelGetterCalls).toBe(0)
    expect(anonymize).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)
  })

  it.each([
    [
      "text.content",
      (part: Record<string, unknown>) => {
        Object.defineProperty(part, "content", {
          enumerable: true,
          get() {
            throw new Error("text secret")
          },
        })
      },
    ],
    [
      "structured-output.raw",
      (part: Record<string, unknown>) => {
        Object.defineProperty(part, "raw", {
          enumerable: true,
          get() {
            throw new Error("raw secret")
          },
        })
      },
    ],
  ] as const)(
    "rejects a UI semantic %s accessor before connect",
    async (_label, defineHostile) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const connect = vi.fn(() => emptyStream())
      const wrapped = piiConnection({ connect }, { session })
      const part = {
        type: _label === "text.content" ? "text" : "structured-output",
        ...(_label === "text.content"
          ? {}
          : { status: "complete", data: { email: "ana@acme.com" } }),
      } as Record<string, unknown>
      defineHostile(part)
      await expect(
        collect(
          wrapped.connect([
            { id: "ui-1", role: "assistant", parts: [part] },
          ] as unknown as Array<UIMessage>)
        )
      ).rejects.toMatchObject({
        path: [0, "parts", 0, _label.split(".")[1]],
        discriminant: "<accessor>",
      })
      expect(connect).not.toHaveBeenCalled()
      expect(Object.keys(session.mapping)).toHaveLength(0)
    }
  )

  it("prepares detached message values before asynchronous anonymization", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const message = {
      id: "before-id",
      role: "user" as const,
      content: "ana@acme.com",
    }
    const originalAnonymize = session.anonymize.bind(session)
    vi.spyOn(session, "anonymize").mockImplementation(async (text) => {
      message.id = "after-id"
      message.content = "mutated@acme.com"
      await Promise.resolve()
      return originalAnonymize(text)
    })
    let received: Array<ModelMessage> = []
    const wrapped = piiConnection(
      {
        connect(messages) {
          received = messages as Array<ModelMessage>
          return emptyStream()
        },
      },
      { session }
    )

    await collect(wrapped.connect([message]))
    expect(received[0]).not.toBe(message)
    expect(received[0]!.id).toBe("before-id")
    expect(received[0]!.content).toMatch(TOKEN)
  })

  it("rejects an accessor-backed message container without invoking it", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    let partsGets = 0
    const message = {
      id: "accessor-parts",
      role: "user" as const,
      get parts() {
        partsGets += 1
        throw new Error("parts secret")
      },
    } as unknown as UIMessage

    await expect(
      collect(piiConnection({ connect }, { session }).connect([message]))
    ).rejects.toMatchObject({
      path: [0, "parts"],
      discriminant: "<accessor>",
    })
    expect(partsGets).toBe(0)
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)
  })

  it("captures a stateful proxy once without invoking ordinary get or rereading it", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const target = { type: "text", content: "ana@acme.com" }
    let getCalls = 0
    let ownKeysCalls = 0
    const part = new Proxy(target, {
      get(object, key, receiver) {
        if (key === "content") getCalls += 1
        return key === "content"
          ? "proxy-secret@acme.com"
          : Reflect.get(object, key, receiver)
      },
      ownKeys(object) {
        ownKeysCalls += 1
        if (ownKeysCalls > 1) throw new Error("proxy secret")
        return Reflect.ownKeys(object)
      },
    })
    let received: Array<UIMessage> = []
    const wrapped = piiConnection(
      {
        connect(messages) {
          received = messages as Array<UIMessage>
          return emptyStream()
        },
      },
      { session }
    )

    await collect(
      wrapped.connect([
        { id: "proxy", role: "user", parts: [part] },
      ] as unknown as Array<UIMessage>)
    )
    expect(ownKeysCalls).toBe(1)
    expect(getCalls).toBe(0)
    const forwardedPart = received[0]!.parts[0]!
    expect(Object.is(forwardedPart, part)).toBe(false)
    expect(forwardedPart).toMatchObject({
      type: "text",
      content: expect.stringMatching(TOKEN),
    })
  })

  it.each(["own", "inherited"] as const)(
    "rejects %s toJSON on a semantic message container before session work",
    async (kind) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const anonymize = vi.spyOn(session, "anonymize")
      const connect = vi.fn(() => emptyStream())
      const message = {
        id: "to-json",
        role: "user" as const,
        parts: [{ type: "text" as const, content: "ana@acme.com" }],
      } as UIMessage & Record<string, unknown>
      const toJSON = () => ({ secret: "ana@acme.com" })
      if (kind === "own") message.toJSON = toJSON
      else Object.setPrototypeOf(message, { toJSON })

      await expect(
        collect(piiConnection({ connect }, { session }).connect([message]))
      ).rejects.toMatchObject({ discriminant: "<unsupported>" })
      expect(anonymize).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
      expect(Object.keys(session.mapping)).toHaveLength(0)
    }
  )

  it("does not retain a caller prototype mutated during anonymization", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const prototype: Record<string, unknown> = {}
    const message = Object.assign(Object.create(prototype), {
      id: "prototype-mutation",
      role: "user" as const,
      parts: [{ type: "text" as const, content: "ana@acme.com" }],
    }) as UIMessage
    const originalAnonymize = session.anonymize.bind(session)
    vi.spyOn(session, "anonymize").mockImplementation(async (text) => {
      prototype.toJSON = () => ({ secret: "ana@acme.com" })
      await Promise.resolve()
      return originalAnonymize(text)
    })
    let received: Array<UIMessage> = []
    const wrapped = piiConnection(
      {
        connect(messages) {
          received = messages as Array<UIMessage>
          return emptyStream()
        },
      },
      { session }
    )

    await collect(wrapped.connect([message]))
    expect(Object.getPrototypeOf(received[0])).toBe(null)
    expect(JSON.stringify(received)).not.toContain("secret")
    expect(JSON.stringify(received)).not.toContain("ana@acme.com")
  })

  it("rejects an accessor-backed UI fallback before wire serialization", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const anonymize = vi.spyOn(session, "anonymize")
    const connect = vi.fn(() => emptyStream())
    let contentGets = 0
    const message = {
      id: "ui-fallback",
      role: "user" as const,
      parts: [],
    } as UIMessage & Record<string, unknown>
    Object.defineProperty(message, "content", {
      configurable: true,
      enumerable: true,
      get() {
        contentGets += 1
        return "ana@acme.com"
      },
    })

    await expect(
      collect(piiConnection({ connect }, { session }).connect([message]))
    ).rejects.toMatchObject({
      path: [0],
      discriminant: "<ambiguous>",
    })
    expect(contentGets).toBe(0)
    expect(anonymize).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)
  })

  it("rejects an ambiguous record even when a later record identifies the family", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    const ambiguous = {
      id: "ambiguous",
      role: "user" as const,
      parts: [{ type: "text" as const, content: "ana@acme.com" }],
      content: "ana@acme.com",
    }
    const model = { role: "user" as const, content: "safe" }
    await expect(
      collect(wrapped.connect([ambiguous, model] as Array<ModelMessage>))
    ).rejects.toMatchObject({ discriminant: "<ambiguous>" })
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)
  })

  it("accepts an empty message array without session work", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    const messages: Array<ModelMessage> = []
    await collect(piiConnection({ connect }, { session }).connect(messages))
    expect(connect).toHaveBeenCalledOnce()
    const forwarded = (connect.mock.calls as unknown as Array<unknown[]>)[0]![0]
    expect(forwarded).not.toBe(messages)
    expect(forwarded).toEqual([])
    expect(Object.keys(session.mapping)).toHaveLength(0)
  })

  it("renders prepared nested JSON arrays as usable arrays", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    await collect(
      piiConnection({ connect }, { session }).connect([
        {
          id: "array",
          role: "assistant",
          parts: [
            {
              type: "tool-call",
              id: "call",
              name: "lookup",
              arguments: '{"values":["ana@acme.com",["ana@acme.com"]]}',
              input: { values: ["ana@acme.com", ["ana@acme.com"]] },
              state: "input-complete",
            },
          ],
        },
      ])
    )
    const forwarded = (
      connect.mock.calls as unknown as Array<unknown[]>
    )[0]![0] as Array<UIMessage>
    const part = forwarded[0]!.parts[0]!
    if (part.type !== "tool-call") throw new Error("expected tool call")
    const input = part.input as { values: Array<unknown> }
    expect(Array.isArray(input.values)).toBe(true)
    expect(Array.isArray(input.values[1])).toBe(true)
    expect(input.values[0]).toMatch(TOKEN)
  })

  it("protects valid incomplete tool calls and rejects malformed ones", async () => {
    const original = 'Ana "Boss"'
    const session = createAnonymizer({
      dictionary: [{ value: original, type: "CUSTOM" }],
      placeholders: token(),
    }).createSession()
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    const valid = {
      id: "valid-streaming",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-call" as const,
          id: "call",
          name: "lookup",
          arguments: JSON.stringify({ name: original }),
          input: { name: original },
          state: "input-streaming" as const,
        },
      ],
    } satisfies UIMessage
    await collect(wrapped.connect([valid]))
    const forwarded = (
      connect.mock.calls as unknown as Array<unknown[]>
    )[0]![0] as Array<UIMessage>
    const forwardedPart = forwarded[0]!.parts[0]!
    if (forwardedPart.type !== "tool-call")
      throw new Error("expected tool call")
    expect(forwardedPart.arguments).not.toContain(original)
    expect(forwardedPart.input).toMatchObject({
      name: expect.stringMatching(TOKEN),
    })

    const malformed = {
      ...valid,
      id: "malformed-streaming",
      parts: [{ ...valid.parts[0]!, arguments: '{"name":"Ana \\"Boss}' }],
    } satisfies UIMessage
    await expect(collect(wrapped.connect([malformed]))).rejects.toMatchObject({
      discriminant: "<invalid-json>",
    })
    expect(connect).toHaveBeenCalledOnce()
  })

  it("rejects an all-ambiguous message array before session work", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const anonymize = vi.spyOn(session, "anonymize")
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    const message = {
      id: "ambiguous",
      role: "user" as const,
      parts: [{ type: "text" as const, content: "ana@acme.com" }],
      content: "ana@acme.com",
    } as unknown as UIMessage & ModelMessage

    await expect(collect(wrapped.connect([message]))).rejects.toMatchObject({
      discriminant: "<ambiguous>",
    })
    expect(anonymize).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)
  })

  const strictJsonExotics: Array<[string, () => unknown]> = [
    [
      "custom prototype",
      () =>
        Object.assign(Object.create({ inherited: true }), {
          email: "ana@acme.com",
        }),
    ],
    [
      "toJSON",
      () => ({
        email: "ana@acme.com",
        toJSON: () => ({ email: "ana@acme.com" }),
      }),
    ],
    ["function", () => ({ email: () => "ana@acme.com" })],
    ["symbol", () => ({ email: Symbol("ana@acme.com") })],
    ["bigint", () => ({ email: 1n })],
    ["nonfinite", () => ({ email: Number.NaN })],
    [
      "accessor",
      () =>
        Object.defineProperty({}, "email", {
          enumerable: true,
          get: () => "ana@acme.com",
        }),
    ],
    [
      "cycle",
      () => {
        const value: Record<string, unknown> = { email: "ana@acme.com" }
        value.self = value
        return value
      },
    ],
    ["sparse", () => Object.assign(new Array(2), { 1: "ana@acme.com" })],
    [
      "proxy trap",
      () =>
        new Proxy(
          { email: "ana@acme.com" },
          {
            ownKeys: () => {
              throw new Error("secret key")
            },
          }
        ),
    ],
  ]

  it.each(strictJsonExotics)(
    "rejects %s semantic tool input before mapping",
    async (_label, createValue) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const connect = vi.fn(() => emptyStream())
      const wrapped = piiConnection({ connect }, { session })
      const message = {
        id: "tool",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-call" as const,
            id: "call",
            name: "lookup",
            arguments: '{"email":"ana@acme.com"}',
            input: createValue(),
            state: "input-complete" as const,
          },
        ],
      } satisfies UIMessage

      let caught: unknown
      try {
        await collect(wrapped.connect([message]))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(UnsupportedTanStackSemanticContentError)
      expect(String(caught)).not.toContain("secret key")
      expect(String(caught)).not.toContain("ana@acme.com")
      expect(connect).not.toHaveBeenCalled()
      expect(Object.keys(session.mapping)).toHaveLength(0)
    }
  )

  it("preserves anonymizer failures from parsed freeform tool results", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const failure = new Error("anonymizer failure")
    const anonymize = vi.spyOn(session, "anonymize").mockRejectedValue(failure)
    const wrapped = piiConnection({ connect: () => emptyStream() }, { session })
    const message = {
      id: "result",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-result" as const,
          toolCallId: "call",
          content: '{"email":"ana@acme.com"}',
          state: "complete" as const,
        },
      ],
    } satisfies UIMessage

    await expect(collect(wrapped.connect([message]))).rejects.toBe(failure)
    expect(anonymize).toHaveBeenCalledOnce()
  })

  it("rejects JSON graphs deeper than the bounded preparation limit", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    let data: Record<string, unknown> = { email: "ana@acme.com" }
    for (let index = 0; index < 300; index += 1) data = { next: data }
    const message = {
      id: "deep",
      role: "assistant" as const,
      parts: [
        {
          type: "structured-output" as const,
          status: "complete" as const,
          raw: "",
          data,
        },
      ],
    } satisfies UIMessage

    await expect(collect(wrapped.connect([message]))).rejects.toMatchObject({
      discriminant: "<depth>",
    })
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)
  })

  it("rejects a structured-output data fallback that is cyclic and protects a valid empty-raw fallback", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    const data = { email: "ana@acme.com" }
    const message = {
      id: "ui-structured",
      role: "assistant" as const,
      parts: [
        {
          type: "structured-output" as const,
          status: "complete" as const,
          raw: "",
          data,
        },
      ],
    } satisfies UIMessage

    await collect(wrapped.connect([message]))
    const protectedPart = (
      connect.mock.calls as unknown as Array<unknown[]>
    )[0]![0] as Array<UIMessage>
    const part = protectedPart[0]!.parts[0]!
    if (part.type !== "structured-output")
      throw new Error("expected structured output")
    expect(part.raw).toMatch(TOKEN)
    expect(JSON.parse(part.raw)).toEqual({
      email: expect.stringMatching(TOKEN),
    })
    expect(part.data).toBe(data)

    const cyclic: Record<string, unknown> = { email: "ana@acme.com" }
    cyclic.self = cyclic
    const cyclicMessage = {
      id: "ui-cyclic",
      role: "assistant" as const,
      parts: [
        {
          type: "structured-output" as const,
          status: "complete" as const,
          raw: "",
          data: cyclic,
        },
      ],
    } as unknown as UIMessage
    const before = { ...session.mapping }
    await expect(
      collect(wrapped.connect([cyclicMessage]))
    ).rejects.toMatchObject({
      path: [0, "parts", 0, "data", "<field>"],
      discriminant: "<cycle>",
    })
    expect(connect).toHaveBeenCalledOnce()
    expect(session.mapping).toEqual(before)

    const invalid = { email: "ana@acme.com", callback: () => "secret" }
    const invalidMessage = {
      id: "ui-invalid",
      role: "assistant" as const,
      parts: [
        {
          type: "structured-output" as const,
          status: "complete" as const,
          raw: "",
          data: invalid,
        },
      ],
    } as unknown as UIMessage
    await expect(
      collect(wrapped.connect([invalidMessage]))
    ).rejects.toMatchObject({
      path: [0, "parts", 0, "data", "<field>"],
      discriminant: "<invalid-json>",
    })
    expect(connect).toHaveBeenCalledOnce()
    expect(session.mapping).toEqual(before)
  })

  it("rejects malformed tool-call JSON in every serialized state", async () => {
    const original = 'Ana "Boss"'
    const session = createAnonymizer({
      dictionary: [{ value: original, type: "CUSTOM" }],
      placeholders: token(),
    }).createSession()
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    const truncated = '{"name":"Ana \\"Boss}'
    const uiMessage = {
      id: "ui-tool",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-call" as const,
          id: "call-1",
          name: "lookup",
          arguments: truncated,
          state: "input-streaming" as const,
        },
      ],
    } satisfies UIMessage
    await expect(collect(wrapped.connect([uiMessage]))).rejects.toMatchObject({
      path: [0, "parts", 0, "arguments"],
      discriminant: "<invalid-json>",
    })
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)

    const includedUiMessage = {
      ...uiMessage,
      parts: [{ ...uiMessage.parts[0]!, state: "input-complete" as const }],
    } satisfies UIMessage
    await expect(
      collect(wrapped.connect([includedUiMessage]))
    ).rejects.toMatchObject({
      path: [0, "parts", 0, "arguments"],
      discriminant: "<invalid-json>",
    })
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)

    const modelMessage = {
      role: "assistant" as const,
      content: "safe",
      toolCalls: [
        {
          id: "call-1",
          type: "function" as const,
          function: { name: "lookup", arguments: truncated },
        },
      ],
    } satisfies ModelMessage
    await expect(
      collect(wrapped.connect([modelMessage]))
    ).rejects.toMatchObject({
      path: [0, "toolCalls", 0, "function", "arguments"],
      discriminant: "<invalid-json>",
    })
    expect(connect).not.toHaveBeenCalled()

    await collect(
      wrapped.connect([
        {
          id: "ui-result",
          role: "assistant",
          parts: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              content: `freeform ${original}`,
              state: "error",
            },
          ],
        },
      ])
    )
    const resultPart = (
      connect.mock.calls as unknown as Array<unknown[]>
    )[0]![0] as Array<UIMessage>
    const result = resultPart[0]!.parts[0]!
    if (result.type !== "tool-result") throw new Error("expected tool result")
    expect(result.content).not.toContain(original)
  })

  it.each([
    "future-secret-part",
    "future-ana@acme.com",
    "future-\n-secret",
    "x".repeat(1000),
  ])("sanitizes unsafe unknown discriminant %s", async (type) => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    const message = [
      {
        id: "ui-future",
        role: "user" as const,
        parts: [{ type, secret: "ana@acme.com" }],
      },
    ] as unknown as Array<UIMessage>
    let caught: unknown
    try {
      await collect(wrapped.connect(message))
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      path: [0, "parts", 0],
      discriminant: "<unsupported>",
    })
    expect(String(caught)).not.toContain("ana@acme.com")
    expect(String(caught)).not.toContain("\n")
    expect(connect).not.toHaveBeenCalled()
  })

  it("classifies the whole message array once and preserves cross-family siblings", async () => {
    const session = createAnonymizer({
      dictionary: [{ value: "ana@acme.com", type: "EMAIL" }],
      placeholders: token(),
    }).createSession()
    const calls: Array<Parameters<ConnectConnectionAdapter["connect"]>> = []
    const inner: ConnectConnectionAdapter = {
      connect(...args) {
        calls.push(args)
        return emptyStream()
      },
    }
    const wrapped = piiConnection(inner, { session })
    const futurePart = { type: "future-secret-part", secret: "ana@acme.com" }
    const ui = {
      id: "ui-1",
      role: "user" as const,
      parts: [{ type: "text" as const, content: "ana@acme.com" }],
      unknownContent: { future: futurePart },
      toolCalls: [futurePart],
    } as unknown as UIMessage & {
      unknownContent: unknown
      toolCalls: unknown
    }
    const model = {
      role: "user" as const,
      content: "ana@acme.com",
      parts: [futurePart],
    } as unknown as ModelMessage & { parts: unknown }
    await collect(wrapped.connect([ui]))
    await collect(wrapped.connect([model]))
    const protectedUi = calls[0]![0][0] as typeof ui
    const protectedUiText = protectedUi.parts[0]!
    if (protectedUiText.type !== "text") throw new Error("expected UI text")
    expect(protectedUiText.content).toMatch(TOKEN)
    expect(protectedUi.unknownContent).toBe(ui.unknownContent)
    expect(protectedUi.toolCalls).toBe(ui.toolCalls)
    const protectedModel = calls[1]![0][0] as typeof model
    expect(protectedModel.content).toMatch(TOKEN)
    expect(Object.is(protectedModel.parts, model.parts)).toBe(true)

    const modelWithId = {
      role: "user" as const,
      content: "ana@acme.com",
      id: "model-id",
    }
    const laterModelOnly = { role: "user" as const, content: "safe" }
    await collect(wrapped.connect([modelWithId, laterModelOnly]))
    const protectedModelWithId = calls[2]![0][0] as typeof modelWithId
    expect(protectedModelWithId.content).toMatch(TOKEN)

    const firstAmbiguous = {
      id: "ambiguous",
      role: "user" as const,
      parts: [{ type: "text" as const, content: "safe" }],
      content: "safe",
    } as unknown as UIMessage & ModelMessage
    const laterModel = { role: "user" as const, content: "ana@acme.com" }
    await expect(
      collect(wrapped.connect([firstAmbiguous]))
    ).rejects.toMatchObject({ discriminant: "<ambiguous>" })
    await expect(
      collect(wrapped.connect([firstAmbiguous, laterModel]))
    ).rejects.toMatchObject({ discriminant: "<ambiguous>" })

    const uiOnly = {
      id: "ui-only",
      role: "user" as const,
      parts: [{ type: "text" as const, content: "safe" }],
    }
    const modelOnly = { role: "user" as const, content: "safe" }
    await expect(
      collect(
        wrapped.connect([uiOnly, modelOnly] as unknown as Array<UIMessage>)
      )
    ).rejects.toMatchObject({ discriminant: "<unsupported>" })
    expect(calls).toHaveLength(3)
  })

  it("protects every pinned semantic part while preserving opaque parts and controls", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const calls: Array<Parameters<ConnectConnectionAdapter["connect"]>> = []
    const inner: ConnectConnectionAdapter = {
      connect(messages, data, signal, runContext) {
        calls.push([messages, data, signal, runContext])
        return emptyStream()
      },
    }
    const wrapped = piiConnection(inner, { session })
    const uiParts: Array<MessagePart> = [
      { type: "text", content: "ui ana@acme.com" },
      {
        type: "image",
        source: { type: "url", value: "https://img.test/ana@acme.com" },
      },
      {
        type: "audio",
        source: { type: "url", value: "https://audio.test/ana@acme.com" },
      },
      {
        type: "video",
        source: { type: "url", value: "https://video.test/ana@acme.com" },
      },
      {
        type: "document",
        source: { type: "url", value: "https://docs.test/ana@acme.com" },
      },
      {
        type: "tool-call",
        id: "call-ana@acme.com",
        name: "lookup-ana@acme.com",
        arguments: '{"email":"ana@acme.com"}',
        input: { email: "ana@acme.com" },
        output: { owner: "ana@acme.com" },
        state: "complete",
      },
      {
        type: "tool-result",
        toolCallId: "call-ana@acme.com",
        content: '{"email":"ana@acme.com"}',
        state: "complete",
        error: "Unable to notify ana@acme.com",
      },
      {
        type: "thinking",
        content: "reasoning ana@acme.com stays opaque",
        signature: "sig-ana@acme.com",
      },
      {
        type: "structured-output",
        status: "complete",
        raw: '{"email":"ana@acme.com"}',
        data: { email: "ana@acme.com" },
        reasoning: "reasoning ana@acme.com stays opaque",
      },
      {
        type: "ui-resource",
        resource: {
          uri: "ui://ana@acme.com/resource",
          mimeType: "text/html",
          text: "resource ana@acme.com stays opaque",
        },
        toolCallId: "call-ana@acme.com",
        toolName: "render-ana@acme.com",
      },
    ]
    const modelContent: Array<ContentPart> = [
      { type: "text", content: "model ana@acme.com" },
      {
        type: "image",
        source: { type: "url", value: "https://img.test/ana@acme.com" },
      },
      {
        type: "audio",
        source: { type: "url", value: "https://audio.test/ana@acme.com" },
      },
      {
        type: "video",
        source: { type: "url", value: "https://video.test/ana@acme.com" },
      },
      {
        type: "document",
        source: { type: "url", value: "https://docs.test/ana@acme.com" },
      },
    ]
    const uiMessage = deepFreeze({
      id: "ui-id-ana@acme.com",
      role: "assistant",
      parts: uiParts,
      createdAt: new Date("2026-08-11T10:00:00.000Z"),
      unknownControl: { secret: "ana@acme.com" },
    } as UIMessage & { unknownControl: unknown })
    const modelMessage = deepFreeze({
      role: "assistant",
      content: modelContent,
      id: "model-id-ana@acme.com",
      name: "name-ana@acme.com",
      thinking: [{ content: "thinking ana@acme.com" }],
      unknownControl: { secret: "ana@acme.com" },
    } as ModelMessage & { unknownControl: unknown })
    const originalUi = structuredClone(uiMessage)
    const originalModel = structuredClone(modelMessage)

    await collect(wrapped.connect([uiMessage]))
    await collect(wrapped.connect([modelMessage]))

    const protectedUi = calls[0]![0][0] as UIMessage & {
      unknownControl: unknown
    }
    const protectedParts = protectedUi.parts
    expect(protectedParts[0]).toMatchObject({
      type: "text",
      content: expect.stringMatching(TOKEN),
    })
    expect(protectedParts[1]).not.toBe(uiParts[1])
    expect(protectedParts[2]).not.toBe(uiParts[2])
    expect(protectedParts[3]).not.toBe(uiParts[3])
    expect(protectedParts[4]).not.toBe(uiParts[4])
    expect(protectedParts[5]).toMatchObject({
      type: "tool-call",
      id: "call-ana@acme.com",
      name: "lookup-ana@acme.com",
      arguments: expect.stringMatching(TOKEN),
      input: { email: expect.stringMatching(TOKEN) },
      output: { owner: expect.stringMatching(TOKEN) },
    })
    expect(protectedParts[6]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-ana@acme.com",
      content: expect.stringMatching(TOKEN),
      error: expect.stringMatching(TOKEN),
    })
    expect(Object.is(protectedParts[7], uiParts[7])).toBe(false)
    expect(protectedParts[8]).toMatchObject({
      type: "structured-output",
      status: "complete",
      raw: expect.stringMatching(TOKEN),
    })
    expect(Object.is(protectedParts[9], uiParts[9])).toBe(false)
    expect(protectedUi.unknownControl).toBe(uiMessage.unknownControl)

    const protectedModel = calls[1]![0][0] as ModelMessage & {
      unknownControl: unknown
    }
    expect(protectedModel.content).toMatchObject([
      { type: "text", content: expect.stringMatching(TOKEN) },
      modelContent[1],
      modelContent[2],
      modelContent[3],
      modelContent[4],
    ])
    if (!Array.isArray(protectedModel.content))
      throw new Error("expected parts")
    expect(Object.is(protectedModel.content[1], modelContent[1])).toBe(false)
    expect(Object.is(protectedModel.content[4], modelContent[4])).toBe(false)
    expect(protectedModel.id).toBe(modelMessage.id)
    expect(protectedModel.name).toBe(modelMessage.name)
    expect(protectedModel.thinking).toBe(modelMessage.thinking)
    expect(protectedModel.unknownControl).toBe(modelMessage.unknownControl)
    expect(uiMessage).toEqual(originalUi)
    expect(modelMessage).toEqual(originalModel)
  })

  it.each([
    ["UI parts", "parts"],
    ["Model content", "content"],
  ] as const)(
    "rejects an unknown %s discriminant before connect and redacts the error",
    async (_label, location) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const connect = vi.fn(() => emptyStream())
      const wrapped = piiConnection({ connect }, { session })
      const futurePart = {
        type: "future-secret-part",
        content: "ana@acme.com must never enter this error",
        sibling: { secret: "ana@acme.com" },
      }
      const messages =
        location === "parts"
          ? ([
              {
                id: "ui-message",
                role: "user" as const,
                parts: [{ type: "text" as const, content: "safe" }, futurePart],
              },
            ] as unknown as Array<UIMessage>)
          : ([
              {
                role: "user" as const,
                content: [
                  { type: "text" as const, content: "safe" },
                  futurePart,
                ],
              },
            ] as unknown as Array<ModelMessage>)

      let caught: unknown
      try {
        await collect(wrapped.connect(messages))
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(UnsupportedTanStackSemanticContentError)
      expect(caught).toMatchObject({
        name: "UnsupportedTanStackSemanticContentError",
        path: [0, location, 1],
        discriminant: "<unsupported>",
      })
      expect(String(caught)).toBe(
        `UnsupportedTanStackSemanticContentError: Unsupported TanStack semantic content at $[0].${location}[1]: <unsupported>`
      )
      expect(String(caught)).not.toContain("ana@acme.com")
      expect(caught).not.toHaveProperty("part")
      expect(caught).not.toHaveProperty("cause")
      expect(connect).not.toHaveBeenCalled()
    }
  )

  it("preserves prototype-sensitive sibling keys and descriptors while protecting frozen inputs", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    const textPart = Object.create(null) as Record<string, unknown>
    const descriptors = Object.create(null) as Record<
      string,
      PropertyDescriptor
    >
    descriptors.type = { value: "text", enumerable: true }
    descriptors.content = {
      value: "ana@acme.com",
      enumerable: true,
      writable: false,
      configurable: false,
    }
    descriptors["__proto__"] = {
      value: "sibling-ana@acme.com",
      enumerable: true,
      writable: false,
      configurable: false,
    }
    Object.defineProperties(textPart, descriptors)
    const message = deepFreeze({
      id: "frozen",
      role: "user" as const,
      parts: [textPart],
    } as unknown as UIMessage)

    await collect(wrapped.connect([message]))

    const firstCall = (connect.mock.calls as unknown as Array<unknown[]>)[0]!
    const protectedMessages = firstCall[0] as Array<UIMessage>
    const protectedPart = protectedMessages[0]!.parts[0] as unknown as Record<
      string,
      unknown
    >
    expect(protectedPart.content).toMatch(TOKEN)
    expect(Object.getPrototypeOf(protectedPart)).toBe(null)
    expect(
      Object.prototype.hasOwnProperty.call(protectedPart, "__proto__")
    ).toBe(true)
    expect(protectedPart["__proto__"]).toBe("sibling-ana@acme.com")
    expect(
      Object.getOwnPropertyDescriptor(protectedPart, "content")
    ).toMatchObject({ enumerable: true, writable: false, configurable: false })
    expect(message.parts[0]).toBe(textPart)
    expect(textPart.content).toBe("ana@acme.com")
  })

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
    expect(Object.is(ui.parts[1], imagePart)).toBe(false)
    expect(Object.is(ui.parts[2], uiMessages[0]!.parts[2])).toBe(false)
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
    expect(Object.is(modelParts[1], documentPart)).toBe(false)
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

  it("protects escaped PII inside model tool-message JSON", async () => {
    const original = 'Ana "Boss"'
    const session = createAnonymizer({
      dictionary: [{ value: original, type: "CUSTOM" }],
      placeholders: token(),
    }).createSession()
    let received: Array<ModelMessage> = []
    const wrapped = piiConnection(
      {
        connect(messages) {
          received = messages as Array<ModelMessage>
          return emptyStream()
        },
      },
      { session }
    )

    await collect(
      wrapped.connect([
        {
          role: "tool",
          toolCallId: "tool-1",
          content: JSON.stringify({ owner: original }),
        },
        {
          role: "tool",
          toolCallId: "tool-2",
          content: [
            {
              type: "text",
              content: JSON.stringify({ owner: original }),
            },
          ],
        },
      ])
    )

    const content = received[0]!.content as string
    expect(content).not.toContain("Ana")
    expect(JSON.parse(content)).toEqual({ owner: expect.stringMatching(TOKEN) })
    const part = (received[1]!.content as Array<{ content: string }>)[0]!
    expect(part.content).not.toContain("Ana")
    expect(JSON.parse(part.content)).toEqual({
      owner: expect.stringMatching(TOKEN),
    })
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
    // Models sometimes case-fold or confuse Crockford characters. Tool JSON
    // must take the same strategy-aware lenient restoration path as text.
    const args = JSON.stringify({ name: placeholder!.toLowerCase() })
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
            result: [
              {
                type: "text",
                content: JSON.stringify({ name: placeholder!.toLowerCase() }),
              },
            ],
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
    const end = chunks.find(
      (chunk) => chunk.type === EventType.TOOL_CALL_END
    ) as Extract<StreamChunk, { type: "TOOL_CALL_END" }>
    const resultPart = (end.result as Array<{ content: string }>)[0]!
    expect(JSON.parse(resultPart.content)).toEqual({ name: original })
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

  it("preserves an ambiguous token-like suffix on normal bare completion", async () => {
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

    expect(output).toBe(`Safe text ${placeholder!.slice(0, 8)}`)
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
