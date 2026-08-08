import type { ChatTransport, UIMessage, UIMessageChunk } from "ai"

interface LocalChatStopReason {
  readonly name: "LocalChatStop"
}

function watchExpectedStop(reason: LocalChatStopReason): () => void {
  if (typeof window === "undefined") return () => {}
  let removed = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const remove = () => {
    if (removed) return
    removed = true
    if (timeout) clearTimeout(timeout)
    window.removeEventListener("unhandledrejection", handle)
  }
  const handle = (event: PromiseRejectionEvent) => {
    if (event.reason !== reason) return
    event.preventDefault()
    remove()
  }
  window.addEventListener("unhandledrejection", handle)
  return () => {
    if (removed || timeout) return
    // Chromium dispatches unhandledrejection after the cancellation turn.
    timeout = setTimeout(remove, 1_000)
  }
}

function closedStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      controller.close()
    },
  })
}

function stopAwareStream(
  stream: ReadableStream<UIMessageChunk>,
  stop: () => void,
  cleanup: () => void
): ReadableStream<UIMessageChunk> {
  const reader = stream.getReader()
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    cleanup()
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          finish()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      stop()
      finish()
      await reader.cancel(reason).catch(() => {})
    },
  })
}

/**
 * Keeps useChat's DOMException abort reason out of local model providers.
 * The inner signal still stops inference, while an expected Stop cannot become
 * an unhandled AbortError in Chromium.
 */
export function normalizeChatTransportAbort<UI_MESSAGE extends UIMessage>(
  transport: ChatTransport<UI_MESSAGE>
): ChatTransport<UI_MESSAGE> {
  return {
    async sendMessages(options) {
      const inner = new AbortController()
      const stopReason: LocalChatStopReason = Object.freeze({
        name: "LocalChatStop",
      })
      const finishWatchingStop = watchExpectedStop(stopReason)
      const stop = () => {
        if (!inner.signal.aborted) inner.abort(stopReason)
      }
      const cleanup = () => {
        options.abortSignal?.removeEventListener("abort", stop)
        finishWatchingStop()
      }

      if (options.abortSignal?.aborted) stop()
      else options.abortSignal?.addEventListener("abort", stop, { once: true })

      try {
        const stream = await transport.sendMessages({
          ...options,
          abortSignal: inner.signal,
        })
        if (inner.signal.aborted) {
          cleanup()
          await stream.cancel().catch(() => {})
          return closedStream()
        }
        return stopAwareStream(stream, stop, cleanup)
      } catch (error) {
        cleanup()
        if (inner.signal.aborted) return closedStream()
        throw error
      }
    },
    reconnectToStream: (options) => transport.reconnectToStream(options),
  }
}
