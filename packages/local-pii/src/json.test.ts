import { describe, expect, it } from "vitest"
import { anonymizeJson, rehydrateJson, rehydrateToolArgs } from "./json"

const mapping = { PIIAAA: 'Ana "the boss"', PIIBBB: "a@b.io" }

describe("rehydrateJson", () => {
  it("deep-rehydrates string leaves, leaving keys and non-strings alone", () => {
    const out = rehydrateJson(
      { name: "PIIAAA", count: 3, arr: ["PIIBBB", true, null] },
      mapping
    )
    expect(out).toEqual({
      name: 'Ana "the boss"',
      count: 3,
      arr: ["a@b.io", true, null],
    })
  })
})

describe("rehydrateToolArgs", () => {
  it("keeps the JSON valid even when a restored value contains quotes", () => {
    const args = JSON.stringify({ email: "PIIBBB", note: "PIIAAA" })
    const { args: out, clean } = rehydrateToolArgs(args, mapping)
    expect(clean).toBe(true)
    expect(JSON.parse(out)).toEqual({ email: "a@b.io", note: 'Ana "the boss"' })
  })

  it("falls back (clean:false) on invalid JSON but still substitutes", () => {
    const { args, clean } = rehydrateToolArgs('{"email": PIIBBB', mapping)
    expect(clean).toBe(false)
    expect(args).toContain("a@b.io")
  })

  it("leaves unknown / model-invented placeholders untouched", () => {
    const { args } = rehydrateToolArgs(JSON.stringify({ x: "PIIZZZ" }), mapping)
    expect(JSON.parse(args).x).toBe("PIIZZZ")
  })
})

describe("anonymizeJson", () => {
  it("redacts only string leaves via the provided redactor", async () => {
    const redact = async (s: string) => s.replace("a@b.io", "TOKEN")
    const out = await anonymizeJson(redact, {
      to: "a@b.io",
      n: 1,
      tags: ["a@b.io"],
    })
    expect(out).toEqual({ to: "TOKEN", n: 1, tags: ["TOKEN"] })
  })
})
