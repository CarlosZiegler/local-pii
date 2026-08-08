import type { StreamChunk } from "@tanstack/ai/client"
import { createStreamingRehydrator } from "./rehydrate"
import type { PiiSession } from "./session"

type TextContentChunk = Extract<StreamChunk, { type: "TEXT_MESSAGE_CONTENT" }>
type TextEndChunk = Extract<StreamChunk, { type: "TEXT_MESSAGE_END" }>
type StreamingRehydrator = ReturnType<typeof createStreamingRehydrator>

interface TextStreamState {
  protectedContent: string
  rehydrator: StreamingRehydrator
}

function finalTextChunk(
  messageId: string,
  delta: string,
  reference: StreamChunk
): StreamChunk {
  const common = reference as StreamChunk & {
    model?: string
    timestamp?: number
    rawEvent?: unknown
  }
  return {
    type: "TEXT_MESSAGE_CONTENT",
    messageId,
    delta,
    ...(common.model === undefined ? {} : { model: common.model }),
    ...(common.timestamp === undefined ? {} : { timestamp: common.timestamp }),
    ...(common.rawEvent === undefined ? {} : { rawEvent: common.rawEvent }),
  } as unknown as StreamChunk
}

function incrementalTextChunk(
  content: TextContentChunk,
  delta: string
): StreamChunk {
  const output: TextContentChunk & { content?: string } = {
    ...content,
    delta,
  }
  // TanStack falls back to this cumulative provider field when `delta` is
  // empty. Keeping it could bypass the streaming rehydrator and expose a
  // placeholder, so the adapter emits only the canonical incremental value.
  delete output.content
  return output
}

function normalizeProtectedDelta(
  state: TextStreamState,
  chunk: TextContentChunk
): string {
  if (chunk.delta !== "") {
    state.protectedContent += chunk.delta
    return chunk.delta
  }

  const cumulative = chunk.content
  if (cumulative === undefined || cumulative === "") return ""

  const previous = state.protectedContent
  if (cumulative.startsWith(previous)) {
    state.protectedContent = cumulative
    return cumulative.slice(previous.length)
  }
  if (previous.startsWith(cumulative)) return ""

  state.protectedContent += cumulative
  return cumulative
}

/** Restore one connection run with buffers isolated from every other run. */
export function restoreTanStackStream(
  session: PiiSession,
  source: AsyncIterable<StreamChunk>,
  signal?: AbortSignal
): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]()
      const text = new Map<string, TextStreamState>()
      let upstreamDone = false
      let failed = false
      let runError = false

      const stateFor = (messageId: string) => {
        let state = text.get(messageId)
        if (!state) {
          state = {
            protectedContent: "",
            rehydrator: createStreamingRehydrator(() => session.mapping),
          }
          text.set(messageId, state)
        }
        return state
      }

      const flushOne = (chunk: TextEndChunk): StreamChunk | undefined => {
        const state = text.get(chunk.messageId)
        text.delete(chunk.messageId)
        const tail = state?.rehydrator.flush()
        return tail ? finalTextChunk(chunk.messageId, tail, chunk) : undefined
      }

      const flushAll = (reference: StreamChunk): StreamChunk[] => {
        const output: StreamChunk[] = []
        for (const [messageId, state] of text) {
          const tail = state.rehydrator.flush()
          if (tail) output.push(finalTextChunk(messageId, tail, reference))
        }
        text.clear()
        return output
      }

      try {
        while (true) {
          signal?.throwIfAborted()
          const next = await iterator.next()
          signal?.throwIfAborted()

          if (next.done) {
            upstreamDone = true
            if (!runError) {
              for (const chunk of flushAll({} as StreamChunk)) yield chunk
            }
            return
          }

          const chunk = next.value
          if (chunk.type === "RUN_ERROR") {
            runError = true
            text.clear()
            yield chunk
            continue
          }

          if (chunk.type === "TEXT_MESSAGE_CONTENT") {
            const content = chunk as TextContentChunk
            const state = stateFor(content.messageId)
            const protectedDelta = normalizeProtectedDelta(state, content)
            const delta = state.rehydrator.push(protectedDelta)
            yield incrementalTextChunk(content, delta)
            continue
          }

          if (chunk.type === "TEXT_MESSAGE_END") {
            const tail = flushOne(chunk as TextEndChunk)
            if (tail) yield tail
            yield chunk
            continue
          }

          if (chunk.type === "RUN_FINISHED") {
            for (const tail of flushAll(chunk)) yield tail
            yield chunk
            continue
          }

          yield chunk
        }
      } catch (error) {
        failed = true
        text.clear()
        throw error
      } finally {
        try {
          if (!upstreamDone) await iterator.return?.()
        } catch (cleanupError) {
          if (!failed) throw cleanupError
        }
      }
    },
  }
}
