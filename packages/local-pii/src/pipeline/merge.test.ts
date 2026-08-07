import { describe, expect, it } from "vitest"
import type { Entity } from "../types"
import { mergeEntities } from "./merge"

function ent(part: Partial<Entity> & Pick<Entity, "start" | "end">): Entity {
  return {
    text: "x",
    type: "PERSON",
    confidence: 1,
    source: "deterministic",
    ...part,
  }
}

describe("mergeEntities", () => {
  it("keeps disjoint entities and sorts them by start", () => {
    const out = mergeEntities([ent({ start: 10, end: 12 }), ent({ start: 0, end: 3 })])
    expect(out.map((e) => e.start)).toEqual([0, 10])
  })

  it("drops the lower-priority entity on overlap (dictionary > deterministic > ner)", () => {
    const dict = ent({ start: 0, end: 5, source: "dictionary", type: "PERSON" })
    const ner = ent({ start: 2, end: 9, source: "ner", type: "CITY", confidence: 0.9 })
    const out = mergeEntities([ner, dict])
    expect(out).toHaveLength(1)
    expect(out[0]?.source).toBe("dictionary")
  })

  it("prefers deterministic over ner on overlap", () => {
    const email = ent({ start: 3, end: 20, source: "deterministic", type: "EMAIL" })
    const person = ent({ start: 0, end: 8, source: "ner", type: "GIVEN_NAME", confidence: 0.8 })
    const out = mergeEntities([email, person])
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe("EMAIL")
  })

  it("prefers the longer entity when source and confidence tie", () => {
    const short = ent({ start: 0, end: 4, type: "PHONE" })
    const long = ent({ start: 0, end: 16, type: "CREDIT_CARD" })
    const out = mergeEntities([short, long])
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe("CREDIT_CARD")
  })

  it("removes exact duplicates from two sources", () => {
    const a = ent({ start: 0, end: 5, source: "deterministic" })
    const b = ent({ start: 0, end: 5, source: "ner", confidence: 0.5 })
    expect(mergeEntities([a, b])).toHaveLength(1)
  })
})
