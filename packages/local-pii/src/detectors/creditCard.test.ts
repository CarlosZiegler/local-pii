import { describe, expect, it } from "vitest"
import { creditCardDetector } from "./creditCard"

describe("creditCardDetector", () => {
  it("detects a spaced Visa number that passes Luhn", () => {
    const text = "card 4111 1111 1111 1111 on file"
    const [span] = creditCardDetector.detect(text)
    expect(span?.type).toBe("CREDIT_CARD")
    expect(span?.text).toBe("4111 1111 1111 1111")
  })

  it("detects a hyphenated number and a 15-digit Amex", () => {
    expect(creditCardDetector.detect("4111-1111-1111-1111")[0]?.text).toBe(
      "4111-1111-1111-1111"
    )
    expect(creditCardDetector.detect("amex 3782 822463 10005")[0]?.text).toBe(
      "3782 822463 10005"
    )
  })

  it("rejects a 16-digit number that fails the Luhn check", () => {
    expect(creditCardDetector.detect("4111 1111 1111 1112")).toEqual([])
  })

  it("ignores short digit runs and phone-length numbers", () => {
    expect(creditCardDetector.detect("call 12345678")).toEqual([])
  })
})
