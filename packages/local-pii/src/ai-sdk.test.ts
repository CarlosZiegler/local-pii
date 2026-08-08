/* eslint-disable @typescript-eslint/no-explicit-any -- mock model returns use the SDK's loose test shape */
import { generateText, stepCountIs, tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { withPii } from "./ai-sdk"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

describe("withPii (AI SDK middleware, tool loop)", () => {
  it("runs the tool with real values while the provider only ever sees tokens", async () => {
    const wirePrompts: string[] = []
    let step = 0

    const model = new MockLanguageModelV4({
      doGenerate: async (options): Promise<any> => {
        const wire = JSON.stringify(options.prompt)
        wirePrompts.push(wire)
        step += 1
        if (step === 1) {
          const ph = wire.match(TOKEN)![0]
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "c1",
                toolName: "lookup",
                input: JSON.stringify({ email: ph }),
              },
            ],
            finishReason: "tool-calls" as const,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          }
        }
        return {
          content: [{ type: "text" as const, text: "All set." }],
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }
      },
    })

    let toolSawEmail = ""
    const lookup = tool({
      description: "Look up a contact by email",
      inputSchema: z.object({ email: z.string() }),
      execute: async ({ email }) => {
        toolSawEmail = email
        return `Found ${email}, phone +49 151 12345678`
      },
    })

    const result = await generateText({
      model: withPii(model),
      tools: { lookup },
      stopWhen: stepCountIs(3),
      prompt: "look up ana@acme.com",
    })

    // The tool executed with the REAL email (rehydrated from the tool-call args).
    expect(toolSawEmail).toBe("ana@acme.com")
    expect(result.text).toBe("All set.")

    // LEAK SWEEP: nothing the provider saw contained raw PII (email or the phone
    // the tool introduced mid-loop).
    for (const wire of wirePrompts) {
      expect(wire).not.toContain("ana@acme.com")
      expect(wire).not.toContain("+49 151 12345678")
    }
    expect(wirePrompts.length).toBe(2)
  })
})
