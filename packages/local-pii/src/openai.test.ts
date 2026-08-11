import { describe, expect, it } from "vitest"
import { createAnonymizer } from "./anonymizer"
import { protectOpenAIMessages } from "./openai-content"
import { createPiiChat, withPiiOpenAI, type ChatMessage } from "./openai"
import { sequential } from "./placeholder/strategies"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child)
  }
  return value
}

interface TestWithResponse<T> {
  data: T
  response: object
  request_id: string
  [key: string]: unknown
}

type TestApiPromise<T> = Promise<T> & {
  asResponse(): Promise<object>
  withResponse(): Promise<TestWithResponse<T>>
}

function testApiPromise<T>(value: T, response: object): TestApiPromise<T> {
  const promise = Promise.resolve(value)
  return Object.assign(promise, {
    asResponse: async () => response,
    withResponse: async () => ({
      data: value,
      response,
      request_id: "request-1",
      envelopeControl: "preserved",
    }),
  }) as TestApiPromise<T>
}

describe("createPiiChat (tool-call cycle)", () => {
  it("retains the original message array when no semantic field changes", async () => {
    const chat = createPiiChat()
    const messages = [{ role: "assistant", content: "nothing private" }]
    const protectedMessages = await protectOpenAIMessages(
      chat.session,
      messages
    )
    expect(protectedMessages).toBe(messages)
  })

  it("redacts content, restores it, and never leaks the raw value", async () => {
    const chat = createPiiChat()
    const [system, user] = await chat.anonymizeMessages([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "look up ana@acme.com please" },
    ])
    expect(system!.content).toBe("You are helpful.")
    expect(user!.content).not.toContain("ana@acme.com")
    const placeholder = Object.keys(chat.mapping)[0]!
    expect(user!.content).toContain(placeholder)
    expect(chat.rehydrateText(user!.content!)).toBe(
      "look up ana@acme.com please"
    )
  })

  it("rehydrates placeholders inside tool-call argument JSON (keeping it valid)", async () => {
    const chat = createPiiChat()
    await chat.anonymizeMessages([
      { role: "user", content: "email ana@acme.com" },
    ])
    const placeholder = Object.keys(chat.mapping)[0]!

    // The model replies with a tool call whose JSON args reference the placeholder.
    const assistant: ChatMessage = {
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "lookup",
            arguments: JSON.stringify({ email: placeholder }),
          },
        },
      ],
    }
    const restored = chat.rehydrateMessage(assistant)
    const args = JSON.parse(restored.tool_calls![0]!.function.arguments)
    expect(args.email).toBe("ana@acme.com") // real value, to actually run the tool
  })

  it("keeps the placeholder stable when a tool RESULT re-introduces the same PII", async () => {
    const chat = createPiiChat()
    await chat.anonymizeMessages([
      { role: "user", content: "look up ana@acme.com" },
    ])
    const placeholder = Object.keys(chat.mapping)[0]!

    // Our backend tool returns real PII; it must be redacted with the SAME vault.
    const [toolMsg] = await chat.anonymizeMessages([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "found ana@acme.com in the CRM",
      },
    ])
    expect(toolMsg!.content).toContain(placeholder)
    expect(toolMsg!.content).not.toContain("ana@acme.com")
  })
})

class PrivateCompletions {
  #secret = "private-completions"
  parseBody: Record<string, unknown> | undefined
  parseOptions: object | undefined
  streamCalls = 0
  runToolsCalls = 0

  create(body: Record<string, unknown>, options?: object) {
    return this.parse(body, options)
  }

  parse(body: Record<string, unknown>, options?: object) {
    this.parseBody = body
    this.parseOptions = options
    const content = (body.messages as ChatMessage[])[0]!.content as string
    return testApiPromise(
      { choices: [{ message: { role: "assistant", content } }] },
      { status: 200 }
    )
  }

  stream(body: Record<string, unknown>) {
    void body
    this.streamCalls++
    return undefined
  }

  runTools(body: Record<string, unknown>) {
    void body
    this.runToolsCalls++
    return undefined
  }

  privateValue() {
    return this.#secret
  }
}

class SurfaceStream implements AsyncIterable<unknown> {
  #secret = "private-stream"
  readonly controller = { state: "active" }
  readonly chunks: unknown[]
  rawReadableCalls = 0

  constructor(chunks: unknown[]) {
    this.chunks = chunks
  }

  privateValue() {
    return this.#secret
  }

  [Symbol.asyncIterator]() {
    let index = 0
    return {
      next: async () =>
        index < this.chunks.length
          ? { done: false, value: this.chunks[index++] }
          : { done: true, value: undefined },
    }
  }

  tee() {
    return [new SurfaceStream(this.chunks), new SurfaceStream(this.chunks)]
  }

  toReadableStream(): ReadableStream<Uint8Array> {
    this.rawReadableCalls++
    throw new Error("raw stream helper must not bypass restoration")
  }
}

describe("withPiiOpenAI client surface compatibility", () => {
  it("protects parse, preserves options, and binds delegated private methods", async () => {
    const completions = new PrivateCompletions()
    const client = { chat: { completions } }
    const wrapped = withPiiOpenAI(client)
    const options = { headers: { "x-test": "preserved" }, timeout: 123 }
    const restored = (await wrapped.chat.completions.parse(
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "email ana@acme.com" }],
      },
      options
    )) as { choices: Array<{ message: ChatMessage }> }
    expect(completions.parseOptions).toBe(options)
    expect(completions.parseBody!.messages).toBeDefined()
    expect(
      (completions.parseBody!.messages as ChatMessage[])[0]!.content
    ).not.toContain("ana@acme.com")
    expect(restored.choices[0]!.message.content).toBe("email ana@acme.com")
    expect(wrapped.chat.completions.privateValue()).toBe("private-completions")
  })

  it("fails closed for raw stream and runTools helpers", () => {
    const completions = new PrivateCompletions()
    const wrapped = withPiiOpenAI({ chat: { completions } })
    expect(() =>
      wrapped.chat.completions.stream({
        model: "gpt-test",
        messages: [{ role: "user", content: "email ana@acme.com" }],
      })
    ).toThrow(/completions\.create/i)
    expect(() =>
      wrapped.chat.completions.runTools({
        model: "gpt-test",
        messages: [{ role: "user", content: "email ana@acme.com" }],
      })
    ).toThrow(/completions\.create/i)
    expect(completions.streamCalls).toBe(0)
    expect(completions.runToolsCalls).toBe(0)
  })

  it("forwards RequestOptions by identity and honors its signal", async () => {
    let providerCalls = 0
    let providerOptions: unknown
    const client = {
      chat: {
        completions: {
          create: (body: Record<string, unknown>, options?: unknown) => {
            providerCalls++
            providerOptions = options
            return { choices: [], body }
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const options = {
      headers: { "x-request": "preserved" },
      timeout: 321,
    }
    await wrapped.chat.completions.create(
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "email ana@acme.com" }],
      },
      options
    )
    expect(providerOptions).toBe(options)

    const reason = new Error("options cancelled")
    const signalController = new AbortController()
    signalController.abort(reason)
    await expect(
      wrapped.chat.completions.create(
        {
          model: "gpt-test",
          messages: [{ role: "user", content: "email ana@acme.com" }],
        },
        { ...options, signal: signalController.signal }
      )
    ).rejects.toBe(reason)
    expect(providerCalls).toBe(1)
  })

  it("preserves APIPromise helpers and restores withResponse data", async () => {
    const response = { status: 201, request_id: "raw-request" }
    let rawPromise: TestApiPromise<unknown> | undefined
    const client = {
      chat: {
        completions: {
          create: (params: Record<string, unknown>, options?: object) => {
            void options
            const protectedContent = (params.messages as ChatMessage[])[0]!
              .content as string
            rawPromise = testApiPromise(
              {
                choices: [
                  { message: { role: "assistant", content: protectedContent } },
                ],
              },
              response
            )
            return rawPromise
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const options = { headers: { "x-request": "value" } }
    const result = wrapped.chat.completions.create(
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "email ana@acme.com" }],
      },
      options
    ) as TestApiPromise<{
      choices: Array<{ message: ChatMessage }>
    }>
    expect(typeof result.then).toBe("function")
    expect(typeof result.asResponse).toBe("function")
    expect(typeof result.withResponse).toBe("function")
    expect(await result).toMatchObject({
      choices: [{ message: { content: "email ana@acme.com" } }],
    })
    expect(await result.asResponse()).toBe(response)
    const envelope = await result.withResponse()
    expect(envelope.response).toBe(response)
    expect(envelope.request_id).toBe("request-1")
    expect(envelope.envelopeControl).toBe("preserved")
    expect(envelope.data.choices[0]!.message.content).toBe("email ana@acme.com")
    expect(rawPromise).toBeDefined()
  })

  it("preserves stream surfaces while wrapping tee and readable-stream output", async () => {
    let rawStream: SurfaceStream | undefined
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const placeholder = (
              (params.messages as ChatMessage[])[0]!.content as string
            ).match(TOKEN)![0]
            rawStream = new SurfaceStream([
              { choices: [{ index: 0, delta: { content: placeholder } }] },
            ])
            return rawStream
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "email ana@acme.com" }],
    })) as SurfaceStream & AsyncIterable<unknown>
    expect(stream.controller).toBe(rawStream!.controller)
    expect(stream.privateValue()).toBe("private-stream")
    const tee = stream.tee()
    expect(tee).toHaveLength(2)
    for (const branch of tee) {
      let restored = ""
      for await (const chunk of branch as AsyncIterable<{
        choices?: Array<{ delta?: { content?: string } }>
      }>)
        restored += chunk.choices?.[0]?.delta?.content ?? ""
      expect(restored).toBe("ana@acme.com")
    }
    const readable = stream.toReadableStream()
    const reader = readable.getReader()
    const lines: unknown[] = []
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const text = new TextDecoder().decode(next.value)
      expect(text.endsWith("\n")).toBe(true)
      lines.push(JSON.parse(text.trim()))
    }
    expect(lines).toContainEqual({
      choices: [{ index: 0, delta: { content: "ana@acme.com" } }],
    })
    expect(rawStream!.rawReadableCalls).toBe(0)
  })
})

describe("withPiiOpenAI (full tool loop + leak sweep)", () => {
  it("protects only semantic message fields while preserving frozen input and controls", async () => {
    const captured: Array<Record<string, unknown>> = []
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            captured.push(params)
            return {
              id: "completion-1",
              choices: [],
              custom: { untouched: true },
            }
          },
        },
      },
    }
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "email ana@acme.com",
        name: "ana@acme.com",
        metadata: { trace: "ana@acme.com" },
        control: "ana@acme.com",
        tool_calls: [
          {
            id: "ana@acme.com",
            type: "ana@acme.com",
            function: {
              name: "ana@acme.com",
              arguments: JSON.stringify({ email: "ana@acme.com", keep: 1 }),
            },
            metadata: { control: "ana@acme.com" },
          },
        ],
      },
    ]
    const params = deepFreeze({
      model: "gpt-test",
      messages,
      tools: [
        {
          type: "ana@acme.com",
          function: {
            name: "ana@acme.com",
            parameters: { example: "ana@acme.com" },
          },
          unknown: { value: "ana@acme.com" },
        },
      ],
      metadata: { request: "ana@acme.com" },
      unknownOption: "ana@acme.com",
      stream: false,
      signal: undefined,
    })

    const wrapped = withPiiOpenAI(client)
    await wrapped.chat.completions.create(params)

    expect(messages[0]!.content).toBe("email ana@acme.com")
    expect(messages[0]!.tool_calls![0]!.function.arguments).toContain(
      "ana@acme.com"
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]!.model).toBe("gpt-test")
    expect(captured[0]!.tools).toBe(params.tools)
    expect(captured[0]!.metadata).toBe(params.metadata)
    const sent = captured[0]!.messages as ChatMessage[]
    expect(sent[0]!.role).toBe("user")
    expect(sent[0]!.name).toBe("ana@acme.com")
    expect(sent[0]!.metadata).toEqual({ trace: "ana@acme.com" })
    expect(sent[0]!.control).toBe("ana@acme.com")
    expect(sent[0]!.content).not.toContain("ana@acme.com")
    expect(sent[0]!.tool_calls![0]!.id).toBe("ana@acme.com")
    expect(sent[0]!.tool_calls![0]!.type).toBe("ana@acme.com")
    expect(sent[0]!.tool_calls![0]!.metadata).toEqual({
      control: "ana@acme.com",
    })
    expect(sent[0]!.tool_calls![0]!.function.name).toBe("ana@acme.com")
    expect(sent[0]!.tool_calls![0]!.function.arguments).not.toContain(
      "ana@acme.com"
    )
    expect(captured[0]!.tools).toBe(params.tools)
    expect(captured[0]!.metadata).toBe(params.metadata)
    expect(captured[0]!.unknownOption).toBe("ana@acme.com")
    expect(
      (captured[0]!.tools as Array<Record<string, unknown>>)[0]!.unknown
    ).toEqual({
      value: "ana@acme.com",
    })
  })

  it("restores complete messages without mutating response objects or siblings", async () => {
    const response = {
      id: "completion-2",
      choices: [
        {
          index: 0,
          finish_reason: "ana@acme.com",
          message: {
            role: "assistant",
            content: "Contact ana@acme.com",
            name: "ana@acme.com",
            metadata: { message: "ana@acme.com" },
            control: "ana@acme.com",
            tool_calls: [
              {
                id: "ana@acme.com",
                type: "ana@acme.com",
                function: {
                  name: "ana@acme.com",
                  arguments: JSON.stringify({ email: "ana@acme.com" }),
                },
                custom: { preserve: "ana@acme.com" },
              },
            ],
            custom: { preserve: "ana@acme.com" },
          },
          custom: { preserve: "ana@acme.com" },
        },
      ],
      usage: { total_tokens: 12, metadata: "ana@acme.com" },
      custom: { preserve: "ana@acme.com" },
    }
    let providerSnapshot: typeof response | undefined
    let choicesReference: typeof response.choices | undefined
    let messageReference: (typeof response.choices)[0]["message"] | undefined
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const protectedContent = (params.messages as ChatMessage[])[0]!
              .content as string
            const placeholder = protectedContent.match(TOKEN)![0]
            response.choices[0]!.message.content = `Contact ${placeholder}`
            response.choices[0]!.message.tool_calls![0]!.function.arguments =
              JSON.stringify({ email: placeholder })
            choicesReference = response.choices
            messageReference = response.choices[0]!.message
            providerSnapshot = structuredClone(response)
            return response
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const restored = (await wrapped.chat.completions.create({
      model: "gpt-test",
      messages: [{ role: "user", content: "email ana@acme.com" }],
    })) as typeof response

    expect(restored.choices[0]!.message.content).toBe("Contact ana@acme.com")
    expect(
      JSON.parse(
        restored.choices[0]!.message.tool_calls![0]!.function.arguments
      )
    ).toEqual({
      email: "ana@acme.com",
    })
    expect(restored.choices[0]!.finish_reason).toBe("ana@acme.com")
    expect(restored.choices[0]!.custom).toEqual({ preserve: "ana@acme.com" })
    expect(restored.choices[0]!.message.name).toBe("ana@acme.com")
    expect(restored.choices[0]!.message.metadata).toEqual({
      message: "ana@acme.com",
    })
    expect(restored.choices[0]!.message.control).toBe("ana@acme.com")
    expect(restored.choices[0]!.message.tool_calls![0]!.id).toBe("ana@acme.com")
    expect(restored.choices[0]!.message.tool_calls![0]!.type).toBe(
      "ana@acme.com"
    )
    expect(restored.choices[0]!.message.tool_calls![0]!.function.name).toBe(
      "ana@acme.com"
    )
    expect(restored.choices[0]!.message.tool_calls![0]!.custom).toEqual({
      preserve: "ana@acme.com",
    })
    expect(restored.choices[0]!.message.custom).toEqual({
      preserve: "ana@acme.com",
    })
    expect(restored.usage).toEqual({
      total_tokens: 12,
      metadata: "ana@acme.com",
    })
    expect(restored.custom).toEqual({ preserve: "ana@acme.com" })
    expect(providerSnapshot).toBeDefined()
    expect(response).toEqual(providerSnapshot)
    expect(response.choices).toBe(choicesReference)
    expect(response.choices[0]!.message).toBe(messageReference)
    expect(response.choices[0]!.message.content).toMatch(TOKEN)
    expect(
      response.choices[0]!.message.tool_calls![0]!.function.arguments
    ).toMatch(TOKEN)
  })

  it("falls back to lenient text restoration for invalid tool JSON", async () => {
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const protectedContent = (params.messages as ChatMessage[])[0]!
              .content as string
            const placeholder = protectedContent.match(TOKEN)![0]
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "call-invalid",
                        type: "function",
                        function: {
                          name: "lookup",
                          arguments: `lookup ${placeholder}`,
                        },
                      },
                    ],
                  },
                },
              ],
            }
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const restored = (await wrapped.chat.completions.create({
      model: "gpt-test",
      messages: [{ role: "user", content: "email ana@acme.com" }],
    })) as { choices: Array<{ message: ChatMessage }> }
    expect(
      restored.choices[0]!.message.tool_calls![0]!.function.arguments
    ).toBe("lookup ana@acme.com")
  })

  it("restores complete tool JSON values without rewriting untouched lexemes", async () => {
    const privateValue = 'Alice "Ace"\\line\nnext'
    const anonymizer = createAnonymizer({
      detectors: "none",
      dictionary: [{ value: privateValue }],
      placeholders: sequential(),
    })
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const protectedContent = (params.messages as ChatMessage[])[0]!
              .content as string
            const placeholder = protectedContent.match(/\[[A-Z_]+_\d+\]/)![0]
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "call-lexemes",
                        type: "function",
                        function: {
                          name: "lookup",
                          arguments: `{  "big":9007199254740993, "name" : "${placeholder}", "untouched": "raw" }`,
                        },
                      },
                    ],
                  },
                },
              ],
            }
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client, { anonymizer })
    const restored = (await wrapped.chat.completions.create({
      model: "gpt-test",
      messages: [{ role: "user", content: privateValue }],
    })) as { choices: Array<{ message: ChatMessage }> }
    const argumentsValue =
      restored.choices[0]!.message.tool_calls![0]!.function.arguments
    expect(argumentsValue).toBe(
      `{  "big":9007199254740993, "name" : ${JSON.stringify(privateValue)}, "untouched": "raw" }`
    )
    expect(JSON.parse(argumentsValue).name).toBe(privateValue)
    expect(argumentsValue).toContain("9007199254740993")
  })

  it("JSON-escapes restored values in incremental tool channels", async () => {
    const privateValue = 'Alice "Ace"\\line\nnext'
    const anonymizer = createAnonymizer({
      detectors: "none",
      dictionary: [{ value: privateValue }],
      placeholders: sequential(),
    })
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const protectedContent = (params.messages as ChatMessage[])[0]!
              .content as string
            const placeholder = protectedContent.match(/\[[A-Z_]+_\d+\]/)![0]
            const argument = JSON.stringify({
              name: placeholder,
              note: "progressive prefix",
            })
            async function* source() {
              for (const character of argument)
                yield {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            function: { arguments: character },
                          },
                        ],
                      },
                    },
                  ],
                }
            }
            return source()
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client, { anonymizer })
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: privateValue }],
    })) as AsyncIterable<{
      choices?: Array<{
        delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> }
      }>
    }>
    let argumentsValue = ""
    for await (const chunk of stream)
      argumentsValue +=
        chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? ""
    expect(JSON.parse(argumentsValue).name).toBe(privateValue)
  })

  it("restores interleaved text and tool channels independently at every split boundary", async () => {
    let placeholderSeen = ""
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const placeholder = (
              (params.messages as ChatMessage[])[0]!.content as string
            ).match(TOKEN)![0]
            placeholderSeen = placeholder
            async function* source() {
              const text0 = `A${placeholder}B`
              const text1 = `C${placeholder}D`
              const tool0 = JSON.stringify({ email: placeholder, channel: 0 })
              const tool1 = JSON.stringify({ email: placeholder, channel: 1 })
              const max = Math.max(
                text0.length,
                text1.length,
                tool0.length,
                tool1.length
              )
              for (let i = 0; i < max; i++) {
                const choices: unknown[] = []
                if (i < text0.length)
                  choices.push({
                    index: 0,
                    delta: { content: text0[i], sibling: "choice-0" },
                  })
                if (i < text1.length)
                  choices.push({
                    index: 1,
                    delta: { content: text1[i], sibling: "choice-1" },
                  })
                const toolCalls: unknown[] = []
                if (i < tool0.length)
                  toolCalls.push({
                    index: 0,
                    id: "tool-0",
                    type: "function",
                    function: { name: "lookup", arguments: tool0[i] },
                    sibling: "tool-0",
                  })
                if (i < tool1.length)
                  toolCalls.push({
                    index: 0,
                    id: "tool-1",
                    type: "function",
                    function: { name: "lookup", arguments: tool1[i] },
                    sibling: "tool-1",
                  })
                if (toolCalls.length > 0)
                  choices.push(
                    {
                      index: 0,
                      delta: {
                        tool_calls: toolCalls.filter(
                          (call) => (call as { id?: string }).id === "tool-0"
                        ),
                        sibling: "tools-0",
                      },
                    },
                    {
                      index: 1,
                      delta: {
                        tool_calls: toolCalls.filter(
                          (call) => (call as { id?: string }).id === "tool-1"
                        ),
                        sibling: "tools-1",
                      },
                    }
                  )
                yield { id: `chunk-${i}`, choices, sibling: { i } }
              }
            }
            return source()
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "email ana@acme.com" }],
    })) as AsyncIterable<{
      id?: string
      choices?: Array<{
        index?: number
        delta?: {
          content?: string
          tool_calls?: Array<{
            index?: number
            function?: { arguments?: string }
            sibling?: string
          }>
          sibling?: string
        }
        sibling?: string
      }>
      sibling?: { i: number }
    }>
    const chunks: Array<{
      value: {
        choices?: Array<{
          index?: number
          delta?: {
            content?: string
            tool_calls?: Array<{
              index?: number
              function?: { arguments?: string }
              sibling?: string
            }>
            sibling?: string
          }
        }>
        sibling?: { i: number }
      }
    }> = []
    for await (const chunk of stream) chunks.push({ value: chunk })

    const text = new Map<number, string>()
    const args = new Map<string, string>()
    for (const chunk of chunks) {
      for (const choice of chunk.value.choices ?? []) {
        const choiceIndex = choice.index ?? 0
        if (choice.delta?.content !== undefined)
          text.set(
            choiceIndex,
            `${text.get(choiceIndex) ?? ""}${choice.delta.content}`
          )
        for (const call of choice.delta?.tool_calls ?? []) {
          const key = `${choiceIndex}:${call.index ?? 0}`
          args.set(
            key,
            `${args.get(key) ?? ""}${call.function?.arguments ?? ""}`
          )
        }
      }
    }
    expect(text.get(0)).toBe("Aana@acme.comB")
    expect(text.get(1)).toBe("Cana@acme.comD")
    expect(JSON.parse(args.get("0:0")!)).toEqual({
      email: "ana@acme.com",
      channel: 0,
    })
    expect(JSON.parse(args.get("1:0")!)).toEqual({
      email: "ana@acme.com",
      channel: 1,
    })
    expect(chunks.some((chunk) => chunk.value.sibling?.i === 0)).toBe(true)
    expect(
      chunks.some((chunk) =>
        chunk.value.choices?.some(
          (choice) =>
            choice.delta?.sibling === "choice-0" && choice.delta.content === ""
        )
      )
    ).toBe(true)
    expect(
      chunks.every((chunk) => !JSON.stringify(chunk).includes(placeholderSeen))
    ).toBe(true)
  })

  it("restores long tool arguments progressively before the final source chunk", async () => {
    let observedProgressiveArgument = false
    let argumentLength = 0
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const protectedContent = (params.messages as ChatMessage[])[0]!
              .content as string
            const placeholder = protectedContent.match(TOKEN)![0]
            const argument = JSON.stringify({
              note: "This prefix is deliberately longer than the placeholder holdback.",
              email: placeholder,
            })
            argumentLength = argument.length
            async function* source() {
              for (let index = 0; index < argument.length; index++) {
                yield {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            function: {
                              name: "lookup",
                              arguments: argument[index],
                            },
                            sibling: "preserve-me",
                          },
                        ],
                        position: index,
                      },
                    },
                  ],
                }
              }
            }
            return source()
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "email ana@acme.com" }],
    })) as AsyncIterable<{
      choices?: Array<{
        delta?: {
          position?: number
          tool_calls?: Array<{
            function?: { arguments?: string }
            sibling?: string
          }>
        }
      }>
    }>
    let restoredArguments = ""
    for await (const chunk of stream) {
      const call = chunk.choices?.[0]?.delta?.tool_calls?.[0]
      const piece = call?.function?.arguments ?? ""
      const position = chunk.choices?.[0]?.delta?.position
      if (
        position !== undefined &&
        position < argumentLength - 1 &&
        piece.length > 0
      )
        observedProgressiveArgument = true
      if (call?.sibling) expect(call.sibling).toBe("preserve-me")
      restoredArguments += piece
    }
    expect(observedProgressiveArgument).toBe(true)
    expect(JSON.parse(restoredArguments)).toEqual({
      note: "This prefix is deliberately longer than the placeholder holdback.",
      email: "ana@acme.com",
    })
  })

  it("does not pull upstream again after flushing normal-completion tails", async () => {
    let pulls = 0
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const protectedContent = (params.messages as ChatMessage[])[0]!
              .content as string
            const placeholder = protectedContent.match(TOKEN)![0]
            const source: AsyncIterable<unknown> = {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    pulls++
                    if (pulls === 1)
                      return {
                        done: false,
                        value: {
                          choices: [
                            { index: 0, delta: { content: placeholder } },
                          ],
                        },
                      }
                    if (pulls === 2) return { done: true, value: undefined }
                    throw new Error("forbidden pull after flush")
                  },
                }
              },
            }
            return source
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "email ana@acme.com" }],
    })) as AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }>
    let restored = ""
    for await (const chunk of stream)
      restored += chunk.choices?.[0]?.delta?.content ?? ""
    expect(restored).toBe("ana@acme.com")
    expect(pulls).toBe(2)
  })

  it("rechecks abort signals before each queued flush item", async () => {
    const reason = new Error("aborted during flush")
    const controller = new AbortController()
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const protectedContent = (params.messages as ChatMessage[])[0]!
              .content as string
            const placeholder = protectedContent.match(TOKEN)![0]
            async function* source() {
              yield {
                choices: [
                  { index: 0, delta: { content: placeholder } },
                  { index: 1, delta: { content: placeholder } },
                ],
              }
            }
            return source()
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      signal: controller.signal,
      messages: [{ role: "user", content: "email ana@acme.com" }],
    })) as AsyncIterable<unknown>
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    controller.abort(reason)
    await expect(iterator.next()).rejects.toBe(reason)
  })

  it("honors abort identity before protection and again before provider invocation", async () => {
    const reason = new Error("caller cancelled")
    const controller = new AbortController()
    controller.abort(reason)
    let providerCalls = 0
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            void params
            providerCalls++
            return { choices: [] }
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    await expect(
      wrapped.chat.completions.create({
        model: "gpt-test",
        messages: [{ role: "user", content: "email ana@acme.com" }],
        signal: controller.signal,
      })
    ).rejects.toBe(reason)
    expect(providerCalls).toBe(0)

    const secondReason = new Error("cancelled while protecting")
    const secondController = new AbortController()
    const session = {
      anonymize: async (text: string) => {
        secondController.abort(secondReason)
        return { redactedText: text, entities: [], mapping: {} }
      },
      anonymizeJson: async (value: unknown) => value,
      rehydrate: (text: string) => text,
      rehydrateJson: (value: unknown) => value,
      mapping: {},
      clear: () => undefined,
    }
    const wrappedWithSession = withPiiOpenAI(client, { session })
    await expect(
      wrappedWithSession.chat.completions.create({
        model: "gpt-test",
        messages: [{ role: "user", content: "private" }],
        signal: secondController.signal,
      })
    ).rejects.toBe(secondReason)
    expect(providerCalls).toBe(0)
  })

  it("uses an AbortError fallback when an aborted structural signal has no reason", async () => {
    let providerCalls = 0
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            void params
            providerCalls++
            return { choices: [] }
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const signal = { aborted: true } as AbortSignal
    const rejection = wrapped.chat.completions.create({
      model: "gpt-test",
      messages: [{ role: "user", content: "email ana@acme.com" }],
      signal,
    })
    await expect(rejection).rejects.toMatchObject({ name: "AbortError" })
    expect(providerCalls).toBe(0)
  })

  it("preserves a provider generation failure", async () => {
    const failure = new Error("provider unavailable")
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            void params
            throw failure
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    await expect(
      wrapped.chat.completions.create({
        model: "gpt-test",
        messages: [{ role: "user", content: "email ana@acme.com" }],
      })
    ).rejects.toBe(failure)
  })

  it("stays lazy and cleans up an early consumer return exactly once", async () => {
    let nextCalls = 0
    let returnCalls = 0
    const source: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCalls++
            return { done: false, value: { choices: [] } }
          },
          async return() {
            returnCalls++
            return { done: true, value: undefined }
          },
        }
      },
    }
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            void params
            return source
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [],
    })) as AsyncIterable<unknown>
    expect(nextCalls).toBe(0)
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    expect(nextCalls).toBe(1)
    await iterator.return?.()
    expect(returnCalls).toBe(1)
  })

  it("discards buffered text and tool tails on consumer early return", async () => {
    let placeholder = ""
    let returnCalls = 0
    const source: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return {
              done: false,
              value: {
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: placeholder.slice(0, 4),
                      tool_calls: [
                        {
                          index: 0,
                          function: {
                            arguments: `{"email":"${placeholder.slice(0, 4)}`,
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            }
          },
          async return() {
            returnCalls++
            return { done: true, value: undefined }
          },
        }
      },
    }
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const protectedContent = (params.messages as ChatMessage[])[0]!
              .content as string
            placeholder = protectedContent.match(TOKEN)![0]
            return source
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "email ana@acme.com" }],
    })) as AsyncIterable<unknown>
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(JSON.stringify(first.value)).not.toContain(placeholder)
    await iterator.return?.()
    expect(returnCalls).toBe(1)
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })

  it("discards incomplete stream tails and lets the primary source failure win cleanup failure", async () => {
    const primary = new Error("source failed")
    const cleanup = new Error("cleanup failed")
    let nextCalls = 0
    let returnCalls = 0
    const source: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (nextCalls++ === 0) {
              return {
                done: false,
                value: { choices: [{ index: 0, delta: { content: "PII" } }] },
              }
            }
            throw primary
          },
          async return() {
            returnCalls++
            throw cleanup
          },
        }
      },
    }
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            void params
            return source
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "email ana@acme.com" }],
    })) as AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }>
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(JSON.stringify(first.value)).not.toContain("PII")
    await expect(iterator.next()).rejects.toBe(primary)
    expect(returnCalls).toBe(1)
  })

  it("discards an incomplete tool-argument tail when the source fails", async () => {
    const sourceFailure = new Error("tool stream failed")
    let placeholder = ""
    let returnCalls = 0
    const source: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        let calls = 0
        return {
          async next() {
            if (calls++ === 0)
              return {
                done: false,
                value: {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            function: {
                              arguments: `{"email":"${placeholder.slice(0, 4)}`,
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              }
            throw sourceFailure
          },
          async return() {
            returnCalls++
            return { done: true, value: undefined }
          },
        }
      },
    }
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const protectedContent = (params.messages as ChatMessage[])[0]!
              .content as string
            placeholder = protectedContent.match(TOKEN)![0]
            return source
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "email ana@acme.com" }],
    })) as AsyncIterable<unknown>
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(JSON.stringify(first.value)).not.toContain(placeholder)
    await expect(iterator.next()).rejects.toBe(sourceFailure)
    expect(returnCalls).toBe(1)
  })

  it("replaces a successful early return with an upstream cleanup failure", async () => {
    const cleanup = new Error("cleanup failed")
    let returnCalls = 0
    const source: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: { choices: [] } }
          },
          async return() {
            returnCalls++
            throw cleanup
          },
        }
      },
    }
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            void params
            return source
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [],
    })) as AsyncIterable<unknown>
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    await expect(iterator.return?.()).rejects.toBe(cleanup)
    expect(returnCalls).toBe(1)
  })

  it("aborts a stream before its next pull, cleans up once, and discards tails", async () => {
    const reason = new Error("stream cancelled")
    const controller = new AbortController()
    let nextCalls = 0
    let returnCalls = 0
    const source: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCalls++
            return {
              done: false,
              value: {
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: "PII",
                      tool_calls: [
                        {
                          index: 0,
                          function: { arguments: '{"email":"PII' },
                        },
                      ],
                    },
                  },
                ],
              },
            }
          },
          async return() {
            returnCalls++
            return { done: true, value: undefined }
          },
        }
      },
    }
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            void params
            return source
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "email ana@acme.com" }],
      signal: controller.signal,
    })) as AsyncIterable<unknown>
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(JSON.stringify(first.value)).not.toContain("PII")
    controller.abort(reason)
    await expect(iterator.next()).rejects.toBe(reason)
    expect(nextCalls).toBe(1)
    expect(returnCalls).toBe(1)
  })

  it("keeps a consumer-body failure ahead of an upstream return failure", async () => {
    const consumerFailure = new Error("consumer failed")
    const cleanupFailure = new Error("consumer cleanup failed")
    const source: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: { choices: [] } }
          },
          async return() {
            throw cleanupFailure
          },
        }
      },
    }
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            void params
            return source
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const stream = (await wrapped.chat.completions.create({
      model: "gpt-test",
      stream: true,
      messages: [],
    })) as AsyncIterable<unknown>
    await expect(
      (async () => {
        for await (const chunk of stream) {
          void chunk
          throw consumerFailure
        }
      })()
    ).rejects.toBe(consumerFailure)
  })

  it("isolates state across overlapping wrapped stream calls", async () => {
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const content = (params.messages as ChatMessage[])[0]!
              .content as string
            const placeholder = content.match(TOKEN)![0]
            async function* source() {
              yield {
                choices: [
                  { index: 0, delta: { content: placeholder.slice(0, 2) } },
                ],
              }
              await Promise.resolve()
              yield {
                choices: [
                  { index: 0, delta: { content: placeholder.slice(2) } },
                ],
              }
            }
            return source()
          },
        },
      },
    }
    const wrapped = withPiiOpenAI(client)
    const [first, second] = await Promise.all([
      wrapped.chat.completions.create({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "email ana@acme.com" }],
      }),
      wrapped.chat.completions.create({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "email bob@example.com" }],
      }),
    ])
    const collect = async (stream: unknown) => {
      let text = ""
      for await (const chunk of stream as AsyncIterable<{
        choices?: Array<{ delta?: { content?: string } }>
      }>)
        text += chunk.choices?.[0]?.delta?.content ?? ""
      return text
    }
    const [firstText, secondText] = await Promise.all([
      collect(first),
      collect(second),
    ])
    expect(firstText).toBe("ana@acme.com")
    expect(secondText).toBe("bob@example.com")
  })

  it("never sends raw PII to the provider, yet runs the tool with real values", async () => {
    const captured: Array<Record<string, unknown>> = []
    let step = 0

    // A fake OpenAI-compatible client. It only ever sees anonymized messages,
    // so it echoes the placeholders it finds back into tool args / final text.
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            captured.push(params)
            step += 1
            const messages = params.messages as ChatMessage[]
            if (step === 1) {
              const user = messages.find((m) => m.role === "user")!
              const ph = user.content!.match(TOKEN)![0]
              return {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "c1",
                          type: "function",
                          function: {
                            name: "lookup",
                            arguments: JSON.stringify({ email: ph }),
                          },
                        },
                      ],
                    },
                  },
                ],
              }
            }
            const tool = messages.find((m) => m.role === "tool")!
            const phones = tool.content!.match(new RegExp(TOKEN, "g"))!
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: `Reachable at ${phones[1]}.`,
                  },
                },
              ],
            }
          },
        },
      },
    }

    const wrapped = withPiiOpenAI(client)
    const messages: ChatMessage[] = [
      { role: "user", content: "look up ana@acme.com" },
    ]

    // Step 1 → the model asks to call a tool; args come back with REAL values.
    const r1 = (await wrapped.chat.completions.create({
      model: "grok-4",
      messages,
    })) as {
      choices: Array<{ message: ChatMessage }>
    }
    const assistant = r1.choices[0]!.message
    const args = JSON.parse(assistant.tool_calls![0]!.function.arguments)
    expect(args.email).toBe("ana@acme.com") // real value → we can run the tool

    // Run the tool; it returns REAL PII, including a NEW phone number.
    const toolResult: ChatMessage = {
      role: "tool",
      tool_call_id: "c1",
      content: "Found ana@acme.com, phone +49 151 12345678",
    }

    // Step 2 → send history + tool result; get the final rehydrated answer.
    const r2 = (await wrapped.chat.completions.create({
      model: "grok-4",
      messages: [...messages, assistant, toolResult],
    })) as { choices: Array<{ message: ChatMessage }> }
    expect(r2.choices[0]!.message.content).toBe(
      "Reachable at +49 151 12345678."
    )

    // LEAK SWEEP: no raw PII in anything the provider ever saw.
    const raw = ["ana@acme.com", "+49 151 12345678"]
    for (const params of captured) {
      const wire = JSON.stringify(params)
      for (const value of raw) expect(wire).not.toContain(value)
    }
  })
})
