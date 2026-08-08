import { describe, expect, it } from "vitest"
import { hmacSha256Hex, sha256Hex } from "./sha256"

describe("sha256Hex", () => {
  it("hashes the empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  })

  it("hashes 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })

  it("hashes a multi-block, non-ASCII input", () => {
    expect(sha256Hex("héllo wörld ".repeat(10))).toHaveLength(64)
  })
})

describe("hmacSha256Hex", () => {
  it("matches the RFC test vector", () => {
    expect(
      hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog")
    ).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8")
  })

  it("is deterministic and key-dependent", () => {
    expect(hmacSha256Hex("k1", "x")).toBe(hmacSha256Hex("k1", "x"))
    expect(hmacSha256Hex("k1", "x")).not.toBe(hmacSha256Hex("k2", "x"))
  })
})
