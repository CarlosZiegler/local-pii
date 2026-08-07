import type { PiiType } from "../types"

// Case-folded so "João Silva" and "joão silva" share one placeholder.
const NAME_LIKE = new Set<PiiType>([
  "GIVEN_NAME",
  "SURNAME",
  "PERSON",
  "CITY",
  "STATE",
  "STREET_NAME",
  "SECONDARY_ADDRESS",
  "ORGANIZATION",
  "CUSTOM",
])

// Separators stripped so "+49 151…" and "+49151…" share one placeholder.
const STRIP_SEPARATORS = new Set<PiiType>([
  "CREDIT_CARD",
  "IBAN",
  "PHONE",
  "BANK_ACCOUNT",
  "ROUTING_NUMBER",
  "SSN",
])

/**
 * Reduce a raw value to a canonical key component so equal entities dedupe to
 * one placeholder regardless of formatting. NFC + trim + inner-whitespace
 * collapse for all; case-fold for name-like types; separator strip for
 * numeric/identifier types.
 */
export function canonicalize(type: PiiType, value: string): string {
  const base = value.normalize("NFC").trim().replace(/\s+/g, " ")
  if (STRIP_SEPARATORS.has(type)) return base.replace(/[\s\-().]/g, "")
  if (NAME_LIKE.has(type)) return base.toLowerCase()
  return base
}
