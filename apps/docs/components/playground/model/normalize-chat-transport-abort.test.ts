import type { ChatTransport, UIMessage, UIMessageChunk } from "ai"
import { describe, expect, it, vi } from "vitest"
import { normalizeChatTransportAbort } from "./normalize-chat-transport-abort"

function transportWith(
  sendMessages: ChatTransport<UIMessage>["sendMessages"]
): ChatTransport<UIMessage> {
  return {
    sendMessages,
    reconnectToStream: async () => null,
  }
}

const OPTIONS = {
  body: undefined,
  chatId: "chat",
  headers: undefined,
  messageId: undefined,
  messages: [],
  metadata: undefined,
  trigger: "submit-message" as const,
}

describe("normalizeChatTransportAbort", () => {
  it("relays Stop without the DOMException reason", async () => {
    let innerSignal: AbortSignal | undefined
    const transport = normalizeChatTransportAbort(
      transportWith(async ({ abortSignal }) => {
        innerSignal = abortSignal
        return new ReadableStream<UIMessageChunk>()
      })
    )
    const outer = new AbortController()

    const stream = await transport.sendMessages({
      ...OPTIONS,
      abortSignal: outer.signal,
    })
    outer.abort()

    expect(innerSignal?.aborted).toBe(true)
    expect(innerSignal?.reason).toEqual({ name: "LocalChatStop" })
    const rejection = Object.assign(
      new Event("unhandledrejection", { cancelable: true }),
      { reason: innerSignal?.reason }
    )
    window.dispatchEvent(rejection)
    expect(rejection.defaultPrevented).toBe(true)
    await stream.cancel()
  })

  it("stops inference when the consumer cancels the stream", async () => {
    const cancelled = vi.fn()
    let innerSignal: AbortSignal | undefined
    const transport = normalizeChatTransportAbort(
      transportWith(async ({ abortSignal }) => {
        innerSignal = abortSignal
        return new ReadableStream<UIMessageChunk>({ cancel: cancelled })
      })
    )

    const stream = await transport.sendMessages({
      ...OPTIONS,
      abortSignal: new AbortController().signal,
    })
    await stream.cancel("done")

    expect(innerSignal?.aborted).toBe(true)
    expect(cancelled).toHaveBeenCalledWith("done")
  })
})
