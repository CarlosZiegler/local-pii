import { describe, expect, it } from "vitest"
import { withLocalPiiMetro, type MetroConfigLike } from "./metro"

describe("withLocalPiiMetro", () => {
  it("adds 'onnx' to an empty resolver", () => {
    const out = withLocalPiiMetro({} as MetroConfigLike)
    expect(out.resolver?.assetExts).toEqual(["onnx"])
  })

  it("appends 'onnx' while preserving existing asset extensions", () => {
    const out = withLocalPiiMetro({ resolver: { assetExts: ["png", "ttf"] } })
    expect(out.resolver?.assetExts).toEqual(["png", "ttf", "onnx"])
  })

  it("is idempotent — never adds 'onnx' twice", () => {
    const once = withLocalPiiMetro({ resolver: { assetExts: ["onnx"] } })
    expect(once.resolver?.assetExts).toEqual(["onnx"])
    const twice = withLocalPiiMetro({} as MetroConfigLike)
    expect(twice.resolver?.assetExts).toEqual(["onnx"])
  })

  it("preserves other config keys", () => {
    const out = withLocalPiiMetro({ projectRoot: "/x", resolver: { sourceExts: ["ts"] } })
    expect(out.projectRoot).toBe("/x")
    expect(out.resolver?.sourceExts).toEqual(["ts"])
  })
})
