import { browserAI } from "@browser-ai/core"
import type { LanguageModel } from "ai"
import type { BrowserModelRuntime } from "./types"

type V4Model = Extract<LanguageModel, { specificationVersion: "v4" }>

interface BrowserAIInternals {
  sessionManager?: { destroySession(): void }
}

export interface EphemeralBrowserAIOptions {
  createModel?: () => V4Model
  runtime?: BrowserModelRuntime
}

type PromptGlobal = typeof globalThis & {
  LanguageModel?: BrowserModelRuntime
}

let promptRuntimeTail = Promise.resolve()

async function acquirePromptRuntimeLock(): Promise<() => void> {
  const previous = promptRuntimeTail
  let release = () => {}
  promptRuntimeTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  return release
}

async function withPromptRuntime<Result>(
  runtime: BrowserModelRuntime | undefined,
  call: () => PromiseLike<Result>
): Promise<Result> {
  if (!runtime || runtime.kind === "gemini-nano") return call()

  const release = await acquirePromptRuntimeLock()
  const promptGlobal = globalThis as PromptGlobal
  const previous = Object.getOwnPropertyDescriptor(
    promptGlobal,
    "LanguageModel"
  )
  let installed = false
  try {
    Object.defineProperty(promptGlobal, "LanguageModel", {
      configurable: true,
      value: runtime,
      writable: true,
    })
    installed = true
    return await call()
  } finally {
    if (installed) {
      if (previous) {
        Object.defineProperty(promptGlobal, "LanguageModel", previous)
      } else {
        Reflect.deleteProperty(promptGlobal, "LanguageModel")
      }
    }
    release()
  }
}

function releaseProviderSession(model: V4Model) {
  ;(model as unknown as BrowserAIInternals).sessionManager?.destroySession()
}

function releaseWhenClosed<Chunk>(
  stream: ReadableStream<Chunk>,
  release: () => void
): ReadableStream<Chunk> {
  const reader = stream.getReader()
  let released = false
  const releaseOnce = () => {
    if (released) return
    released = true
    release()
  }

  return new ReadableStream<Chunk>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          releaseOnce()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        releaseOnce()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        releaseOnce()
      }
    },
  })
}

/**
 * Browser AI caches one stateful Prompt API session per model instance. This
 * facade creates and releases a provider model for every AI SDK generation so
 * the complete prompt supplied by the SDK is never duplicated in hidden state.
 */
export function createEphemeralBrowserAIModel(
  options: EphemeralBrowserAIOptions = {}
): V4Model {
  const createModel =
    options.createModel ?? (() => browserAI("text") as unknown as V4Model)

  return {
    modelId: "text",
    provider: "browser-ai",
    specificationVersion: "v4",
    supportedUrls: {},
    async doGenerate(callOptions) {
      const model = createModel()
      try {
        return await withPromptRuntime(options.runtime, () =>
          model.doGenerate(callOptions)
        )
      } finally {
        releaseProviderSession(model)
      }
    },
    async doStream(callOptions) {
      const model = createModel()
      try {
        const result = await withPromptRuntime(options.runtime, () =>
          model.doStream(callOptions)
        )
        return {
          ...result,
          stream: releaseWhenClosed(result.stream, () =>
            releaseProviderSession(model)
          ),
        }
      } catch (error) {
        releaseProviderSession(model)
        throw error
      }
    },
  }
}
