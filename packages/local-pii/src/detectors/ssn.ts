import { makeRegexDetector } from "./_util"

/** US Social Security Number: AAA-GG-SSSS (hyphen or space separated). */
const CANDIDATE = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g

export function ssnValid(raw: string): boolean {
  const m = /^(\d{3})[- ](\d{2})[- ](\d{4})$/.exec(raw)
  if (!m) return false
  const area = Number(m[1])
  const group = Number(m[2])
  const serial = Number(m[3])
  // Ranges the SSA never issues.
  if (area === 0 || area === 666 || area >= 900) return false
  if (group === 0 || serial === 0) return false
  return true
}

export const ssnDetector = makeRegexDetector({
  name: "ssn",
  type: "SSN",
  pattern: CANDIDATE,
  validate: (m) => ssnValid(m[0]),
})
