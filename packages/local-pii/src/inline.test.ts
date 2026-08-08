import { describe, expect, it, vi } from "vitest"
import { createAnonymizer } from "./anonymizer"
import {
  runInline,
  runInlineJson,
  runInlineText,
  type InlineContext,
} from "./inline"
import { token } from "./placeholder/strategies"
import type { PiiSession } from "./session"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

describe("runInlineText", () => {
  it("protects the model-facing input and restores the complete response", async () => {
    const wire: string[] = []

    const output = await runInlineText({
      input: "Email ana@acme.com",
      call: async (protectedText, context) => {
        expect("session" in context).toBe(false)
        // @ts-expect-error The model callback must not receive the PII vault.
        expect(context.session).toBeUndefined()
        wire.push(protectedText)
        return `Confirmed ${protectedText}`
      },
    })

    expect(wire).toHaveLength(1)
    expect(wire[0]).not.toContain("ana@acme.com")
    expect(wire[0]).toMatch(TOKEN)
    expect(output).toBe("Confirmed Email ana@acme.com")
  })

  it("borrows a supplied session without clearing its conversation mapping", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const clear = vi.spyOn(session, "clear")

    await runInlineText({
      input: "Email ana@acme.com",
      session,
      call: async (protectedText) => protectedText,
    })

    expect(clear).not.toHaveBeenCalled()
    expect(Object.values(session.mapping)).toContain("ana@acme.com")
  })

  it("clears an internally owned session after a successful call", async () => {
    let owned: PiiSession | undefined
    let clear: ReturnType<typeof vi.spyOn> | undefined

    await runInline({
      input: "Email ana@acme.com",
      protect: async (input, context) => {
        owned = context.session
        clear = vi.spyOn(context.session, "clear")
        return (await context.session.anonymize(input)).redactedText
      },
      call: async (protectedText) => protectedText,
      restore: (output, { session }) =>
        session.rehydrate(output, { lenient: true }),
    })

    expect(clear).toHaveBeenCalledOnce()
    expect(owned?.mapping).toEqual({})
  })

  it("preserves the original callback error and still clears owned state", async () => {
    const failure = new Error("model failed")
    let owned: PiiSession | undefined
    let clear: ReturnType<typeof vi.spyOn> | undefined

    const result = runInline({
      input: "Email ana@acme.com",
      protect: async (input, context) => {
        owned = context.session
        clear = vi.spyOn(context.session, "clear")
        return (await context.session.anonymize(input)).redactedText
      },
      call: async () => {
        throw failure
      },
      restore: (output) => output,
    })

    await expect(result).rejects.toBe(failure)
    expect(clear).toHaveBeenCalledOnce()
    expect(owned?.mapping).toEqual({})
  })

  it("forwards the AbortSignal and preserves its abort reason", async () => {
    const controller = new AbortController()
    const reason = new Error("user stopped")
    let owned: PiiSession | undefined
    let clear: ReturnType<typeof vi.spyOn> | undefined
    let context: InlineContext | undefined

    const result = runInline({
      input: "Email ana@acme.com",
      signal: controller.signal,
      protect: async (input, transformContext) => {
        owned = transformContext.session
        clear = vi.spyOn(transformContext.session, "clear")
        return (await transformContext.session.anonymize(input)).redactedText
      },
      call: async (protectedText, nextContext) => {
        context = nextContext
        controller.abort(reason)
        nextContext.signal?.throwIfAborted()
        return protectedText
      },
      restore: (output) => output,
    })

    await expect(result).rejects.toBe(reason)
    expect(context?.signal).toBe(controller.signal)
    expect(context && "session" in context).toBe(false)
    expect(clear).toHaveBeenCalledOnce()
    expect(owned?.mapping).toEqual({})
  })
})

describe("runInlineJson", () => {
  it("protects nested string leaves, restores output, and does not mutate input", async () => {
    const input = {
      contact: {
        email: "ana@acme.com",
        phones: ["+49 151 12345678", ""],
      },
      attempts: 2,
      enabled: true,
    } as const
    const snapshot = structuredClone(input)
    let wire: unknown

    const output = await runInlineJson<
      typeof input,
      { summary: string; nested: unknown }
    >({
      input,
      call: async (protectedInput) => {
        wire = protectedInput
        const protectedContact = protectedInput as {
          contact: { email: string; phones: readonly string[] }
        }
        return {
          summary: `${protectedContact.contact.email} / ${protectedContact.contact.phones[0]}`,
          nested: protectedInput,
        }
      },
    })

    expect(JSON.stringify(wire)).not.toContain("ana@acme.com")
    expect(JSON.stringify(wire)).not.toContain("+49 151 12345678")
    expect(output.summary).toBe("ana@acme.com / +49 151 12345678")
    expect(output.nested).toEqual(input)
    expect(input).toEqual(snapshot)
  })
})

describe("runInline", () => {
  it("executes custom protect, call, and restore steps in order", async () => {
    const steps: string[] = []

    const output = await runInline<number, string, string, number>({
      input: 7,
      protect: async (value) => {
        steps.push("protect")
        return `#${value}`
      },
      call: async (value) => {
        steps.push("call")
        return `${value}!`
      },
      restore: (value) => {
        steps.push("restore")
        return value.length
      },
    })

    expect(output).toBe(3)
    expect(steps).toEqual(["protect", "call", "restore"])
  })
})
