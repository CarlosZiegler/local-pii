import {
  EventType,
  type ModelMessage,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai/client"
import type { ConnectConnectionAdapter } from "@tanstack/ai-client"
import type { BrowserModelRuntime } from "./types"

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
      "The local playground does not send tool messages to the Prompt API"
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

function promptMessage(
  message: UIMessage | ModelMessage
): LanguageModelMessage | LanguageModelSystemMessage {
  return {
    role: message.role as
      LanguageModelMessageRole | LanguageModelSystemMessageRole,
    content: messageText(message),
  } as LanguageModelMessage | LanguageModelSystemMessage
}

function fallbackId(prefix: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}-${suffix}`
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** A direct, in-browser Prompt API connection. No fetch or server transport. */
export function createPromptConnection(
  runtime: BrowserModelRuntime
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

        const initialPrompts = messages
          .slice(0, -1)
          .map(promptMessage) as LanguageModelCreateOptions["initialPrompts"]
        signal?.throwIfAborted()

        let model: LanguageModel | undefined
        let reader: ReadableStreamDefaultReader<string> | undefined
        let completed = false
        let started = false
        const threadId = runContext?.threadId ?? fallbackId("thread")
        const runId = runContext?.runId ?? fallbackId("run")
        const messageId = fallbackId("message")

        try {
          model = await runtime.create({ initialPrompts, signal })
          signal?.throwIfAborted()
          started = true
          yield {
            type: EventType.RUN_STARTED,
            threadId,
            runId,
            model: runtime.kind,
          } satisfies StreamChunk
          yield {
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
            model: runtime.kind,
          } satisfies StreamChunk

          reader = model.promptStreaming(prompt, { signal }).getReader()
          while (true) {
            const next = await reader.read()
            if (next.done) break
            signal?.throwIfAborted()
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: next.value,
              model: runtime.kind,
            } satisfies StreamChunk
          }
          completed = true
          yield {
            type: EventType.TEXT_MESSAGE_END,
            messageId,
            model: runtime.kind,
          } satisfies StreamChunk
          yield {
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
            finishReason: "stop",
            model: runtime.kind,
          } satisfies StreamChunk
        } catch (cause) {
          if (!started) throw cause
          yield {
            type: EventType.RUN_ERROR,
            message: errorMessage(cause),
            model: runtime.kind,
          } satisfies StreamChunk
        } finally {
          if (!completed) {
            try {
              await reader?.cancel()
            } catch {
              // The source may already be errored or aborted.
            }
          }
          model?.destroy()
        }
      })()
    },
  }
}
