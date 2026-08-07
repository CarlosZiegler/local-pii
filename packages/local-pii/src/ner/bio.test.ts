import { describe, expect, it } from "vitest"
import { decodeBio } from "./bio"
import type { EncodedToken } from "../tokenizer/wordpiece"

const LABELS = ["O", "B-GIVEN_NAME", "I-GIVEN_NAME", "B-SURNAME", "I-CITY", "B-CITY"]

function tok(token: string, start: number, end: number, special = false): EncodedToken {
  return { id: 0, token, start, end, special }
}

/** One-hot-ish logits selecting `labelIndex`. */
function pick(labelIndex: number): number[] {
  return LABELS.map((_, i) => (i === labelIndex ? 8 : 0))
}

describe("decodeBio", () => {
  it("emits one entity per contiguous label, using original-text offsets", () => {
    const text = "João Silva"
    const tokens = [tok("[CLS]", 0, 0, true), tok("joão", 0, 4), tok("silva", 5, 10), tok("[SEP]", 10, 10, true)]
    const logits = [pick(0), pick(1), pick(3), pick(0)]
    const out = decodeBio({ tokens, logits, labels: LABELS, text })
    expect(out).toEqual([
      { start: 0, end: 4, text: "João", type: "GIVEN_NAME", source: "ner", confidence: expect.any(Number) },
      { start: 5, end: 10, text: "Silva", type: "SURNAME", source: "ner", confidence: expect.any(Number) },
    ])
  })

  it("merges same-type tokens separated only by whitespace into one span", () => {
    const text = "New York"
    const tokens = [tok("[CLS]", 0, 0, true), tok("new", 0, 3), tok("york", 4, 8), tok("[SEP]", 8, 8, true)]
    const logits = [pick(0), pick(5), pick(4), pick(0)] // B-CITY, I-CITY
    const out = decodeBio({ tokens, logits, labels: LABELS, text })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ start: 0, end: 8, text: "New York", type: "CITY" })
  })

  it("does not merge across a non-whitespace gap", () => {
    const text = "Ann,Bob"
    const tokens = [tok("[CLS]", 0, 0, true), tok("ann", 0, 3), tok("bob", 4, 7), tok("[SEP]", 7, 7, true)]
    const logits = [pick(0), pick(1), pick(1), pick(0)] // both GIVEN_NAME but comma between
    const out = decodeBio({ tokens, logits, labels: LABELS, text })
    expect(out).toHaveLength(2)
  })

  it("assigns a softmax confidence in (0, 1]", () => {
    const text = "Ana"
    const tokens = [tok("[CLS]", 0, 0, true), tok("ana", 0, 3), tok("[SEP]", 3, 3, true)]
    const out = decodeBio({ tokens, logits: [pick(0), pick(1), pick(0)], labels: LABELS, text })
    expect(out[0]!.confidence).toBeGreaterThan(0)
    expect(out[0]!.confidence).toBeLessThanOrEqual(1)
  })
})
