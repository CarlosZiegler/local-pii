import { describe, expect, it, vi } from "vitest"
import { createAnonymizer, type Anonymizer } from "./anonymizer"
import {
  runInline,
  runInlineJson,
  runInlineText,
  type InlineContext,
} from "./inline"
import { token } from "./placeholder/strategies"
import type { PiiSession } from "./session"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

function withOwnedSession(session: PiiSession): Anonymizer {
  const base = createAnonymizer({ placeholders: token() })
  return {
    ...base,
    createSession: () => session,
  }
}

describe("runInlineText", () => {
  it("protects the model-facing input and restores the complete response", async () => {
    const wire: string[] = []

    const output = await runInlineText({
      input: "Email ana@acme.com",
      call: async (protectedText, context) => {
        expect(context.session.mapping).not.toEqual({})
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
    const owned = createAnonymizer({ placeholders: token() }).createSession()
    const clear = vi.spyOn(owned, "clear")

    await runInlineText({
      input: "Email ana@acme.com",
      anonymizer: withOwnedSession(owned),
      call: async (protectedText) => protectedText,
    })

    expect(clear).toHaveBeenCalledOnce()
    expect(owned.mapping).toEqual({})
  })

  it("preserves the original callback error and still clears owned state", async () => {
    const failure = new Error("model failed")
    const owned = createAnonymizer({ placeholders: token() }).createSession()
    const clear = vi.spyOn(owned, "clear")

    const result = runInlineText({
      input: "Email ana@acme.com",
      anonymizer: withOwnedSession(owned),
      call: async () => {
        throw failure
      },
    })

    await expect(result).rejects.toBe(failure)
    expect(clear).toHaveBeenCalledOnce()
    expect(owned.mapping).toEqual({})
  })

  it("forwards the AbortSignal and preserves its abort reason", async () => {
    const controller = new AbortController()
    const reason = new Error("user stopped")
    const owned = createAnonymizer({ placeholders: token() }).createSession()
    const clear = vi.spyOn(owned, "clear")
    let context: InlineContext | undefined

    const result = runInlineText({
      input: "Email ana@acme.com",
      anonymizer: withOwnedSession(owned),
      signal: controller.signal,
      call: async (protectedText, nextContext) => {
        context = nextContext
        controller.abort(reason)
        nextContext.signal?.throwIfAborted()
        return protectedText
      },
    })

    await expect(result).rejects.toBe(reason)
    expect(context?.signal).toBe(controller.signal)
    expect(clear).toHaveBeenCalledOnce()
    expect(owned.mapping).toEqual({})
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

    const output = await runInlineJson<typeof input, { summary: string; nested: unknown }>({
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
