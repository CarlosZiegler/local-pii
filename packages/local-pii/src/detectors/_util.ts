import type { Detector, Entity, PiiType } from "../types"

export interface RegexDetectorOptions {
  readonly name: string
  readonly type: PiiType
  /** Pattern used to find candidates. The `g` flag is added if missing. */
  readonly pattern: RegExp
  /**
   * Optional second gate applied to every raw match. Return `false` to reject
   * (e.g. a card number that fails Luhn). This is how detectors stay precise
   * without an unreadable mega-regex.
   */
  readonly validate?: (match: RegExpExecArray) => boolean
}

/**
 * Build a deterministic {@link Detector} from a regular expression. Matches
 * are reported as entities with `confidence: 1` and `source: "deterministic"`.
 * A `validate` gate can reject matches that pass the pattern but fail a
 * semantic check.
 */
export function makeRegexDetector(opts: RegexDetectorOptions): Detector {
  const flags = opts.pattern.flags.includes("g")
    ? opts.pattern.flags
    : opts.pattern.flags + "g"

  return {
    name: opts.name,
    type: opts.type,
    detect(text: string): Entity[] {
      const re = new RegExp(opts.pattern.source, flags)
      const entities: Entity[] = []
      let match: RegExpExecArray | null
      while ((match = re.exec(text)) !== null) {
        // Guard against zero-width matches spinning forever.
        if (match[0] === "") {
          re.lastIndex++
          continue
        }
        if (opts.validate && !opts.validate(match)) continue
        entities.push({
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
          type: opts.type,
          confidence: 1,
          source: "deterministic",
        })
      }
      return entities
    },
  }
}

/** Strip every character except decimal digits. */
export function digitsOnly(value: string): string {
  return value.replace(/\D+/g, "")
}
