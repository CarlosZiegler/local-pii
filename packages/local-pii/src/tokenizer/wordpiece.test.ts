import { describe, expect, it } from "vitest"
import { createBertTokenizer } from "./wordpiece"

// Synthetic vocab (index = id) — enough to exercise the algorithm without the
// real 19,730-token file.
const VOCAB = [
  "[PAD]", // 0
  "[UNK]", // 1
  "[CLS]", // 2
  "[SEP]", // 3
  "play", // 4
  "##ing", // 5
  "hi", // 6
  "!", // 7
  "cafe", // 8
  "carlos", // 9
  "世", // 10
]

const tok = createBertTokenizer(VOCAB)

function view(text: string) {
  return tok.encode(text).map((t) => ({ token: t.token, start: t.start, end: t.end }))
}

describe("createBertTokenizer", () => {
  it("wraps output in [CLS]/[SEP] with zero-width special spans", () => {
    const out = tok.encode("hi")
    expect(out[0]).toMatchObject({ token: "[CLS]", id: 2, start: 0, end: 0, special: true })
    expect(out.at(-1)).toMatchObject({ token: "[SEP]", id: 3, start: 2, end: 2, special: true })
  })

  it("greedy longest-match splits into ## continuations with correct offsets", () => {
    expect(view("playing")).toEqual([
      { token: "[CLS]", start: 0, end: 0 },
      { token: "play", start: 0, end: 4 },
      { token: "##ing", start: 4, end: 7 },
      { token: "[SEP]", start: 7, end: 7 },
    ])
  })

  it("maps offsets back through accent stripping (Café -> cafe)", () => {
    const text = "Café"
    const [, cafe] = tok.encode(text)
    expect(cafe).toMatchObject({ token: "cafe", start: 0, end: 4 })
    expect(text.slice(cafe!.start, cafe!.end)).toBe("Café")
  })

  it("splits punctuation into its own token", () => {
    expect(view("hi!")).toEqual([
      { token: "[CLS]", start: 0, end: 0 },
      { token: "hi", start: 0, end: 2 },
      { token: "!", start: 2, end: 3 },
      { token: "[SEP]", start: 3, end: 3 },
    ])
  })

  it("emits [UNK] for a word with an unmatched piece, spanning the whole word", () => {
    const out = tok.encode("carlosz")
    expect(out[1]).toMatchObject({ token: "[UNK]", id: 1, start: 0, end: 7 })
  })

  it("isolates CJK characters as individual tokens", () => {
    expect(view("世a")).toEqual([
      { token: "[CLS]", start: 0, end: 0 },
      { token: "世", start: 0, end: 1 },
      { token: "[UNK]", start: 1, end: 2 },
      { token: "[SEP]", start: 2, end: 2 },
    ])
  })
})
