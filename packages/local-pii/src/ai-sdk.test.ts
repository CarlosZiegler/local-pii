/* eslint-disable @typescript-eslint/no-explicit-any -- mock model returns use the SDK's loose test shape */
import { generateText, stepCountIs, tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { withPii } from "./ai-sdk"
import { createAnonymizer } from "./anonymizer"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

describe("withPii (AI SDK middleware, tool loop)", () => {
  it("protects only the pinned LanguageModelV4 semantic prompt fields", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    let seen: any
    const model: any = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      async doGenerate(options: any) {
        seen = options
        return {
          content: [],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          warnings: [],
        }
      },
      async doStream() {
        throw new Error("unused")
      },
    }
    const prompt = [
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
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "reasoning ana@acme.com" },
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
    ]
    const original = structuredClone(prompt)

    await (withPii(model, { session }) as any).doGenerate({ prompt })

    expect(prompt).toEqual(original)
    expect(seen.prompt[0].content).not.toContain("ana@acme.com")
    expect(seen.prompt[1].content[0].text).not.toContain("ana@acme.com")
    expect(seen.prompt[1].content[1]).toBe((prompt as any)[1].content[1])
    expect(seen.prompt[2].content[0].text).toBe("reasoning ana@acme.com")
    expect(seen.prompt[2].content[1].input.email).not.toBe("ana@acme.com")
    expect(seen.prompt[2].content[2].output.value).not.toContain("ana@acme.com")
    expect(seen.prompt[2].content[3].output.value.email).not.toBe(
      "ana@acme.com"
    )
    expect(seen.prompt[2].content[4].output.reason).toBe("reason ana@acme.com")
  })

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

  it("restores interleaved text and tool channels at protocol boundaries", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    let sourceChunks: any[] = []
    let sourceIndex = 0
    const model: any = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("unused")
      },
      async doStream() {
        const token = Object.keys(session.mapping)[0]!
        sourceChunks = [
          { type: "text-start", id: "text-1", marker: "keep" },
          { type: "text-delta", id: "text-1", delta: "Hello " },
          { type: "tool-input-start", id: "tool-1", toolName: "lookup" },
          { type: "tool-input-delta", id: "tool-1", delta: '{"email":"' },
          { type: "text-delta", id: "text-1", delta: token.slice(0, 4) },
          {
            type: "tool-input-delta",
            id: "tool-1",
            delta: token.slice(0, 4),
            control: "first",
          },
          {
            type: "tool-input-delta",
            id: "tool-1",
            delta: token.slice(4),
            control: true,
          },
          { type: "text-delta", id: "text-1", delta: token.slice(4) },
          { type: "text-delta", id: "text-1", delta: "!" },
          {
            type: "tool-input-delta",
            id: "tool-1",
            delta: '", "large":9007199254740993}',
          },
          { type: "tool-input-end", id: "tool-1", endControl: "x" },
          { type: "text-end", id: "text-1" },
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
          },
        ]
        return {
          stream: new ReadableStream({
            pull(controller) {
              if (sourceIndex === sourceChunks.length) controller.close()
              else controller.enqueue(sourceChunks[sourceIndex++])
            },
          }),
          response: { headers: { "x-test": "yes" } },
        }
      },
    }
    const wrapped: any = withPii(model, { session })
    const result = await wrapped.doStream({
      prompt: [{ role: "system", content: "ana@acme.com" }],
    })
    const output: any[] = []
    const reader = result.stream.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      output.push(next.value)
    }

    const token = Object.keys(session.mapping)[0]!
    const originalChunks = sourceChunks.map((chunk) => ({ ...chunk }))
    expect(token).toContain("EMAIL")
    expect(
      output
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe(`Hello ana@acme.com!`)
    const toolDeltas = output.filter((part) => part.type === "tool-input-delta")
    expect(toolDeltas.slice(0, 3).every((part) => part.delta === "")).toBe(true)
    expect(toolDeltas.at(-1)).toMatchObject({
      id: "tool-1",
      delta: '{"email":"ana@acme.com", "large":9007199254740993}',
    })
    expect(output.find((part) => part.type === "tool-input-end")).toMatchObject(
      {
        type: "tool-input-end",
        endControl: "x",
      }
    )
    expect(sourceChunks).toEqual(originalChunks)
  })

  it("honors pre-aborted and post-protection signals without touching the provider", async () => {
    const reason = new Error("caller stopped")
    const controller = new AbortController()
    controller.abort(reason)
    let generateCalls = 0
    const model: any = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      async doGenerate() {
        generateCalls++
        throw new Error("must not reach provider")
      },
      async doStream() {
        generateCalls++
        throw new Error("must not reach provider")
      },
    }
    await expect(
      (withPii(model) as any).doGenerate({
        prompt: [],
        abortSignal: controller.signal,
      })
    ).rejects.toBe(reason)
    expect(generateCalls).toBe(0)

    let releaseProtection!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseProtection = resolve
    })
    const session: any = {
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
    const call = (withPii(model, { session }) as any).doGenerate({
      prompt: [{ role: "system", content: "PII" }],
      abortSignal: postAbort.signal,
    })
    postAbort.abort(reason)
    releaseProtection()
    await expect(call).rejects.toBe(reason)
    expect(generateCalls).toBe(0)
  })

  it("restores the complete v4 generated content matrix and envelope immutably", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    let providerResult: any
    const model: any = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      async doGenerate() {
        const token = Object.keys(session.mapping)[0]!
        providerResult = {
          content: [
            { type: "text", text: `hello ${token}` },
            { type: "reasoning", text: `reason ${token}` },
            { type: "custom", kind: "test.custom", marker: token },
            {
              type: "file",
              mediaType: "text/plain",
              data: { type: "data", data: "abc" },
            },
            {
              type: "reasoning-file",
              mediaType: "text/plain",
              data: { type: "data", data: "def" },
            },
            {
              type: "source",
              sourceType: "url",
              id: "source-1",
              url: `https://${token}.example`,
            },
            {
              type: "tool-approval-request",
              approvalId: "approval-1",
              toolCallId: "call-1",
            },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "lookup",
              input: `{ "email": "${token}", "large": 9007199254740993 }`,
            },
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "lookup",
              result: `tool ${token}`,
            },
          ],
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
      async doStream() {
        throw new Error("unused")
      },
    }
    const result = await (withPii(model, { session }) as any).doGenerate({
      prompt: [{ role: "system", content: "ana@acme.com" }],
    })

    expect(providerResult.content[0].text).toContain("[EMAIL_")
    expect(providerResult.content[1].text).toContain("[EMAIL_")
    expect(result.content[0].text).toBe("hello ana@acme.com")
    expect(result.content[1].text).toBe("reason [EMAIL_1]")
    expect(result.content[2]).toBe(providerResult.content[2])
    expect(result.content[3]).toBe(providerResult.content[3])
    expect(result.content[5]).toBe(providerResult.content[5])
    expect(result.content[7].input).toBe(
      '{ "email": "ana@acme.com", "large": 9007199254740993 }'
    )
    expect(result.content[8].result).toBe("tool ana@acme.com")
    expect(result.finishReason).toBe(providerResult.finishReason)
    expect(result.usage).toBe(providerResult.usage)
    expect(result.providerMetadata).toBe(providerResult.providerMetadata)
    expect(result.request).toBe(providerResult.request)
    expect(result.response).toBe(providerResult.response)
    expect(result.unknownControl).toBe(providerResult.unknownControl)
    expect(providerResult.content[0].text).not.toBe("hello ana@acme.com")
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
    const model: any = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("unused")
      },
      async doStream() {
        return {
          stream: new ReadableStream({
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
    }
    const result = await (withPii(model, { session }) as any).doStream({
      prompt: [],
    })
    await expect(result.stream.getReader().read()).rejects.toBe(sourceError)
    // An errored source is already terminal, so Web Streams does not invoke
    // its underlying cancel algorithm a second time.
    expect(cancelCalls).toBe(0)

    const second = await (withPii(model, { session }) as any).doStream({
      prompt: [],
    })
    const reader = second.stream.getReader()
    await reader.cancel(cancelReason)
    expect(cancelCalls).toBe(1)
    expect(cancelValue).toBe(cancelReason)
  })

  it("treats an error part and abort as terminal without flushing privacy tails", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@acme.com" }],
    }).createSession()
    const abortReason = new Error("aborted")
    const controller = new AbortController()
    let sourceCancelCalls = 0
    let sourceController!: ReadableStreamDefaultController<any>
    const model: any = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("unused")
      },
      async doStream() {
        const token = Object.keys(session.mapping)[0]!
        return {
          stream: new ReadableStream({
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
            },
          }),
        }
      },
    }
    const wrapped: any = withPii(model, { session })
    const result = await wrapped.doStream({
      prompt: [{ role: "system", content: "ana@acme.com" }],
    })
    const reader = result.stream.getReader()
    const first = await reader.read()
    expect(first.value.delta).toBe("")
    const errorPart = await reader.read()
    expect(errorPart.value.type).toBe("error")
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
