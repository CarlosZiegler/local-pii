import { makeRegexDetector } from "./_util"

/**
 * Matches `local@domain.tld`. The local part is any run of non-space,
 * non-`@` characters (Unicode-aware, so accented locals work); domain labels
 * exclude sentence punctuation so a trailing `,`/`.`/`)` is left out of the
 * match (e.g. "email a@b.com," stops at "com").
 */
const DOMAIN_LABEL = `[^\\s@.,;:!?"'<>()\\[\\]]+`
const EMAIL = new RegExp(
  `[^\\s@]+@${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+`,
  "gu"
)

export const emailDetector = makeRegexDetector({
  name: "email",
  type: "EMAIL",
  pattern: EMAIL,
})
