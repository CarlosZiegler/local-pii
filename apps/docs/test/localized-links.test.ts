import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const docsDirectory = resolve(import.meta.dirname, "../content/docs")

function localeFor(file: string): "de" | "en" | "pt" {
  if (file.endsWith(".de.mdx")) return "de"
  if (file.endsWith(".pt.mdx")) return "pt"
  return "en"
}

describe("localized documentation links", () => {
  for (const file of readdirSync(docsDirectory).filter((name) =>
    name.endsWith(".mdx")
  )) {
    it(`${file} keeps internal links in its locale`, () => {
      const source = readFileSync(resolve(docsDirectory, file), "utf8")
      const locale = localeFor(file)
      const internalLinks = source.matchAll(/\]\((\/(?:de|en|pt)\/docs\/[^)]+)\)/g)

      expect(source).not.toMatch(/\]\(\/docs\//)
      expect(source).not.toMatch(/\]\(\.\//)
      for (const [, href] of internalLinks) {
        expect(href).toMatch(new RegExp(`^/${locale}/docs/`))
      }
    })
  }
})
