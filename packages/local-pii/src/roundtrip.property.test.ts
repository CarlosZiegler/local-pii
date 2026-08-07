import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { createAnonymizer } from "./anonymizer"
import { token } from "./placeholder/strategies"
import { rehydrate } from "./rehydrate"

// Filler words that no detector should ever match (no @, digits, dots, brackets).
const FILLERS = [
  "ola", "meet", "call", "about", "tomorrow", "the", "project",
  "please", "regarding", "send", "details", "to", "hey", "note",
]
const PII = [
  "a@b.io",
  "ana.silva@example.com",
  "joao+news@mail.co.uk",
  "+49 151 12345678",
  "(030) 555-1234",
  "4111 1111 1111 1111",
  "DE89 3704 0044 0532 0130 00",
  "192.168.0.1",
  "https://example.com/x",
]

const segment = fc.oneof(fc.constantFrom(...FILLERS), fc.constantFrom(...PII))

describe("round-trip invariant (property-based)", () => {
  it("rehydrate(anonymize(x)) === x for any PII/filler mix, with opaque tokens", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(segment, { minLength: 1, maxLength: 14 }),
        async (segments) => {
          const text = segments.join(" ")
          const pii = createAnonymizer({ placeholders: token() })
          const { redactedText, mapping } = await pii.anonymize(text)
          return rehydrate(redactedText, mapping) === text
        },
      ),
      { numRuns: 300 },
    )
  })

  // Characterizes a real limitation: readable [TYPE_N] placeholders can collide
  // with placeholder-shaped text already in the input. Opaque token() avoids it.
  it("sequential placeholders can collide with placeholder-shaped input; token() does not", async () => {
    const text = "template [EMAIL_1] then real ana@acme.com"

    const seq = createAnonymizer() // sequential (default)
    const r1 = await seq.anonymize(text)
    expect(rehydrate(r1.redactedText, r1.mapping)).not.toBe(text) // ⚠️ collision

    const tok = createAnonymizer({ placeholders: token() })
    const r2 = await tok.anonymize(text)
    expect(rehydrate(r2.redactedText, r2.mapping)).toBe(text) // ✓ safe
  })
})
