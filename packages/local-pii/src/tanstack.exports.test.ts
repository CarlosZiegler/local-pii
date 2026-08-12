import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type * as TanStackApi from "./tanstack"

type TanStackModule = typeof TanStackApi

interface PackageManifest {
  exports: Record<
    string,
    string | { types: string; import: string; require: string }
  >
}

describe("local-pii/tanstack public subpath", () => {
  it("maps the public subpath to ESM, CommonJS, and declarations", async () => {
    const path = fileURLToPath(new URL("../package.json", import.meta.url))
    const manifest = JSON.parse(await readFile(path, "utf8")) as PackageManifest

    expect(manifest.exports["./tanstack"]).toEqual({
      types: "./dist/tanstack.d.ts",
      import: "./dist/tanstack.js",
      require: "./dist/tanstack.cjs",
    })
  })

  it("loads the built ESM and CommonJS entry points", async () => {
    const esmUrl = new URL("../dist/tanstack.js", import.meta.url).href
    const cjsPath = fileURLToPath(
      new URL("../dist/tanstack.cjs", import.meta.url)
    )
    const require = createRequire(import.meta.url)
    const esm = (await import(esmUrl)) as TanStackModule
    const cjs = require(cjsPath) as TanStackModule

    expect(esm.piiConnection).toBeTypeOf("function")
    expect(cjs.piiConnection).toBeTypeOf("function")
    expect(esm.UnsupportedTanStackSemanticContentError).toBeTypeOf("function")
    expect(cjs.UnsupportedTanStackSemanticContentError).toBeTypeOf("function")
  })

  it("emits declarations against public TanStack package types", async () => {
    const path = fileURLToPath(
      new URL("../dist/tanstack.d.ts", import.meta.url)
    )
    const declarations = await readFile(path, "utf8")

    expect(declarations).toContain("@tanstack/ai-client")
    expect(declarations).toContain("piiConnection")
    expect(declarations).toContain("UnsupportedTanStackSemanticContentError")
    expect(declarations).not.toContain("@tanstack/ai-client/src/")
  })
})
