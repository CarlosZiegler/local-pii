import fc from "fast-check"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createAnonymizer } from "./anonymizer"
import {
  runInline,
  runInlineJson,
  runInlineText,
  runInlineTextStream,
  type InlineContext,
} from "./inline"
import { token } from "./placeholder/strategies"
import type { PiiSession } from "./session"
import type { Anonymizer } from "./anonymizer"
import type { DetectionModel, Entity } from "./types"

const TOKEN = /PII[0-9A-HJKMNP-TV-Z]+/

const sessionTracker = vi.hoisted(() => ({ sessions: [] as PiiSession[] }))

vi.mock("./anonymizer", async () => {
  const actual =
    await vi.importActual<typeof import("./anonymizer")>("./anonymizer")

  return {
    ...actual,
    createAnonymizer: (...args: Parameters<typeof actual.createAnonymizer>) => {
      const anonymizer = actual.createAnonymizer(...args)
      return {
        ...anonymizer,
        createSession: () => {
          const session = anonymizer.createSession()
          sessionTracker.sessions.push(session)
          return session
        },
      }
    },
  }
})

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let output = ""
  for await (const chunk of iterable) output += chunk
  return output
}

function partition(text: string, lengths: readonly number[]): string[] {
  const chunks: string[] = []
  let offset = 0
  let index = 0
  while (offset < text.length) {
    const length = lengths[index % lengths.length] ?? text.length
    chunks.push(text.slice(offset, offset + length))
    offset += length
    index += 1
  }
  return chunks
}

function joaoDetectionModel(): DetectionModel {
  return {
    name: "mock-joao",
    load: vi.fn(async () => {}),
    detect: vi.fn(async (text): Promise<Entity[]> => {
      const start = text.indexOf("João")
      if (start < 0) return []
      return [
        {
          start,
          end: start + "João".length,
          text: "João",
          type: "GIVEN_NAME",
          source: "ner",
          confidence: 1,
        },
      ]
    }),
    dispose: vi.fn(async () => {}),
  }
}

function callerAnonymizer(): Anonymizer {
  return createAnonymizer({
    detectors: "none",
    detection: joaoDetectionModel(),
    placeholders: token(),
  })
}

function instrumentSessionCreation(anonymizer: Anonymizer) {
  const createSession = anonymizer.createSession.bind(anonymizer)
  const created: PiiSession[] = []
  const createSessionSpy = vi
    .spyOn(anonymizer, "createSession")
    .mockImplementation(() => {
      const session = createSession()
      created.push(session)
      vi.spyOn(session, "clear")
      return session
    })
  return { created, createSessionSpy }
}

function anonymizerWithClearFailure(cleanup: Error) {
  const anonymizer = callerAnonymizer()
  const session = anonymizer.createSession()
  const clear = vi.fn(() => {
    throw cleanup
  })
  session.clear = clear
  const createSessionSpy = vi
    .spyOn(anonymizer, "createSession")
    .mockReturnValue(session)
  return { anonymizer, clear, createSessionSpy, session }
}

beforeEach(() => {
  sessionTracker.sessions.length = 0
})

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

  it("derives a temporary session from the caller anonymizer", async () => {
    const anonymizer = callerAnonymizer()
    const { created, createSessionSpy } = instrumentSessionCreation(anonymizer)
    let wire = ""

    const output = await runInlineText({
      input: "Olá João",
      anonymizer,
      call: async (protectedText) => {
        wire = protectedText
        return `Confirmado: ${protectedText}`
      },
    })

    expect(createSessionSpy).toHaveBeenCalledOnce()
    expect(wire).not.toContain("João")
    expect(wire).toMatch(TOKEN)
    expect(output).toBe("Confirmado: Olá João")
    expect(created[0]?.clear).toHaveBeenCalledOnce()
    expect(created[0]?.mapping).toEqual({})
  })

  it("prefers a supplied session over the caller anonymizer", async () => {
    const anonymizer = callerAnonymizer()
    const session = anonymizer.createSession()
    const clear = vi.spyOn(session, "clear")
    const createSessionSpy = vi.spyOn(anonymizer, "createSession")
    let wire = ""

    const output = await runInlineText({
      input: "Olá João",
      session,
      anonymizer,
      call: async (protectedText) => {
        wire = protectedText
        return protectedText
      },
    })

    expect(createSessionSpy).not.toHaveBeenCalled()
    expect(wire).not.toContain("João")
    expect(wire).toMatch(TOKEN)
    expect(output).toBe("Olá João")
    expect(clear).not.toHaveBeenCalled()
    expect(Object.values(session.mapping)).toContain("João")
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

  it("derives a caller-anonymizer session for JSON protection and restoration", async () => {
    const anonymizer = callerAnonymizer()
    const { created } = instrumentSessionCreation(anonymizer)
    const input = { greeting: "Olá João", count: 1 } as const

    const output = await runInlineJson<typeof input, { reply: string }>({
      input,
      anonymizer,
      call: async (protectedInput) => {
        expect(JSON.stringify(protectedInput)).not.toContain("João")
        expect(JSON.stringify(protectedInput)).toMatch(TOKEN)
        return { reply: protectedInput.greeting }
      },
    })

    expect(output).toEqual({ reply: "Olá João" })
    expect(created[0]?.clear).toHaveBeenCalledOnce()
    expect(created[0]?.mapping).toEqual({})
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

  it("protects and restores João through the advanced generic seam", async () => {
    const anonymizer = callerAnonymizer()
    const { created } = instrumentSessionCreation(anonymizer)

    const output = await runInline({
      input: "Olá João",
      anonymizer,
      protect: async (input, { session }) =>
        (await session.anonymize(input)).redactedText,
      call: async (protectedInput) => {
        expect(protectedInput).not.toContain("João")
        expect(protectedInput).toMatch(TOKEN)
        return `Resposta: ${protectedInput}`
      },
      restore: (response, { session }) =>
        session.rehydrate(response, { lenient: true }),
    })

    expect(output).toBe("Resposta: Olá João")
    expect(created[0]?.clear).toHaveBeenCalledOnce()
    expect(created[0]?.mapping).toEqual({})
  })

  it("clears a caller-anonymizer session after failure", async () => {
    const anonymizer = callerAnonymizer()
    const { created } = instrumentSessionCreation(anonymizer)
    const failure = new Error("model failed")

    await expect(
      runInline({
        input: "Olá João",
        anonymizer,
        protect: async (input, { session }) =>
          (await session.anonymize(input)).redactedText,
        call: async () => {
          throw failure
        },
        restore: (response) => response,
      })
    ).rejects.toBe(failure)

    expect(created[0]?.clear).toHaveBeenCalledOnce()
    expect(created[0]?.mapping).toEqual({})
  })

  it("clears a caller-anonymizer session after abort", async () => {
    const anonymizer = callerAnonymizer()
    const { created } = instrumentSessionCreation(anonymizer)
    const controller = new AbortController()
    const reason = new Error("user stopped")

    await expect(
      runInline({
        input: "Olá João",
        signal: controller.signal,
        anonymizer,
        protect: async (input, { session }) =>
          (await session.anonymize(input)).redactedText,
        call: async (protectedInput) => {
          controller.abort(reason)
          return protectedInput
        },
        restore: (response) => response,
      })
    ).rejects.toBe(reason)

    expect(created[0]?.clear).toHaveBeenCalledOnce()
    expect(created[0]?.mapping).toEqual({})
  })

  it("preserves the primary error when complete cleanup fails", async () => {
    const primary = new Error("primary")
    const cleanup = new Error("cleanup")
    const { anonymizer, clear } = anonymizerWithClearFailure(cleanup)

    await expect(
      runInline({
        input: "Olá João",
        anonymizer,
        protect: async (input, { session }) =>
          (await session.anonymize(input)).redactedText,
        call: async () => {
          throw primary
        },
        restore: (response) => response,
      })
    ).rejects.toBe(primary)

    expect(clear).toHaveBeenCalledOnce()
  })

  it("surfaces cleanup failure after a successful complete operation", async () => {
    const cleanup = new Error("cleanup")
    const { anonymizer, clear } = anonymizerWithClearFailure(cleanup)

    await expect(
      runInline({
        input: "Olá João",
        anonymizer,
        protect: async (input, { session }) =>
          (await session.anonymize(input)).redactedText,
        call: async (protectedInput) => protectedInput,
        restore: (response) => response,
      })
    ).rejects.toBe(cleanup)

    expect(clear).toHaveBeenCalledOnce()
  })
})

describe("runInlineTextStream", () => {
  it("restores an opaque placeholder at every possible split boundary", async () => {
    const input = "Email ana@acme.com"
    const probe = createAnonymizer({ placeholders: token() }).createSession()
    const probeInput = (await probe.anonymize(input)).redactedText
    const probePlaceholder = probeInput.match(TOKEN)?.[0]
    expect(probePlaceholder).toBeDefined()

    for (let split = 0; split <= probePlaceholder!.length; split += 1) {
      const session = createAnonymizer({
        placeholders: token(),
      }).createSession()
      const protectedInput = (await session.anonymize(input)).redactedText
      const placeholder = protectedInput.match(TOKEN)?.[0]
      expect(placeholder).toBeDefined()
      const boundary = protectedInput.indexOf(placeholder!) + split

      const output = await collect(
        runInlineTextStream({
          input,
          session,
          call: async function* (wireInput) {
            expect(wireInput).toBe(protectedInput)
            const response = `Confirmed ${wireInput}`
            const responseBoundary = "Confirmed ".length + boundary
            yield response.slice(0, responseBoundary)
            yield response.slice(responseBoundary)
          },
        })
      )

      expect(output).toBe(`Confirmed ${input}`)
    }
  })

  it("is lazy, keeps its owned session alive, and clears it on early return", async () => {
    let upstreamClosed = false
    const stream = runInlineTextStream({
      input: "Email ana@acme.com",
      call: async function* (wireInput) {
        try {
          yield `${wireInput} ${"safe ".repeat(12)}`
          yield "unread"
        } finally {
          upstreamClosed = true
        }
      },
    })

    expect(sessionTracker.sessions).toHaveLength(0)
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    const owned = sessionTracker.sessions[0]

    expect(first.done).toBe(false)
    expect(first.value).toContain("ana@acme.com")
    expect(Object.values(owned?.mapping ?? {})).toContain("ana@acme.com")

    await iterator.return?.()

    expect(upstreamClosed).toBe(true)
    expect(owned?.mapping).toEqual({})
  })

  it("clears an owned session after normal completion", async () => {
    const output = await collect(
      runInlineTextStream({
        input: "Email ana@acme.com",
        call: async function* (wireInput) {
          yield wireInput
        },
      })
    )

    expect(output).toBe("Email ana@acme.com")
    expect(sessionTracker.sessions).toHaveLength(1)
    expect(sessionTracker.sessions[0]?.mapping).toEqual({})
  })

  it("derives and clears a caller-anonymizer session after stream completion", async () => {
    const anonymizer = callerAnonymizer()
    const { created } = instrumentSessionCreation(anonymizer)

    const output = await collect(
      runInlineTextStream({
        input: "Olá João",
        anonymizer,
        call: async function* (wireInput) {
          expect(wireInput).not.toContain("João")
          expect(wireInput).toMatch(TOKEN)
          yield `Resposta: ${wireInput}`
        },
      })
    )

    expect(output).toBe("Resposta: Olá João")
    expect(created[0]?.clear).toHaveBeenCalledOnce()
    expect(created[0]?.mapping).toEqual({})
  })

  it("clears a caller-anonymizer session on streamed early return", async () => {
    const anonymizer = callerAnonymizer()
    const { created } = instrumentSessionCreation(anonymizer)
    let upstreamClosed = false

    const iterator = runInlineTextStream({
      input: "Olá João",
      anonymizer,
      call: async function* (wireInput) {
        try {
          yield wireInput
          yield "unread"
        } finally {
          upstreamClosed = true
        }
      },
    })[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toBeTypeOf("string")
    expect(Object.values(created[0]?.mapping ?? {})).toContain("João")
    await iterator.return?.()

    expect(upstreamClosed).toBe(true)
    expect(created[0]?.clear).toHaveBeenCalledOnce()
    expect(created[0]?.mapping).toEqual({})
  })

  it("preserves the primary error when streamed cleanup fails", async () => {
    const primary = new Error("primary")
    const cleanup = new Error("cleanup")
    const { anonymizer, clear } = anonymizerWithClearFailure(cleanup)

    const stream = runInlineTextStream({
      input: "Olá João",
      anonymizer,
      call: () => {
        throw primary
      },
    })

    await expect(collect(stream)).rejects.toBe(primary)
    expect(clear).toHaveBeenCalledOnce()
  })

  it("surfaces stream cleanup failure after successful completion", async () => {
    const cleanup = new Error("cleanup")
    const { anonymizer, clear } = anonymizerWithClearFailure(cleanup)

    await expect(
      collect(
        runInlineTextStream({
          input: "Olá João",
          anonymizer,
          call: async function* (wireInput) {
            yield wireInput
          },
        })
      )
    ).rejects.toBe(cleanup)

    expect(clear).toHaveBeenCalledOnce()
  })

  it("preserves the first stream cleanup failure", async () => {
    const upstreamCleanup = new Error("upstream cleanup")
    const sessionCleanup = new Error("session cleanup")
    const { anonymizer, clear } = anonymizerWithClearFailure(sessionCleanup)
    const upstream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false as const, value: "chunk" }),
          return: async () => {
            throw upstreamCleanup
          },
        }
      },
    }

    const iterator = runInlineTextStream({
      input: "Olá João",
      anonymizer,
      call: () => upstream,
    })[Symbol.asyncIterator]()

    await iterator.next()
    await expect(iterator.return?.()).rejects.toBe(upstreamCleanup)
    expect(clear).toHaveBeenCalledOnce()
  })

  it("preserves an upstream error and discards an incomplete token tail", async () => {
    const failure = new Error("stream failed")
    let emitted = ""
    const stream = runInlineTextStream({
      input: "Email ana@acme.com",
      call: async function* (wireInput) {
        const placeholder = wireInput.match(TOKEN)?.[0]
        expect(placeholder).toBeDefined()
        yield `Before ${placeholder!.slice(0, -2)}`
        throw failure
      },
    })

    try {
      for await (const chunk of stream) emitted += chunk
      throw new Error("expected stream to fail")
    } catch (error) {
      expect(error).toBe(failure)
    }

    expect(emitted).not.toContain("PII")
    expect(sessionTracker.sessions[0]?.mapping).toEqual({})
  })

  it("preserves abort identity, closes upstream, and discards buffered tails", async () => {
    const controller = new AbortController()
    const reason = new Error("user stopped")
    let upstreamClosed = false
    let emitted = ""
    const stream = runInlineTextStream({
      input: "Email ana@acme.com",
      signal: controller.signal,
      call: async function* (wireInput, context) {
        expect(context.signal).toBe(controller.signal)
        expect("session" in context).toBe(false)
        const placeholder = wireInput.match(TOKEN)?.[0]
        try {
          yield `Before ${placeholder!.slice(0, -2)}`
          controller.abort(reason)
          yield "ignored"
        } finally {
          upstreamClosed = true
        }
      },
    })

    try {
      for await (const chunk of stream) emitted += chunk
      throw new Error("expected stream to abort")
    } catch (error) {
      expect(error).toBe(reason)
    }

    expect(emitted).not.toContain("PII")
    expect(upstreamClosed).toBe(true)
    expect(sessionTracker.sessions[0]?.mapping).toEqual({})
  })

  it("keeps a borrowed session mapping after completion", async () => {
    const session = createAnonymizer({ placeholders: token() }).createSession()
    const clear = vi.spyOn(session, "clear")

    await collect(
      runInlineTextStream({
        input: "Email ana@acme.com",
        session,
        call: async function* (wireInput) {
          yield wireInput
        },
      })
    )

    expect(clear).not.toHaveBeenCalled()
    expect(Object.values(session.mapping)).toContain("ana@acme.com")
  })

  it("rehydrates arbitrary chunk partitions", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 24 }), {
          minLength: 1,
          maxLength: 16,
        }),
        async (lengths) => {
          const input = "ana@acme.com and +49 151 12345678"
          const session = createAnonymizer({
            placeholders: token(),
          }).createSession()

          const output = await collect(
            runInlineTextStream({
              input,
              session,
              call: async function* (wireInput) {
                const response = `First ${wireInput}; again ${wireInput}.`
                for (const chunk of partition(response, lengths)) yield chunk
              },
            })
          )

          expect(output).toBe(`First ${input}; again ${input}.`)
        }
      ),
      { numRuns: 50 }
    )
  })
})
