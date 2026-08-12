import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const manifest = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8")
)

const publicExports = Object.entries(manifest.exports).filter(
  ([subpath]) => subpath !== "./package.json"
)
const expectedRuntimeExport = new Map([
  [".", "createAnonymizer"],
  ["./expo", "rampart"],
  ["./metro", "withLocalPiiMetro"],
  ["./web", "rampartWeb"],
  ["./openai", "withPiiOpenAI"],
  ["./ai-sdk", "withPii"],
  ["./inline", "runInlineText"],
  ["./tanstack", "piiConnection"],
])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function loadDirectTarget(subpath, target, kind) {
  const absolute = resolve(packageRoot, target)
  const loaded =
    kind === "import"
      ? await import(`${pathToFileURL(absolute).href}?matrix=${Date.now()}`)
      : require(absolute)
  const expected = expectedRuntimeExport.get(subpath)
  assert(
    typeof loaded[expected] === "function",
    `${subpath} ${kind} target did not expose ${expected}`
  )
}

const expoStubs = new Map([
  [
    "expo-asset",
    `export class Asset {
      static fromModule() {
        return { localUri: "file:///rampart.onnx", uri: "file:///rampart.onnx", async downloadAsync() {} }
      }
    }`,
  ],
  [
    "expo-file-system",
    "export const cacheDirectory = null; export async function copyAsync() {}",
  ],
  [
    "expo-crypto",
    "export function getRandomBytes(length) { return new Uint8Array(length) }",
  ],
  [
    "expo-secure-store",
    "export async function getItemAsync() { return null }; export async function setItemAsync() {}",
  ],
  [
    "onnxruntime-react-native",
    "export const InferenceSession = {}; export class Tensor {}",
  ],
  [
    "@local-pii/model-rampart",
    "export const vocab = []; export const labels = []; export default { vocab, labels }",
  ],
])

const stubExpoPeers = {
  name: "stub-expo-peers",
  setup(buildContext) {
    buildContext.onResolve({ filter: /.*/ }, (args) =>
      expoStubs.has(args.path)
        ? { path: args.path, namespace: "expo-matrix-stub" }
        : undefined
    )
    buildContext.onLoad(
      { filter: /.*/, namespace: "expo-matrix-stub" },
      (args) => ({ contents: expoStubs.get(args.path), loader: "js" })
    )
  },
}

async function loadExpoTarget(target, kind) {
  const result = await build({
    entryPoints: [resolve(packageRoot, target)],
    bundle: true,
    write: false,
    platform: "node",
    target: "node20",
    format: kind === "import" ? "esm" : "cjs",
    plugins: [stubExpoPeers],
  })
  const source = result.outputFiles[0].text
  let loaded
  if (kind === "import") {
    loaded = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    )
  } else {
    const module = { exports: {} }
    const execute = new Function(
      "require",
      "module",
      "exports",
      "__filename",
      "__dirname",
      source
    )
    execute(require, module, module.exports, "expo-matrix.cjs", packageRoot)
    loaded = module.exports
  }
  assert(
    typeof loaded.rampart === "function",
    `./expo ${kind} target did not expose rampart`
  )
}

for (const [subpath, targets] of publicExports) {
  assert(typeof targets === "object", `${subpath} must use conditional exports`)
  for (const condition of ["types", "import", "require"]) {
    const absolute = resolve(packageRoot, targets[condition])
    await readFile(absolute)
  }
  for (const condition of ["import", "require"]) {
    if (subpath === "./expo")
      await loadExpoTarget(targets[condition], condition)
    else await loadDirectTarget(subpath, targets[condition], condition)
  }
}

assert(
  typeof manifest["react-native"] === "string",
  "package.json must advertise a react-native target"
)
await readFile(resolve(packageRoot, manifest["react-native"]))
await loadDirectTarget(".", manifest["react-native"], "import")

const fixtureRoot = resolve(packageRoot, "test/import-matrix")
const permittedExternal = {
  "ai-sdk": ["ai"],
  tanstack: ["@tanstack/ai", "@tanstack/ai-client"],
  expo: [
    "@local-pii/model-rampart",
    "expo-asset",
    "expo-crypto",
    "expo-file-system",
    "expo-secure-store",
    "onnxruntime-react-native",
    "react-native",
  ],
}

function dependencyInput(input, dependency) {
  const normalized = input.replaceAll("\\", "/")
  return (
    normalized.includes(`/node_modules/${dependency}/`) ||
    normalized.includes(`/node_modules/${dependency}@`) ||
    normalized.includes(`/node_modules/.bun/${dependency}@`)
  )
}

function nativeOnlyInput(input) {
  const normalized = input.replaceAll("\\", "/")
  return /\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:@expo\/|@react-native\/|expo(?:-|\/|@)|react-native(?:\/|@)|onnxruntime-react-native(?:\/|@))/.test(
    normalized
  )
}

async function verifyBundle(
  name,
  platform,
  { allowNativeRuntime = false, allowWebRuntime = false } = {}
) {
  const extension = name === "metro" ? "cts" : "ts"
  const result = await build({
    entryPoints: [resolve(fixtureRoot, `${name}.${extension}`)],
    bundle: true,
    write: false,
    metafile: true,
    platform,
    target: platform === "browser" ? "es2022" : "node20",
    format: platform === "browser" ? "esm" : "cjs",
    external: permittedExternal[name] ?? [],
    logLevel: "silent",
  })
  const inputs = Object.keys(result.metafile.inputs)
  if (!allowNativeRuntime) {
    const found = inputs.find(nativeOnlyInput)
    assert(
      !found,
      `${name} (${platform}) included a forbidden Expo or React Native dependency: ${found}`
    )
  }
  if (!allowWebRuntime) {
    const found = inputs.find((input) =>
      dependencyInput(input, "onnxruntime-web")
    )
    assert(
      !found,
      `${name} (${platform}) included forbidden dependency onnxruntime-web: ${found}`
    )
  }
}

for (const name of ["core", "inline", "openai", "ai-sdk", "tanstack"])
  await verifyBundle(name, "browser")
await verifyBundle("web", "browser", { allowWebRuntime: true })

for (const name of ["core", "inline", "openai", "ai-sdk", "tanstack", "metro"])
  await verifyBundle(name, "node")

await verifyBundle("expo", "node", { allowNativeRuntime: true })

console.log(
  `verified ${publicExports.length} public subpaths, the react-native target, and 13 isolated bundles`
)
