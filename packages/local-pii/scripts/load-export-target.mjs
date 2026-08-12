import Module, { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { createCommonJsExpoStubs } from "./expo-matrix-stubs.mjs"

const [, , kind, absolute, expected] = process.argv
const require = createRequire(import.meta.url)

const cjsStubs = createCommonJsExpoStubs()

let loaded
if (kind === "import") {
  loaded = await import(pathToFileURL(absolute).href)
} else if (kind === "require") {
  // Node 20 has no public synchronous CommonJS loader hook. This isolated child
  // patches the loader only while directly evaluating one advertised target.
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
