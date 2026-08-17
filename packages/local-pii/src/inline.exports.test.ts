import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type * as InlineApi from "./inline"

type InlineModule = typeof InlineApi

interface PackageManifest {
  exports: Record<
    string,
    string | { types: string; import: string; require: string }
  >
}

describe("@local-pii/core/inline public subpath", () => {
  it("maps the public subpath to ESM, CommonJS, and declarations", async () => {
    const path = fileURLToPath(new URL("../package.json", import.meta.url))
    const manifest = JSON.parse(await readFile(path, "utf8")) as PackageManifest

    expect(manifest.exports["./inline"]).toEqual({
      types: "./dist/inline.d.ts",
      import: "./dist/inline.js",
      require: "./dist/inline.cjs",
    })
  })

  it("loads the built ESM and CommonJS entry points", async () => {
    const esmUrl = new URL("../dist/inline.js", import.meta.url).href
    const cjsPath = fileURLToPath(
      new URL("../dist/inline.cjs", import.meta.url)
    )
    const require = createRequire(import.meta.url)
    const esm = (await import(esmUrl)) as InlineModule
    const cjs = require(cjsPath) as InlineModule

    expect(esm.runInlineTextStream).toBeTypeOf("function")
    expect(cjs.runInlineTextStream).toBeTypeOf("function")

    await expect(
      esm.runInlineText({ input: "hello", call: async (input) => input })
    ).resolves.toBe("hello")
    await expect(
      cjs.runInlineText({ input: "hello", call: async (input) => input })
    ).resolves.toBe("hello")
  })

  it("emits the public API in the bundled type declarations", async () => {
    const path = fileURLToPath(new URL("../dist/inline.d.ts", import.meta.url))
    const declarations = await readFile(path, "utf8")

    expect(declarations).toContain("runInlineText")
    expect(declarations).toContain("runInlineTextStream")
    expect(declarations).toContain("runInlineJson")
    expect(declarations).toContain("runInline")
    expect(declarations).toContain("anonymizer?: Anonymizer")
  })
})
