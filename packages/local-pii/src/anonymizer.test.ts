import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { createAnonymizer } from "./anonymizer"
import { rehydrate } from "./rehydrate"
import { hashed } from "./placeholder/strategies"
import type { AnonymizerOptions, DetectionModel, NerBackend } from "./index"
import type { Entity } from "./types"

expectTypeOf<DetectionModel>().toEqualTypeOf<NerBackend>()
expectTypeOf<NerBackend>().toEqualTypeOf<DetectionModel>()
expectTypeOf<AnonymizerOptions["detection"]>().toEqualTypeOf<
  DetectionModel | false | undefined
>()
expectTypeOf<AnonymizerOptions["ner"]>().toEqualTypeOf<
  NerBackend | false | undefined
>()

/** A NER backend that returns whatever the caller computes from the text. */
function mockNer(fn: (text: string) => Entity[]): NerBackend {
  return {
    name: "mock",
    load: vi.fn(async () => {}),
    detect: vi.fn(async (t) => fn(t)),
    dispose: vi.fn(async () => {}),
  }
}

function span(text: string, needle: string, type: Entity["type"]): Entity {
  const start = text.indexOf(needle)
  return {
    start,
    end: start + needle.length,
    text: needle,
    type,
    source: "ner",
    confidence: 0.99,
  }
}

const NOTE =
  "Meu telefone é +49 151 12345678 e meu email é joao@example.com, cartão 4111 1111 1111 1111."

describe("createAnonymizer (deterministic)", () => {
  it("round-trips: rehydrate(redacted, mapping) === original", async () => {
    const pii = createAnonymizer()
    const { redactedText, mapping } = await pii.anonymize(NOTE)
    expect(rehydrate(redactedText, mapping)).toBe(NOTE)
  })

  it("removes the raw PII and inserts readable placeholders", async () => {
    const pii = createAnonymizer()
    const { redactedText } = await pii.anonymize(NOTE)
    expect(redactedText).not.toContain("joao@example.com")
    expect(redactedText).not.toContain("+49 151 12345678")
    expect(redactedText).not.toContain("4111 1111 1111 1111")
    expect(redactedText).toContain("[EMAIL_1]")
    expect(redactedText).toContain("[PHONE_1]")
    expect(redactedText).toContain("[CREDIT_CARD_1]")
  })

  it("dedupes repeated values to one stable placeholder", async () => {
    const pii = createAnonymizer()
    const { redactedText, mapping } = await pii.anonymize(
      "write to a@b.io and again a@b.io"
    )
    expect(redactedText).toBe("write to [EMAIL_1] and again [EMAIL_1]")
    expect(Object.keys(mapping)).toEqual(["[EMAIL_1]"])
  })

  it("anonymizeSync produces the same result without the model", () => {
    const pii = createAnonymizer()
    const { redactedText } = pii.anonymizeSync("call +49 151 12345678")
    expect(redactedText).toBe("call [PHONE_1]")
  })

  it("redacts custom dictionary terms", async () => {
    const pii = createAnonymizer({
      dictionary: [{ value: "Projeto Fênix", type: "ORGANIZATION" }],
    })
    const { redactedText, mapping } = await pii.anonymize(
      "lancei o Projeto Fênix ontem"
    )
    expect(redactedText).toBe("lancei o [ORGANIZATION_1] ontem")
    expect(rehydrate(redactedText, mapping)).toBe(
      "lancei o Projeto Fênix ontem"
    )
  })

  it("round-trips with the keyed hashed strategy", async () => {
    const pii = createAnonymizer({ placeholders: hashed({ secret: "s3cr3t" }) })
    const text = "email joao@example.com"
    const { redactedText, mapping } = await pii.anonymize(text)
    expect(redactedText).toMatch(/^email \[EMAIL_[0-9a-f]{8}\]$/)
    expect(rehydrate(redactedText, mapping)).toBe(text)
  })
})

describe("createAnonymizer (NER integration)", () => {
  it.each(["detection", "ner"] as const)(
    "uses the %s compatibility name for the same model seam",
    async (key) => {
      const model = mockNer((text) => [span(text, "ana@acme.com", "EMAIL")])
      const result = await createAnonymizer({
        detectors: "none",
        [key]: model,
      }).anonymize("ana@acme.com")

      expect(result.redactedText).toBe("[EMAIL_1]")
      expect(model.load).toHaveBeenCalledOnce()
      expect(model.detect).toHaveBeenCalledOnce()
    }
  )

  it("rejects every ambiguous detection/ner combination synchronously", () => {
    const model = mockNer(() => [])

    const bothModels = () => createAnonymizer({ detection: model, ner: model })
    expect(bothModels).toThrow(TypeError)
    expect(bothModels).toThrow(
      '"detection" and "ner" configure the same Detection model'
    )
    expect(() => createAnonymizer({ detection: false, ner: false })).toThrow(
      TypeError
    )
    expect(() =>
      createAnonymizer({ detection: model, ner: undefined })
    ).not.toThrow()
    expect(() =>
      createAnonymizer({ detection: undefined, ner: model })
    ).not.toThrow()
    expect(() => createAnonymizer({ detection: model, ner: false })).toThrow(
      TypeError
    )
    expect(() => createAnonymizer({ detection: false, ner: model })).toThrow(
      TypeError
    )
    expect(model.load).not.toHaveBeenCalled()
    expect(model.detect).not.toHaveBeenCalled()
  })

  it("merges NER names with deterministic detections and round-trips", async () => {
    const text = "João Silva ligou de joao@example.com"
    const pii = createAnonymizer({
      ner: mockNer((t) => [
        span(t, "João", "GIVEN_NAME"),
        span(t, "Silva", "SURNAME"),
      ]),
    })
    const { redactedText, mapping } = await pii.anonymize(text)
    expect(redactedText).toBe("[GIVEN_NAME_1] [SURNAME_1] ligou de [EMAIL_1]")
    expect(rehydrate(redactedText, mapping)).toBe(text)
    expect(pii.status).toBe("ready")
  })

  it("keeps CITY by default but redacts it when asked", async () => {
    const text = "moro em Kempten"
    const kept = createAnonymizer({
      ner: mockNer((t) => [span(t, "Kempten", "CITY")]),
    })
    expect((await kept.anonymize(text)).redactedText).toBe(text)

    const redacted = createAnonymizer({
      ner: mockNer((t) => [span(t, "Kempten", "CITY")]),
      redact: ["CITY"],
    })
    expect((await redacted.anonymize(text)).redactedText).toBe(
      "moro em [CITY_1]"
    )
  })

  it("degrades to deterministic-only when NER fails (strict: false)", async () => {
    const onDegraded = vi.fn()
    const pii = createAnonymizer({
      ner: {
        name: "boom",
        load: async () => {
          throw new Error("no model")
        },
        detect: async () => [],
        dispose: async () => {},
      },
      onDegraded,
    })
    const { redactedText } = await pii.anonymize("call +49 151 12345678")
    expect(redactedText).toBe("call [PHONE_1]")
    expect(pii.status).toBe("degraded")
    expect(onDegraded).toHaveBeenCalledOnce()
  })

  it("throws on NER failure when strict: true", async () => {
    const pii = createAnonymizer({
      strict: true,
      ner: {
        name: "boom",
        load: async () => {
          throw new Error("no model")
        },
        detect: async () => [],
        dispose: async () => {},
      },
    })
    await expect(pii.anonymize("x")).rejects.toThrow("no model")
  })
})

describe("PiiSession", () => {
  it("keeps placeholders stable across turns", async () => {
    const pii = createAnonymizer()
    const session = pii.createSession()
    const t1 = await session.anonymize("first mail a@b.io")
    const t2 = await session.anonymize("again a@b.io and c@d.io")
    expect(t1.redactedText).toBe("first mail [EMAIL_1]")
    expect(t2.redactedText).toBe("again [EMAIL_1] and [EMAIL_2]")
    expect(session.rehydrate("reply to [EMAIL_2]")).toBe("reply to c@d.io")
  })
})
