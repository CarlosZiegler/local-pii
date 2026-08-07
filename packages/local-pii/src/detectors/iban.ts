import { makeRegexDetector } from "./_util"

/** Country code, 2 check digits, then 10–30 grouped alphanumerics. */
const CANDIDATE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){10,30}\b/g

/** ISO 7064 mod-97-10 check: rearrange, map letters to numbers, mod 97 === 1. */
export function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, "").toUpperCase()
  if (iban.length < 15 || iban.length > 34) return false
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0)
    const chunk = code >= 65 ? String(code - 55) : ch // A->10 … Z->35
    for (const digit of chunk) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97
    }
  }
  return remainder === 1
}

export const ibanDetector = makeRegexDetector({
  name: "iban",
  type: "IBAN",
  pattern: CANDIDATE,
  validate: (m) => ibanValid(m[0]),
})
