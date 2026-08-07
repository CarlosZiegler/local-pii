import type { Detector, DictionaryEntry, Entity } from "../types"
import { escapeRegex } from "../util"

// Unicode-aware word-boundary guards (letters, numbers, underscore).
const LEFT = "(?<![\\p{L}\\p{N}_])"
const RIGHT = "(?![\\p{L}\\p{N}_])"

interface CompiledEntry {
  readonly regex: RegExp
  readonly type: Entity["type"]
}

/**
 * A detector for a user-supplied list of exact terms (own name, family,
 * employer, addresses…). Highest-priority source. Matches are
 * case-insensitive and whole-word by default; both are per-entry overridable.
 */
export function createDictionaryDetector(
  entries: readonly DictionaryEntry[],
): Detector {
  const compiled: CompiledEntry[] = entries.map((entry) => {
    const body = escapeRegex(entry.value)
    const wholeWord = entry.wholeWord ?? true
    const source = wholeWord ? `${LEFT}(?:${body})${RIGHT}` : body
    const flags = entry.caseSensitive ? "gu" : "giu"
    return { regex: new RegExp(source, flags), type: entry.type ?? "CUSTOM" }
  })

  return {
    name: "dictionary",
    detect(text: string): Entity[] {
      const entities: Entity[] = []
      for (const { regex, type } of compiled) {
        regex.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = regex.exec(text)) !== null) {
          if (match[0] === "") {
            regex.lastIndex++
            continue
          }
          entities.push({
            start: match.index,
            end: match.index + match[0].length,
            text: match[0],
            type,
            confidence: 1,
            source: "dictionary",
          })
        }
      }
      return entities
    },
  }
}
