import type { EncodedToken } from "../tokenizer/wordpiece"

/**
 * Split a full `[CLS] … [SEP]` token sequence into overlapping windows that fit
 * the model's max sequence length. Content tokens are windowed with a stride of
 * 75% of the capacity, so an entity near a window edge appears complete in a
 * neighbouring window; the overlap-resolution stage then keeps the longer span.
 * Sequences that already fit are returned unchanged (single window).
 */
export function chunkTokens(
  tokens: readonly EncodedToken[],
  maxTokens = 512
): EncodedToken[][] {
  if (tokens.length === 0) return []
  const cls = tokens[0]!
  const sep = tokens[tokens.length - 1]!
  const content = tokens.slice(1, -1)
  const capacity = Math.max(1, maxTokens - 2)

  if (content.length <= capacity) return [tokens.slice()]

  const stride = Math.max(1, Math.floor(capacity * 0.75))
  const windows: EncodedToken[][] = []
  for (let start = 0; start < content.length; start += stride) {
    windows.push([cls, ...content.slice(start, start + capacity), sep])
    if (start + capacity >= content.length) break
  }
  return windows
}
