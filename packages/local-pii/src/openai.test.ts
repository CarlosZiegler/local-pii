import { describe, expect, it } from "vitest"
import { createPiiChat, withPiiOpenAI, type ChatMessage } from "./openai"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

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
    expect(chat.rehydrateText(user!.content!)).toBe("look up ana@acme.com please")
  })

  it("rehydrates placeholders inside tool-call argument JSON (keeping it valid)", async () => {
    const chat = createPiiChat()
    await chat.anonymizeMessages([{ role: "user", content: "email ana@acme.com" }])
    const placeholder = Object.keys(chat.mapping)[0]!

    // The model replies with a tool call whose JSON args reference the placeholder.
    const assistant: ChatMessage = {
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: JSON.stringify({ email: placeholder }) },
        },
      ],
    }
    const restored = chat.rehydrateMessage(assistant)
    const args = JSON.parse(restored.tool_calls![0]!.function.arguments)
    expect(args.email).toBe("ana@acme.com") // real value, to actually run the tool
  })

  it("keeps the placeholder stable when a tool RESULT re-introduces the same PII", async () => {
    const chat = createPiiChat()
    await chat.anonymizeMessages([{ role: "user", content: "look up ana@acme.com" }])
    const placeholder = Object.keys(chat.mapping)[0]!

    // Our backend tool returns real PII; it must be redacted with the SAME vault.
    const [toolMsg] = await chat.anonymizeMessages([
      { role: "tool", tool_call_id: "call_1", content: "found ana@acme.com in the CRM" },
    ])
    expect(toolMsg!.content).toContain(placeholder)
    expect(toolMsg!.content).not.toContain("ana@acme.com")
  })
})

describe("withPiiOpenAI (full tool loop + leak sweep)", () => {
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
                          function: { name: "lookup", arguments: JSON.stringify({ email: ph }) },
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
              choices: [{ message: { role: "assistant", content: `Reachable at ${phones[1]}.` } }],
            }
          },
        },
      },
    }

    const wrapped = withPiiOpenAI(client)
    const messages: ChatMessage[] = [{ role: "user", content: "look up ana@acme.com" }]

    // Step 1 → the model asks to call a tool; args come back with REAL values.
    const r1 = (await wrapped.chat.completions.create({ model: "grok-4", messages })) as {
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
    expect(r2.choices[0]!.message.content).toBe("Reachable at +49 151 12345678.")

    // LEAK SWEEP: no raw PII in anything the provider ever saw.
    const raw = ["ana@acme.com", "+49 151 12345678"]
    for (const params of captured) {
      const wire = JSON.stringify(params)
      for (const value of raw) expect(wire).not.toContain(value)
    }
  })
})
