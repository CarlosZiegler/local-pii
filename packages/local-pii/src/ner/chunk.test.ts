import { describe, expect, it } from "vitest"
import { chunkTokens } from "./chunk"
import type { EncodedToken } from "../tokenizer/wordpiece"

function seq(n: number): EncodedToken[] {
  const t = (token: string, i: number, special = false): EncodedToken => ({
    id: i,
    token,
    start: i,
    end: i + 1,
    special,
  })
  const content = Array.from({ length: n }, (_, i) => t(`w${i}`, i + 1))
  return [t("[CLS]", 0, true), ...content, t("[SEP]", n + 1, true)]
}

describe("chunkTokens", () => {
  it("returns a single window when the sequence already fits", () => {
    const tokens = seq(3)
    expect(chunkTokens(tokens, 512)).toEqual([tokens])
  })

  it("splits long sequences into CLS/SEP-wrapped overlapping windows", () => {
    // capacity = 4 - 2 = 2, stride = floor(2*0.75) = 1
    const windows = chunkTokens(seq(4), 4)
    expect(windows.length).toBeGreaterThan(1)
    for (const w of windows) {
      expect(w[0]!.token).toBe("[CLS]")
      expect(w.at(-1)!.token).toBe("[SEP]")
      expect(w.length).toBeLessThanOrEqual(4)
    }
  })

  it("covers every content token across the windows", () => {
    const windows = chunkTokens(seq(10), 6) // capacity 4, stride 3
    const covered = new Set<string>()
    for (const w of windows) for (const t of w) if (!t.special) covered.add(t.token)
    expect(covered.size).toBe(10)
  })
})
