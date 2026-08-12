const stubs = new Map([
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

const prefix = "local-pii-matrix-stub:"

export async function resolve(specifier, context, nextResolve) {
  if (stubs.has(specifier)) {
    return {
      shortCircuit: true,
      url: `${prefix}${encodeURIComponent(specifier)}`,
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(prefix)) {
    const specifier = decodeURIComponent(url.slice(prefix.length))
    return {
      format: "module",
      shortCircuit: true,
      source: stubs.get(specifier),
    }
  }
  return nextLoad(url, context)
}
