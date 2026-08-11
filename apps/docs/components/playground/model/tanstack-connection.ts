import {
  EventType,
  type ModelMessage,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai/client"
import type { ConnectConnectionAdapter } from "@tanstack/ai-client"
import { createProtectedBrowserRequest } from "./protected-request"
import type { BrowserGenerationRuntime, ProtectedBrowserTurn } from "./types"

export class UnsupportedPromptMessageError extends Error {
  override name = "UnsupportedPromptMessageError"
}

function messageText(message: UIMessage | ModelMessage): string {
  if ("parts" in message) {
    const unsupported = message.parts.some((part) => part.type !== "text")
    if (unsupported) {
      throw new UnsupportedPromptMessageError(
        "The local playground supports text message parts only"
      )
    }
    return message.parts
      .map((part) => (part.type === "text" ? part.content : ""))
      .join("")
  }

  if (message.role === "tool") {
    throw new UnsupportedPromptMessageError(
      "The local playground does not send tool messages to the browser runtime"
    )
  }
  if (typeof message.content === "string") return message.content
  if (message.content === null) return ""
  const unsupported = message.content.some((part) => part.type !== "text")
  if (unsupported) {
    throw new UnsupportedPromptMessageError(
      "The local playground supports text content only"
    )
  }
  return message.content
    .map((part) => (part.type === "text" ? part.content : ""))
    .join("")
}

function fallbackId(prefix: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}-${suffix}`
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function protectedHistory(
  messages: readonly (UIMessage | ModelMessage)[]
): ProtectedBrowserTurn[] {
  return messages.map((message) => ({
    role:
      message.role === "system"
        ? "system"
        : message.role === "assistant"
          ? "assistant"
          : "user",
    protectedContent: messageText(message),
  }))
}

/** A direct browser-generation connection. No fetch or server transport. */
export function createBrowserConnection(
  runtime: BrowserGenerationRuntime
): ConnectConnectionAdapter {
  return {
    connect(messages, _data, signal, runContext) {
      return (async function* (): AsyncIterableIterator<StreamChunk> {
        if (messages.length === 0) {
          throw new UnsupportedPromptMessageError("A final message is required")
        }
        const final = messages.at(-1)!
        if (final.role !== "user") {
          throw new UnsupportedPromptMessageError(
            "The final message must be a non-empty user prompt"
          )
        }
        const prompt = messageText(final)
        if (prompt.trim() === "") {
          throw new UnsupportedPromptMessageError(
            "The final message must be a non-empty user prompt"
          )
        }
        signal?.throwIfAborted()

        const request = createProtectedBrowserRequest({
          protectedHistory: protectedHistory(messages.slice(0, -1)),
          protectedContent: prompt,
          signal,
        })
        const generation = runtime.generate(request)
        const iterator = generation[Symbol.asyncIterator]()
        let completed = false
        let started = false
        let hasPrimaryError = false
        let primaryError: unknown
        let hasCleanupError = false
        let cleanupError: unknown
        const threadId = runContext?.threadId ?? fallbackId("thread")
        const runId = runContext?.runId ?? fallbackId("run")
        const messageId = fallbackId("message")

        try {
          try {
            started = true
            yield {
              type: EventType.RUN_STARTED,
              threadId,
              runId,
              ...(runContext?.parentRunId === undefined
                ? {}
                : { parentRunId: runContext.parentRunId }),
              model: runtime.id,
            } satisfies StreamChunk
            yield {
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: "assistant",
              model: runtime.id,
            } satisfies StreamChunk

            while (true) {
              const next = await iterator.next()
              if (next.done) break
              signal?.throwIfAborted()
              yield {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: next.value,
                model: runtime.id,
              } satisfies StreamChunk
            }
            completed = true
            yield {
              type: EventType.TEXT_MESSAGE_END,
              messageId,
              model: runtime.id,
            } satisfies StreamChunk
            yield {
              type: EventType.RUN_FINISHED,
              threadId,
              runId,
              finishReason: "stop",
              model: runtime.id,
            } satisfies StreamChunk
          } catch (cause) {
            if (!started) throw cause
            hasPrimaryError = true
            primaryError = cause
          }
        } finally {
          if (!completed) {
            try {
              await iterator.return?.(
                signal?.aborted ? signal.reason : undefined
              )
            } catch (cause) {
              if (!hasPrimaryError) {
                hasCleanupError = true
                cleanupError = cause
                throw cause
              }
            }
          }
        }
        if (!started) return
        const terminalError = hasPrimaryError
          ? primaryError
          : hasCleanupError
            ? cleanupError
            : undefined
        if (hasPrimaryError || hasCleanupError) {
          yield {
            type: EventType.RUN_ERROR,
            threadId,
            runId,
            message: errorMessage(terminalError),
            model: runtime.id,
          } satisfies StreamChunk
        }
      })()
    },
  }
}

/** Backwards-compatible docs-local name while callers migrate to the seam. */
export const createPromptConnection = createBrowserConnection
