export const expoStubSources = new Map([
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

export function createCommonJsExpoStubs() {
  const vocab = []
  const labels = []
  return new Map([
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
}
