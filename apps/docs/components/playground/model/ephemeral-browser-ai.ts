import { browserAI } from "@browser-ai/core"
import type { LanguageModel } from "ai"

type V4Model = Extract<LanguageModel, { specificationVersion: "v4" }>

interface BrowserAIInternals {
  sessionManager?: { destroySession(): void }
}

export interface EphemeralBrowserAIOptions {
  createModel?: () => V4Model
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
        return await model.doGenerate(callOptions)
      } finally {
        releaseProviderSession(model)
      }
    },
    async doStream(callOptions) {
      const model = createModel()
      try {
        const result = await model.doStream(callOptions)
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
