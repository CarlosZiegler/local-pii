import { Asset } from "expo-asset"
import { cacheDirectory, copyAsync } from "expo-file-system"
import * as ortRuntime from "onnxruntime-react-native"
import * as modelRampart from "@local-pii/model-rampart"
import { createRampartNer, type OrtModule } from "./ner/rampart"
import type { NerBackend } from "./types"

export interface RampartOptions {
  /**
   * The model asset: `require("@local-pii/model-rampart/assets/rampart-q4.onnx")`
   * (a Metro asset id) or an absolute file path. Required — passing the asset
   * from the app keeps the 14.7 MB binary out of the library bundle.
   */
  model: number | string
  /** Defaults to the bundled `@local-pii/model-rampart` vocab. */
  vocab?: readonly string[]
  /** Defaults to the bundled `@local-pii/model-rampart` labels. */
  labels?: readonly string[]
  maxTokens?: number
  executionProviders?: Array<"cpu" | "xnnpack" | "coreml" | "nnapi">
  /** Override the ONNX runtime (defaults to `onnxruntime-react-native`). */
  ort?: OrtModule
}

function stripFileUri(path: string): string {
  return path.startsWith("file://") ? path.slice("file://".length) : path
}

async function resolveModelPath(model: number | string): Promise<string> {
  if (typeof model === "string") return stripFileUri(model)

  const asset = await Asset.fromModule(model).downloadAsync()
  const source = asset.localUri ?? asset.uri
  // iOS standalone builds fail to load the model from inside the app bundle;
  // always copy it to the cache directory first (onnxruntime issues
  // #26738 / #27062).
  if (cacheDirectory) {
    const dest = `${cacheDirectory}rampart-q4.onnx`
    try {
      await copyAsync({ from: source, to: dest })
      return stripFileUri(dest)
    } catch {
      // Fall back to the original location if the copy fails.
    }
  }
  return stripFileUri(source)
}

/**
 * The Rampart NER backend for React Native. Wires `onnxruntime-react-native`
 * and the bundled model/tokenizer assets to the runtime-agnostic
 * {@link createRampartNer} core. Requires a dev client / prebuild — it does not
 * work in Expo Go — and Metro configured via `withLocalPiiMetro`.
 *
 * ```ts
 * import { createAnonymizer } from "local-pii"
 * import { rampart } from "local-pii/expo"
 *
 * const pii = createAnonymizer({
 *   ner: rampart({ model: require("@local-pii/model-rampart/assets/rampart-q4.onnx") }),
 * })
 * ```
 */
export function rampart(options: RampartOptions): NerBackend {
  const ort = options.ort ?? (ortRuntime as unknown as OrtModule)
  let inner: NerBackend | null = null
  let loadPromise: Promise<void> | null = null
  let disposePromise: Promise<void> | null = null

  return {
    name: "rampart",

    async load() {
      if (disposePromise) await disposePromise
      if (inner) return
      if (loadPromise) return loadPromise

      const operation = (async () => {
        const modelPath = await resolveModelPath(options.model)
        // Keep `inner` unset until load succeeds so a failed candidate is never
        // retained and a later retry creates a fresh model session.
        const candidate = createRampartNer({
          ort,
          model: modelPath,
          vocab: options.vocab ?? modelRampart.vocab,
          labels: options.labels ?? modelRampart.labels,
          maxTokens: options.maxTokens,
          sessionOptions: options.executionProviders
            ? { executionProviders: options.executionProviders }
            : undefined,
        })
        try {
          await candidate.load()
        } catch (error) {
          try {
            await candidate.dispose()
          } catch {
            // Cleanup failure must not replace the primary load error.
          }
          throw error
        }
        inner = candidate
      })()
      loadPromise = operation
      try {
        await operation
      } finally {
        if (loadPromise === operation) loadPromise = null
      }
    },

    async detect(text: string) {
      return inner ? inner.detect(text) : []
    },

    async dispose() {
      if (disposePromise) return disposePromise
      const operation = (async () => {
        try {
          await loadPromise
        } catch {
          // A failed load already disposes its unpublished candidate.
        }
        const candidate = inner
        if (!candidate) return
        await candidate.dispose()
        if (inner === candidate) inner = null
      })()
      disposePromise = operation
      try {
        await operation
      } finally {
        if (disposePromise === operation) disposePromise = null
      }
    },
  }
}

export { getOrCreateDeviceSecret } from "./secret"
