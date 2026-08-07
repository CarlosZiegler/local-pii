import {
  isCjk,
  isPunctuation,
  isWhitespace,
  normalizeWithOffsets,
  type NormChar,
} from "./normalize"

/** One token from the tokenizer, carrying its span in the ORIGINAL text. */
export interface EncodedToken {
  readonly id: number
  readonly token: string
  /** Code-unit span in the original text; `[0,0]` for the leading/trailing specials. */
  readonly start: number
  readonly end: number
  readonly special: boolean
}

export interface BertTokenizerConfig {
  unkToken?: string
  clsToken?: string
  sepToken?: string
  maxInputCharsPerWord?: number
}

export interface BertTokenizer {
  encode(text: string): EncodedToken[]
}

/**
 * A pure BERT WordPiece tokenizer with original-text offset tracking. Given the
 * published `vocab.txt` (as an array indexed by token id), it reproduces the
 * uncased BERT pipeline: normalize → split on whitespace → isolate punctuation
 * and CJK → greedy longest-match WordPiece with `##` continuations and `[UNK]`
 * fallback → wrap in `[CLS]`/`[SEP]`.
 */
export function createBertTokenizer(
  vocab: readonly string[],
  config: BertTokenizerConfig = {},
): BertTokenizer {
  const unk = config.unkToken ?? "[UNK]"
  const cls = config.clsToken ?? "[CLS]"
  const sep = config.sepToken ?? "[SEP]"
  const maxChars = config.maxInputCharsPerWord ?? 200

  const vocabMap = new Map<string, number>()
  vocab.forEach((token, id) => vocabMap.set(token, id))
  const idOf = (token: string): number =>
    vocabMap.get(token) ?? vocabMap.get(unk) ?? 0
  const unkId = idOf(unk)

  /** Split normalized chars into WordPiece inputs (whitespace/punct/CJK aware). */
  function splitIntoPieces(chars: readonly NormChar[]): NormChar[][] {
    const pieces: NormChar[][] = []
    let current: NormChar[] = []
    const flush = (): void => {
      if (current.length > 0) {
        pieces.push(current)
        current = []
      }
    }
    for (const nc of chars) {
      if (isWhitespace(nc.ch)) {
        flush()
        continue
      }
      const cp = nc.ch.codePointAt(0) ?? 0
      if (isPunctuation(nc.ch) || isCjk(cp)) {
        flush()
        pieces.push([nc])
        continue
      }
      current.push(nc)
    }
    flush()
    return pieces
  }

  function unkToken(piece: readonly NormChar[]): EncodedToken {
    const first = piece[0]!
    const last = piece[piece.length - 1]!
    return { id: unkId, token: unk, start: first.start, end: last.end, special: false }
  }

  function wordpiece(piece: readonly NormChar[], out: EncodedToken[]): void {
    if (piece.length === 0) return
    if (piece.length > maxChars) {
      out.push(unkToken(piece))
      return
    }

    const subTokens: EncodedToken[] = []
    let start = 0
    while (start < piece.length) {
      let end = piece.length
      let match: string | null = null
      while (start < end) {
        const raw = piece
          .slice(start, end)
          .map((c) => c.ch)
          .join("")
        const candidate = start > 0 ? `##${raw}` : raw
        if (vocabMap.has(candidate)) {
          match = candidate
          break
        }
        end--
      }
      if (match === null) {
        // Any unmatched sub-piece makes the whole word [UNK] (BERT semantics).
        out.push(unkToken(piece))
        return
      }
      subTokens.push({
        id: idOf(match),
        token: match,
        start: piece[start]!.start,
        end: piece[end - 1]!.end,
        special: false,
      })
      start = end
    }
    for (const sub of subTokens) out.push(sub)
  }

  return {
    encode(text: string): EncodedToken[] {
      const chars = normalizeWithOffsets(text)
      const out: EncodedToken[] = [
        { id: idOf(cls), token: cls, start: 0, end: 0, special: true },
      ]
      for (const piece of splitIntoPieces(chars)) wordpiece(piece, out)
      out.push({
        id: idOf(sep),
        token: sep,
        start: text.length,
        end: text.length,
        special: true,
      })
      return out
    },
  }
}
