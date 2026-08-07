import { describe, expect, it } from "vitest"
import { createAnonymizer } from "./anonymizer"

// These tests ASSERT current limitations, so the docs stay honest. When a future
// improvement flips one of these, the test fails → update the Limitations page.
describe("known limitations (characterization)", () => {
  it("deterministic-only leaves personal names in the clear (the NER model's job)", async () => {
    const text = "meeting with Ana Silva tomorrow"
    // No NER backend configured → names are not redacted.
    expect((await createAnonymizer().anonymize(text)).redactedText).toBe(text)
  })

  it("indirect identifiers pass through untouched", async () => {
    // No single detector catches "who" this describes.
    const text = "the only Brazilian engineer at company X in Kempten"
    expect((await createAnonymizer().anonymize(text)).redactedText).toBe(text)
  })

  it("readable placeholders can collide with placeholder-shaped input; token() cannot", async () => {
    const { token } = await import("./placeholder/strategies")
    const { rehydrate } = await import("./rehydrate")
    const text = "template [EMAIL_1] plus real ana@acme.com"

    const seq = await createAnonymizer().anonymize(text) // sequential (default)
    expect(rehydrate(seq.redactedText, seq.mapping)).not.toBe(text) // ⚠️ collision

    const tok = await createAnonymizer({ placeholders: token() }).anonymize(text)
    expect(rehydrate(tok.redactedText, tok.mapping)).toBe(text) // ✓ opaque tokens are safe
  })
})
