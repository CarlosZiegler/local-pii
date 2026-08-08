import { describe, expect, it } from "vitest"
import { createStreamingRehydrator, rehydrate } from "./rehydrate"

describe("rehydrate", () => {
  it("restores placeholders from the mapping", () => {
    const mapping = {
      "[GIVEN_NAME_1]": "João",
      "[PHONE_1]": "+49 151 12345678",
    }
    expect(rehydrate("ligue para [GIVEN_NAME_1] no [PHONE_1]", mapping)).toBe(
      "ligue para João no +49 151 12345678"
    )
  })

  it("restores every occurrence", () => {
    const mapping = { "[GIVEN_NAME_1]": "Ana" }
    expect(rehydrate("[GIVEN_NAME_1] e [GIVEN_NAME_1]", mapping)).toBe(
      "Ana e Ana"
    )
  })

  it("matches the longest placeholder first (10 before 1)", () => {
    const mapping = { "[PHONE_1]": "one", "[PHONE_10]": "ten" }
    expect(rehydrate("[PHONE_10] then [PHONE_1]", mapping)).toBe("ten then one")
  })

  it("leaves unknown / model-invented placeholders untouched", () => {
    expect(rehydrate("[GIVEN_NAME_9] stays", { "[GIVEN_NAME_1]": "Ana" })).toBe(
      "[GIVEN_NAME_9] stays"
    )
  })

  it("returns the text unchanged for an empty mapping", () => {
    expect(rehydrate("nothing here", {})).toBe("nothing here")
  })

  it("matches bracket-mangled tokens in lenient mode", () => {
    const mapping = { "[GIVEN_NAME_1]": "Ana" }
    expect(
      rehydrate("call GIVEN_NAME_1 today", mapping, { lenient: true })
    ).toBe("call Ana today")
    expect(
      rehydrate("call [[GIVEN_NAME_1]] today", mapping, { lenient: true })
    ).toBe("call Ana today")
    // Without lenient, a bracket-stripped token is left as-is.
    expect(rehydrate("call GIVEN_NAME_1 today", mapping)).toBe(
      "call GIVEN_NAME_1 today"
    )
  })
})

describe("createStreamingRehydrator", () => {
  const key = "[[EMAIL_abcdefghij0123456789]]"
  const mapping = { [key]: "a@b.io" }

  it("restores a token split across several chunks", () => {
    const r = createStreamingRehydrator(mapping)
    const chunks = ["hi ", "[[EMAIL_", "abcdefghij", "0123456789]]", " end"]
    let out = ""
    for (const c of chunks) out += r.push(c)
    out += r.flush()
    expect(out).toBe("hi a@b.io end")
  })

  it("passes text through unchanged when there are no placeholders", () => {
    const r = createStreamingRehydrator({})
    expect(r.push("hello ") + r.push("world") + r.flush()).toBe("hello world")
  })

  it("emits a completed token once enough trailing text has arrived", () => {
    const r = createStreamingRehydrator(mapping)
    const emitted = r.push(
      `see ${key} for more text well past the holdback window`
    )
    expect(emitted).toContain("a@b.io")
  })

  it("preserves an ambiguous known-token prefix when a successful stream ends", () => {
    const r = createStreamingRehydrator(mapping)
    expect(r.push(`safe ${key.slice(0, 10)}`)).toBe("")
    expect(r.flush()).toBe(`safe ${key.slice(0, 10)}`)
  })

  it("does not truncate ordinary text matching a custom token prefix", () => {
    const r = createStreamingRehydrator({ STOPABCDEFG: "Ana" })
    expect(r.push("please STOP") + r.flush()).toBe("please STOP")
  })
})
