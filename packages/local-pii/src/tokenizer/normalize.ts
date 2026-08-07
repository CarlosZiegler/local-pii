/** A normalized character plus the code-unit span it came from in the original. */
export interface NormChar {
  readonly ch: string
  readonly start: number
  readonly end: number
}

export function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch)
}

export function isControl(ch: string): boolean {
  if (isWhitespace(ch)) return false
  return /\p{C}/u.test(ch)
}

export function isPunctuation(ch: string): boolean {
  // ASCII punctuation ranges + any Unicode punctuation category.
  return /[!-/:-@[-`{-~]/.test(ch) || /\p{P}/u.test(ch)
}

export function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x2f800 && codePoint <= 0x2fa1f)
  )
}

/**
 * BERT text normalization with an offset map. Lowercases, NFD-decomposes and
 * strips combining marks (Rampart's tokenizer is `do_lower_case: true`), while
 * recording, for every produced character, the code-unit span of the ORIGINAL
 * char it came from — so detected token spans map back onto the raw text even
 * after accent stripping or case folding. Control characters are dropped.
 */
export function normalizeWithOffsets(text: string): NormChar[] {
  const out: NormChar[] = []
  let i = 0
  while (i < text.length) {
    const codePoint = text.codePointAt(i)
    if (codePoint === undefined) break
    const size = codePoint > 0xffff ? 2 : 1
    const start = i
    const end = i + size
    i = end

    const original = text.slice(start, end)
    if (isControl(original)) continue

    const normalized = original
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Mn}+/gu, "")
    for (const ch of normalized) out.push({ ch, start, end })
  }
  return out
}
