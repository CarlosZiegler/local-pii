import type { StreamChunk } from "@tanstack/ai/client"
import { createStreamingRehydrator } from "./rehydrate"
import type { PiiSession } from "./session"

type TextContentChunk = Extract<StreamChunk, { type: "TEXT_MESSAGE_CONTENT" }>
type TextEndChunk = Extract<StreamChunk, { type: "TEXT_MESSAGE_END" }>
type ToolArgsChunk = Extract<StreamChunk, { type: "TOOL_CALL_ARGS" }>
type ToolEndChunk = Extract<StreamChunk, { type: "TOOL_CALL_END" }>
type ToolResultChunk = Extract<StreamChunk, { type: "TOOL_CALL_RESULT" }>
type StreamingRehydrator = ReturnType<typeof createStreamingRehydrator>

interface StreamState {
  protectedContent: string
  rehydrator: StreamingRehydrator
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object"
}

function jsonStringMapping(
  mapping: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapping).map(([placeholder, value]) => [
      placeholder,
      JSON.stringify(value).slice(1, -1),
    ])
  )
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

function finalToolArgsChunk(
  toolCallId: string,
  delta: string,
  reference: StreamChunk
): StreamChunk {
  const common = reference as StreamChunk & {
    model?: string
    timestamp?: number
    rawEvent?: unknown
  }
  return {
    type: "TOOL_CALL_ARGS",
    toolCallId,
    delta,
    ...(common.model === undefined ? {} : { model: common.model }),
    ...(common.timestamp === undefined ? {} : { timestamp: common.timestamp }),
    ...(common.rawEvent === undefined ? {} : { rawEvent: common.rawEvent }),
  } as unknown as StreamChunk
}

function incrementalToolArgsChunk(
  chunk: ToolArgsChunk,
  delta: string
): StreamChunk {
  const output: ToolArgsChunk & { args?: string } = { ...chunk, delta }
  delete output.args
  return output
}

function normalizeProtectedIncrement(
  state: StreamState,
  delta: string,
  cumulative?: string
): string {
  if (delta !== "") {
    state.protectedContent += delta
    return delta
  }

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

function restoreJsonText(session: PiiSession, value: string): string {
  try {
    return JSON.stringify(
      session.rehydrateJson(JSON.parse(value), { lenient: true })
    )
  } catch {
    return session.rehydrate(value, { lenient: true })
  }
}

function restoreContentPart(session: PiiSession, part: unknown): unknown {
  if (!isRecord(part)) return part
  if (part.type === "text" && typeof part.content === "string") {
    return {
      ...part,
      content: session.rehydrate(part.content, { lenient: true }),
    }
  }
  return part
}

function restoreToolResultValue(session: PiiSession, value: unknown): unknown {
  if (typeof value === "string") return restoreJsonText(session, value)
  if (Array.isArray(value)) {
    return value.map((part) => restoreContentPart(session, part))
  }
  return value
}

function restoreToolEndChunk(
  session: PiiSession,
  chunk: ToolEndChunk
): StreamChunk {
  const output = { ...chunk }
  if (chunk.input !== undefined) {
    output.input = session.rehydrateJson(chunk.input, { lenient: true })
  }
  if (chunk.output !== undefined) {
    output.output = session.rehydrateJson(chunk.output, { lenient: true })
  }
  if (chunk.result !== undefined) {
    output.result = restoreToolResultValue(
      session,
      chunk.result
    ) as ToolEndChunk["result"]
  }
  return output
}

function restoreToolResultChunk(
  session: PiiSession,
  chunk: ToolResultChunk
): StreamChunk {
  return { ...chunk, content: restoreJsonText(session, chunk.content) }
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
      const text = new Map<string, StreamState>()
      const tools = new Map<string, StreamState>()
      const pending = new Map<string, { id: string; kind: "text" | "tool" }>()
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
          pending.set(`text:${messageId}`, { kind: "text", id: messageId })
        }
        return state
      }

      const toolStateFor = (toolCallId: string) => {
        let state = tools.get(toolCallId)
        if (!state) {
          state = {
            protectedContent: "",
            rehydrator: createStreamingRehydrator(() =>
              jsonStringMapping(session.mapping)
            ),
          }
          tools.set(toolCallId, state)
          pending.set(`tool:${toolCallId}`, { kind: "tool", id: toolCallId })
        }
        return state
      }

      const flushOne = (chunk: TextEndChunk): StreamChunk | undefined => {
        const state = text.get(chunk.messageId)
        text.delete(chunk.messageId)
        pending.delete(`text:${chunk.messageId}`)
        const tail = state?.rehydrator.flushSafe()
        return tail ? finalTextChunk(chunk.messageId, tail, chunk) : undefined
      }

      const flushOneTool = (chunk: ToolEndChunk): StreamChunk | undefined => {
        const state = tools.get(chunk.toolCallId)
        tools.delete(chunk.toolCallId)
        pending.delete(`tool:${chunk.toolCallId}`)
        const tail = state?.rehydrator.flushSafe()
        return tail
          ? finalToolArgsChunk(chunk.toolCallId, tail, chunk)
          : undefined
      }

      const flushAll = (reference: StreamChunk): StreamChunk[] => {
        const output: StreamChunk[] = []
        for (const item of pending.values()) {
          if (item.kind === "text") {
            const tail = text.get(item.id)?.rehydrator.flushSafe()
            if (tail) output.push(finalTextChunk(item.id, tail, reference))
          } else {
            const tail = tools.get(item.id)?.rehydrator.flushSafe()
            if (tail) output.push(finalToolArgsChunk(item.id, tail, reference))
          }
        }
        text.clear()
        tools.clear()
        pending.clear()
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
            tools.clear()
            pending.clear()
            yield chunk
            continue
          }

          if (chunk.type === "TEXT_MESSAGE_CONTENT") {
            const content = chunk as TextContentChunk
            const state = stateFor(content.messageId)
            const protectedDelta = normalizeProtectedIncrement(
              state,
              content.delta,
              content.content
            )
            const delta = state.rehydrator.push(protectedDelta)
            yield incrementalTextChunk(content, delta)
            continue
          }

          if (chunk.type === "TOOL_CALL_ARGS") {
            const args = chunk as ToolArgsChunk
            const state = toolStateFor(args.toolCallId)
            const protectedDelta = normalizeProtectedIncrement(
              state,
              args.delta,
              args.args
            )
            const delta = state.rehydrator.push(protectedDelta)
            yield incrementalToolArgsChunk(args, delta)
            continue
          }

          if (chunk.type === "TEXT_MESSAGE_END") {
            const tail = flushOne(chunk as TextEndChunk)
            if (tail) yield tail
            yield chunk
            continue
          }

          if (chunk.type === "TOOL_CALL_END") {
            const end = chunk as ToolEndChunk
            const tail = flushOneTool(end)
            if (tail) yield tail
            yield restoreToolEndChunk(session, end)
            continue
          }

          if (chunk.type === "TOOL_CALL_RESULT") {
            yield restoreToolResultChunk(session, chunk as ToolResultChunk)
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
        tools.clear()
        pending.clear()
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
