import { describe, expect, it } from "vitest"
import { emailDetector } from "./email"

describe("emailDetector", () => {
  it("finds a plain email and reports its exact span", () => {
    const text = "reach me at ana.silva@example.com tomorrow"
    const [entity, ...rest] = emailDetector.detect(text)

    expect(rest).toHaveLength(0)
    expect(entity).toBeDefined()
    expect(entity!.type).toBe("EMAIL")
    expect(entity!.text).toBe("ana.silva@example.com")
    expect(text.slice(entity!.start, entity!.end)).toBe("ana.silva@example.com")
    expect(entity!.source).toBe("deterministic")
    expect(entity!.confidence).toBe(1)
  })

  it("finds multiple emails including plus-addressing and subdomains", () => {
    const text = "a@b.io and joão+news@mail.co.uk please"
    const values = emailDetector.detect(text).map((e) => e.text)
    expect(values).toEqual(["a@b.io", "joão+news@mail.co.uk"])
  })

  it("does not match a bare domain or an @handle", () => {
    expect(emailDetector.detect("visit example.com or @acme")).toEqual([])
  })

  it("excludes trailing sentence punctuation from the match", () => {
    expect(emailDetector.detect("mail anna@acme.com, please")[0]?.text).toBe(
      "anna@acme.com",
    )
    expect(emailDetector.detect("(see bob@x.io).")[0]?.text).toBe("bob@x.io")
  })

  it("returns an empty array when there is no email", () => {
    expect(emailDetector.detect("nothing to see here")).toEqual([])
  })
})
