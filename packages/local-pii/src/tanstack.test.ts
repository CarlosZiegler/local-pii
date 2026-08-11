import {
  EventType,
  uiMessagesToWire,
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

  it("rejects an unknown sibling accessor without invoking it", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    let siblingGets = 0
    const part = {
      type: "text" as const,
      content: "ana@acme.com",
    } as Record<string, unknown>
    Object.defineProperty(part, "futureField", {
      enumerable: true,
      get() {
        siblingGets += 1
        throw new Error("future secret")
      },
    })

    await expect(
      collect(
        piiConnection({ connect }, { session }).connect([
          { id: "sibling-accessor", role: "user", parts: [part] },
        ] as unknown as Array<UIMessage>)
      )
    ).rejects.toMatchObject({
      path: [0, "parts", 0, "<field>"],
      discriminant: "<accessor>",
    })
    expect(siblingGets).toBe(0)
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)
  })

  it("rejects own array iteration hooks before session work", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    const parts = [{ type: "text" as const, content: "ana@acme.com" }] as Array<
      Record<string, unknown>
    >
    Object.defineProperty(parts, Symbol.iterator, {
      configurable: true,
      value: function* () {
        yield { type: "text", content: "leaked@acme.com" }
      },
    })

    await expect(
      collect(
        piiConnection({ connect }, { session }).connect([
          { id: "array-hook", role: "user", parts },
        ] as unknown as Array<UIMessage>)
      )
    ).rejects.toMatchObject({
      path: [0, "parts", "<field>"],
      discriminant: "<invalid>",
    })
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)
  })

  it("fails closed when Array.prototype mutates during protection", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const originalAnonymize = session.anonymize.bind(session)
    const arrayPrototype = Array.prototype as Array<unknown> & {
      toJSON?: () => unknown
    }
    const toJsonDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "toJSON"
    )
    const someDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "some"
    )
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator
    )
    const numericDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "0"
    )
    const arrayLengthDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "length"
    )
    const arrayPrototypeParent = Object.getPrototypeOf(Array.prototype)
    const chainMutation = {
      toJSON: () => ({ leaked: "ana@acme.com" }),
    }
    let settledBeforeRestore = false
    vi.spyOn(session, "anonymize").mockImplementation(async (text) => {
      const result = await originalAnonymize(text)
      Object.defineProperty(arrayPrototype, "toJSON", {
        configurable: true,
        value: () => ({ leaked: "ana@acme.com" }),
      })
      Object.defineProperty(arrayPrototype, "some", {
        configurable: true,
        value: () => false,
      })
      Object.defineProperty(arrayPrototype, Symbol.iterator, {
        configurable: true,
        value: function* () {
          yield { leaked: "ana@acme.com" }
        },
      })
      Object.defineProperty(arrayPrototype, "0", {
        configurable: true,
        set() {},
      })
      Object.setPrototypeOf(arrayPrototype, chainMutation)
      return result
    })
    const innerConnect = vi.fn(() => emptyStream())
    let caught: unknown
    try {
      const wrapped = piiConnection({ connect: innerConnect }, { session })
      try {
        await collect(
          wrapped.connect([
            {
              id: "stable-array-hooks",
              role: "user",
              parts: [{ type: "text", content: "ana@acme.com" }],
            },
          ])
        )
      } catch (error) {
        caught = error
        settledBeforeRestore = true
      }
    } finally {
      if (toJsonDescriptor)
        Object.defineProperty(Array.prototype, "toJSON", toJsonDescriptor)
      else
        delete (Array.prototype as Array<unknown> & { toJSON?: unknown }).toJSON
      if (someDescriptor)
        Object.defineProperty(Array.prototype, "some", someDescriptor)
      if (iteratorDescriptor)
        Object.defineProperty(
          Array.prototype,
          Symbol.iterator,
          iteratorDescriptor
        )
      if (numericDescriptor)
        Object.defineProperty(Array.prototype, "0", numericDescriptor)
      else delete (Array.prototype as Array<unknown>)[0]
      if (arrayLengthDescriptor)
        Object.defineProperty(Array.prototype, "length", arrayLengthDescriptor)
      Object.setPrototypeOf(Array.prototype, arrayPrototypeParent)
    }
    expect(innerConnect).not.toHaveBeenCalled()
    expect(settledBeforeRestore).toBe(true)
    expect(caught).toMatchObject({ path: [], discriminant: "<invalid>" })
  })

  it("does not resolve a transient Array.prototype map replacement from a caller trap", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const originalMap = Object.getOwnPropertyDescriptor(Array.prototype, "map")!
    const source = [
      { role: "user" as const, content: "ana@acme.com" },
    ] as Array<ModelMessage>
    let ownKeysCalls = 0
    const messages = new Proxy(source, {
      ownKeys(target) {
        ownKeysCalls += 1
        Object.defineProperty(Array.prototype, "map", {
          configurable: true,
          value: () => [],
        })
        Object.defineProperty(Array.prototype, "map", originalMap)
        return Reflect.ownKeys(target)
      },
    })
    const received: Array<ModelMessage>[] = []
    const wrapped = piiConnection(
      {
        connect(protectedMessages) {
          received.push(protectedMessages as Array<ModelMessage>)
          return emptyStream()
        },
      },
      { session }
    )

    await collect(wrapped.connect(messages))
    expect(ownKeysCalls).toBe(1)
    expect(received[0]![0]!.content).toMatch(TOKEN)
  })

  it("pins connect before a getter can mutate the Array prototype chain", () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const originalToJson = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "toJSON"
    )
    const connect = vi.fn(() => emptyStream())
    const inner = {
      get connect() {
        Object.defineProperty(Array.prototype, "toJSON", {
          configurable: true,
          value: () => ({ leaked: "ana@acme.com" }),
        })
        return connect
      },
    } as unknown as ConnectConnectionAdapter

    try {
      expect(() => piiConnection(inner, { session })).toThrow(
        UnsupportedTanStackSemanticContentError
      )
    } finally {
      if (originalToJson)
        Object.defineProperty(Array.prototype, "toJSON", originalToJson)
      else
        delete (Array.prototype as Array<unknown> & { toJSON?: unknown }).toJSON
    }
    expect(connect).not.toHaveBeenCalled()
    expect(Object.keys(session.mapping)).toHaveLength(0)
  })

  it("gives an abort reason precedence over a late intrinsic mutation", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const originalAnonymize = session.anonymize.bind(session)
    const originalToJson = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "toJSON"
    )
    const controller = new AbortController()
    const abortReason = new Error("abort wins")
    const connect = vi.fn(() => emptyStream())
    vi.spyOn(session, "anonymize").mockImplementation(async (text) => {
      const result = await originalAnonymize(text)
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value: () => ({ leaked: "ana@acme.com" }),
      })
      controller.abort(abortReason)
      return result
    })

    let caught: unknown
    try {
      await collect(
        piiConnection({ connect }, { session }).connect(
          [{ role: "user", content: "ana@acme.com" }],
          undefined,
          controller.signal
        )
      )
    } catch (error) {
      caught = error
    } finally {
      if (originalToJson)
        Object.defineProperty(Array.prototype, "toJSON", originalToJson)
      else
        delete (Array.prototype as Array<unknown> & { toJSON?: unknown }).toJSON
    }
    expect(caught).toBe(abortReason)
    expect(connect).not.toHaveBeenCalled()
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
      path: [0, "content"],
      discriminant: "<accessor>",
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

  it("protects valid incomplete tool calls and sanitizes malformed ones", async () => {
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
    await collect(wrapped.connect([malformed]))
    expect(connect).toHaveBeenCalledTimes(2)
    const sanitized = (
      connect.mock.calls as unknown as Array<unknown[]>
    )[1]![0] as Array<UIMessage>
    const sanitizedPart = sanitized[0]!.parts[0]!
    if (sanitizedPart.type !== "tool-call")
      throw new Error("expected tool call")
    expect(sanitizedPart.arguments).toBe("")
    expect(sanitizedPart.arguments).not.toContain("Ana")
  })

  it.each(["awaiting-input", "input-streaming"] as const)(
    "sanitizes empty and truncated %s arguments while protecting input",
    async (state) => {
      const original = 'Ana "Boss"'
      const session = createAnonymizer({
        dictionary: [{ value: original, type: "CUSTOM" }],
        placeholders: token(),
      }).createSession()
      const connect = vi.fn(() => emptyStream())
      const argument = state === "awaiting-input" ? "" : '{"name":"Ana'
      const message = {
        id: `partial-${state}`,
        role: "assistant" as const,
        parts: [
          {
            type: "tool-call" as const,
            id: "call",
            name: "lookup",
            arguments: argument,
            input: { name: original },
            state,
          },
        ],
      } satisfies UIMessage
      const callerSnapshot = structuredClone(message)

      await collect(piiConnection({ connect }, { session }).connect([message]))
      const forwarded = (
        connect.mock.calls as unknown as Array<unknown[]>
      )[0]![0] as Array<UIMessage>
      const forwardedPart = forwarded[0]!.parts[0]!
      if (forwardedPart.type !== "tool-call")
        throw new Error("expected tool call")
      expect(forwardedPart.arguments).toBe("")
      expect(forwardedPart.input).toEqual({
        name: expect.stringMatching(TOKEN),
      })
      const wire = uiMessagesToWire(forwarded)
      const wireCall = (wire[0] as { toolCalls?: Array<unknown> })
        .toolCalls?.[0]
      expect(
        (wireCall as { function?: { arguments?: string } })?.function?.arguments
      ).toBe("")
      expect(JSON.stringify(wire)).not.toContain(original)
      expect(message).toEqual(callerSnapshot)
    }
  )

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
    expect(part.data).not.toBe(data)
    expect(part.data).toEqual({ email: expect.stringMatching(TOKEN) })

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

  it("protects every structured-output representation used by the UI wire converter", async () => {
    const original = "ana@acme.com"
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    const message = {
      id: "structured-wire",
      role: "assistant" as const,
      parts: [
        {
          type: "structured-output" as const,
          status: "complete" as const,
          raw: JSON.stringify({ raw: original }),
          data: { data: original },
          partial: { partial: original },
          errorMessage: `failed ${original}`,
        },
        {
          type: "structured-output" as const,
          status: "streaming" as const,
          raw: JSON.stringify({ streaming: original }),
          data: { data: original },
          partial: { partial: original },
        },
        {
          type: "structured-output" as const,
          status: "error" as const,
          raw: `{"error":"${original}`,
          partial: { partial: original },
          errorMessage: `error ${original}`,
        },
      ],
    } as unknown as UIMessage
    const snapshot = structuredClone(message)

    await collect(wrapped.connect([message]))
    const forwarded = (
      connect.mock.calls as unknown as Array<unknown[]>
    )[0]![0] as Array<UIMessage>
    const wire = uiMessagesToWire(forwarded)

    expect(JSON.stringify(wire)).not.toContain(original)
    expect(message).toEqual(snapshot)
    const first = forwarded[0]!.parts[0]!
    const second = forwarded[0]!.parts[1]!
    const third = forwarded[0]!.parts[2]!
    expect(first).toMatchObject({
      raw: expect.stringMatching(TOKEN),
      data: { data: expect.stringMatching(TOKEN) },
      partial: { partial: expect.stringMatching(TOKEN) },
      errorMessage: expect.stringMatching(TOKEN),
    })
    expect(second).toMatchObject({
      raw: expect.stringMatching(TOKEN),
      data: { data: expect.stringMatching(TOKEN) },
      partial: { partial: expect.stringMatching(TOKEN) },
    })
    expect(third).toMatchObject({
      raw: "",
      partial: { partial: expect.stringMatching(TOKEN) },
      errorMessage: expect.stringMatching(TOKEN),
    })
  })

  it("protects error-state tool-call arguments when they are incomplete", async () => {
    const original = 'Ana "Boss"'
    const session = createAnonymizer({
      dictionary: [{ value: original, type: "CUSTOM" }],
      placeholders: token(),
    }).createSession()
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    const message = {
      id: "error-tool",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-call" as const,
          id: "call-error",
          name: "lookup",
          arguments: '{"name":"Ana \\"Boss}',
          state: "error" as const,
        },
      ],
    } as unknown as UIMessage

    await collect(wrapped.connect([message]))
    const forwarded = (
      connect.mock.calls as unknown as Array<unknown[]>
    )[0]![0] as Array<UIMessage>
    const part = forwarded[0]!.parts[0]!
    if (part.type !== "tool-call") throw new Error("expected tool call")
    expect(part.arguments).toBe("")
    expect(part.arguments).not.toContain("Ana")
  })

  it("uses captured JSON and collection intrinsics after anonymization yields", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const originalAnonymize = session.anonymize.bind(session)
    const originalJsonStringify = Object.getOwnPropertyDescriptor(
      JSON,
      "stringify"
    )!
    const originalArrayIsArray = Object.getOwnPropertyDescriptor(
      Array,
      "isArray"
    )!
    const originalObjectKeys = Object.getOwnPropertyDescriptor(Object, "keys")!
    const connect = vi.fn(() => emptyStream())
    vi.spyOn(session, "anonymize").mockImplementation(async (text) => {
      const result = await originalAnonymize(text)
      Object.defineProperty(JSON, "stringify", {
        configurable: true,
        writable: true,
        value: () => '{"leaked":"ana@acme.com"}',
      })
      Object.defineProperty(Array, "isArray", {
        configurable: true,
        writable: true,
        value: () => false,
      })
      Object.defineProperty(Object, "keys", {
        configurable: true,
        writable: true,
        value: () => [],
      })
      return result
    })

    try {
      await collect(
        piiConnection({ connect }, { session }).connect([
          {
            id: "late-intrinsics",
            role: "assistant",
            parts: [
              {
                type: "structured-output",
                status: "complete",
                raw: '{"email":"ana@acme.com"}',
                data: { email: "ana@acme.com" },
              },
            ],
          },
        ] as unknown as Array<UIMessage>)
      )
      const forwarded = (
        connect.mock.calls as unknown as Array<unknown[]>
      )[0]![0] as Array<UIMessage>
      const stableStringify =
        originalJsonStringify.value as typeof JSON.stringify
      expect(stableStringify(forwarded)).not.toContain("ana@acme.com")
      const part = forwarded[0]!.parts[0]!
      expect(part).toMatchObject({
        raw: expect.stringMatching(TOKEN),
        data: { email: expect.stringMatching(TOKEN) },
      })
    } finally {
      Object.defineProperty(JSON, "stringify", originalJsonStringify)
      Object.defineProperty(Array, "isArray", originalArrayIsArray)
      Object.defineProperty(Object, "keys", originalObjectKeys)
    }
  })

  it("allows non-callable toJSON data while protecting JSON values", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const connect = vi.fn(() => emptyStream())
    const wrapped = piiConnection({ connect }, { session })
    const message = Object.assign(
      Object.create({ toJSON: () => "inherited raw" }),
      {
        id: "non-callable-toJSON",
        role: "assistant" as const,
        toJSON: "control",
        parts: [
          {
            type: "structured-output" as const,
            status: "complete" as const,
            raw: "",
            data: { toJSON: "ana@acme.com" },
          },
        ],
      }
    ) as unknown as UIMessage

    await collect(wrapped.connect([message]))
    const forwarded = (
      connect.mock.calls as unknown as Array<unknown[]>
    )[0]![0] as Array<UIMessage>
    const forwardedMessage = forwarded[0]!
    expect(
      (forwardedMessage as unknown as Record<string, unknown>).toJSON
    ).toBe("control")
    expect(JSON.stringify(forwarded)).not.toContain("ana@acme.com")
    const part = forwardedMessage.parts[0]!
    if (part.type !== "structured-output")
      throw new Error("expected structured output")
    expect(part.data).toEqual({ toJSON: expect.stringMatching(TOKEN) })
  })

  it("uses captured Map and String intrinsics after anonymization yields", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const originalAnonymize = session.anonymize.bind(session)
    const mapKeys = ["set", "get", "has"] as const
    const mapDescriptors = {
      set: Object.getOwnPropertyDescriptor(Map.prototype, "set")!,
      get: Object.getOwnPropertyDescriptor(Map.prototype, "get")!,
      has: Object.getOwnPropertyDescriptor(Map.prototype, "has")!,
    }
    const originalStringDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "String"
    )!
    vi.spyOn(session, "anonymize").mockImplementation(async (text) => {
      const result = await originalAnonymize(text)
      for (const key of mapKeys) {
        const descriptor = mapDescriptors[key]
        Object.defineProperty(Map.prototype, key, {
          configurable: true,
          get() {
            Object.defineProperty(Map.prototype, key, descriptor)
            if (key === "set")
              return function (this: Map<unknown, unknown>) {
                return this
              }
            if (key === "has") return () => false
            return () => undefined
          },
        })
      }
      Object.defineProperty(globalThis, "String", {
        configurable: true,
        writable: true,
        value: () => {
          Object.defineProperty(globalThis, "String", originalStringDescriptor)
          return "wrong-key"
        },
      })
      return result
    })

    try {
      const forwarded: Array<UIMessage>[] = []
      const wrapped = piiConnection(
        {
          connect(messages) {
            forwarded.push(messages as Array<UIMessage>)
            return emptyStream()
          },
        },
        { session }
      )
      await collect(
        wrapped.connect([
          {
            id: "map-intrinsics",
            role: "assistant",
            parts: [
              { type: "text", content: "ana@acme.com" },
              {
                type: "structured-output",
                status: "complete",
                raw: '{"email":"ana@acme.com"}',
                data: { email: "ana@acme.com" },
              },
            ],
          },
        ] as unknown as Array<UIMessage>)
      )
      expect(JSON.stringify(forwarded)).not.toContain("ana@acme.com")
      expect(forwarded[0]![0]!.parts[0]).toMatchObject({
        content: expect.stringMatching(TOKEN),
      })
      expect(forwarded[0]![0]!.parts[1]).toMatchObject({
        raw: expect.stringMatching(TOKEN),
        data: { email: expect.stringMatching(TOKEN) },
      })
    } finally {
      for (const key of mapKeys)
        Object.defineProperty(Map.prototype, key, mapDescriptors[key])
      Object.defineProperty(globalThis, "String", originalStringDescriptor)
    }
  })

  it("rejects malformed tool-call JSON in included states", async () => {
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
    await collect(wrapped.connect([uiMessage]))
    expect(connect).toHaveBeenCalledOnce()
    const sanitized = (
      connect.mock.calls as unknown as Array<unknown[]>
    )[0]![0] as Array<UIMessage>
    const sanitizedPart = sanitized[0]!.parts[0]!
    if (sanitizedPart.type !== "tool-call")
      throw new Error("expected tool call")
    expect(sanitizedPart.arguments).toBe("")
    expect(sanitizedPart.arguments).not.toContain("Ana")
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
    expect(connect).toHaveBeenCalledOnce()
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
    expect(connect).toHaveBeenCalledOnce()

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
    )[1]![0] as Array<UIMessage>
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
    expect(
      Object.getPrototypeOf(Object.getPrototypeOf(protectedMessages))
    ).toBe(null)
    expect(Object.getPrototypeOf(protectedMessages)).not.toBe(Array.prototype)
    expect(protectedMessages).not.toBeInstanceOf(Array)
    expect(protectedMessages.some((item) => item.id === "frozen")).toBe(true)
    expect([...protectedMessages]).toHaveLength(1)
    const protectedPart = protectedMessages[0]!.parts[0] as unknown as Record<
      string,
      unknown
    >
    expect(
      Object.getPrototypeOf(Object.getPrototypeOf(protectedMessages[0]!.parts))
    ).toBe(null)
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
    expect("data" in structured ? structured.data : undefined).not.toBe(
      structuredData
    )
    expect("data" in structured ? structured.data : undefined).toEqual({
      email: expect.stringMatching(TOKEN),
    })
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

  it("restores escaped tool JSON at every argument split boundary", async () => {
    const original = 'Ana "Boss"\\Support\nLine'
    const session = createAnonymizer({
      dictionary: [{ value: original, type: "CUSTOM" }],
      placeholders: token(),
    }).createSession()
    const protectedName = (await session.anonymize(original)).redactedText
    const placeholder = protectedName.match(TOKEN)?.[0]
    expect(placeholder).toBeDefined()
    const args = JSON.stringify({ name: placeholder!.toLowerCase() })

    for (let split = 0; split <= args.length; split += 1) {
      const inner: ConnectConnectionAdapter = {
        connect: () =>
          (async function* () {
            yield {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: "tool-split",
              delta: args.slice(0, split),
            } satisfies StreamChunk
            yield {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: "tool-split",
              delta: args.slice(split),
            } satisfies StreamChunk
            yield {
              type: EventType.TOOL_CALL_END,
              toolCallId: "tool-split",
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
    }
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

  it.each([
    ["connect", EventType.RUN_FINISHED],
    ["connect", EventType.RUN_ERROR],
    ["joinRun", EventType.RUN_FINISHED],
    ["joinRun", EventType.RUN_ERROR],
  ] as const)(
    "%s drains terminal %s events and restores the later run",
    async (entrypoint, terminalType) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const firstTerminal =
        terminalType === EventType.RUN_FINISHED
          ? ({
              type: terminalType,
              threadId: "thread-1",
              runId: "run-1",
            } satisfies StreamChunk)
          : ({
              type: terminalType,
              message: "provider failed",
            } satisfies StreamChunk)
      const secondTerminal =
        terminalType === EventType.RUN_FINISHED
          ? ({
              type: terminalType,
              threadId: "thread-1",
              runId: "run-2",
            } satisfies StreamChunk)
          : ({
              type: terminalType,
              message: "provider failed again",
            } satisfies StreamChunk)
      let nextCalls = 0
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls += 1
              const chunks: Array<StreamChunk> = [
                {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "before-finished",
                  delta: "tail before terminal",
                } satisfies StreamChunk,
                firstTerminal,
                {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "after-first-terminal",
                  delta: "must be read after terminal",
                } satisfies StreamChunk,
                {
                  type: EventType.TEXT_MESSAGE_END,
                  messageId: "after-first-terminal",
                } satisfies StreamChunk,
                secondTerminal,
              ]
              const value = chunks[nextCalls - 1]
              if (value) return { done: false as const, value }
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }

      const chunks = await collect(
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      )

      expect(chunks).toEqual([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "before-finished",
          delta: "tail before terminal",
        },
        firstTerminal,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "after-first-terminal",
          delta: "must be read after terminal",
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "after-first-terminal",
        },
        secondTerminal,
      ])
      expect(nextCalls).toBe(6)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "cancels a pending upstream next when the caller aborts through %s",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const controller = new AbortController()
      const abortReason = new Error("abort while waiting")
      let resolveNext!: (result: IteratorResult<StreamChunk>) => void
      let nextCalled = false
      let nextResolved = false
      let returnCalled = false
      let returnReason: unknown
      let returnBeforeNextResolved = false
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalled = true
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                resolveNext = (result) => {
                  nextResolved = true
                  resolve(result)
                }
              })
            },
            async return(value?: unknown) {
              returnCalled = true
              returnReason = value
              returnBeforeNextResolved = !nextResolved
              resolveNext({ done: true, value: undefined })
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const wrapped = piiConnection(inner, { session })
      const stream =
        entrypoint === "connect"
          ? wrapped.connect(
              [{ role: "user", content: "hello" }],
              undefined,
              controller.signal
            )
          : wrapped.joinRun!("run-1", controller.signal)
      const iterator = stream[Symbol.asyncIterator]()
      const pending = iterator.next()
      const observed = pending.catch((error: unknown) => error)

      try {
        for (let attempt = 0; !nextCalled && attempt < 10; attempt += 1)
          await new Promise((resolve) => setTimeout(resolve, 0))
        expect(nextCalled).toBe(true)
        controller.abort(abortReason)
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(returnCalled).toBe(true)
        expect(returnReason).toBe(abortReason)
        expect(returnBeforeNextResolved).toBe(true)
        await expect(observed).resolves.toBe(abortReason)
      } finally {
        resolveNext?.({ done: true, value: undefined })
        await observed
      }
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "settles a public next promptly when %s aborts during message protection",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const never = new Promise<never>(() => {})
      vi.spyOn(session, "anonymize").mockReturnValue(never)
      const controller = new AbortController()
      const abortReason = new Error(`${entrypoint} protection abort`)
      const connect = vi.fn(() => emptyStream())
      const joinRun = vi.fn(() => emptyStream())
      const wrapped = piiConnection({ connect, joinRun }, { session })
      const stream =
        entrypoint === "connect"
          ? wrapped.connect(
              [{ role: "user", content: "hello" }],
              undefined,
              controller.signal
            )
          : wrapped.joinRun!("run-1", controller.signal)
      const iterator = stream[Symbol.asyncIterator]()
      const observed = iterator.next().catch((error: unknown) => error)
      controller.abort(abortReason)

      await expect(
        Promise.race([
          observed,
          new Promise((resolve) =>
            setTimeout(() => resolve(Symbol.for("timed out")), 50)
          ),
        ])
      ).resolves.toBe(abortReason)
      expect(connect).not.toHaveBeenCalled()
      expect(joinRun).not.toHaveBeenCalled()
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "settles an outstanding %s next when the caller returns during upstream wait",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      let nextCalled = false
      let returnValue: unknown
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalled = true
              return new Promise<IteratorResult<StreamChunk>>(() => {})
            },
            async return(value?: unknown) {
              returnValue = value
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const wrappedStream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = wrappedStream[Symbol.asyncIterator]()
      const pending = iterator.next()
      for (let attempt = 0; !nextCalled && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(nextCalled).toBe(true)

      await expect(
        Promise.race([
          iterator.return?.("caller-close"),
          new Promise((resolve) =>
            setTimeout(() => resolve(Symbol.for("timed out")), 50)
          ),
        ])
      ).resolves.toMatchObject({ done: true, value: "caller-close" })
      await expect(pending).resolves.toMatchObject({ done: true })
      expect(returnValue).toBe("caller-close")
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "preserves a caller throw through %s before and after the first yield",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const primary = new Error(`${entrypoint} caller throw`)
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          let yielded = false
          return {
            async next() {
              if (yielded) return { done: true as const, value: undefined }
              yielded = true
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "throw-test",
                  delta: "first",
                } satisfies StreamChunk,
              }
            },
            async return() {
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const wrapped = piiConnection(inner, { session })
      const before =
        entrypoint === "connect"
          ? wrapped.connect([{ role: "user", content: "hello" }])
          : wrapped.joinRun!("run-1")
      await expect(
        before[Symbol.asyncIterator]().throw?.(primary)
      ).rejects.toBe(primary)

      const after =
        entrypoint === "connect"
          ? wrapped.connect([{ role: "user", content: "hello" }])
          : wrapped.joinRun!("run-1")
      const iterator = after[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toMatchObject({ done: false })
      await expect(iterator.throw?.(primary)).rejects.toBe(primary)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "keeps the caller throw primary when %s cleanup rejects",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const primary = new Error(`${entrypoint} throw primary`)
      const cleanup = new Error(`${entrypoint} throw cleanup`)
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "throw-cleanup",
                  delta: "first",
                } satisfies StreamChunk,
              }
            },
            async return() {
              throw cleanup
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toMatchObject({ done: false })
      await expect(iterator.throw?.(primary)).rejects.toBe(primary)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "delegates %s caller throw to an upstream async iterator",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const primary = new Error(`${entrypoint} delegated throw`)
      let thrown: unknown
      let returned = false
      const delegated = {
        type: EventType.RUN_ERROR,
        message: "delegated",
      } satisfies StreamChunk
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "delegated-throw",
                  delta: "first",
                } satisfies StreamChunk,
              }
            },
            async throw(value?: unknown) {
              thrown = value
              return { done: true as const, value: delegated }
            },
            async return() {
              returned = true
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toMatchObject({ done: false })
      await expect(iterator.throw?.(primary)).resolves.toEqual({
        done: true,
        value: delegated,
      })
      expect(thrown).toBe(primary)
      expect(returned).toBe(false)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "restores and continues after %s upstream throw recovery",
    async (entrypoint) => {
      const original = "ana@acme.com"
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize(original)).redactedText
      const split = Math.floor(protectedContent.length / 2)
      const continuation = " continuation after recovery ".repeat(3)
      const primary = new Error(`${entrypoint} recovery throw`)
      let thrown: unknown
      let pulls = 0
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              pulls += 1
              if (pulls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "recovered-message",
                    delta: protectedContent.slice(0, split),
                  } satisfies StreamChunk,
                }
              if (pulls === 2)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "recovered-message",
                    delta: " after next",
                  } satisfies StreamChunk,
                }
              if (pulls === 3)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: "recovered-message",
                  } satisfies StreamChunk,
                }
              return { done: true as const, value: undefined }
            },
            async throw(value?: unknown) {
              thrown = value
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "recovered-message",
                  delta: protectedContent.slice(split) + continuation,
                } satisfies StreamChunk,
              }
            },
            async return() {
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first).toMatchObject({ done: false })
      const recovered = await iterator.throw?.(primary)
      expect(recovered).toMatchObject({ done: false })
      expect(
        (
          recovered?.value as Extract<
            StreamChunk,
            { type: "TEXT_MESSAGE_CONTENT" }
          >
        ).delta
      ).toContain(original)
      expect(
        (
          recovered?.value as Extract<
            StreamChunk,
            { type: "TEXT_MESSAGE_CONTENT" }
          >
        ).delta
      ).not.toContain(protectedContent)
      const rest: StreamChunk[] = []
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        rest.push(next.value)
      }
      const restoredText = [
        ...(first.done ? [] : [first.value]),
        ...(recovered?.done ? [] : recovered ? [recovered.value] : []),
        ...rest,
      ]
        .filter(
          (
            chunk
          ): chunk is Extract<StreamChunk, { type: "TEXT_MESSAGE_CONTENT" }> =>
            chunk?.type === EventType.TEXT_MESSAGE_CONTENT
        )
        .map((chunk) => chunk.delta)
        .join("")
      expect(restoredText).toContain(original)
      expect(restoredText).toContain("after next")
      expect(restoredText).toContain(continuation)
      expect(restoredText).not.toContain(protectedContent)
      expect(thrown).toBe(primary)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "settles a pending next before surfacing %s return cleanup failure",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const reason = `${entrypoint} return reason`
      const cleanup = new Error(`${entrypoint} return cleanup`)
      let nextCalled = false
      let returnValue: unknown
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalled = true
              return new Promise<IteratorResult<StreamChunk>>(() => {})
            },
            async return(value?: unknown) {
              returnValue = value
              throw cleanup
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      const pending = iterator.next()
      for (let attempt = 0; !nextCalled && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(nextCalled).toBe(true)

      const closing = iterator.return?.(reason)
      await expect(pending).resolves.toMatchObject({ done: true })
      await expect(closing).rejects.toBe(cleanup)
      expect(returnValue).toBe(reason)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "races a pending %s delegated throw against abort",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const lateContent = (await session.anonymize("late@acme.com"))
        .redactedText
      const controller = new AbortController()
      const primary = new Error(`${entrypoint} delegated throw`)
      const abortReason = new Error(`${entrypoint} throw abort`)
      let throwCalled = false
      let returnValue: unknown
      let releaseThrow!: (result: IteratorResult<StreamChunk>) => void
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "throw-abort",
                  delta: "before throw",
                } satisfies StreamChunk,
              }
            },
            throw(value?: unknown) {
              throwCalled = value === primary
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                releaseThrow = resolve
              })
            },
            async return(value?: unknown) {
              returnValue = value
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect(
              [{ role: "user", content: "hello" }],
              undefined,
              controller.signal
            )
          : piiConnection(inner, { session }).joinRun!(
              "run-1",
              controller.signal
            )
      const iterator = stream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toMatchObject({ done: false })
      const pendingThrow = iterator.throw?.(primary)
      for (let attempt = 0; !throwCalled && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(throwCalled).toBe(true)
      controller.abort(abortReason)

      await expect(
        Promise.race([
          pendingThrow,
          new Promise((resolve) =>
            setTimeout(() => resolve(Symbol.for("timed out")), 50)
          ),
        ])
      ).rejects.toBe(abortReason)
      expect(returnValue).toBe(abortReason)

      releaseThrow({
        done: false,
        value: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "throw-abort",
          delta: lateContent,
        } satisfies StreamChunk,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await expect(iterator.next()).rejects.toBe(abortReason)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "settles a pending %s delegated throw when the caller returns",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const primary = new Error(`${entrypoint} delegated throw`)
      const closeReason = `${entrypoint} close`
      let releaseThrow!: (result: IteratorResult<StreamChunk>) => void
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "throw-return",
                  delta: "before throw",
                } satisfies StreamChunk,
              }
            },
            throw() {
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                releaseThrow = resolve
              })
            },
            async return(value?: unknown) {
              expect(value).toBe(closeReason)
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const pendingThrow = iterator.throw?.(primary)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const closing = iterator.return?.(closeReason)
      await expect(closing).resolves.toMatchObject({
        done: true,
        value: closeReason,
      })
      await expect(pendingThrow).resolves.toMatchObject({
        done: true,
        value: closeReason,
      })
      releaseThrow({ done: false, value: {} as StreamChunk })
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "cleans up when %s delegated throw restoration fails",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const restoreError = new Error(`${entrypoint} restoration failure`)
      vi.spyOn(session, "rehydrateJson").mockImplementation(() => {
        throw restoreError
      })
      const primary = new Error(`${entrypoint} delegated throw`)
      let returnCalls = 0
      let returnValue: unknown
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "throw-restore-error",
                  delta: "before throw",
                } satisfies StreamChunk,
              }
            },
            async throw() {
              return {
                done: false as const,
                value: {
                  type: EventType.CUSTOM,
                  name: "structured-output.complete",
                  value: { object: { email: "protected" } },
                } as unknown as StreamChunk,
              }
            },
            async return(value?: unknown) {
              returnCalls += 1
              returnValue = value
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      await expect(iterator.throw?.(primary)).rejects.toBe(restoreError)
      expect(returnCalls).toBe(1)
      expect(returnValue).toBe(restoreError)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "removes inner abort listeners when %s closes during a pending next",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, "addEventListener")
      const remove = vi.spyOn(controller.signal, "removeEventListener")
      let nextCalled = false
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalled = true
              return new Promise<IteratorResult<StreamChunk>>(() => {})
            },
            async throw() {
              return { done: true as const, value: undefined }
            },
            async return() {
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const wrapped = piiConnection(inner, { session })
      const makeStream = () =>
        entrypoint === "connect"
          ? wrapped.connect(
              [{ role: "user", content: "hello" }],
              undefined,
              controller.signal
            )
          : wrapped.joinRun!("run-1", controller.signal)

      const returned = makeStream()[Symbol.asyncIterator]()
      const pendingReturn = returned.next()
      for (let attempt = 0; !nextCalled && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(nextCalled).toBe(true)
      await expect(returned.return?.("caller-close")).resolves.toMatchObject({
        done: true,
      })
      await expect(pendingReturn).resolves.toMatchObject({ done: true })

      nextCalled = false
      const thrown = makeStream()[Symbol.asyncIterator]()
      const pendingThrowNext = thrown.next()
      for (let attempt = 0; !nextCalled && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      await expect(thrown.throw?.(new Error("close throw"))).resolves.toEqual({
        done: true,
        value: undefined,
      })
      await expect(pendingThrowNext).resolves.toMatchObject({ done: true })

      const addedAbortListeners = add.mock.calls.filter(
        ([type]) => type === "abort"
      )
      expect(addedAbortListeners).toHaveLength(4)
      for (const [, listener] of addedAbortListeners)
        expect(
          remove.mock.calls.some(
            ([type, removedListener]) =>
              type === "abort" && removedListener === listener
          )
        ).toBe(true)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "settles every concurrent %s delegated throw on abort",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const controller = new AbortController()
      const abortReason = new Error(`${entrypoint} concurrent throw abort`)
      const firstError = new Error(`${entrypoint} first throw`)
      const secondError = new Error(`${entrypoint} second throw`)
      const releases: Array<(result: IteratorResult<StreamChunk>) => void> = []
      let throwCalls = 0
      let returnValue: unknown
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "concurrent-throw-abort",
                  delta: "before throw",
                } satisfies StreamChunk,
              }
            },
            throw() {
              throwCalls += 1
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                releases.push(resolve)
              })
            },
            async return(value?: unknown) {
              returnValue = value
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect(
              [{ role: "user", content: "hello" }],
              undefined,
              controller.signal
            )
          : piiConnection(inner, { session }).joinRun!(
              "run-1",
              controller.signal
            )
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const first = iterator.throw?.(firstError)
      const second = iterator.throw?.(secondError)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(throwCalls).toBe(1)
      controller.abort(abortReason)

      const timedOut = Symbol("timed out")
      const settled = await Promise.race([
        Promise.allSettled([first, second]),
        new Promise<typeof timedOut>((resolve) =>
          setTimeout(() => resolve(timedOut), 50)
        ),
      ])
      expect(settled).not.toBe(timedOut)
      expect(settled).toEqual([
        { status: "rejected", reason: abortReason },
        { status: "rejected", reason: abortReason },
      ])
      expect(returnValue).toBe(abortReason)

      for (const release of releases)
        release({
          done: false,
          value: {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "concurrent-throw-abort",
            delta: "late",
          } satisfies StreamChunk,
        })
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "settles every concurrent %s delegated throw on caller return",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const closeReason = `${entrypoint} concurrent throw return`
      const firstError = new Error(`${entrypoint} first throw`)
      const secondError = new Error(`${entrypoint} second throw`)
      const releases: Array<(result: IteratorResult<StreamChunk>) => void> = []
      let throwCalls = 0
      let returnValue: unknown
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "concurrent-throw-return",
                  delta: "before throw",
                } satisfies StreamChunk,
              }
            },
            throw() {
              throwCalls += 1
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                releases.push(resolve)
              })
            },
            async return(value?: unknown) {
              returnValue = value
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const first = iterator.throw?.(firstError)
      const second = iterator.throw?.(secondError)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(throwCalls).toBe(1)
      await expect(iterator.return?.(closeReason)).resolves.toMatchObject({
        done: true,
        value: closeReason,
      })

      await expect(first).resolves.toMatchObject({
        done: true,
        value: closeReason,
      })
      await expect(second).resolves.toMatchObject({
        done: true,
        value: closeReason,
      })
      expect(returnValue).toBe(closeReason)
      for (const release of releases)
        release({ done: false, value: {} as StreamChunk })
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "awaits delegated %s restoration cleanup before rejecting",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const restoreError = new Error(`${entrypoint} restoration failure`)
      vi.spyOn(session, "rehydrateJson").mockImplementation(() => {
        throw restoreError
      })
      const primary = new Error(`${entrypoint} delegated throw`)
      let releaseCleanup!: (result: IteratorResult<StreamChunk>) => void
      let cleanupStarted = false
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "delayed-cleanup",
                  delta: "before throw",
                } satisfies StreamChunk,
              }
            },
            async throw() {
              return {
                done: false as const,
                value: {
                  type: EventType.CUSTOM,
                  name: "structured-output.complete",
                  value: { object: { email: "protected" } },
                } as unknown as StreamChunk,
              }
            },
            return() {
              cleanupStarted = true
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                releaseCleanup = resolve
              })
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const thrown = iterator.throw?.(primary)
      for (let attempt = 0; !cleanupStarted && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(cleanupStarted).toBe(true)
      const timedOut = Symbol("timed out")
      await expect(
        Promise.race([
          thrown?.then(
            () => Symbol("settled"),
            () => Symbol("settled")
          ),
          new Promise<typeof timedOut>((resolve) =>
            setTimeout(() => resolve(timedOut), 20)
          ),
        ])
      ).resolves.toBe(timedOut)
      releaseCleanup({ done: true, value: undefined })
      await expect(thrown).rejects.toBe(restoreError)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "preserves delegated %s restoration failure over cleanup failure",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const restoreError = new Error(`${entrypoint} restoration failure`)
      const cleanupError = new Error(`${entrypoint} cleanup failure`)
      vi.spyOn(session, "rehydrateJson").mockImplementation(() => {
        throw restoreError
      })
      let rejectCleanup!: (error: unknown) => void
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "cleanup-precedence",
                  delta: "before throw",
                } satisfies StreamChunk,
              }
            },
            async throw() {
              return {
                done: false as const,
                value: {
                  type: EventType.CUSTOM,
                  name: "structured-output.complete",
                  value: { object: { email: "protected" } },
                } as unknown as StreamChunk,
              }
            },
            return() {
              return new Promise<IteratorResult<StreamChunk>>((_, reject) => {
                rejectCleanup = reject
              })
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const thrown = iterator.throw?.(new Error(`${entrypoint} primary`))
      for (let attempt = 0; !rejectCleanup && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(rejectCleanup).toBeTypeOf("function")
      rejectCleanup(cleanupError)
      await expect(thrown).rejects.toBe(restoreError)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "serializes overlapping %s delegated throws before restoring split tokens",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize("ana@acme.com"))
        .redactedText
      const splitAt = Math.floor(protectedContent.length / 2)
      const firstError = new Error(`${entrypoint} first split throw`)
      const secondError = new Error(`${entrypoint} second split throw`)
      let throwCalls = 0
      let releaseFirst!: (result: IteratorResult<StreamChunk>) => void
      let secondSettled = false
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (throwCalls > 0)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: "split-message",
                  } satisfies StreamChunk,
                }
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "split-seed",
                  delta: "seed",
                } satisfies StreamChunk,
              }
            },
            throw() {
              throwCalls += 1
              if (throwCalls === 1)
                return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                  releaseFirst = resolve
                })
              return Promise.resolve({
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "split-message",
                  delta: protectedContent.slice(splitAt),
                } satisfies StreamChunk,
              })
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const first = iterator.throw?.(firstError)
      const second = iterator.throw?.(secondError)
      void second?.then(
        () => {
          secondSettled = true
        },
        () => {
          secondSettled = true
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(throwCalls).toBe(1)
      expect(secondSettled).toBe(false)

      releaseFirst({
        done: false,
        value: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "split-message",
          delta: protectedContent.slice(0, splitAt),
        } satisfies StreamChunk,
      })
      const firstResult = await first
      const secondResult = await second
      expect(throwCalls).toBe(2)
      expect(firstResult).toMatchObject({
        done: false,
        value: { messageId: "split-message", delta: "" },
      })
      expect(secondResult).toMatchObject({
        done: false,
        value: { messageId: "split-message", delta: "" },
      })
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { messageId: "split-message", delta: "ana@acme.com" },
      })
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "keeps an earlier %s delegated terminal ahead of a later throw",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const firstError = new Error(`${entrypoint} first terminal throw`)
      const secondError = new Error(`${entrypoint} second terminal throw`)
      const terminal = {
        type: EventType.RUN_FINISHED,
        runId: "run-1",
        threadId: "thread-1",
      } satisfies StreamChunk
      let throwCalls = 0
      let releaseFirst!: (result: IteratorResult<StreamChunk>) => void
      let secondSettled = false
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "terminal-seed",
                  delta: "seed",
                } satisfies StreamChunk,
              }
            },
            throw() {
              throwCalls += 1
              if (throwCalls === 1)
                return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                  releaseFirst = resolve
                })
              return Promise.resolve({
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "late-message",
                  delta: "late",
                } satisfies StreamChunk,
              })
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const first = iterator.throw?.(firstError)
      const second = iterator.throw?.(secondError)
      void second?.then(
        () => {
          secondSettled = true
        },
        () => {
          secondSettled = true
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(throwCalls).toBe(1)
      expect(secondSettled).toBe(false)

      releaseFirst({ done: true, value: terminal })
      await expect(first).resolves.toEqual({ done: true, value: terminal })
      await expect(second).resolves.toEqual({ done: true, value: terminal })
      expect(throwCalls).toBe(1)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "delivers expanded %s throw output before a later normal throw",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize("ana@acme.com"))
        .redactedText
      let nextCalls = 0
      let throwCalls = 0
      let laterSettled = false
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls += 1
              if (nextCalls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "expanded-message",
                    delta: protectedContent,
                  } satisfies StreamChunk,
                }
              return { done: true as const, value: undefined }
            },
            throw() {
              throwCalls += 1
              if (throwCalls === 1)
                return Promise.resolve({
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: "expanded-message",
                  } satisfies StreamChunk,
                })
              return Promise.resolve({
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "later-message",
                  delta: "later",
                } satisfies StreamChunk,
              })
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const first = await iterator.throw?.(new Error(`${entrypoint} first`))
      expect(first).toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_CONTENT, delta: "ana@acme.com" },
      })
      const later = iterator.throw?.(new Error(`${entrypoint} later`))
      void later?.then(
        () => {
          laterSettled = true
        },
        () => {
          laterSettled = true
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(throwCalls).toBe(1)
      expect(laterSettled).toBe(false)
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_END },
      })
      await expect(later).resolves.toMatchObject({
        done: false,
        value: { messageId: "later-message", delta: "" },
      })
      expect(throwCalls).toBe(2)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "delivers expanded %s throw output before a later RUN_ERROR",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize("ana@acme.com"))
        .redactedText
      let nextCalls = 0
      let throwCalls = 0
      let laterSettled = false
      const runError = {
        type: EventType.RUN_ERROR,
        message: "later failed",
      } satisfies StreamChunk
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls += 1
              if (nextCalls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "expanded-error-message",
                    delta: protectedContent,
                  } satisfies StreamChunk,
                }
              return { done: true as const, value: undefined }
            },
            throw() {
              throwCalls += 1
              if (throwCalls === 1)
                return Promise.resolve({
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: "expanded-error-message",
                  } satisfies StreamChunk,
                })
              return Promise.resolve({ done: false as const, value: runError })
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      await expect(
        iterator.throw?.(new Error(`${entrypoint} first`))
      ).resolves.toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_CONTENT, delta: "ana@acme.com" },
      })
      const later = iterator.throw?.(new Error(`${entrypoint} error`))
      void later?.then(
        () => {
          laterSettled = true
        },
        () => {
          laterSettled = true
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(throwCalls).toBe(1)
      expect(laterSettled).toBe(false)
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_END },
      })
      await expect(later).resolves.toEqual({ done: false, value: runError })
      expect(throwCalls).toBe(2)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "settles concurrent %s throws after an expanded recovery without a next",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize("ana@acme.com"))
        .redactedText
      let throwCalls = 0
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "concurrent-expansion",
                  delta: protectedContent,
                } satisfies StreamChunk,
              }
            },
            async throw() {
              throwCalls += 1
              if (throwCalls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: "concurrent-expansion",
                  } satisfies StreamChunk,
                }
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "concurrent-later",
                  delta: "later",
                } satisfies StreamChunk,
              }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()

      const first = iterator.throw?.(new Error(`${entrypoint} first`))
      const second = iterator.throw?.(new Error(`${entrypoint} second`))
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({
          done: false,
          value: expect.objectContaining({
            type: EventType.TEXT_MESSAGE_CONTENT,
            delta: "ana@acme.com",
          }),
        }),
        expect.objectContaining({
          done: false,
          value: expect.objectContaining({ type: EventType.TEXT_MESSAGE_END }),
        }),
      ])
      expect(throwCalls).toBe(2)
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "concurrent-later",
          delta: "",
        },
      })
    }
  )

  it.each([
    ["connect", "run-error"],
    ["connect", "done"],
    ["joinRun", "run-error"],
    ["joinRun", "done"],
  ] as const)(
    "keeps queued expansion before a concurrent %s %s terminal",
    async (entrypoint, terminalKind) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize("ana@acme.com"))
        .redactedText
      const firstError = new Error(`${entrypoint} queued first`)
      const secondError = new Error(`${entrypoint} queued second`)
      const runError = {
        type: EventType.RUN_ERROR,
        message: `${entrypoint} queued failure`,
      } satisfies StreamChunk
      const terminal = {
        type: EventType.RUN_FINISHED,
        threadId: `${entrypoint}-thread`,
        runId: `${entrypoint}-queued`,
      } satisfies StreamChunk
      let nextCalls = 0
      let throwCalls = 0
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls += 1
              if (nextCalls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "queued-expansion",
                    delta: protectedContent,
                  } satisfies StreamChunk,
                }
              return { done: true as const, value: undefined }
            },
            async throw(value?: unknown) {
              throwCalls += 1
              if (throwCalls === 1) {
                expect(value).toBe(firstError)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: "queued-expansion",
                  } satisfies StreamChunk,
                }
              }
              expect(value).toBe(secondError)
              return terminalKind === "run-error"
                ? { done: false as const, value: runError }
                : { done: true as const, value: terminal }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()

      const first = iterator.throw!(firstError)
      const second = iterator.throw!(secondError)
      const [firstResult, secondResult] = await Promise.all([first, second])
      expect(firstResult).toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_CONTENT, delta: "ana@acme.com" },
      })
      expect(secondResult).toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_END },
      })
      expect(throwCalls).toBe(2)

      if (terminalKind === "run-error")
        await expect(iterator.next()).resolves.toEqual({
          done: false,
          value: runError,
        })
      else
        await expect(iterator.next()).resolves.toEqual({
          done: true,
          value: terminal,
        })
    }
  )

  it.each([
    ["connect", "sync", "resolve"],
    ["connect", "sync", "reject"],
    ["connect", "async", "resolve"],
    ["connect", "async", "reject"],
    ["joinRun", "sync", "resolve"],
    ["joinRun", "sync", "reject"],
    ["joinRun", "async", "resolve"],
    ["joinRun", "async", "reject"],
  ] as const)(
    "orders a concurrent %s throw %s rejection after queued output with %s cleanup",
    async (entrypoint, rejectionKind, cleanupKind) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize("ana@acme.com"))
        .redactedText
      const firstError = new Error(`${entrypoint} rejection first`)
      const secondError = new Error(`${entrypoint} rejection second`)
      let throwCalls = 0
      let returnCalls = 0
      let returnValue: unknown
      let cleanupStarted = false
      let finishCleanup!: () => void
      let failCleanup!: (error: unknown) => void
      const cleanupError = new Error(`${entrypoint} rejection cleanup`)
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (throwCalls === 0)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "queued-rejection",
                    delta: protectedContent,
                  } satisfies StreamChunk,
                }
              return { done: true as const, value: undefined }
            },
            throw(value?: unknown) {
              throwCalls += 1
              if (throwCalls === 1) {
                expect(value).toBe(firstError)
                return Promise.resolve({
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: "queued-rejection",
                  } satisfies StreamChunk,
                })
              }
              expect(value).toBe(secondError)
              if (rejectionKind === "sync") throw secondError
              return Promise.reject(secondError)
            },
            return(value?: unknown) {
              returnCalls += 1
              returnValue = value
              cleanupStarted = true
              return new Promise<IteratorResult<StreamChunk>>(
                (resolve, reject) => {
                  finishCleanup = () =>
                    resolve({ done: true as const, value: undefined })
                  failCleanup = reject
                }
              )
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()

      const first = iterator.throw!(firstError)
      const second = iterator.throw!(secondError)
      await expect(first).resolves.toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_CONTENT, delta: "ana@acme.com" },
      })
      await expect(second).resolves.toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_END },
      })
      expect(throwCalls).toBe(2)
      const pendingError = iterator.next()
      for (let attempt = 0; !cleanupStarted && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(cleanupStarted).toBe(true)
      const timedOut = Symbol("timed out")
      await expect(
        Promise.race([
          pendingError.then(
            () => Symbol("settled"),
            () => Symbol("settled")
          ),
          new Promise<typeof timedOut>((resolve) =>
            setTimeout(() => resolve(timedOut), 20)
          ),
        ])
      ).resolves.toBe(timedOut)
      if (cleanupKind === "resolve") finishCleanup()
      else failCleanup(cleanupError)
      await expect(pendingError).rejects.toBe(secondError)
      expect(returnCalls).toBe(1)
      expect(returnValue).toBe(secondError)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "orders a concurrent %s throw restoration failure after queued output",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize("ana@acme.com"))
        .redactedText
      const restoreError = new Error(`${entrypoint} concurrent restoration`)
      vi.spyOn(session, "rehydrateJson").mockImplementation(() => {
        throw restoreError
      })
      const firstError = new Error(`${entrypoint} restoration first`)
      const secondError = new Error(`${entrypoint} restoration second`)
      let throwCalls = 0
      let returnCalls = 0
      let returnValue: unknown
      let cleanupStarted = false
      let finishCleanup!: () => void
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "queued-restoration",
                  delta: protectedContent,
                } satisfies StreamChunk,
              }
            },
            async throw(value?: unknown) {
              throwCalls += 1
              if (throwCalls === 1) {
                expect(value).toBe(firstError)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: "queued-restoration",
                  } satisfies StreamChunk,
                }
              }
              expect(value).toBe(secondError)
              return {
                done: false as const,
                value: {
                  type: EventType.CUSTOM,
                  name: "structured-output.complete",
                  value: { object: { email: "protected" } },
                } as unknown as StreamChunk,
              }
            },
            async return(value?: unknown) {
              returnCalls += 1
              returnValue = value
              cleanupStarted = true
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                finishCleanup = () =>
                  resolve({ done: true as const, value: undefined })
              })
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()

      const first = iterator.throw!(firstError)
      const second = iterator.throw!(secondError)
      await expect(first).resolves.toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_CONTENT, delta: "ana@acme.com" },
      })
      await expect(second).resolves.toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_END },
      })
      expect(throwCalls).toBe(2)
      const pendingError = iterator.next()
      for (let attempt = 0; !cleanupStarted && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(cleanupStarted).toBe(true)
      const timedOut = Symbol("timed out")
      await expect(
        Promise.race([
          pendingError.then(
            () => Symbol("settled"),
            () => Symbol("settled")
          ),
          new Promise<typeof timedOut>((resolve) =>
            setTimeout(() => resolve(timedOut), 20)
          ),
        ])
      ).resolves.toBe(timedOut)
      finishCleanup()
      await expect(pendingError).rejects.toBe(restoreError)
      expect(returnCalls).toBe(1)
      expect(returnValue).toBe(restoreError)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "does not trust a spoofed recoverable %s next marker",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const marker = Symbol.for("local-pii.tanstack.recoverable-next")
      const spoofed = Object.assign(new Error(`${entrypoint} spoofed`), {
        [marker]: true,
        cause: new Error(`${entrypoint} wrong cause`),
      })
      let returnValue: unknown
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw spoofed
            },
            async return(value?: unknown) {
              returnValue = value
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()

      await expect(iterator.next()).rejects.toBe(spoofed)
      expect(returnValue).toBe(spoofed)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "does not read a hostile recoverable %s next marker",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const marker = Symbol.for("local-pii.tanstack.recoverable-next")
      const getterError = new Error(`${entrypoint} marker getter`)
      const primary = Object.defineProperty(
        new Error(`${entrypoint} primary`),
        marker,
        {
          configurable: true,
          get() {
            throw getterError
          },
        }
      )
      let returnValue: unknown
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw primary
            },
            async return(value?: unknown) {
              returnValue = value
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()

      await expect(iterator.next()).rejects.toBe(primary)
      expect(returnValue).toBe(primary)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "serializes %s throw-next-throw recovery across split output",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize("ana@acme.com"))
        .redactedText
      const firstError = new Error(`${entrypoint} first`)
      const secondError = new Error(`${entrypoint} second`)
      let nextCalls = 0
      let throwCalls = 0
      let releaseFirst!: (result: IteratorResult<StreamChunk>) => void
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls += 1
              if (nextCalls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "cross-method",
                    delta: protectedContent,
                  } satisfies StreamChunk,
                }
              return { done: true as const, value: undefined }
            },
            throw(value?: unknown) {
              expect(value).toBe(throwCalls === 0 ? firstError : secondError)
              throwCalls += 1
              if (throwCalls === 1)
                return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                  releaseFirst = resolve
                })
              return Promise.resolve({
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "after-cross-method",
                  delta: "later",
                } satisfies StreamChunk,
              })
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()

      const first = iterator.throw?.(firstError)
      const middle = iterator.next()
      const second = iterator.throw?.(secondError)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(throwCalls).toBe(1)

      releaseFirst({
        done: false,
        value: {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "cross-method",
        } satisfies StreamChunk,
      })
      await expect(first).resolves.toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_CONTENT, delta: "ana@acme.com" },
      })
      await expect(middle).resolves.toMatchObject({
        done: false,
        value: { type: EventType.TEXT_MESSAGE_END, messageId: "cross-method" },
      })
      await expect(second).resolves.toMatchObject({
        done: false,
        value: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "after-cross-method",
          delta: "",
        },
      })
      expect(throwCalls).toBe(2)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "settles a later %s throw when an earlier next exhausts",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const primary = new Error(`${entrypoint} pending throw`)
      let releaseNext!: (result: IteratorResult<StreamChunk>) => void
      let releaseThrow!: (result: IteratorResult<StreamChunk>) => void
      let returnCalls = 0
      let nextStarted = false
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextStarted = true
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                releaseNext = resolve
              })
            },
            throw(value?: unknown) {
              expect(value).toBe(primary)
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                releaseThrow = resolve
              })
            },
            async return() {
              returnCalls += 1
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      const next = iterator.next()
      for (let attempt = 0; !nextStarted && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      const throwing = iterator.throw?.(primary)
      for (
        let attempt = 0;
        releaseThrow === undefined && attempt < 20;
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(releaseThrow).toBeDefined()
      releaseNext({ done: true, value: undefined })
      await expect(next).resolves.toEqual({ done: true, value: undefined })
      await expect(throwing).resolves.toEqual({ done: true, value: undefined })
      expect(returnCalls).toBe(0)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "propagates an earlier %s next error to later controls",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const primary = new Error(`${entrypoint} pending next failure`)
      let rejectNext!: (error: unknown) => void
      let nextStarted = false
      let returnValue: unknown
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextStarted = true
              return new Promise<IteratorResult<StreamChunk>>((_, reject) => {
                rejectNext = reject
              })
            },
            throw() {
              return new Promise<IteratorResult<StreamChunk>>(() => {})
            },
            async return(value?: unknown) {
              returnValue = value
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      const next = iterator.next()
      for (let attempt = 0; !nextStarted && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      const throwing = iterator.throw?.(new Error(`${entrypoint} later`))
      rejectNext(primary)
      await expect(next).rejects.toBe(primary)
      await expect(throwing).rejects.toBe(primary)
      expect(returnValue).toBe(primary)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "ignores a late loser rejection after recoverable %s throw",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const firstError = new Error(`${entrypoint} recoverable throw`)
      const lateError = new Error(`${entrypoint} late next`)
      let nextCalls = 0
      let nextStarted = false
      let rejectFirst!: (error: unknown) => void
      let returnCalls = 0
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalls += 1
              if (nextCalls === 1) {
                nextStarted = true
                return new Promise<IteratorResult<StreamChunk>>((_, reject) => {
                  rejectFirst = reject
                })
              }
              if (nextCalls === 2)
                return Promise.resolve({
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "after-loser",
                    delta: "continues",
                  } satisfies StreamChunk,
                })
              return Promise.resolve({ done: true as const, value: undefined })
            },
            async throw(value?: unknown) {
              expect(value).toBe(firstError)
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "after-loser",
                  delta: "recovered",
                } satisfies StreamChunk,
              }
            },
            async return() {
              returnCalls += 1
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      const pending = iterator.next()
      for (let attempt = 0; !nextStarted && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      const recovered = iterator.throw?.(firstError)
      await expect(recovered).resolves.toMatchObject({
        done: false,
        value: { delta: "recovered" },
      })
      await expect(pending).rejects.toBe(firstError)

      rejectFirst(lateError)
      await new Promise((resolve) => setTimeout(resolve, 0))
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { delta: "continues" },
      })
      expect(returnCalls).toBe(0)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "ignores a late loser completion after recoverable %s throw",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const firstError = new Error(`${entrypoint} recoverable throw`)
      let nextCalls = 0
      let nextStarted = false
      let finishFirst!: (result: IteratorResult<StreamChunk>) => void
      let returnCalls = 0
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalls += 1
              if (nextCalls === 1) {
                nextStarted = true
                return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                  finishFirst = resolve
                })
              }
              if (nextCalls === 2)
                return Promise.resolve({
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "after-loser-completion",
                    delta: "continues",
                  } satisfies StreamChunk,
                })
              return Promise.resolve({ done: true as const, value: undefined })
            },
            async throw(value?: unknown) {
              expect(value).toBe(firstError)
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "after-loser-completion",
                  delta: "recovered",
                } satisfies StreamChunk,
              }
            },
            async return() {
              returnCalls += 1
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      const pending = iterator.next()
      for (let attempt = 0; !nextStarted && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      await expect(iterator.throw?.(firstError)).resolves.toMatchObject({
        done: false,
        value: { delta: "recovered" },
      })
      await expect(pending).rejects.toBe(firstError)

      finishFirst({ done: true, value: undefined })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { delta: "continues" },
      })
      expect(returnCalls).toBe(0)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "serializes outer %s throw-next-throw calls in public order",
    async (entrypoint) => {
      const original = "order@example.com"
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize(original)).redactedText
      const split = Math.floor(protectedContent.length / 2)
      const prefixError = new Error(`${entrypoint} prefix`)
      const suffixError = new Error(`${entrypoint} suffix`)
      const calls: string[] = []
      let nextCalls = 0
      let throwCalls = 0
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls += 1
              calls.push(`next${nextCalls}`)
              if (nextCalls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "outer-order",
                    delta: "",
                  } satisfies StreamChunk,
                }
              if (nextCalls === 2)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "outer-order",
                    delta: "",
                  } satisfies StreamChunk,
                }
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_END,
                  messageId: "outer-order",
                } satisfies StreamChunk,
              }
            },
            async throw(value?: unknown) {
              throwCalls += 1
              if (throwCalls === 1) {
                expect(value).toBe(prefixError)
                calls.push("throw1")
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "outer-order",
                    delta: protectedContent.slice(0, split),
                  } satisfies StreamChunk,
                }
              }
              expect(value).toBe(suffixError)
              calls.push("throw2")
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "outer-order",
                  delta: protectedContent.slice(split),
                } satisfies StreamChunk,
              }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const prefix = iterator.throw!(prefixError)
      const middle = iterator.next()
      const suffix = iterator.throw!(suffixError)
      const end = iterator.next()
      const results = await Promise.all([prefix, middle, suffix, end])
      expect(calls).toEqual(["next1", "throw1", "next2", "throw2", "next3"])
      const restored = results
        .filter(
          (result): result is IteratorResult<StreamChunk> =>
            result !== undefined && !result.done
        )
        .map((result) => {
          const chunk = result.value as Extract<
            StreamChunk,
            { type: "TEXT_MESSAGE_CONTENT" }
          >
          return chunk.type === EventType.TEXT_MESSAGE_CONTENT
            ? chunk.delta
            : ""
        })
        .join("")
      expect(restored).toContain(original)
      expect(restored).not.toContain(protectedContent)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "preserves %s next-before-throw invocation order",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const reason = new Error(`${entrypoint} same-turn throw`)
      const calls: string[] = []
      let releaseNext!: (result: IteratorResult<StreamChunk>) => void
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              calls.push("next")
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                releaseNext = resolve
              })
            },
            async throw(value?: unknown) {
              calls.push("throw")
              expect(value).toBe(reason)
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "same-turn",
                  delta: "recovered",
                } satisfies StreamChunk,
              }
            },
            async return() {
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      const pending = iterator.next()
      const recovered = iterator.throw?.(reason)
      await expect(recovered).resolves.toMatchObject({
        done: false,
        value: { delta: "recovered" },
      })
      await expect(pending).rejects.toBe(reason)
      expect(calls).toEqual(["next", "throw"])
      releaseNext({ done: true, value: undefined })
      await iterator.return?.()
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "awaits sibling %s throw failures behind shared cleanup",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const restoreError = new Error(`${entrypoint} sibling restoration`)
      vi.spyOn(session, "rehydrateJson").mockImplementation(() => {
        throw restoreError
      })
      let releaseCleanup!: (result: IteratorResult<StreamChunk>) => void
      let cleanupStarted = false
      let throwCalls = 0
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "sibling-cleanup-seed",
                  delta: "seed",
                } satisfies StreamChunk,
              }
            },
            async throw() {
              throwCalls += 1
              if (throwCalls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.CUSTOM,
                    name: "structured-output.complete",
                    value: { object: { email: "protected" } },
                  } as unknown as StreamChunk,
                }
              return new Promise<IteratorResult<StreamChunk>>(() => {})
            },
            return() {
              cleanupStarted = true
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                releaseCleanup = resolve
              })
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const first = iterator.throw?.(new Error(`${entrypoint} first`))
      const second = iterator.throw?.(new Error(`${entrypoint} second`))
      for (let attempt = 0; !cleanupStarted && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(cleanupStarted).toBe(true)
      const timedOut = Symbol("timed out")
      await expect(
        Promise.race([
          second?.then(
            () => Symbol("settled"),
            () => Symbol("settled")
          ),
          new Promise<typeof timedOut>((resolve) =>
            setTimeout(() => resolve(timedOut), 20)
          ),
        ])
      ).resolves.toBe(timedOut)
      releaseCleanup({ done: true, value: undefined })
      await expect(first).rejects.toBe(restoreError)
      await expect(second).rejects.toBe(restoreError)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "retains %s abort observation after recoverable throw preempts next",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, "addEventListener")
      const remove = vi.spyOn(controller.signal, "removeEventListener")
      const firstError = new Error(`${entrypoint} recoverable throw`)
      const secondError = new Error(`${entrypoint} second throw`)
      const abortReason = new Error(`${entrypoint} final abort`)
      let nextCalled = false
      let throwCalls = 0
      let returnValue: unknown
      let releaseSecond!: (result: IteratorResult<StreamChunk>) => void
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalled = true
              return new Promise<IteratorResult<StreamChunk>>(() => {})
            },
            async throw() {
              throwCalls += 1
              if (throwCalls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "recoverable-throw",
                    delta: "recovered",
                  } satisfies StreamChunk,
                }
              return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                releaseSecond = resolve
              })
            },
            async return(value?: unknown) {
              returnValue = value
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const stream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect(
              [{ role: "user", content: "hello" }],
              undefined,
              controller.signal
            )
          : piiConnection(inner, { session }).joinRun!(
              "run-1",
              controller.signal
            )
      const iterator = stream[Symbol.asyncIterator]()
      const pendingNext = iterator.next()
      for (let attempt = 0; !nextCalled && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(nextCalled).toBe(true)
      const recovered = iterator.throw?.(firstError)
      await expect(recovered).resolves.toMatchObject({
        done: false,
        value: { delta: "recovered" },
      })
      await expect(pendingNext).rejects.toBe(firstError)

      const second = iterator.throw?.(secondError)
      for (let attempt = 0; throwCalls < 2 && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(throwCalls).toBe(2)
      controller.abort(abortReason)
      await expect(
        Promise.race([
          second,
          new Promise((resolve) =>
            setTimeout(() => resolve(Symbol.for("timed out")), 50)
          ),
        ])
      ).rejects.toBe(abortReason)
      expect(returnValue).toBe(abortReason)
      releaseSecond({ done: false, value: {} as StreamChunk })

      const addedAbortListeners = add.mock.calls.filter(
        ([type]) => type === "abort"
      )
      for (const [, listener] of addedAbortListeners)
        expect(
          remove.mock.calls.some(
            ([type, removedListener]) =>
              type === "abort" && removedListener === listener
          )
        ).toBe(true)
    }
  )

  it("removes lazy abort listeners after completion and initialization failure", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, "addEventListener")
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    const inner: ConnectConnectionAdapter = {
      connect: () => emptyStream(),
    }
    const wrapped = piiConnection(inner, { session })
    for (let index = 0; index < 3; index += 1) {
      const iterator = wrapped
        .connect(
          [{ role: "user", content: `message-${index}` }],
          undefined,
          controller.signal
        )
        [Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toMatchObject({ done: true })
    }
    const addedAbortListeners = add.mock.calls.filter(
      ([type]) => type === "abort"
    )
    expect(addedAbortListeners).toHaveLength(6)
    for (const [, listener] of addedAbortListeners)
      expect(
        remove.mock.calls.some(
          ([type, removedListener]) =>
            type === "abort" && removedListener === listener
        )
      ).toBe(true)

    const initializationError = new Error("initialization failed")
    const failingController = new AbortController()
    const failingAdd = vi.spyOn(failingController.signal, "addEventListener")
    const failingRemove = vi.spyOn(
      failingController.signal,
      "removeEventListener"
    )
    const failing = piiConnection(
      {
        connect: () => {
          throw initializationError
        },
      },
      { session }
    )
    const failingIterator = failing
      .connect(
        [{ role: "user", content: "initialization" }],
        undefined,
        failingController.signal
      )
      [Symbol.asyncIterator]()
    await expect(failingIterator.next()).rejects.toBe(initializationError)
    const [, listener] =
      failingAdd.mock.calls.find(([type]) => type === "abort") ?? []
    expect(
      failingRemove.mock.calls.some(
        ([type, removedListener]) =>
          type === "abort" && removedListener === listener
      )
    ).toBe(true)
  })

  it.each(["connect", "joinRun"] as const)(
    "settles promptly when a native async generator ignores abort through %s",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const controller = new AbortController()
      const abortReason = new Error(`${entrypoint} native abort`)
      let release!: () => void
      let returnCalls = 0
      let entered = false
      const source = (async function* () {
        try {
          entered = true
          await new Promise<void>((resolve) => {
            release = resolve
          })
          yield {
            type: EventType.RUN_FINISHED,
            runId: "run-1",
            threadId: "thread-1",
          } satisfies StreamChunk
        } finally {
          returnCalls += 1
        }
      })()
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const wrappedStream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect(
              [{ role: "user", content: "hello" }],
              undefined,
              controller.signal
            )
          : piiConnection(inner, { session }).joinRun!(
              "run-1",
              controller.signal
            )
      const iterator = wrappedStream[Symbol.asyncIterator]()
      const pending = iterator.next()
      for (let attempt = 0; !entered && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(entered).toBe(true)
      const observed = pending.catch((error: unknown) => error)
      controller.abort(abortReason)

      await expect(
        Promise.race([
          observed,
          new Promise((resolve) =>
            setTimeout(() => resolve(Symbol.for("timed out")), 50)
          ),
        ])
      ).resolves.toBe(abortReason)

      release()
      for (let attempt = 0; returnCalls === 0 && attempt < 20; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      expect(returnCalls).toBe(1)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "forwards the caller's exact return reason upstream through %s",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const callerReason = `${entrypoint} caller return`
      let returnValue: unknown
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          let yielded = false
          return {
            async next() {
              if (yielded) return { done: true as const, value: undefined }
              yielded = true
              return {
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "return-reason",
                  delta: "first",
                } satisfies StreamChunk,
              }
            },
            async return(value?: unknown) {
              returnValue = value
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const wrappedStream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = wrappedStream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toMatchObject({ done: false })
      await expect(iterator.return?.(callerReason)).resolves.toMatchObject({
        done: true,
      })
      expect(returnValue).toBe(callerReason)
    }
  )

  it("clears buffered state before early return cleanup can resume a pending next", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const protectedContent = (await session.anonymize("ana@acme.com"))
      .redactedText
    let resolvePending!: (result: IteratorResult<StreamChunk>) => void
    let pendingNext = false
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        let calls = 0
        return {
          next() {
            calls += 1
            if (calls === 1)
              return Promise.resolve({
                done: false as const,
                value: {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "early-return",
                  delta: protectedContent.slice(0, 8),
                } satisfies StreamChunk,
              })
            pendingNext = true
            return new Promise<IteratorResult<StreamChunk>>((resolve) => {
              resolvePending = resolve
            })
          },
          async return(value?: unknown) {
            expect(value).toBe("caller")
            resolvePending({
              done: false,
              value: {
                type: EventType.TEXT_MESSAGE_END,
                messageId: "early-return",
              } satisfies StreamChunk,
            })
            return { done: true as const, value: undefined }
          },
        }
      },
    }
    const iterator = piiConnection({ connect: () => source }, { session })
      .connect([{ role: "user", content: "hello" }])
      [Symbol.asyncIterator]()

    await iterator.next()
    const pending = iterator.next()
    for (let attempt = 0; !pendingNext && attempt < 20; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pendingNext).toBe(true)
    const closing = iterator.return?.("caller")
    await session.anonymize("mutation-after-return@example.net")
    await expect(closing).resolves.toMatchObject({
      done: true,
      value: "caller",
    })
    await expect(pending).resolves.toMatchObject({ done: true })
  })

  it.each(["connect", "joinRun"] as const)(
    "discards buffered tool arguments after RUN_ERROR through %s",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedContent = (await session.anonymize("ana@acme.com"))
        .redactedText
      const source = (async function* () {
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "discarded-tool",
          delta: protectedContent,
        } satisfies StreamChunk
        yield {
          type: EventType.RUN_ERROR,
          message: "retry this run",
        } satisfies StreamChunk
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "later-tool",
          delta: protectedContent,
        } satisfies StreamChunk
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId: "later-tool",
          toolCallName: "lookup",
        } satisfies StreamChunk
      })()
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const chunks = await collect(
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      )

      expect(
        chunks.some(
          (chunk) =>
            chunk.type === EventType.TOOL_CALL_ARGS &&
            chunk.toolCallId === "discarded-tool" &&
            chunk.delta !== ""
        )
      ).toBe(false)
      expect(
        chunks.find(
          (chunk) =>
            chunk.type === EventType.TOOL_CALL_ARGS &&
            chunk.toolCallId === "later-tool" &&
            chunk.delta !== ""
        )
      ).toBeUndefined()
      expect(chunks).toContainEqual({
        type: EventType.RUN_ERROR,
        message: "retry this run",
      })
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "restores pinned CUSTOM payloads immutably through %s",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const objectPlaceholder = (await session.anonymize("ana@acme.com"))
        .redactedText
      const rawPlaceholder = (await session.anonymize("bob@example.net"))
        .redactedText
      const reasoningPlaceholder = (await session.anonymize("reason for Ana"))
        .redactedText
      const inputPlaceholder = (await session.anonymize("tool@acme.com"))
        .redactedText
      const originalChunks = [
        {
          type: EventType.CUSTOM,
          name: "structured-output.complete",
          value: {
            object: {
              owner: objectPlaceholder,
              nested: { value: rawPlaceholder },
            },
            raw: JSON.stringify({ email: rawPlaceholder }),
            reasoning: reasoningPlaceholder,
          },
          threadId: "thread-control",
          runId: "run-control",
        },
        {
          type: EventType.CUSTOM,
          name: "tool-input-available",
          value: {
            toolCallId: "tool-1",
            toolName: "lookup",
            input: { email: inputPlaceholder },
          },
          approvalId: "control-1",
        },
        {
          type: EventType.CUSTOM,
          name: "approval-requested",
          value: {
            toolCallId: "tool-2",
            toolName: "lookup",
            input: { email: inputPlaceholder },
            approval: { id: "approval-1", needsApproval: true },
          },
          approvalId: "control-2",
        },
      ] as unknown as Array<StreamChunk>
      const before = structuredClone(originalChunks)
      const source = (async function* () {
        for (const chunk of originalChunks) yield chunk
      })()
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const chunks = await collect(
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      )

      const complete = chunks[0] as Extract<StreamChunk, { type: "CUSTOM" }>
      expect(complete.value).toMatchObject({
        object: {
          owner: "ana@acme.com",
          nested: { value: "bob@example.net" },
        },
        raw: JSON.stringify({ email: "bob@example.net" }),
        reasoning: "reason for Ana",
      })
      expect(
        (chunks[1] as Extract<StreamChunk, { type: "CUSTOM" }>).value
      ).toMatchObject({
        input: { email: "tool@acme.com" },
      })
      expect(
        (chunks[2] as Extract<StreamChunk, { type: "CUSTOM" }>).value
      ).toMatchObject({
        input: { email: "tool@acme.com" },
      })
      expect(originalChunks).toEqual(before)
    }
  )

  it("keeps the authoritative structured object when raw JSON is malformed", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const placeholder = (await session.anonymize("ana@acme.com")).redactedText
    const chunk = {
      type: EventType.CUSTOM,
      name: "structured-output.complete",
      value: {
        object: { email: placeholder },
        raw: `{ "email": "${placeholder}`,
        reasoning: `thinking about ${placeholder}`,
      },
    } as unknown as StreamChunk
    const inner: ConnectConnectionAdapter = {
      connect: () =>
        (async function* () {
          yield chunk
        })(),
    }

    const [restored] = await collect(
      piiConnection(inner, { session }).connect([
        { role: "user", content: "hello" },
      ])
    )
    expect(
      (restored as Extract<StreamChunk, { type: "CUSTOM" }>).value
    ).toEqual({
      object: { email: "ana@acme.com" },
      raw: '{ "email": "ana@acme.com',
      reasoning: "thinking about ana@acme.com",
    })
  })

  it.each(["connect", "joinRun"] as const)(
    "preserves primary %s failure when upstream cleanup also fails",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const primary = new Error(`${entrypoint} primary`)
      const cleanup = new Error(`${entrypoint} cleanup`)
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          let calls = 0
          return {
            async next() {
              calls += 1
              if (calls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "message-1",
                    delta: "safe",
                  } satisfies StreamChunk,
                }
              throw primary
            },
            async return() {
              throw cleanup
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const wrappedStream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = wrappedStream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toMatchObject({ done: false })
      await expect(iterator.next()).rejects.toBe(primary)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "surfaces cleanup failure after successful %s terminal delivery",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const cleanup = new Error(`${entrypoint} cleanup`)
      const terminal = {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-1",
      } satisfies StreamChunk
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: false as const, value: terminal }
            },
            async return() {
              throw cleanup
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const wrappedStream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")

      const iterator = wrappedStream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: terminal,
      })
      await expect(iterator.return?.()).rejects.toBe(cleanup)
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "does not replace protocol failure with cleanup failure through %s",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const cleanup = new Error(`${entrypoint} cleanup`)
      const terminal = {
        type: EventType.RUN_ERROR,
        message: "provider failed",
      } satisfies StreamChunk
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          let called = false
          return {
            async next() {
              if (!called) {
                called = true
                return { done: false as const, value: terminal }
              }
              return { done: true as const, value: undefined }
            },
            async return() {
              throw cleanup
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const wrappedStream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")

      await expect(collect(wrappedStream)).resolves.toEqual([terminal])
    }
  )

  it.each(["connect", "joinRun"] as const)(
    "awaits upstream cleanup on early iterator return through %s",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      let closed = false
      const source: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          let calls = 0
          return {
            async next() {
              calls += 1
              if (calls === 1)
                return {
                  done: false as const,
                  value: {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: "message-1",
                    delta: "prefix",
                  } satisfies StreamChunk,
                }
              return new Promise<IteratorResult<StreamChunk>>(() => {})
            },
            async return() {
              closed = true
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      const inner: ConnectConnectionAdapter = {
        connect: () => source,
        joinRun: () => source,
      }
      const wrappedStream =
        entrypoint === "connect"
          ? piiConnection(inner, { session }).connect([
              { role: "user", content: "hello" },
            ])
          : piiConnection(inner, { session }).joinRun!("run-1")
      const iterator = wrappedStream[Symbol.asyncIterator]()

      await iterator.next()
      await iterator.return?.()

      expect(closed).toBe(true)
    }
  )

  it("restores joined runs only through the same live privacy session", async () => {
    const original = "ana@acme.com"
    const liveSession = createAnonymizer({
      placeholders: token(),
    }).createSession()
    const protectedContent = (await liveSession.anonymize(original))
      .redactedText
    const placeholder = protectedContent.match(TOKEN)?.[0]
    expect(placeholder).toBeDefined()
    const source = () =>
      (async function* () {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "joined-message",
          delta: `${placeholder!.slice(0, 4)}`,
        } satisfies StreamChunk
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "joined-message",
          delta: placeholder!.slice(4),
        } satisfies StreamChunk
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "joined-message",
        } satisfies StreamChunk
      })()
    const inner: ConnectConnectionAdapter = {
      connect: () => emptyStream(),
      joinRun: () => source(),
    }

    const restored = await collect(
      piiConnection(inner, { session: liveSession }).joinRun!("run-1")
    )
    const newSession = createAnonymizer({
      placeholders: token(),
    }).createSession()
    const unresolved = await collect(
      piiConnection(inner, { session: newSession }).joinRun!("run-1")
    )

    expect(
      restored
        .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((chunk) => chunk.delta)
        .join("")
    ).toBe(original)
    expect(
      unresolved
        .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((chunk) => chunk.delta)
        .join("")
    ).toBe(placeholder)
  })

  it.each(["connect", "joinRun"] as const)(
    "rejects pre-aborted %s before acquiring the upstream stream",
    async (entrypoint) => {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const controller = new AbortController()
      const reason = new Error(`${entrypoint} pre-abort`)
      controller.abort(reason)
      const connect = vi.fn(() => emptyStream())
      const joinRun = vi.fn(() => emptyStream())
      const inner: ConnectConnectionAdapter = { connect, joinRun }
      const wrapped = piiConnection(inner, { session })
      const stream =
        entrypoint === "connect"
          ? wrapped.connect(
              [{ role: "user", content: "hello" }],
              undefined,
              controller.signal
            )
          : wrapped.joinRun!("run-1", controller.signal)

      await expect(collect(stream)).rejects.toBe(reason)
      expect(connect).not.toHaveBeenCalled()
      expect(joinRun).not.toHaveBeenCalled()
    }
  )

  it("restores every complete tool value and textual tool error", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const input = (await session.anonymize("ana@acme.com")).redactedText
    const output = (await session.anonymize("bob@example.net")).redactedText
    const metadata = { source: "control" }
    const originalEnd = {
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-complete",
      toolCallName: "lookup",
      id: "end-id",
      metadata,
      input: { request: { email: input } },
      output: { owner: output },
      result: JSON.stringify({ message: `failed for ${input}` }),
    } as unknown as StreamChunk
    const inner: ConnectConnectionAdapter = {
      connect: () =>
        (async function* () {
          yield originalEnd
          yield {
            type: EventType.TOOL_CALL_RESULT,
            messageId: "message-a",
            toolCallId: "tool-complete",
            content: `tool failed for ${output}`,
          } satisfies StreamChunk
          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId: "tool-parsed-result",
            toolCallName: "lookup",
            result: { nested: { owner: input } },
          } as unknown as StreamChunk
        })(),
    }

    const chunks = await collect(
      piiConnection(inner, { session }).connect([
        { role: "user", content: "Run lookup" },
      ])
    )
    const end = chunks.find(
      (chunk) => chunk.type === EventType.TOOL_CALL_END
    ) as Extract<StreamChunk, { type: "TOOL_CALL_END" }>
    const error = chunks.find(
      (chunk) => chunk.type === EventType.TOOL_CALL_RESULT
    ) as Extract<StreamChunk, { type: "TOOL_CALL_RESULT" }>

    expect(end.input).toEqual({ request: { email: "ana@acme.com" } })
    expect(end.output).toEqual({ owner: "bob@example.net" })
    expect(JSON.parse(end.result as string)).toEqual({
      message: "failed for ana@acme.com",
    })
    expect(error.content).toBe("tool failed for bob@example.net")
    const parsedResult = chunks.find(
      (chunk) =>
        chunk.type === EventType.TOOL_CALL_END &&
        chunk.toolCallId === "tool-parsed-result"
    ) as Extract<StreamChunk, { type: "TOOL_CALL_END" }>
    expect(parsedResult.result).toEqual({
      nested: { owner: "ana@acme.com" },
    })
    expect(end.toolCallId).toBe("tool-complete")
    expect((end as unknown as { metadata: unknown }).metadata).toBe(metadata)
  })

  it("preserves pinned non-text tool-result content parts by identity", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const imagePart = {
      type: "image",
      source: { type: "url", value: "https://cdn.example/image.png" },
      metadata: { detail: "high", control: "must-stay" },
    }
    const audioPart = {
      type: "audio",
      source: { type: "data", value: "BASE64", mimeType: "audio/wav" },
      metadata: { sampleRate: 44100 },
    }
    const videoPart = {
      type: "video",
      source: { type: "url", value: "https://cdn.example/video.mp4" },
      metadata: { duration: 3 },
    }
    const documentPart = {
      type: "document",
      source: { type: "url", value: "https://cdn.example/file.pdf" },
      metadata: { mediaType: "application/pdf" },
    }
    const result = [imagePart, audioPart, videoPart, documentPart]
    const end = {
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-media",
      toolCallName: "inspect",
      result,
    } as unknown as StreamChunk
    const inner: ConnectConnectionAdapter = {
      connect: () =>
        (async function* () {
          yield end
        })(),
    }

    const [restored] = await collect(
      piiConnection(inner, { session }).connect([
        { role: "user", content: "Inspect media" },
      ])
    )
    const restoredResult = (
      restored as Extract<StreamChunk, { type: "TOOL_CALL_END" }>
    ).result as unknown[]
    expect(restoredResult).toEqual(result)
    expect(restoredResult[0]).toBe(imagePart)
    expect(restoredResult[1]).toBe(audioPart)
    expect(restoredResult[2]).toBe(videoPart)
    expect(restoredResult[3]).toBe(documentPart)
  })
})
