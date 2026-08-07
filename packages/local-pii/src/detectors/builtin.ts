import type { Detector } from "../types"
import { creditCardDetector } from "./creditCard"
import { emailDetector } from "./email"
import { ibanDetector } from "./iban"
import { ipDetector } from "./ip"
import { phoneDetector } from "./phone"
import { ssnDetector } from "./ssn"
import { urlDetector } from "./url"

/**
 * The built-in deterministic detectors, in a stable order. Each is precise
 * (checksum- or structure-validated) so it can be trusted over model guesses.
 */
export const builtinDetectors: readonly Detector[] = [
  emailDetector,
  urlDetector,
  ipDetector,
  ssnDetector,
  creditCardDetector,
  ibanDetector,
  phoneDetector,
]

/** A fresh array of the built-in deterministic detectors. */
export function defaultDetectors(): Detector[] {
  return [...builtinDetectors]
}
