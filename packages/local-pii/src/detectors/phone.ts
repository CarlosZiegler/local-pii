import { digitsOnly, makeRegexDetector } from "./_util"

/**
 * A run of 7–15 digits, optionally starting with `+` and grouped by spaces,
 * dots, hyphens or parentheses. The `\w` guards keep it from starting or
 * ending in the middle of another token.
 */
const CANDIDATE = /(?<![\w])\(?\+?\d(?:[\s().-]{0,2}\d){6,14}(?![\w])/gu

export const phoneDetector = makeRegexDetector({
  name: "phone",
  type: "PHONE",
  pattern: CANDIDATE,
  validate: (m) => {
    const count = digitsOnly(m[0]).length
    return count >= 7 && count <= 15
  },
})
