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

interface ToolStreamState {
  protectedContent: string
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object"
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
  state: { protectedContent: string },
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

function restoreCompleteToolArgs(
  session: PiiSession,
  value: string
): string | undefined {
  try {
    return JSON.stringify(
      session.rehydrateJson(JSON.parse(value), { lenient: true })
    )
  } catch {
    // Never release a protected or syntactically incomplete tool fragment.
    return undefined
  }
}

function restoreContentPart(session: PiiSession, part: unknown): unknown {
  if (!isRecord(part)) return part
  if (part.type === "text" && typeof part.content === "string") {
    return {
      ...part,
      content: restoreJsonText(session, part.content),
    }
  }
  return part
}

function restoreToolResultValue(session: PiiSession, value: unknown): unknown {
  if (typeof value === "string") return restoreJsonText(session, value)
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (isRecord(part) && part.type === "text")
        return restoreContentPart(session, part)
      return session.rehydrateJson(part, { lenient: true })
    })
  }
  return session.rehydrateJson(value, { lenient: true })
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

function restoreCustomChunk(
  session: PiiSession,
  chunk: Extract<StreamChunk, { type: "CUSTOM" }>
): StreamChunk {
  if (!isRecord(chunk.value)) return chunk

  if (chunk.name === "structured-output.complete") {
    const value = chunk.value
    const restoredValue: UnknownRecord = {
      ...value,
      object: session.rehydrateJson(value.object, { lenient: true }),
    }
    if ("raw" in value) {
      restoredValue.raw =
        typeof value.raw === "string"
          ? restoreJsonText(session, value.raw)
          : value.raw
    }
    if ("reasoning" in value) {
      restoredValue.reasoning =
        typeof value.reasoning === "string"
          ? session.rehydrate(value.reasoning, { lenient: true })
          : value.reasoning
    }
    return { ...chunk, value: restoredValue } as unknown as StreamChunk
  }

  if (
    chunk.name === "tool-input-available" ||
    chunk.name === "approval-requested"
  ) {
    const restoredValue: UnknownRecord = { ...chunk.value }
    if ("input" in chunk.value) {
      restoredValue.input = session.rehydrateJson(chunk.value.input, {
        lenient: true,
      })
    }
    return {
      ...chunk,
      value: restoredValue,
    } as unknown as StreamChunk
  }

  return chunk
}

function nextWithAbort(
  iterator: AsyncIterator<StreamChunk>,
  signal: AbortSignal | undefined,
  onAbort: () => void
): Promise<IteratorResult<StreamChunk>> {
  if (!signal) return Promise.resolve(iterator.next())
  signal.throwIfAborted()

  let removeAbortListener = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const handleAbort = () => {
      onAbort()
      reject(signal.reason)
    }
    removeAbortListener = () => signal.removeEventListener("abort", handleAbort)
    signal.addEventListener("abort", handleAbort, { once: true })
  })
  const next = Promise.resolve().then(() => iterator.next())
  return Promise.race([next, aborted]).finally(removeAbortListener)
}

/** Restore one connection run with buffers isolated from every other run. */
export function restoreTanStackStream(
  session: PiiSession,
  source: AsyncIterable<StreamChunk>,
  signal?: AbortSignal
): AsyncIterable<StreamChunk> {
  return {
    [Symbol.asyncIterator]() {
      let iterator: AsyncIterator<StreamChunk> | undefined
      const text = new Map<string, StreamState>()
      const tools = new Map<string, ToolStreamState>()
      const pending = new Map<string, { id: string; kind: "text" | "tool" }>()
      let upstreamDone = false
      let upstreamClosed = false
      let returnStarted = false
      let aborted = false
      let failed = false
      let pendingReturn: Promise<IteratorResult<StreamChunk>> | undefined

      const clear = () => {
        text.clear()
        tools.clear()
        pending.clear()
      }

      const beginReturn = (
        reason?: unknown
      ): Promise<IteratorResult<StreamChunk>> | undefined => {
        if (returnStarted || upstreamDone) return pendingReturn
        returnStarted = true
        upstreamClosed = true
        let result: PromiseLike<IteratorResult<StreamChunk>> | undefined
        try {
          result = iterator?.return?.(reason)
        } catch (error) {
          result = Promise.reject(error)
        }
        pendingReturn = Promise.resolve(
          result ?? { done: true, value: undefined }
        )
        // Abort deliberately does not await a native generator's queued
        // return while its current next() is suspended. Keep the eventual
        // cleanup observed so it cannot become an unhandled rejection.
        void pendingReturn.catch(() => undefined)
        return pendingReturn
      }

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
          state = { protectedContent: "" }
          tools.set(toolCallId, state)
          pending.set(`tool:${toolCallId}`, { kind: "tool", id: toolCallId })
        }
        return state
      }

      const flushOne = (chunk: TextEndChunk): StreamChunk | undefined => {
        const state = text.get(chunk.messageId)
        text.delete(chunk.messageId)
        pending.delete(`text:${chunk.messageId}`)
        const tail = state?.rehydrator.flush()
        return tail ? finalTextChunk(chunk.messageId, tail, chunk) : undefined
      }

      const flushOneTool = (chunk: ToolEndChunk): StreamChunk | undefined => {
        const state = tools.get(chunk.toolCallId)
        tools.delete(chunk.toolCallId)
        pending.delete(`tool:${chunk.toolCallId}`)
        const tail = state
          ? restoreCompleteToolArgs(session, state.protectedContent)
          : undefined
        return tail
          ? finalToolArgsChunk(chunk.toolCallId, tail, chunk)
          : undefined
      }

      const flushAll = (reference: StreamChunk): StreamChunk[] => {
        const output: StreamChunk[] = []
        for (const item of pending.values()) {
          if (item.kind === "text") {
            const tail = text.get(item.id)?.rehydrator.flush()
            if (tail) output.push(finalTextChunk(item.id, tail, reference))
          } else {
            const state = tools.get(item.id)
            const tail = state
              ? restoreCompleteToolArgs(session, state.protectedContent)
              : undefined
            if (tail) output.push(finalToolArgsChunk(item.id, tail, reference))
          }
        }
        text.clear()
        tools.clear()
        pending.clear()
        return output
      }

      const run = async function* (): AsyncGenerator<StreamChunk> {
        try {
          const upstream = source[Symbol.asyncIterator]()
          iterator = upstream
          while (true) {
            signal?.throwIfAborted()
            const next = await nextWithAbort(upstream, signal, () => {
              aborted = true
              closed = true
              clear()
              beginReturn(signal?.reason)
            })
            signal?.throwIfAborted()
            if (closed) {
              clear()
              return
            }

            if (next.done) {
              upstreamDone = true
              for (const chunk of flushAll({} as StreamChunk)) yield chunk
              return
            }

            const chunk = next.value
            if (chunk.type === "RUN_ERROR") {
              // Agent loops can emit a failed turn and then continue with a
              // tool result or a later answer. The failed turn's partial
              // buffers are never valid tails, but the source must drain.
              clear()
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
              normalizeProtectedIncrement(state, args.delta, args.args)
              // Tool arguments are JSON. Buffer them until a successful boundary
              // so JSON escaping and strategy-aware lenient restoration happen
              // on parsed values, never on unsafe string fragments.
              yield incrementalToolArgsChunk(args, "")
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
              // RUN_FINISHED marks one agent turn, not necessarily the source
              // lifetime. Flush a valid current tail, then keep consuming.
              for (const tail of flushAll(chunk)) yield tail
              yield chunk
              continue
            }

            if (chunk.type === "CUSTOM") {
              yield restoreCustomChunk(
                session,
                chunk as Extract<StreamChunk, { type: "CUSTOM" }>
              )
              continue
            }

            yield chunk
          }
        } catch (error) {
          if (signal?.aborted && !aborted) {
            aborted = true
            clear()
            beginReturn(signal.reason)
          }
          failed = true
          clear()
          throw error
        } finally {
          if (!upstreamDone && !upstreamClosed) {
            const cleanup = beginReturn()
            if (cleanup && !aborted) {
              try {
                await cleanup
              } catch (cleanupError) {
                if (!failed) {
                  // Cleanup is the primary failure only when stream processing
                  // itself succeeded.
                  // eslint-disable-next-line no-unsafe-finally -- preserve the cleanup error contract
                  throw cleanupError
                }
              }
            }
          }
        }
      }

      const generator = run()
      let closed = false
      const done = (value?: unknown): IteratorResult<StreamChunk> => ({
        done: true,
        value,
      })

      const wrapped: AsyncIterator<StreamChunk> & AsyncIterable<StreamChunk> = {
        next(value?: unknown) {
          if (closed) return Promise.resolve(done())
          return generator.next(value)
        },
        return(value?: unknown) {
          clear()
          closed = true
          const cleanup = beginReturn(value)
          const closing = generator.return?.(value)
          void Promise.resolve(closing).catch(() => undefined)
          return cleanup
            ? cleanup.then(() => done(value))
            : Promise.resolve(done(value))
        },
        throw(error?: unknown) {
          clear()
          closed = true
          const cleanup = beginReturn(error)
          const throwing = generator.throw?.(error)
          void Promise.resolve(throwing).catch(() => undefined)
          return cleanup ? cleanup.then(() => done()) : Promise.resolve(done())
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
      return wrapped
    },
  }
}
