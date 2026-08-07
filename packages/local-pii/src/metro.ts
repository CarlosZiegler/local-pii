/**
 * Metro config helper. `onnxruntime-react-native` loads the model as an asset,
 * so Metro must treat `.onnx` as an asset extension. Expo config plugins cannot
 * modify `metro.config.js`, so this small wrapper is the honest mechanism:
 *
 * ```js
 * // metro.config.js
 * const { getDefaultConfig } = require("expo/metro-config")
 * const { withLocalPiiMetro } = require("local-pii/metro")
 * module.exports = withLocalPiiMetro(getDefaultConfig(__dirname))
 * ```
 */
export interface MetroConfigLike {
  resolver?: {
    assetExts?: string[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

export function withLocalPiiMetro<T extends MetroConfigLike>(config: T): T {
  const assetExts = config.resolver?.assetExts ?? []
  if (assetExts.includes("onnx")) return config
  return {
    ...config,
    resolver: {
      ...config.resolver,
      assetExts: [...assetExts, "onnx"],
    },
  }
}
