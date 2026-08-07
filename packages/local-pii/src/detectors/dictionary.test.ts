import { describe, expect, it } from "vitest"
import { createDictionaryDetector } from "./dictionary"

describe("createDictionaryDetector", () => {
  it("matches a user term case-insensitively and tags its type", () => {
    const d = createDictionaryDetector([{ value: "Kempten", type: "CITY" }])
    const [e] = d.detect("eu moro em kempten hoje")
    expect(e?.type).toBe("CITY")
    expect(e?.text).toBe("kempten")
    expect(e?.source).toBe("dictionary")
    expect(e?.confidence).toBe(1)
  })

  it("respects whole-word matching by default", () => {
    const d = createDictionaryDetector([{ value: "Ana" }])
    expect(d.detect("a Banana")).toEqual([])
    expect(d.detect("olá Ana!")[0]?.text).toBe("Ana")
  })

  it("defaults the type to CUSTOM", () => {
    const d = createDictionaryDetector([{ value: "Projeto X" }])
    expect(d.detect("no Projeto X vamos")[0]?.type).toBe("CUSTOM")
  })

  it("supports case-sensitive entries", () => {
    const d = createDictionaryDetector([
      { value: "IT", type: "ORGANIZATION", caseSensitive: true },
    ])
    expect(d.detect("the it department")).toEqual([])
    expect(d.detect("the IT department")[0]?.text).toBe("IT")
  })

  it("matches accented terms and finds every occurrence", () => {
    const d = createDictionaryDetector([{ value: "João", type: "GIVEN_NAME" }])
    const hits = d.detect("João ligou. Depois João saiu.")
    expect(hits.map((e) => e.start)).toEqual([0, 19])
  })
})
