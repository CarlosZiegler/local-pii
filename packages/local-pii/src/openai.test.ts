import { describe, expect, it } from "vitest"
import { createPiiChat, withPiiOpenAI, type ChatMessage } from "./openai"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child)
  }
  return value
}

describe("createPiiChat (tool-call cycle)", () => {
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

describe("withPiiOpenAI (full tool loop + leak sweep)", () => {
  it("protects only semantic message fields while preserving frozen input and controls", async () => {
    const captured: Array<Record<string, unknown>> = []
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            captured.push(params)
            return { id: "completion-1", choices: [], custom: { untouched: true } }
          },
        },
      },
    }
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "email ana@acme.com",
        name: "Alice",
        metadata: { trace: "retain" },
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "lookup",
              arguments: JSON.stringify({ email: "ana@acme.com", keep: 1 }),
            },
            metadata: { control: true },
          },
        ],
      },
    ]
    const params = deepFreeze({
      model: "gpt-test",
      messages,
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      metadata: { request: "retain" },
      stream: false,
      signal: undefined,
    })

    const wrapped = withPiiOpenAI(client)
    await wrapped.chat.completions.create(params)

    expect(messages[0]!.content).toBe("email ana@acme.com")
    expect(messages[0]!.tool_calls![0]!.function.arguments).toContain("ana@acme.com")
    expect(captured).toHaveLength(1)
    expect(captured[0]!.model).toBe("gpt-test")
    expect(captured[0]!.tools).toBe(params.tools)
    expect(captured[0]!.metadata).toBe(params.metadata)
    const sent = captured[0]!.messages as ChatMessage[]
    expect(sent[0]!.role).toBe("user")
    expect(sent[0]!.name).toBe("Alice")
    expect(sent[0]!.metadata).toEqual({ trace: "retain" })
    expect(sent[0]!.content).not.toContain("ana@acme.com")
    expect(sent[0]!.tool_calls![0]!.id).toBe("call-1")
    expect(sent[0]!.tool_calls![0]!.metadata).toEqual({ control: true })
    expect(sent[0]!.tool_calls![0]!.function.name).toBe("lookup")
    expect(sent[0]!.tool_calls![0]!.function.arguments).not.toContain("ana@acme.com")
  })

  it("restores complete messages without mutating response objects or siblings", async () => {
    const response = {
      id: "completion-2",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Contact ana@acme.com",
            tool_calls: [
              {
                id: "call-2",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: JSON.stringify({ email: "ana@acme.com" }),
                },
                custom: { preserve: true },
              },
            ],
            custom: { preserve: "message" },
          },
          custom: { preserve: "choice" },
        },
      ],
      usage: { total_tokens: 12 },
      custom: { preserve: "response" },
    }
    const original = structuredClone(response)
    const choicesReference = response.choices
    const messageReference = response.choices[0]!.message
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            void params
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
    expect(JSON.parse(restored.choices[0]!.message.tool_calls![0]!.function.arguments)).toEqual({
      email: "ana@acme.com",
    })
    expect(restored.choices[0]!.custom).toEqual({ preserve: "choice" })
    expect(restored.choices[0]!.message.custom).toEqual({ preserve: "message" })
    expect(restored.usage).toEqual({ total_tokens: 12 })
    expect(response).toEqual(original)
    expect(response.choices).toBe(choicesReference)
    expect(response.choices[0]!.message).toBe(messageReference)
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
              const max = Math.max(text0.length, text1.length, tool0.length, tool1.length)
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
                    index: 1,
                    id: "tool-1",
                    type: "function",
                    function: { name: "lookup", arguments: tool1[i] },
                    sibling: "tool-1",
                  })
                if (toolCalls.length > 0)
                  choices.push({
                    index: 0,
                    delta: { tool_calls: toolCalls, sibling: "tools" },
                  })
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
          text.set(choiceIndex, `${text.get(choiceIndex) ?? ""}${choice.delta.content}`)
        for (const call of choice.delta?.tool_calls ?? []) {
          const key = `${choiceIndex}:${call.index ?? 0}`
          args.set(key, `${args.get(key) ?? ""}${call.function?.arguments ?? ""}`)
        }
      }
    }
    expect(text.get(0)).toBe("Aana@acme.comB")
    expect(text.get(1)).toBe("Cana@acme.comD")
    expect(JSON.parse(args.get("0:0")!)).toEqual({ email: "ana@acme.com", channel: 0 })
    expect(JSON.parse(args.get("0:1")!)).toEqual({ email: "ana@acme.com", channel: 1 })
    expect(chunks.some((chunk) => chunk.value.sibling?.i === 0)).toBe(true)
    expect(chunks.some((chunk) => chunk.value.choices?.some((choice) =>
      choice.delta?.sibling === "choice-0" && choice.delta.content === ""
    ))).toBe(true)
    expect(chunks.every((chunk) => !JSON.stringify(chunk).includes(placeholderSeen))).toBe(true)
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
    })) as AsyncIterable<{ choices?: Array<{ delta?: { content?: string }}> }>
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(JSON.stringify(first.value)).not.toContain("PII")
    await expect(iterator.next()).rejects.toBe(primary)
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
              value: { choices: [{ index: 0, delta: { content: "PII" } }] },
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

  it("isolates state across overlapping wrapped stream calls", async () => {
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const content = (params.messages as ChatMessage[])[0]!.content as string
            const placeholder = content.match(TOKEN)![0]
            async function* source() {
              yield { choices: [{ index: 0, delta: { content: placeholder.slice(0, 2) } }] }
              await Promise.resolve()
              yield { choices: [{ index: 0, delta: { content: placeholder.slice(2) } }] }
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
      for await (const chunk of stream as AsyncIterable<{ choices?: Array<{ delta?: { content?: string }}> }>)
        text += chunk.choices?.[0]?.delta?.content ?? ""
      return text
    }
    const [firstText, secondText] = await Promise.all([collect(first), collect(second)])
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
