import type { Entity, PiiType } from "../types"
import type { EncodedToken } from "../tokenizer/wordpiece"

export interface DecodeBioParams {
  readonly tokens: readonly EncodedToken[]
  /** Per-token label scores (logits), aligned 1:1 with `tokens`. */
  readonly logits: readonly (readonly number[])[]
  /** Label string per class id, e.g. `["O","B-GIVEN_NAME",…]`. */
  readonly labels: readonly string[]
  /** The original text, for slicing entity surfaces. */
  readonly text: string
}

function argmaxSoftmax(scores: readonly number[]): {
  index: number
  prob: number
} {
  let maxIndex = 0
  let max = -Infinity
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!
    if (s > max) {
      max = s
      maxIndex = i
    }
  }
  let sum = 0
  for (const s of scores) sum += Math.exp(s - max)
  return { index: maxIndex, prob: sum > 0 ? 1 / sum : 1 }
}

interface Accum {
  type: PiiType
  start: number
  end: number
  probs: number[]
}

/**
 * Turn per-token label scores into entities over the original text. Argmax +
 * softmax per token; consecutive non-`O` tokens of the same type that are
 * adjacent or separated only by whitespace are merged into one span (so
 * multi-token names and addresses become a single entity). Rampart's label
 * names are used verbatim as {@link PiiType} (no mapping needed).
 */
export function decodeBio(params: DecodeBioParams): Entity[] {
  const { tokens, logits, labels, text } = params
  const entities: Entity[] = []
  let current: Accum | null = null

  const flush = (): void => {
    if (!current) return
    entities.push({
      start: current.start,
      end: current.end,
      text: text.slice(current.start, current.end),
      type: current.type,
      source: "ner",
      confidence:
        current.probs.reduce((a, b) => a + b, 0) / current.probs.length,
    })
    current = null
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.special) {
      flush()
      continue
    }
    const scores = logits[i]
    if (!scores) continue
    const { index, prob } = argmaxSoftmax(scores)
    const label = labels[index] ?? "O"
    if (label === "O") {
      flush()
      continue
    }
    const type = label.slice(2) as PiiType // drop "B-" / "I-"

    const gapIsWhitespace =
      current !== null && text.slice(current.end, token.start).trim() === ""
    if (current && current.type === type && gapIsWhitespace) {
      current.end = token.end
      current.probs.push(prob)
    } else {
      flush()
      current = { type, start: token.start, end: token.end, probs: [prob] }
    }
  }
  flush()
  return entities
}
