import { describe, expect, it } from "vitest"
import { ibanDetector } from "./iban"

describe("ibanDetector", () => {
  it("detects a spaced German IBAN", () => {
    const [span] = ibanDetector.detect("pay to DE89 3704 0044 0532 0130 00 today")
    expect(span?.type).toBe("IBAN")
    expect(span?.text).toBe("DE89 3704 0044 0532 0130 00")
  })

  it("detects a UK IBAN with letters in the account part", () => {
    expect(ibanDetector.detect("GB82 WEST 1234 5698 7654 32")[0]?.text).toBe(
      "GB82 WEST 1234 5698 7654 32",
    )
  })

  it("rejects a string that looks like an IBAN but fails mod-97", () => {
    expect(ibanDetector.detect("DE89 3704 0044 0532 0130 01")).toEqual([])
  })
})
