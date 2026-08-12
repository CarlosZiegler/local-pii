import Module, { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const [, , kind, absolute, expected] = process.argv
const require = createRequire(import.meta.url)

const vocab = []
const labels = []
const cjsStubs = new Map([
  [
    "expo-asset",
    {
      Asset: class Asset {
        static fromModule() {
          return {
            localUri: "file:///rampart.onnx",
            uri: "file:///rampart.onnx",
            async downloadAsync() {},
          }
        }
      },
    },
  ],
  ["expo-file-system", { cacheDirectory: null, async copyAsync() {} }],
  ["expo-crypto", { getRandomBytes: (length) => new Uint8Array(length) }],
  [
    "expo-secure-store",
    {
      async getItemAsync() {
        return null
      },
      async setItemAsync() {},
    },
  ],
  [
    "onnxruntime-react-native",
    { InferenceSession: {}, Tensor: class Tensor {} },
  ],
  ["@local-pii/model-rampart", { vocab, labels, default: { vocab, labels } }],
])

let loaded
if (kind === "import") {
  loaded = await import(pathToFileURL(absolute).href)
} else if (kind === "require") {
  const originalLoad = Module._load
  Module._load = function matrixLoad(request, parent, isMain) {
    if (cjsStubs.has(request)) return cjsStubs.get(request)
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    loaded = require(absolute)
  } finally {
    Module._load = originalLoad
  }
} else {
  throw new Error(`Unsupported export target kind: ${kind}`)
}

if (typeof loaded[expected] !== "function") {
  throw new Error(`${kind} target did not expose ${expected}`)
}
