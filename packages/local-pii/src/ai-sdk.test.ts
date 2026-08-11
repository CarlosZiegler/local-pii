import { generateText, stepCountIs, tool, wrapLanguageModel } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { withPii } from "./ai-sdk"
import { createAnonymizer } from "./anonymizer"
import type { PiiSession } from "./session"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

// These aliases are derived from the public `ai` v7 boundary. The provider
// package is nested under `ai` in this workspace and is intentionally not a
// direct test dependency.
type LanguageModelV4 = ReturnType<typeof wrapLanguageModel>
type LanguageModelV4CallOptions = Parameters<LanguageModelV4["doGenerate"]>[0]
type LanguageModelV4GenerateResult = Awaited<
  ReturnType<LanguageModelV4["doGenerate"]>
>
type LanguageModelV4StreamResult = Awaited<
  ReturnType<LanguageModelV4["doStream"]>
>
type LanguageModelV4StreamPart =
  LanguageModelV4StreamResult["stream"] extends ReadableStream<infer Part>
    ? Part
    : never

function at<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) throw new Error(`missing test value at ${index}`)
  return value
}

type ExtendedStreamPart = LanguageModelV4StreamPart & Record<string, unknown>

function testModel(
  overrides: Partial<Pick<LanguageModelV4, "doGenerate" | "doStream">> = {}
): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test-provider",
    modelId: "test-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("unused doGenerate")
    },
    async doStream() {
      throw new Error("unused doStream")
    },
    ...overrides,
  }
}

function resultEnvelope(
  content: LanguageModelV4GenerateResult["content"],
  finishReason: LanguageModelV4GenerateResult["finishReason"] = {
    unified: "stop",
    raw: "test",
  }
): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason,
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

describe("withPii (AI SDK middleware, tool loop)", () => {
  it("protects only the pinned LanguageModelV4 semantic prompt fields", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    let seen: LanguageModelV4CallOptions | undefined
    const model = testModel({
      async doGenerate(options) {
        seen = options
        return resultEnvelope([])
      },
    })
    const prompt: LanguageModelV4CallOptions["prompt"] = [
      { role: "system", content: "contact ana@acme.com" },
      {
        role: "user",
        content: [
          { type: "text", text: "hello ana@acme.com" },
          {
            type: "file",
            data: { type: "text", text: "file ana@acme.com" },
            mediaType: "text/plain",
          },
        ],
        providerOptions: { test: { preserved: "ana@acme.com" } },
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "reasoning ana@acme.com" },
          {
            type: "reasoning-file",
            data: {
              type: "url",
              url: new URL("https://files.example/ana@acme.com"),
            },
            mediaType: "text/plain",
          },
          { type: "custom", kind: "test.custom" },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "lookup",
            input: { email: "ana@acme.com" },
          },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup",
            output: { type: "text", value: "result ana@acme.com" },
          },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup",
            output: { type: "json", value: { email: "ana@acme.com" } },
          },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup",
            output: { type: "execution-denied", reason: "reason ana@acme.com" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "approval-1",
            approved: false,
            reason: "approval reason ana@acme.com",
          },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup",
            output: {
              type: "error-text",
              value: "error text ana@acme.com",
            },
          },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup",
            output: {
              type: "error-json",
              value: { error: "error json ana@acme.com" },
            },
          },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup",
            output: {
              type: "content",
              value: [
                { type: "text", text: "nested ana@acme.com" },
                {
                  type: "file",
                  data: {
                    type: "url",
                    url: new URL("https://files.example/ana@acme.com"),
                  },
                  mediaType: "text/plain",
                },
                { type: "custom" },
              ],
            },
          },
        ],
      },
    ]
    const snapshot = JSON.stringify(prompt, (_key, value: unknown) =>
      value instanceof URL ? value.toString() : value
    )
    const stopSequences = ["stop ana@acme.com"]
    const headers = { "x-test": "ana@acme.com" }
    const providerOptions = { provider: { mode: "ana@acme.com" } }
    const tools = [
      {
        type: "function" as const,
        name: "lookup",
        description: "lookup ana@acme.com",
        inputSchema: {
          type: "object" as const,
          properties: { email: { type: "string" as const } },
        },
        inputExamples: [{ input: { email: "ana@acme.com" } }],
      },
    ]
    const responseFormat = {
      type: "json" as const,
      name: "result",
      description: "result for ana@acme.com",
      schema: {
        type: "object" as const,
        properties: { email: { type: "string" as const } },
      },
    }
    const options: LanguageModelV4CallOptions = {
      prompt,
      maxOutputTokens: 42,
      temperature: 0.2,
      stopSequences,
      topP: 0.9,
      topK: 10,
      presencePenalty: 0.1,
      frequencyPenalty: 0.1,
      responseFormat,
      seed: 7,
      tools,
      toolChoice: { type: "tool", toolName: "lookup" },
      includeRawChunks: true,
      headers,
      reasoning: "low",
      providerOptions,
    }

    await withPii(model, { session }).doGenerate(options)

    expect(
      JSON.stringify(prompt, (_key, value: unknown) =>
        value instanceof URL ? value.toString() : value
      )
    ).toBe(snapshot)
    const captured = seen
    if (!captured) throw new Error("provider did not receive options")
    const seenSystem = at(captured.prompt, 0)
    if (!seenSystem || seenSystem.role !== "system")
      throw new Error("expected system message")
    expect(seenSystem.content).not.toContain("ana@acme.com")
    expect(captured.stopSequences).toBe(stopSequences)
    expect(captured.headers).toBe(headers)
    expect(captured.providerOptions).toBe(providerOptions)
    expect(captured.tools).toBe(tools)
    expect(captured.responseFormat).toBe(responseFormat)
    const seenUser = at(captured.prompt, 1)
    if (seenUser.role !== "user") throw new Error("expected user message")
    const seenUserText = at(seenUser.content, 0)
    if (seenUserText.type !== "text") throw new Error("expected text part")
    expect(seenUserText.text).not.toContain("ana@acme.com")
    expect(seenUser.content[1]).toBe(
      prompt[1]?.role === "user" ? prompt[1].content[1] : undefined
    )
    const seenAssistant = at(captured.prompt, 2)
    if (seenAssistant.role !== "assistant")
      throw new Error("expected assistant message")
    const reasoning = at(seenAssistant.content, 0)
    if (reasoning.type !== "reasoning")
      throw new Error("expected reasoning part")
    expect(reasoning.text).toBe("reasoning ana@acme.com")
    expect(at(seenAssistant.content, 1)).toBe(
      prompt[2]?.role === "assistant" ? prompt[2].content[1] : undefined
    )
    expect(at(seenAssistant.content, 2)).toBe(
      prompt[2]?.role === "assistant" ? prompt[2].content[2] : undefined
    )
    const toolCall = at(seenAssistant.content, 3)
    if (toolCall.type !== "tool-call")
      throw new Error("expected tool-call part")
    expect(toolCall.input).toEqual({
      email: expect.not.stringContaining("ana@acme.com"),
    })
    const textResult = at(seenAssistant.content, 4)
    if (textResult.type !== "tool-result" || textResult.output.type !== "text")
      throw new Error("expected text tool-result part")
    expect(textResult.output.value).not.toContain("ana@acme.com")
    const jsonResult = at(seenAssistant.content, 5)
    if (jsonResult.type !== "tool-result" || jsonResult.output.type !== "json")
      throw new Error("expected json tool-result part")
    if (
      jsonResult.output.value === null ||
      typeof jsonResult.output.value !== "object" ||
      Array.isArray(jsonResult.output.value)
    )
      throw new Error("expected json object output")
    expect(jsonResult.output.value.email).not.toBe("ana@acme.com")
    const deniedResult = at(seenAssistant.content, 6)
    if (
      deniedResult.type !== "tool-result" ||
      deniedResult.output.type !== "execution-denied"
    )
      throw new Error("expected denied tool-result part")
    expect(deniedResult.output.reason).toBe("reason ana@acme.com")
    const seenTool = at(captured.prompt, 3)
    if (seenTool.role !== "tool") throw new Error("expected tool message")
    const approval = at(seenTool.content, 0)
    if (approval.type !== "tool-approval-response")
      throw new Error("expected approval response")
    expect(approval.reason).toBe("approval reason ana@acme.com")
    const errorText = at(seenTool.content, 1)
    if (
      errorText.type !== "tool-result" ||
      errorText.output.type !== "error-text"
    )
      throw new Error("expected error-text output")
    expect(errorText.output.value).not.toContain("ana@acme.com")
    const errorJson = at(seenTool.content, 2)
    if (
      errorJson.type !== "tool-result" ||
      errorJson.output.type !== "error-json"
    )
      throw new Error("expected error-json output")
    expect(errorJson.output.value).not.toEqual({
      error: "error json ana@acme.com",
    })
    const contentOutput = at(seenTool.content, 3)
    if (
      contentOutput.type !== "tool-result" ||
      contentOutput.output.type !== "content"
    )
      throw new Error("expected content output")
    const nestedText = at(contentOutput.output.value, 0)
    if (nestedText.type !== "text") throw new Error("expected nested text")
    expect(nestedText.text).not.toContain("ana@acme.com")
    const originalTool = at(prompt, 3)
    if (originalTool.role !== "tool") throw new Error("expected original tool")
    const originalNestedResult = at(originalTool.content, 3)
    if (
      originalNestedResult.type !== "tool-result" ||
      originalNestedResult.output.type !== "content"
    )
      throw new Error("expected original content output")
    expect(at(contentOutput.output.value, 1)).toBe(
      at(originalNestedResult.output.value, 1)
    )
  })

  it("runs the tool with real values while the provider only ever sees tokens", async () => {
    const wirePrompts: string[] = []
    let step = 0

    const model = new MockLanguageModelV4({
      doGenerate: async (options): Promise<LanguageModelV4GenerateResult> => {
        const wire = JSON.stringify(options.prompt)
        wirePrompts.push(wire)
        step += 1
        if (step === 1) {
          const ph = wire.match(TOKEN)![0]
          return resultEnvelope(
            [
              {
                type: "tool-call" as const,
                toolCallId: "c1",
                toolName: "lookup",
                input: JSON.stringify({ email: ph }),
              },
            ],
            { unified: "tool-calls", raw: "tool-calls" }
          )
        }
        return resultEnvelope([{ type: "text" as const, text: "All set." }])
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

  it("restores interleaved text and tool channels at protocol boundaries", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    let sourceChunks: ExtendedStreamPart[] = []
    let sourceIndex = 0
    let sourceRequest: LanguageModelV4StreamResult["request"]
    let sourceResponse: LanguageModelV4StreamResult["response"]
    const model = testModel({
      async doStream(): Promise<LanguageModelV4StreamResult> {
        const token = Object.keys(session.mapping)[0]!
        sourceResponse = { headers: { "x-test": "yes" } }
        sourceRequest = { body: { control: "preserved" } }
        const encoded = JSON.stringify({
          email: token,
          note: 'quote " and slash \\ and newline\n',
        })
        const firstTool = encoded.slice(0, Math.ceil(encoded.length / 2))
        const secondTool = encoded.slice(Math.ceil(encoded.length / 2))
        sourceChunks = [
          { type: "text-start", id: "text-a", marker: "keep-a" },
          { type: "text-start", id: "text-b", marker: "keep-b" },
          { type: "tool-input-start", id: "tool-a", toolName: "lookup" },
          { type: "tool-input-start", id: "tool-b", toolName: "lookup" },
          { type: "text-delta", id: "text-a", delta: "A " },
          { type: "text-delta", id: "text-b", delta: "B " },
          {
            type: "tool-input-delta",
            id: "tool-a",
            delta: firstTool,
            control: "a-1",
          },
          {
            type: "tool-input-delta",
            id: "tool-b",
            delta: firstTool,
            control: "b-1",
          },
          {
            type: "text-delta",
            id: "text-a",
            delta: token.slice(0, 4),
            control: "a-2",
          },
          {
            type: "text-delta",
            id: "text-b",
            delta: token.slice(0, 3),
            control: "b-2",
          },
          {
            type: "tool-input-delta",
            id: "tool-b",
            delta: secondTool,
            control: "b-3",
          },
          {
            type: "tool-input-delta",
            id: "tool-a",
            delta: secondTool,
            control: "a-3",
          },
          {
            type: "text-delta",
            id: "text-b",
            delta: token.slice(3),
            control: "b-4",
          },
          {
            type: "text-delta",
            id: "text-a",
            delta: token.slice(4),
            control: "a-4",
          },
          { type: "text-delta", id: "text-a", delta: "!", control: "a-5" },
          { type: "text-delta", id: "text-b", delta: "?", control: "b-5" },
          { type: "tool-input-end", id: "tool-b", endControl: "b-end" },
          { type: "tool-input-end", id: "tool-a", endControl: "a-end" },
          { type: "text-end", id: "text-b", endControl: "b-text-end" },
          { type: "text-end", id: "text-a", endControl: "a-text-end" },
          {
            type: "tool-call",
            toolCallId: "complete-call",
            toolName: "lookup",
            input: `{ "email": "${token}", "large": 9007199254740993 }`,
            marker: "complete-call-control",
          },
          {
            type: "tool-result",
            toolCallId: "complete-call",
            toolName: "lookup",
            result: { email: token, large: Number("9007199254740993") },
            marker: "complete-result-control",
          },
          {
            type: "finish",
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            finishReason: { unified: "stop", raw: "stop" },
            providerMetadata: { test: { token } },
          },
        ]
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            pull(controller) {
              if (sourceIndex === sourceChunks.length) controller.close()
              else controller.enqueue(sourceChunks[sourceIndex++]!)
            },
          }),
          request: sourceRequest,
          response: sourceResponse,
        }
      },
    })
    const wrapped = withPii(model, { session })
    const result = await wrapped.doStream({
      prompt: [{ role: "system", content: "ana@acme.com" }],
    })
    expect(result.request).toBe(sourceRequest)
    expect(result.response).toBe(sourceResponse)
    const output: LanguageModelV4StreamPart[] = []
    const reader = result.stream.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      output.push(next.value)
    }

    const token = Object.keys(session.mapping)[0]!
    const originalChunks = structuredClone(sourceChunks)
    expect(token).toContain("EMAIL")
    const textDeltas = output.filter(
      (
        part
      ): part is Extract<LanguageModelV4StreamPart, { type: "text-delta" }> =>
        part.type === "text-delta"
    )
    expect(
      textDeltas
        .filter((part) => part.id === "text-a")
        .map((part) => part.delta)
        .join("")
    ).toBe("A ana@acme.com!")
    expect(
      textDeltas
        .filter((part) => part.id === "text-b")
        .map((part) => part.delta)
        .join("")
    ).toBe("B ana@acme.com?")
    const toolDeltas = output.filter(
      (
        part
      ): part is Extract<
        LanguageModelV4StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    )
    expect(
      toolDeltas
        .filter((part) => part.id === "tool-a")
        .slice(0, 2)
        .every((part) => part.delta === "")
    ).toBe(true)
    expect(
      toolDeltas
        .filter((part) => part.id === "tool-b")
        .slice(0, 2)
        .every((part) => part.delta === "")
    ).toBe(true)
    const expectedToolJson = JSON.stringify({
      email: "ana@acme.com",
      note: 'quote " and slash \\ and newline\n',
    })
    const lastDelta = (id: string) =>
      [...toolDeltas].reverse().find((part) => part.id === id)
    expect(lastDelta("tool-a")).toMatchObject({
      delta: expectedToolJson,
      control: "a-3",
    })
    expect(lastDelta("tool-b")).toMatchObject({
      delta: expectedToolJson,
      control: "b-3",
    })
    expect(
      output.find(
        (part) => part.type === "tool-input-end" && part.id === "tool-a"
      )
    ).toMatchObject({ endControl: "a-end" })
    expect(
      output.find(
        (part) => part.type === "tool-input-end" && part.id === "tool-b"
      )
    ).toMatchObject({ endControl: "b-end" })
    const completeCall = at(
      output,
      output.findIndex((part) => part.type === "tool-call")
    )
    if (completeCall.type !== "tool-call")
      throw new Error("expected complete call")
    expect(completeCall.input).toBe(
      '{ "email": "ana@acme.com", "large": 9007199254740993 }'
    )
    expect((completeCall as ExtendedStreamPart).marker).toBe(
      "complete-call-control"
    )
    const completeResult = at(
      output,
      output.findIndex((part) => part.type === "tool-result")
    )
    if (completeResult.type !== "tool-result")
      throw new Error("expected complete result")
    expect(completeResult.result).toEqual({
      email: "ana@acme.com",
      large: Number("9007199254740993"),
    })
    expect((completeResult as ExtendedStreamPart).marker).toBe(
      "complete-result-control"
    )
    const extendedOutput = output as ExtendedStreamPart[]
    expect(
      extendedOutput.find(
        (part) => part.type === "text-start" && part.id === "text-a"
      )
    ).toBe(sourceChunks[0])
    expect(
      extendedOutput.find(
        (part) =>
          part.type === "text-delta" &&
          part.id === "text-a" &&
          part.control === "a-2"
      )
    ).toMatchObject({
      control: "a-2",
    })
    expect(
      extendedOutput.find(
        (part) =>
          part.type === "tool-input-delta" &&
          part.id === "tool-a" &&
          part.control === "a-1"
      )
    ).toMatchObject({
      control: "a-1",
      delta: "",
    })
    expect(extendedOutput.find((part) => part.type === "finish")).toBe(
      sourceChunks[sourceChunks.length - 1]
    )
    expect(sourceChunks).toEqual(originalChunks)
  })

  it("isolates every placeholder split boundary across interleaved channels", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    let callIndex = 0
    const sourceSets: ExtendedStreamPart[][] = []
    const sourceSnapshots: ExtendedStreamPart[][] = []
    const model = testModel({
      async doStream(): Promise<LanguageModelV4StreamResult> {
        const token = Object.keys(session.mapping)[0]!
        const split = callIndex++
        const prefix = '{"email":"'
        const suffix = '"}'
        const first = `${prefix}${token.slice(0, split)}`
        const second = `${token.slice(split)}${suffix}`
        const chunks: ExtendedStreamPart[] = [
          { type: "text-start", id: "text-1", marker: "text-1-start" },
          { type: "text-start", id: "text-2", marker: "text-2-start" },
          { type: "tool-input-start", id: "tool-1", toolName: "lookup" },
          { type: "tool-input-start", id: "tool-2", toolName: "lookup" },
          {
            type: "text-delta",
            id: "text-1",
            delta: `one ${token.slice(0, split)}`,
          },
          { type: "tool-input-delta", id: "tool-1", delta: first },
          {
            type: "text-delta",
            id: "text-2",
            delta: `two ${token.slice(0, split)}`,
          },
          { type: "tool-input-delta", id: "tool-2", delta: first },
          { type: "text-delta", id: "text-1", delta: `${token.slice(split)}!` },
          { type: "tool-input-delta", id: "tool-2", delta: second },
          { type: "text-delta", id: "text-2", delta: `${token.slice(split)}?` },
          { type: "tool-input-delta", id: "tool-1", delta: second },
          { type: "tool-input-end", id: "tool-1", marker: "tool-1-end" },
          { type: "text-end", id: "text-1", marker: "text-1-end" },
          { type: "tool-input-end", id: "tool-2", marker: "tool-2-end" },
          { type: "text-end", id: "text-2", marker: "text-2-end" },
        ]
        sourceSets.push(chunks)
        sourceSnapshots.push(structuredClone(chunks))
        let sourceIndex = 0
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            pull(controller) {
              if (sourceIndex === chunks.length) controller.close()
              else controller.enqueue(chunks[sourceIndex++]!)
            },
          }),
        }
      },
    })
    const wrapped = withPii(model, { session })
    const token = "[EMAIL_1]"
    const expectedSources: ExtendedStreamPart[][] = []
    for (let split = 0; split <= token.length; split++) {
      const result = await wrapped.doStream({
        prompt: [{ role: "system", content: "ana@acme.com" }],
      })
      const parts: LanguageModelV4StreamPart[] = []
      const reader = result.stream.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        parts.push(next.value)
      }
      const textDeltas = parts.filter(
        (
          part
        ): part is Extract<LanguageModelV4StreamPart, { type: "text-delta" }> =>
          part.type === "text-delta"
      )
      expect(
        textDeltas
          .filter((part) => part.id === "text-1")
          .map((part) => part.delta)
          .join("")
      ).toBe("one ana@acme.com!")
      expect(
        textDeltas
          .filter((part) => part.id === "text-2")
          .map((part) => part.delta)
          .join("")
      ).toBe("two ana@acme.com?")
      const tools = parts.filter(
        (
          part
        ): part is Extract<
          LanguageModelV4StreamPart,
          { type: "tool-input-delta" }
        > => part.type === "tool-input-delta"
      )
      expect(
        tools
          .filter((part) => part.id === "tool-1")
          .map((part) => part.delta)
          .join("")
      ).toBe('{"email":"ana@acme.com"}')
      expect(
        tools
          .filter((part) => part.id === "tool-2")
          .map((part) => part.delta)
          .join("")
      ).toBe('{"email":"ana@acme.com"}')
      expect(parts.filter((part) => part.type === "text-start")).toHaveLength(2)
      expect(
        parts.filter((part) => part.type === "tool-input-start")
      ).toHaveLength(2)
      expectedSources.push(sourceSets[split]!)
    }
    expect(sourceSets).toEqual(sourceSnapshots)
    expect(sourceSets).toEqual(expectedSources)
  })

  it("honors pre-aborted and post-protection signals without touching the provider", async () => {
    const reason = new Error("caller stopped")
    const controller = new AbortController()
    controller.abort(reason)
    let generateCalls = 0
    const model = testModel({
      async doGenerate() {
        generateCalls++
        throw new Error("must not reach provider")
      },
      async doStream() {
        generateCalls++
        throw new Error("must not reach provider")
      },
    })
    await expect(
      withPii(model).doGenerate({
        prompt: [],
        abortSignal: controller.signal,
      })
    ).rejects.toBe(reason)
    await expect(
      withPii(model).doStream({
        prompt: [],
        abortSignal: controller.signal,
      })
    ).rejects.toBe(reason)
    expect(generateCalls).toBe(0)

    let releaseProtection!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseProtection = resolve
    })
    const session: PiiSession = {
      mapping: {},
      async anonymize() {
        await gate
        return { redactedText: "protected", entities: [], mapping: {} }
      },
      async anonymizeJson(value: unknown) {
        return value
      },
      rehydrate(value: string) {
        return value
      },
      rehydrateJson(value: unknown) {
        return value
      },
      clear() {},
    }
    const postAbort = new AbortController()
    const call = withPii(model, { session }).doGenerate({
      prompt: [{ role: "system", content: "PII" }],
      abortSignal: postAbort.signal,
    })
    postAbort.abort(reason)
    releaseProtection()
    await expect(call).rejects.toBe(reason)
    expect(generateCalls).toBe(0)

    const providerError = new Error("provider generate failed")
    const throwingModel = testModel({
      async doGenerate(): Promise<LanguageModelV4GenerateResult> {
        throw providerError
      },
    })
    await expect(
      withPii(throwingModel).doGenerate({ prompt: [] })
    ).rejects.toBe(providerError)
  })

  it("flushes safe tails on bare close without sharing concurrent channels", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    let call = 0
    const model = testModel({
      async doStream(): Promise<LanguageModelV4StreamResult> {
        const id = ++call
        const token = Object.keys(session.mapping)[0]!
        const valid = id === 1
        const toolInput = valid
          ? JSON.stringify({ email: token })
          : '{"email":"unterminated'
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                id: `text-${id}`,
                delta: `head ${token}`,
              })
              controller.enqueue({
                type: "tool-input-delta",
                id: `tool-${id}`,
                delta: toolInput,
              })
              controller.close()
            },
          }),
        }
      },
    })
    const wrapped = withPii(model, { session })
    const [first, second] = await Promise.all([
      wrapped.doStream({
        prompt: [{ role: "system", content: "ana@acme.com" }],
      }),
      wrapped.doStream({
        prompt: [{ role: "system", content: "ana@acme.com" }],
      }),
    ])

    const readAll = async (
      stream: ReadableStream<LanguageModelV4StreamPart>
    ) => {
      const values: LanguageModelV4StreamPart[] = []
      const reader = stream.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) return values
        values.push(next.value)
      }
    }
    const [firstParts, secondParts] = await Promise.all([
      readAll(first.stream),
      readAll(second.stream),
    ])
    const text = (parts: LanguageModelV4StreamPart[]) =>
      parts
        .filter(
          (
            part
          ): part is Extract<
            LanguageModelV4StreamPart,
            { type: "text-delta" }
          > => part.type === "text-delta"
        )
        .map((part) => part.delta)
        .join("")
    expect(text(firstParts)).toBe("head ana@acme.com")
    expect(text(secondParts)).toBe("head ana@acme.com")
    const firstTool = firstParts.filter(
      (
        part
      ): part is Extract<
        LanguageModelV4StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    )
    const secondTool = secondParts.filter(
      (
        part
      ): part is Extract<
        LanguageModelV4StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    )
    expect(firstTool[firstTool.length - 1]?.delta).toBe(
      '{"email":"ana@acme.com"}'
    )
    expect(secondTool.every((part) => part.delta === "")).toBe(true)
  })

  it("restores the complete v4 generated content matrix and envelope immutably", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    let providerResult:
      (LanguageModelV4GenerateResult & Record<string, unknown>) | undefined
    const model = testModel({
      async doGenerate(): Promise<LanguageModelV4GenerateResult> {
        const token = Object.keys(session.mapping)[0]!
        const custom = {
          type: "custom" as const,
          kind: "test.custom",
          marker: token,
        }
        const content = [
          { type: "text" as const, text: `hello ${token}` },
          { type: "reasoning" as const, text: `reason ${token}` },
          custom as LanguageModelV4GenerateResult["content"][number],
          {
            type: "file" as const,
            mediaType: "text/plain",
            data: { type: "data" as const, data: "abc" },
          },
          {
            type: "reasoning-file" as const,
            mediaType: "text/plain",
            data: { type: "data" as const, data: "def" },
          },
          {
            type: "source" as const,
            sourceType: "url" as const,
            id: "source-1",
            url: `https://${token}.example`,
          },
          {
            type: "tool-approval-request" as const,
            approvalId: "approval-1",
            toolCallId: "call-1",
          },
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "lookup",
            input: String.raw`{ "email": "${token}", "note": "quote \" and slash \\ and newline\n", "large": 9007199254740993 }`,
          },
          {
            type: "tool-result" as const,
            toolCallId: "call-1",
            toolName: "lookup",
            result: {
              message: `tool ${token}`,
              large: Number("9007199254740993"),
            },
          },
        ] as LanguageModelV4GenerateResult["content"]
        providerResult = {
          content,
          finishReason: { unified: "stop", raw: "done" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
            raw: { untouched: token },
          },
          providerMetadata: { test: { token } },
          request: { body: { token } },
          response: { headers: { "x-test": "yes" }, body: { token } },
          warnings: [{ type: "other", message: token }],
          unknownControl: { token },
        }
        return providerResult
      },
    })
    const result = await withPii(model, { session }).doGenerate({
      prompt: [{ role: "system", content: "ana@acme.com" }],
    })

    if (!providerResult) throw new Error("provider did not return a result")

    const providerText = at(providerResult.content, 0)
    const providerReasoning = at(providerResult.content, 1)
    if (providerText.type !== "text" || providerReasoning.type !== "reasoning")
      throw new Error("expected text and reasoning")
    expect(providerText.text).toContain("[EMAIL_")
    expect(providerReasoning.text).toContain("[EMAIL_")
    const resultText = at(result.content, 0)
    const resultReasoning = at(result.content, 1)
    if (resultText.type !== "text" || resultReasoning.type !== "reasoning")
      throw new Error("expected restored text and reasoning")
    expect(resultText.text).toBe("hello ana@acme.com")
    expect(resultReasoning.text).toBe("reason [EMAIL_1]")
    expect(result.content[1]).toBe(providerResult.content[1])
    expect(result.content[2]).toBe(providerResult.content[2])
    expect(result.content[3]).toBe(providerResult.content[3])
    expect(result.content[5]).toBe(providerResult.content[5])
    const restoredCall = at(result.content, 7)
    if (restoredCall.type !== "tool-call") throw new Error("expected tool call")
    expect(restoredCall.input).toBe(
      String.raw`{ "email": "ana@acme.com", "note": "quote \" and slash \\ and newline\n", "large": 9007199254740993 }`
    )
    const restoredResult = at(result.content, 8)
    if (restoredResult.type !== "tool-result")
      throw new Error("expected tool result")
    expect(restoredResult.result).toEqual({
      message: "tool ana@acme.com",
      large: Number("9007199254740993"),
    })
    expect(result.finishReason).toBe(providerResult.finishReason)
    expect(result.usage).toBe(providerResult.usage)
    expect(result.providerMetadata).toBe(providerResult.providerMetadata)
    expect(result.request).toBe(providerResult.request)
    expect(result.response).toBe(providerResult.response)
    expect(
      (result as LanguageModelV4GenerateResult & Record<string, unknown>)[
        "unknownControl"
      ]
    ).toBe(providerResult.unknownControl)
    expect(providerText.text).not.toBe("hello ana@acme.com")
  })

  it("preserves source errors and reaches the original stream cancel exactly once", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    const sourceError = new Error("provider stream failed")
    const cancelReason = new Error("consumer stopped")
    let cancelCalls = 0
    let cancelValue: unknown
    let emitError = true
    const model = testModel({
      async doGenerate(): Promise<LanguageModelV4GenerateResult> {
        throw new Error("unused")
      },
      async doStream(): Promise<LanguageModelV4StreamResult> {
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            pull(controller) {
              if (emitError) {
                emitError = false
                controller.error(sourceError)
              } else {
                controller.enqueue({
                  type: "text-delta",
                  id: "t",
                  delta: "safe",
                })
              }
            },
            cancel(reason) {
              cancelCalls++
              cancelValue = reason
            },
          }),
        }
      },
    })
    const wrapped = withPii(model, { session })
    const result = await wrapped.doStream({
      prompt: [],
    })
    await expect(result.stream.getReader().read()).rejects.toBe(sourceError)
    // An errored source is already terminal, so Web Streams does not invoke
    // its underlying cancel algorithm a second time.
    expect(cancelCalls).toBe(0)

    const second = await wrapped.doStream({
      prompt: [],
    })
    const reader = second.stream.getReader()
    await reader.cancel(cancelReason)
    expect(cancelCalls).toBe(1)
    expect(cancelValue).toBe(cancelReason)

    const cleanupError = new Error("cleanup failed")
    const cleanupModel = testModel({
      async doStream(): Promise<LanguageModelV4StreamResult> {
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            cancel() {
              throw cleanupError
            },
          }),
        }
      },
    })
    const cleanupResult = await withPii(cleanupModel, { session }).doStream({
      prompt: [],
    })
    await expect(
      cleanupResult.stream.getReader().cancel(cancelReason)
    ).rejects.toBe(cleanupError)
  })

  it("treats an error part and abort as terminal without flushing privacy tails", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    const abortReason = new Error("aborted")
    const controller = new AbortController()
    let sourceCancelCalls = 0
    let sourceController!: ReadableStreamDefaultController<LanguageModelV4StreamPart>
    const model = testModel({
      async doGenerate(): Promise<LanguageModelV4GenerateResult> {
        throw new Error("unused")
      },
      async doStream(): Promise<LanguageModelV4StreamResult> {
        const token = Object.keys(session.mapping)[0]!
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(next) {
              sourceController = next
              next.enqueue({
                type: "text-delta",
                id: "t",
                delta: token.slice(0, 3),
              })
              next.enqueue({ type: "error", error: new Error("part failed") })
            },
            cancel() {
              sourceCancelCalls++
              throw new Error("error-part cleanup failed")
            },
          }),
        }
      },
    })
    const wrapped = withPii(model, { session })
    const result = await wrapped.doStream({
      prompt: [{ role: "system", content: "ana@acme.com" }],
    })
    const reader = result.stream.getReader()
    const first = await reader.read()
    if (!first.value || first.value.type !== "text-delta")
      throw new Error("expected text placeholder delta")
    expect(first.value.delta).toBe("")
    const errorPart = await reader.read()
    if (!errorPart.value || errorPart.value.type !== "error")
      throw new Error("expected error part")
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(sourceCancelCalls).toBe(1)

    const abortResult = await wrapped.doStream({
      prompt: [{ role: "system", content: "ana@acme.com" }],
      abortSignal: controller.signal,
    })
    const abortReader = abortResult.stream.getReader()
    await abortReader.read()
    controller.abort(abortReason)
    await expect(abortReader.read()).rejects.toBe(abortReason)
    expect(sourceController).toBeDefined()
  })
})
