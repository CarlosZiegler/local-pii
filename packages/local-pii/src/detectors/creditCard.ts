import { digitsOnly, makeRegexDetector } from "./_util"

/** 13–19 digits, optionally grouped by single spaces or hyphens. */
const CANDIDATE = /\b\d(?:[ -]?\d){11,18}\b/g

/** Luhn (mod-10) checksum used by all major card networks. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

export const creditCardDetector = makeRegexDetector({
  name: "creditCard",
  type: "CREDIT_CARD",
  pattern: CANDIDATE,
  validate: (m) => luhnValid(digitsOnly(m[0])),
})
