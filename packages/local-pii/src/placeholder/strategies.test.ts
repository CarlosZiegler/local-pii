import { describe, expect, it } from "vitest"
import { hashed, sequential, token } from "./strategies"

describe("sequential", () => {
  it("numbers placeholders per type by 1-based occurrence index", () => {
    const s = sequential()
    expect(s.placeholderFor("GIVEN_NAME", "Ana", 1)).toBe("[GIVEN_NAME_1]")
    expect(s.placeholderFor("GIVEN_NAME", "Bo", 2)).toBe("[GIVEN_NAME_2]")
    expect(s.placeholderFor("EMAIL", "a@b.io", 1)).toBe("[EMAIL_1]")
  })

  it("emits a pattern that matches its own output", () => {
    const s = sequential()
    const token = s.placeholderFor("PHONE", "x", 3)
    expect(token).toMatch(s.pattern())
  })
})

describe("hashed", () => {
  it("is deterministic for the same value and secret", () => {
    const s = hashed({ secret: "device-secret" })
    expect(s.placeholderFor("PERSON", "Ana Silva", 1)).toBe(
      s.placeholderFor("PERSON", "Ana Silva", 9)
    )
    expect(s.placeholderFor("PERSON", "Ana Silva", 1)).toMatch(
      /^\[PERSON_[0-9a-f]{8}\]$/
    )
  })

  it("changes with the value and the secret, and never contains the raw value", () => {
    const s1 = hashed({ secret: "s1" })
    const s2 = hashed({ secret: "s2" })
    const forAna = s1.placeholderFor("PERSON", "Ana", 1)
    expect(forAna).not.toContain("Ana")
    expect(forAna).not.toBe(s1.placeholderFor("PERSON", "Bo", 1))
    expect(forAna).not.toBe(s2.placeholderFor("PERSON", "Ana", 1))
  })

  it("honors the requested hex length", () => {
    const s = hashed({ secret: "k", length: 4 })
    expect(s.placeholderFor("EMAIL", "a@b.io", 1)).toMatch(
      /^\[EMAIL_[0-9a-f]{4}\]$/
    )
  })
})

describe("token", () => {
  it("produces opaque Crockford tokens — no brackets, no type or value leak", () => {
    const s = token()
    const t = s.placeholderFor("EMAIL", "a@b.io", 1)
    expect(t).toMatch(/^PII[0-9A-HJKMNP-TV-Z]{16}$/)
    expect(t).not.toContain("EMAIL")
    expect(t).not.toContain("a@b.io")
    expect(t).toMatch(s.pattern())
  })

  it("is random by default, deterministic with a secret", () => {
    expect(token().placeholderFor("P", "Ana", 1)).not.toBe(
      token().placeholderFor("P", "Ana", 1)
    )
    const keyed = token({ secret: "device-secret" })
    expect(keyed.placeholderFor("PERSON", "Ana", 1)).toBe(
      keyed.placeholderFor("PERSON", "Ana", 9)
    )
  })

  it("normalizeMatch recovers a case-folded / O-and-I-confused token", () => {
    const s = token()
    const t = s.placeholderFor("PERSON", "Ana", 1)
    expect(s.normalizeMatch!(t.toLowerCase())).toBe(t)
    // A '0' the model rewrote as the letter 'O', and 'I' for '1', still resolve.
    const mangled = t.replace(/0/g, "o").replace(/1/g, "l")
    expect(s.normalizeMatch!(mangled)).toBe(t)
  })
})
