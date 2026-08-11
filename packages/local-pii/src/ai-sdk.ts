import { wrapLanguageModel, type LanguageModelMiddleware } from "ai"
import {
  cloneAiSdkValue,
  protectAiSdkPrompt,
  restoreAiSdkContent,
} from "./ai-sdk-content"
import { restoreAiSdkStream } from "./ai-sdk-stream"
import { createAnonymizer, type Anonymizer } from "./anonymizer"
import type { PiiSession } from "./session"
import { token } from "./placeholder/strategies"

export interface PiiMiddlewareOptions {
  /** Reuse a session (share the vault across a conversation / tool loop). */
  session?: PiiSession
  /** Or derive a session from an anonymizer. */
  anonymizer?: Anonymizer
}

function resolveSession(opts: PiiMiddlewareOptions): PiiSession {
  if (opts.session) return opts.session
  return (
    opts.anonymizer ?? createAnonymizer({ placeholders: token() })
  ).createSession()
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      })
    : signal.reason
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

/**
 * Vercel AI SDK middleware that protects only LanguageModelV4 semantic prompt
 * fields and restores generated text/tool values on the way back.
 */
export function piiMiddleware(
  opts: PiiMiddlewareOptions = {}
): LanguageModelMiddleware {
  const session = resolveSession(opts)
  let protectionQueue = Promise.resolve()

  return {
    async transformParams({ params }) {
      throwIfAborted(params.abortSignal)
      const previousProtection = protectionQueue
      let releaseProtection!: () => void
      protectionQueue = new Promise<void>((resolve) => {
        releaseProtection = resolve
      })
      try {
        await previousProtection
        throwIfAborted(params.abortSignal)
        const prompt = await protectAiSdkPrompt(session, params.prompt)
        // Protection can invoke asynchronous detection, so abort again before
        // crossing the provider boundary.
        throwIfAborted(params.abortSignal)
        return prompt === params.prompt
          ? params
          : cloneAiSdkValue(params, { prompt })
      } finally {
        releaseProtection()
      }
    },

    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate()
      const content = restoreAiSdkContent(session, result.content)
      return content === result.content
        ? result
        : cloneAiSdkValue(result, { content })
    },

    async wrapStream({ doStream, params }) {
      const result = await doStream()
      return cloneAiSdkValue(result, {
        stream: restoreAiSdkStream(
          session,
          result.stream as ReadableStream<unknown>,
          params.abortSignal
        ),
      })
    },
  }
}

/** Sugar: `wrapLanguageModel({ model, middleware: piiMiddleware(opts) })`. */
export function withPii<M>(model: M, opts: PiiMiddlewareOptions = {}): M {
  return wrapLanguageModel({
    model: model as never,
    middleware: piiMiddleware(opts),
  }) as M
}
