import { describe, expect, it } from "vitest"
import { createAnonymizer } from "./anonymizer"
import type { Entity, NerBackend } from "./types"

function mockNer(fn: (text: string) => Entity[]): NerBackend {
  return {
    name: "mock",
    load: async () => {},
    detect: async (t) => fn(t),
    dispose: async () => {},
  }
}

describe("idempotence", () => {
  it("re-anonymizing already-redacted text changes nothing", async () => {
    const pii = createAnonymizer()
    const once = (await pii.anonymize("mail a@b.io and call +49 151 12345678"))
      .redactedText
    const twice = (await pii.anonymize(once)).redactedText
    expect(twice).toBe(once)
  })
})

describe("vault-dictionary stability across a session", () => {
  it("reuses a known value's placeholder even when NER later misses it", async () => {
    let call = 0
    const ner = mockNer((t) => {
      call += 1
      // NER only fires on the first turn (simulating detection volatility).
      if (call > 1) return []
      const i = t.indexOf("João")
      return i < 0
        ? []
        : [
            {
              start: i,
              end: i + 4,
              text: "João",
              type: "GIVEN_NAME",
              source: "ner",
              confidence: 0.9,
            },
          ]
    })

    const session = createAnonymizer({ ner }).createSession()
    const t1 = await session.anonymize("João called")
    expect(t1.redactedText).toBe("[GIVEN_NAME_1] called")

    // Second turn: NER returns nothing, but the vault-dictionary catches João.
    const t2 = await session.anonymize("later João emailed the team")
    expect(t2.redactedText).toBe("later [GIVEN_NAME_1] emailed the team")
    expect(session.rehydrate(t2.redactedText)).toBe(
      "later João emailed the team"
    )
  })
})
