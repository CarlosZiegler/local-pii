// Minimal ambient declarations for the optional React Native / Expo peer
// modules the `local-pii/expo` and `local-pii/metro` subpaths use. They let
// the glue typecheck without installing native packages (which need an Expo
// app). The real packages provide richer types when present in a consumer app.

declare module "onnxruntime-react-native" {
  export const InferenceSession: {
    create(path: string, options?: unknown): Promise<unknown>
  }
  export class Tensor {
    constructor(type: string, data: unknown, dims: readonly number[])
  }
}

declare module "expo-asset" {
  export class Asset {
    static fromModule(moduleId: number): Asset
    downloadAsync(): Promise<Asset>
    localUri: string | null
    uri: string
  }
}

declare module "expo-file-system" {
  export const cacheDirectory: string | null
  export function copyAsync(options: {
    from: string
    to: string
  }): Promise<void>
}

declare module "expo-crypto" {
  export function getRandomBytes(byteCount: number): Uint8Array
}

declare module "expo-secure-store" {
  export function getItemAsync(key: string): Promise<string | null>
  export function setItemAsync(key: string, value: string): Promise<void>
}
