import type { Entity, EntitySource } from "../types"

const PRIORITY: Record<EntitySource, number> = {
  dictionary: 3, // explicit user intent always wins
  deterministic: 2, // checksum-validated patterns beat model guesses
  ner: 1,
}

function overlaps(a: Entity, b: Entity): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Resolve entities from all sources over the original text into a
 * deterministic, non-overlapping set sorted by `start`.
 *
 * Greedy interval selection: candidates are ranked by
 * `(priority desc, length desc, confidence desc, start asc)` and accepted only
 * if they do not overlap an already-accepted entity. Identical spans from two
 * sources collapse because the higher-ranked one is accepted and the other is
 * rejected by the overlap test. Total and order-independent.
 */
export function mergeEntities(entities: readonly Entity[]): Entity[] {
  const ranked = [...entities].sort((a, b) => {
    const pa = PRIORITY[a.source]
    const pb = PRIORITY[b.source]
    if (pa !== pb) return pb - pa
    const la = a.end - a.start
    const lb = b.end - b.start
    if (la !== lb) return lb - la
    if (a.confidence !== b.confidence) return b.confidence - a.confidence
    return a.start - b.start
  })

  const accepted: Entity[] = []
  for (const candidate of ranked) {
    if (!accepted.some((a) => overlaps(a, candidate))) accepted.push(candidate)
  }

  return accepted.sort((a, b) => a.start - b.start)
}
