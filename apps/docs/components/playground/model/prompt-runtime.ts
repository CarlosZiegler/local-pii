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

export interface LanguageModelFactory {
  availability(options?: LanguageModelCreateCoreOptions): Promise<Availability>
  create(options?: LanguageModelCreateOptions): Promise<LanguageModel>
}

export interface PromptRuntimeDependencies {
  configureFallback?: () => void
  getNative?: () => LanguageModelFactory | undefined
  loadFallback: () => Promise<LanguageModelFactory>
}

export interface PromptRuntimeController {
  activateFallback(): Promise<void>
  activateNative(): Promise<void>
  check(): Promise<void>
  getSnapshot(): LocalRuntimeSnapshot
  subscribe(listener: () => void): () => void
}

declare global {
  interface Window {
    TRANSFORMERS_CONFIG?: {
      apiKey: string
      device: "webgpu"
      dtype: "q4f16"
      modelName: string
    }
  }
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
  const listeners = new Set<() => void>()
  let snapshot: LocalRuntimeSnapshot = { status: "checking" }

  const publish = (next: LocalRuntimeSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const activate = async (
    kind: LocalRuntimeKind,
    getFactory: () => Promise<LanguageModelFactory>
  ) => {
    publish({ kind, metadata: METADATA[kind], progress: 0, status: "downloading" })
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
          publish({ status: "fallback-available" })
          return
        }
        const nativeAvailability = await native.availability(TEXT_EXPECTATIONS)
        publish({
          nativeAvailability,
          status:
            nativeAvailability === "available"
              ? "native-ready"
              : nativeAvailability === "unavailable"
                ? "fallback-available"
                : "native-downloadable",
        })
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
      return activate("gemma-3-270m", async () => {
        dependencies.configureFallback?.()
        return dependencies.loadFallback()
      })
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

export function createBrowserPromptRuntime(): PromptRuntimeController {
  return createPromptRuntimeController({
    getNative: getWindowLanguageModel,
    configureFallback() {
      if (typeof window === "undefined") return
      window.TRANSFORMERS_CONFIG = {
        apiKey: "dummy",
        device: "webgpu",
        dtype: "q4f16",
        modelName: "onnx-community/gemma-3-270m-it-ONNX",
      }
    },
    async loadFallback() {
      if (typeof window === "undefined") {
        throw new Error("The local fallback requires a browser")
      }
      await import("prompt-api-polyfill")
      const factory = getWindowLanguageModel()
      if (!factory) throw new Error("The local Prompt API fallback did not load")
      return factory
    },
  })
}

export { TEXT_EXPECTATIONS }
