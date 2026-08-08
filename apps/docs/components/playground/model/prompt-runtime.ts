import type {
  BrowserModelRuntime,
  LocalRuntimeKind,
  LocalRuntimeMetadata,
  LocalRuntimeSnapshot,
} from "./types"

const TEXT_EXPECTATIONS: Pick<
  LanguageModelCreateCoreOptions,
  "expectedInputs" | "expectedOutputs"
> = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
}

const GEMMA_CACHE_NAME = "transformers-cache"
const GEMMA_CACHE_URLS = [
  "https://huggingface.co/onnx-community/gemma-3-270m-it-ONNX/resolve/main/config.json",
  "https://huggingface.co/onnx-community/gemma-3-270m-it-ONNX/resolve/main/generation_config.json",
  "https://huggingface.co/onnx-community/gemma-3-270m-it-ONNX/resolve/main/tokenizer_config.json",
  "https://huggingface.co/onnx-community/gemma-3-270m-it-ONNX/resolve/main/tokenizer.json",
  "https://huggingface.co/onnx-community/gemma-3-270m-it-ONNX/resolve/main/onnx/model_q4f16.onnx",
  "https://huggingface.co/onnx-community/gemma-3-270m-it-ONNX/resolve/main/onnx/model_q4f16.onnx_data",
] as const

export interface LanguageModelFactory {
  availability(options?: LanguageModelCreateCoreOptions): Promise<Availability>
  create(options?: LanguageModelCreateOptions): Promise<LanguageModel>
}

export interface PromptRuntimeDependencies {
  availabilityTimeoutMs?: number
  getNative?: () => LanguageModelFactory | undefined
  isFallbackCached?: () => Promise<boolean>
  loadFallback: () => Promise<LanguageModelFactory>
}

export interface PromptRuntimeController {
  activateFallback(): Promise<void>
  activateNative(): Promise<void>
  check(): Promise<void>
  getSnapshot(): LocalRuntimeSnapshot
  subscribe(listener: () => void): () => void
}

function withTextExpectations(
  options: LanguageModelCreateOptions = {}
): LanguageModelCreateOptions {
  return { ...options, ...TEXT_EXPECTATIONS }
}

function runtimeFor(
  kind: LocalRuntimeKind,
  factory: LanguageModelFactory
): BrowserModelRuntime {
  return {
    kind,
    availability: (options) => factory.availability(options),
    create: (options) => factory.create(withTextExpectations(options)),
  }
}

const METADATA: Record<LocalRuntimeKind, LocalRuntimeMetadata> = {
  "gemini-nano": {
    device: "browser",
    execution: "local",
    model: "Gemini Nano",
    source: "Chrome built-in Prompt API",
  },
  "gemma-3-270m": {
    artifactSize: "~426 MB",
    device: "browser",
    execution: "local",
    model: "Gemma 3 270M IT (q4f16)",
    source: "onnx-community/gemma-3-270m-it-ONNX",
  },
}

export function createPromptRuntimeController(
  dependencies: PromptRuntimeDependencies
): PromptRuntimeController {
  const availabilityTimeoutMs = dependencies.availabilityTimeoutMs ?? 5_000
  const listeners = new Set<() => void>()
  let snapshot: LocalRuntimeSnapshot = { status: "checking" }

  const publish = (next: LocalRuntimeSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const publishFallback = async (nativeAvailability?: Availability) => {
    let fallbackCached: boolean | undefined
    if (dependencies.isFallbackCached) {
      try {
        fallbackCached = await dependencies.isFallbackCached()
      } catch {
        // Cache inspection must never prevent explicit fallback activation.
        fallbackCached = false
      }
    }
    publish({
      ...(fallbackCached === undefined ? {} : { fallbackCached }),
      ...(nativeAvailability === undefined ? {} : { nativeAvailability }),
      status: "fallback-available",
    })
  }

  const activate = async (
    kind: LocalRuntimeKind,
    getFactory: () => Promise<LanguageModelFactory>
  ) => {
    publish({
      kind,
      metadata: METADATA[kind],
      progress: 0,
      status: "downloading",
    })
    try {
      const factory = await getFactory()
      const warmSession = await factory.create(
        withTextExpectations({
          monitor(monitor) {
            monitor.addEventListener("downloadprogress", (event) => {
              publish({
                kind,
                metadata: METADATA[kind],
                progress: event.loaded,
                status: "downloading",
              })
            })
          },
        })
      )
      warmSession.destroy()
      publish({
        kind,
        metadata: METADATA[kind],
        progress: 1,
        runtime: runtimeFor(kind, factory),
        status: "ready",
      })
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      publish({ kind, error, metadata: METADATA[kind], status: "error" })
      throw error
    }
  }

  return {
    async check() {
      publish({ status: "checking" })
      try {
        const native = dependencies.getNative?.()
        if (!native) {
          await publishFallback()
          return
        }
        let timeout: ReturnType<typeof setTimeout> | undefined
        const nativeAvailability = await Promise.race([
          native.availability(TEXT_EXPECTATIONS),
          new Promise<"timeout">((resolve) => {
            timeout = setTimeout(
              () => resolve("timeout"),
              availabilityTimeoutMs
            )
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout)
        })
        if (nativeAvailability === "timeout") {
          await publishFallback()
          return
        }
        if (nativeAvailability === "unavailable") {
          await publishFallback(nativeAvailability)
        } else {
          publish({
            nativeAvailability,
            status:
              nativeAvailability === "available"
                ? "native-ready"
                : "native-downloadable",
          })
        }
      } catch (cause) {
        publish({
          error: cause instanceof Error ? cause : new Error(String(cause)),
          status: "error",
        })
      }
    },
    activateNative() {
      return activate("gemini-nano", async () => {
        const native = dependencies.getNative?.()
        if (!native) throw new Error("Chrome Prompt API is not available")
        return native
      })
    },
    activateFallback() {
      return activate("gemma-3-270m", dependencies.loadFallback)
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function getWindowLanguageModel(): LanguageModelFactory | undefined {
  if (typeof window === "undefined" || !("LanguageModel" in window)) {
    return undefined
  }
  return (window as unknown as { LanguageModel?: LanguageModelFactory })
    .LanguageModel
}

export async function hasCachedGemmaArtifacts(
  cacheStorage: CacheStorage | undefined = typeof caches === "undefined"
    ? undefined
    : caches
): Promise<boolean> {
  if (!cacheStorage || !(await cacheStorage.has(GEMMA_CACHE_NAME))) return false
  const cache = await cacheStorage.open(GEMMA_CACHE_NAME)
  const artifacts = await Promise.all(
    GEMMA_CACHE_URLS.map((url) => cache.match(url))
  )
  return artifacts.every(Boolean)
}

export function createBrowserPromptRuntime(): PromptRuntimeController {
  return createPromptRuntimeController({
    getNative: getWindowLanguageModel,
    isFallbackCached: hasCachedGemmaArtifacts,
    async loadFallback() {
      if (typeof window === "undefined") {
        throw new Error("The local fallback requires a browser")
      }
      const { createGemmaLanguageModelFactory } =
        await import("./gemma-runtime")
      return createGemmaLanguageModelFactory()
    },
  })
}

export { TEXT_EXPECTATIONS }
