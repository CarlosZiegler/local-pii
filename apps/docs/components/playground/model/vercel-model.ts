import type { LanguageModel } from "ai"
import type { BrowserGenerationRuntime, ProtectedBrowserTurn } from "./types"
import { createProtectedBrowserRequest } from "./protected-request"

type V4Model = Extract<LanguageModel, { specificationVersion: "v4" }>
type V4CallOptions = Parameters<V4Model["doGenerate"]>[0]
type V4GenerateResult = Awaited<ReturnType<V4Model["doGenerate"]>>
type V4StreamResult = Awaited<ReturnType<V4Model["doStream"]>>
type V4StreamPart =
  V4StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never

export class UnsupportedBrowserModelInputError extends TypeError {
  override name = "UnsupportedBrowserModelInputError"
}

type TextTurn = {
  role: "system" | "user" | "assistant"
  content: string
}

function unsupported(message: string): never {
  throw new UnsupportedBrowserModelInputError(message)
}

function textParts(
  content: string | readonly { type: string; text?: unknown }[]
): string {
  if (typeof content === "string") return content
  return content
    .map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") {
        return unsupported(
          "The browser generation model supports text content only"
        )
      }
      return part.text
    })
    .join("")
}

function textPrompt(options: V4CallOptions): TextTurn[] {
  if (options.tools !== undefined || options.toolChoice !== undefined) {
    return unsupported("The browser generation model does not support tools")
  }
  if (options.reasoning !== undefined) {
    return unsupported(
      "The browser generation model does not support reasoning content"
    )
  }

  return options.prompt.map((message) => {
    if (message.role === "system") {
      if (typeof message.content !== "string")
        return unsupported("The system prompt must contain text")
      return { role: "system", content: message.content }
    }
    if (message.role !== "user" && message.role !== "assistant") {
      return unsupported(
        `The browser generation model does not support the ${message.role} role`
      )
    }
    return {
      role: message.role,
      content: textParts(message.content),
    }
  })
}

function protectedRequest(
  options: V4CallOptions
): ReturnType<typeof createProtectedBrowserRequest> {
  const prompt = textPrompt(options)
  const final = prompt.at(-1)
  if (!final || final.role !== "user" || final.content.trim() === "") {
    return unsupported("The final browser generation message must be user text")
  }

  const protectedHistory: ProtectedBrowserTurn[] = prompt
    .slice(0, -1)
    .map((message) => ({
      role: message.role,
      protectedContent: message.content,
    }))

  return createProtectedBrowserRequest({
    protectedHistory,
    protectedContent: final.content,
    signal: options.abortSignal,
  })
}

function usage() {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

function finishReason() {
  return { unified: "stop" as const, raw: "browser" }
}

/** Adapt the direct BrowserGenerationRuntime to AI SDK LanguageModel v4. */
export function createBrowserLanguageModel(
  runtime: BrowserGenerationRuntime
): V4Model {
  const model = {
    specificationVersion: "v4" as const,
    provider: "docs-browser-generation",
    modelId: runtime.id,
    supportedUrls: {},

    async doGenerate(options: V4CallOptions): Promise<V4GenerateResult> {
      const request = protectedRequest(options)
      const source = runtime.generate(request)[Symbol.asyncIterator]()
      let text = ""
      let completed = false
      let hasPrimaryError = false
      let primaryError: unknown
      try {
        while (true) {
          const next = await source.next()
          if (next.done) break
          text += next.value
        }
        completed = true
      } catch (error) {
        hasPrimaryError = true
        primaryError = error
      }

      let hasCleanupError = false
      let cleanupError: unknown
      if (!completed) {
        try {
          await source.return?.(
            request.signal?.aborted ? request.signal.reason : undefined
          )
        } catch (error) {
          hasCleanupError = true
          cleanupError = error
        }
      }
      if (hasPrimaryError) throw primaryError
      if (hasCleanupError) throw cleanupError
      return {
        content: [{ type: "text", text }],
        finishReason: finishReason(),
        usage: usage(),
        warnings: [],
      }
    },

    async doStream(options: V4CallOptions): Promise<V4StreamResult> {
      const request = protectedRequest(options)
      const source = runtime.generate(request)[Symbol.asyncIterator]()
      const id = `browser-text-${globalThis.crypto?.randomUUID?.() ?? "stream"}`
      let cancelled = false
      let finished = false

      const stream = new ReadableStream<V4StreamPart>({
        start(controller) {
          void (async () => {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ type: "text-start", id })
            let hasPrimaryError = false
            let primaryError: unknown
            let hasCleanupError = false
            let cleanupError: unknown
            try {
              while (true) {
                const next = await source.next()
                if (next.done) break
                if (cancelled) break
                controller.enqueue({
                  type: "text-delta",
                  id,
                  delta: next.value,
                })
              }
              if (cancelled) return
              controller.enqueue({ type: "text-end", id })
              controller.enqueue({
                type: "finish",
                finishReason: finishReason(),
                usage: usage(),
              })
              finished = true
            } catch (error) {
              hasPrimaryError = true
              primaryError = error
            }

            if (!finished && !cancelled) {
              try {
                await source.return?.(
                  request.signal?.aborted ? request.signal.reason : undefined
                )
              } catch (error) {
                hasCleanupError = true
                cleanupError = error
              }
            }
            if (cancelled) return
            if (hasPrimaryError) {
              controller.error(primaryError)
            } else if (hasCleanupError) {
              controller.error(cleanupError)
            } else if (finished) {
              controller.close()
            }
          })()
        },
        async cancel(reason) {
          cancelled = true
          await source.return?.(reason)
        },
      })
      return { stream }
    },
  }
  return model as V4Model
}

export { textPrompt }
