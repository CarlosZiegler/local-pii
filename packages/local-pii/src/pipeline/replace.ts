import type { Entity } from "../types"
import type { Vault } from "./vault"

/**
 * Replace each resolved entity's span with its placeholder, building the
 * output from slices in a single left-to-right pass. `entities` must be sorted
 * by `start` and non-overlapping (as returned by `mergeEntities`).
 */
export function redactText(
  text: string,
  entities: readonly Entity[],
  vault: Vault
): string {
  let out = ""
  let cursor = 0
  for (const entity of entities) {
    out += text.slice(cursor, entity.start)
    out += vault.placeholderFor(entity.type, entity.text)
    cursor = entity.end
  }
  out += text.slice(cursor)
  return out
}
