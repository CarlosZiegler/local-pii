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
const TRUSTED_REFLECT_APPLY = Reflect.apply
const TRUSTED_ARRAY_PUSH = Array.prototype.push
const TRUSTED_ARRAY_SHIFT = Array.prototype.shift
const recoverableNextErrors = new WeakMap<object, unknown>()
const concurrentThrowHandlers = new WeakMap<object, () => void>()

function arrayPush<T>(items: T[], item: T) {
  TRUSTED_REFLECT_APPLY(TRUSTED_ARRAY_PUSH, items, [item])
}

function arrayShift<T>(items: T[]) {
  return TRUSTED_REFLECT_APPLY(TRUSTED_ARRAY_SHIFT, items, []) as
    | T
    | undefined
}

export function recoverableTanStackNextError(cause: unknown): object {
  const marker = Object.create(null) as object
  recoverableNextErrors.set(marker, cause)
  return marker
}

export function unwrapRecoverableTanStackNext(error: unknown): {
  recoverable: boolean
  value: unknown
} {
  if (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) {
    if (recoverableNextErrors.has(error))
      return { recoverable: true, value: recoverableNextErrors.get(error) }
  }
  return { recoverable: false, value: error }
}

export function markTanStackThrowConcurrent(iterator: AsyncIterator<unknown>) {
  concurrentThrowHandlers.get(iterator as object)?.()
}

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
    let changed = false
    const restored = value.map((part) => {
      const output = restoreContentPart(session, part)
      changed ||= output !== part
      return output
    })
    return changed ? restored : value
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
): {
  promise: Promise<IteratorResult<StreamChunk>>
  cancel: () => void
} {
  if (!signal)
    return {
      promise: Promise.resolve(iterator.next()),
      cancel: () => {},
    }
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
  let canceled = false
  const cancel = () => {
    if (canceled) return
    canceled = true
    removeAbortListener()
  }
  return {
    promise: Promise.race([next, aborted]).finally(cancel),
    cancel,
  }
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
      let closed = false
      let nextInFlight = false
      let cancelPendingNext = () => {}
      type PendingNext = {
        settled: boolean
        resolve: (result: IteratorResult<StreamChunk>) => void
        reject: (error: unknown) => void
      }
      const pendingNext = new Set<PendingNext>()
      type QueuedOutcome =
        | { kind: "result"; result: IteratorResult<StreamChunk> }
        | { kind: "error"; error: unknown }
      const queued: QueuedOutcome[] = []

      const queueResult = (result: IteratorResult<StreamChunk>) => {
        arrayPush(queued, { kind: "result", result })
      }

      const queueValue = (value: StreamChunk) => {
        queueResult({ done: false, value })
      }

      const queueError = (error: unknown) => {
        arrayPush(queued, { kind: "error", error })
      }

      type ThrowGate = {
        canceled: boolean
        resolve: (result: IteratorResult<StreamChunk>) => void
        reject: (error: unknown) => void
      }
      const activeThrows = new Set<ThrowGate>()
      type NextOperation = {
        kind: "next"
        preempted?: boolean
        preemptedSettled?: boolean
        preemptedTerminal?: boolean
        waitingSource?: boolean
        pending: {
          settled: boolean
          resolve: (result: IteratorResult<StreamChunk>) => void
          reject: (error: unknown) => void
        }
        value?: unknown
      }
      type ThrowOperation = {
        kind: "throw"
        error: unknown
        concurrent?: boolean
        preemptedNext?: NextOperation
        gate: ThrowGate
      }
      type Operation = NextOperation | ThrowOperation
      const operations: Operation[] = []
      let activeOperation:
        | (Operation & { preempted?: boolean; waitingSource?: boolean })
        | undefined
      const preemptedNext = new Set<NextOperation>()
      const losingNext = new Set<NextOperation>()
      let allowConcurrentThrow = false
      let errorCloseStarted = false
      let errorCleanup: Promise<IteratorResult<StreamChunk>> | undefined
      let pump = () => {}

      const settleDelegatedThrows = (
        kind: "return" | "abort" | "throw",
        value?: unknown,
        cleanup?: Promise<IteratorResult<StreamChunk>>
      ) => {
        const gates = [...activeThrows]
        activeThrows.clear()
        for (const gate of gates) {
          gate.canceled = true
          if (kind === "return")
            gate.resolve({ done: true, value: value as StreamChunk })
          else if (cleanup)
            void cleanup.then(
              () => gate.reject(value),
              () => gate.reject(value)
            )
          else gate.reject(value)
        }
      }

      const settlePending = (
        kind: "return" | "abort" | "throw",
        value?: unknown,
        recoverable = false,
        skip?: PendingNext
      ) => {
        for (const pending of pendingNext) {
          if (pending === skip) continue
          pending.settled = true
          if (kind === "return")
            pending.resolve({ done: true, value: undefined })
          else
            pending.reject(
              recoverable ? recoverableTanStackNextError(value) : value
            )
        }
        pendingNext.clear()
      }

      const clearBuffers = () => {
        text.clear()
        tools.clear()
        pending.clear()
      }

      const clear = () => {
        clearBuffers()
        queued.length = 0
      }

      const discardQueuedOperations = () => {
        operations.splice(0)
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

      const restoreChunk = (chunk: StreamChunk): StreamChunk[] => {
        if (chunk.type === "RUN_ERROR") {
          // Agent loops can emit a failed turn and then continue with a tool
          // result or a later answer. The failed turn's partial buffers are
          // never valid tails, but the source must drain.
          clearBuffers()
          return [chunk]
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
          return [incrementalTextChunk(content, delta)]
        }

        if (chunk.type === "TOOL_CALL_ARGS") {
          const args = chunk as ToolArgsChunk
          const state = toolStateFor(args.toolCallId)
          normalizeProtectedIncrement(state, args.delta, args.args)
          // Tool arguments are JSON. Buffer them until a successful boundary
          // so JSON escaping and strategy-aware lenient restoration happen
          // on parsed values, never on unsafe string fragments.
          return [incrementalToolArgsChunk(args, "")]
        }

        if (chunk.type === "TEXT_MESSAGE_END") {
          const tail = flushOne(chunk as TextEndChunk)
          return [...(tail ? [tail] : []), chunk]
        }

        if (chunk.type === "TOOL_CALL_END") {
          const end = chunk as ToolEndChunk
          const tail = flushOneTool(end)
          return [...(tail ? [tail] : []), restoreToolEndChunk(session, end)]
        }

        if (chunk.type === "TOOL_CALL_RESULT") {
          return [restoreToolResultChunk(session, chunk as ToolResultChunk)]
        }

        if (chunk.type === "RUN_FINISHED") {
          return [...flushAll(chunk), chunk]
        }

        if (chunk.type === "CUSTOM") {
          return [
            restoreCustomChunk(
              session,
              chunk as Extract<StreamChunk, { type: "CUSTOM" }>
            ),
          ]
        }

        return [chunk]
      }

      const run = async function* (): AsyncGenerator<StreamChunk> {
        let failure: unknown
        try {
          const upstream = source[Symbol.asyncIterator]()
          iterator = upstream
          while (true) {
            try {
              signal?.throwIfAborted()
              nextInFlight = true
              let next: IteratorResult<StreamChunk>
              const pending = nextWithAbort(upstream, signal, () => {
                aborted = true
                closed = true
                settleDelegatedThrows("abort", signal?.reason)
                settlePreemptedNext("abort", signal?.reason)
                settlePending("abort", signal?.reason)
                clear()
                discardQueuedOperations()
                beginReturn(signal?.reason)
              })
              cancelPendingNext = pending.cancel
              try {
                next = await pending.promise
              } finally {
                pending.cancel()
                if (cancelPendingNext === pending.cancel)
                  cancelPendingNext = () => {}
                nextInFlight = false
              }
              const losing = losingNext.values().next().value as
                | NextOperation
                | undefined
              if (losing?.preemptedSettled) {
                const terminal = losing.preemptedTerminal
                losingNext.delete(losing)
                if (terminal) return
                continue
              }
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

              for (const output of restoreChunk(next.value)) yield output
            } catch (error) {
              const losing = losingNext.values().next().value as
                | NextOperation
                | undefined
              if (losing?.preemptedSettled) {
                const terminal = losing.preemptedTerminal
                losingNext.delete(losing)
                if (terminal) return
                continue
              }
              throw error
            }
          }
        } catch (error) {
          if (signal?.aborted && !aborted) {
            aborted = true
            closed = true
            settleDelegatedThrows("abort", signal.reason)
            settlePreemptedNext("abort", signal.reason)
            settlePending("abort", signal.reason)
            clear()
            discardQueuedOperations()
            beginReturn(signal.reason)
          }
          failed = true
          failure = error
          clear()
          throw error
        } finally {
          if (!upstreamDone && !upstreamClosed) {
            const cleanup = beginReturn(failure)
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
      const done = (value?: unknown): IteratorResult<StreamChunk> => ({
        done: true,
        value,
      })

      const resolveNext = (
        operation: NextOperation,
        result: IteratorResult<StreamChunk>
      ) => {
        if (operation.pending.settled) return
        operation.pending.settled = true
        pendingNext.delete(operation.pending)
        operation.pending.resolve(result)
      }

      const rejectNext = (operation: NextOperation, error: unknown) => {
        if (operation.pending.settled) return
        operation.pending.settled = true
        pendingNext.delete(operation.pending)
        operation.pending.reject(error)
      }

      const settlePreemptedNext = (
        kind: "return" | "abort" | "throw",
        value?: unknown,
        recoverable = false,
        target?: NextOperation
      ) => {
        const settle = (operation: NextOperation) => {
          if (operation.preemptedSettled) return
          operation.preemptedSettled = true
          operation.preemptedTerminal = kind !== "throw" || !recoverable
          if (kind === "return") resolveNext(operation, done())
          else
            rejectNext(
              operation,
              recoverable ? recoverableTanStackNextError(value) : value
            )
        }
        if (target) {
          preemptedNext.delete(target)
          settle(target)
          return
        }
        for (const operation of preemptedNext) settle(operation)
        preemptedNext.clear()
      }

      const closeAfterError = (error: unknown, skip?: PendingNext) => {
        if (errorCloseStarted) return errorCleanup
        errorCloseStarted = true
        clear()
        discardQueuedOperations()
        closed = true
        const cleanup = beginReturn(error)
        errorCleanup = cleanup
        settlePreemptedNext("throw", error)
        settlePending("throw", error, false, skip)
        settleDelegatedThrows("throw", error, cleanup)
        void cleanup?.catch(() => undefined)
        const closing = generator.return?.(error)
        void Promise.resolve(closing).catch(() => undefined)
        return cleanup
      }

      const closeAfterDone = (value: unknown) => {
        clear()
        discardQueuedOperations()
        upstreamDone = true
        upstreamClosed = true
        closed = true
        settlePreemptedNext("return")
        settleDelegatedThrows("return", value)
        settlePending("return")
        const closing = generator.return?.(value)
        void Promise.resolve(closing).catch(() => undefined)
      }

      const settleConcurrentThrow = (
        operation: ThrowOperation,
        outcome: QueuedOutcome
      ) => {
        activeThrows.delete(operation.gate)
        if (outcome.kind === "error") {
          const cleanup = closeAfterError(outcome.error)
          const reject = () => operation.gate.reject(outcome.error)
          if (cleanup) void cleanup.then(reject, reject).catch(() => undefined)
          else reject()
          return
        }
        settlePreemptedNext(
          "throw",
          operation.error,
          true,
          operation.preemptedNext
        )
        operation.gate.resolve(outcome.result)
        if (outcome.result.done) closeAfterDone(outcome.result.value)
      }

      const deferConcurrentThrow = (
        operation: ThrowOperation,
        error: unknown
      ) => {
        if (!operation.concurrent || queued.length === 0) return false
        const first = arrayShift(queued) as QueuedOutcome
        queueError(error)
        settleConcurrentThrow(operation, first)
        return true
      }

      const completeNext = (
        operation: NextOperation,
        result: IteratorResult<StreamChunk>
      ) => {
        if (result.done) {
          resolveNext(operation, result)
          closeAfterDone(result.value)
        } else resolveNext(operation, result)
      }

      const completeThrow = (
        operation: ThrowOperation,
        result: IteratorResult<StreamChunk>
      ) => {
        if (operation.gate.canceled) return

        // A concurrent throw may finish while an earlier recovery has queued
        // output. The public operation order still owns that output: give the
        // oldest item to this throw and retain this throw's result for the
        // next public operation.
        if (operation.concurrent && queued.length > 0) {
          const first = arrayShift(queued) as QueuedOutcome
          if (result.done) queueResult(result)
          else {
            try {
              const restored = restoreChunk(result.value)
              for (let index = 0; index < restored.length; index += 1)
                queueValue(restored[index] as StreamChunk)
            } catch (restoreError) {
              queueError(restoreError)
            }
          }
          settleConcurrentThrow(operation, first)
          return
        }

        if (result.done) {
          activeThrows.delete(operation.gate)
          closeAfterDone(result.value)
          operation.gate.resolve(result)
          return
        }

        try {
          const restored = restoreChunk(result.value)
          const first = restored[0]
          for (let index = 1; index < restored.length; index += 1)
            queueValue(restored[index] as StreamChunk)
          activeThrows.delete(operation.gate)
          settlePreemptedNext(
            "throw",
            operation.error,
            true,
            operation.preemptedNext
          )
          operation.gate.resolve(
            first
              ? { done: false as const, value: first }
              : { done: false as const, value: result.value }
          )
        } catch (restoreError) {
          closeAfterError(restoreError)
        }
      }

      const failNext = (operation: NextOperation, error: unknown) => {
        if (operation.pending.settled) return
        const cleanup = closeAfterError(error, operation.pending)
        const reject = () => rejectNext(operation, error)
        if (cleanup) void cleanup.then(reject, reject).catch(() => undefined)
        else reject()
      }

      const failThrow = (operation: ThrowOperation, error: unknown) => {
        if (operation.gate.canceled) return
        closeAfterError(error)
      }

      const selectOperation = (): Operation | undefined => {
        const first = operations[0]
        if (!first) return undefined
        if (first.kind === "throw" && queued.length > 0) {
          const nextIndex = operations.findIndex(
            (operation) => operation.kind === "next"
          )
          if (nextIndex < 0) {
            // A throw started while another throw was still active is a
            // concurrent control call. It must not wait for a future `next`
            // merely because the earlier restoration expanded into multiple
            // outputs. Sequential calls retain the normal output backpressure.
            if (first.concurrent) return operations.shift()
            return undefined
          }
          return operations.splice(nextIndex, 1)[0]
        }
        return operations.shift()
      }

      pump = () => {
        if (closed || activeOperation) return
        const operation = selectOperation()
        if (!operation) return
        activeOperation = operation

        if (operation.kind === "next") {
          if (queued.length > 0) {
            const outcome = arrayShift(queued) as QueuedOutcome
            activeOperation = undefined
            if (outcome.kind === "error") failNext(operation, outcome.error)
            else completeNext(operation, outcome.result)
            pump()
            return
          }
          operation.waitingSource = true
          let result: PromiseLike<IteratorResult<StreamChunk>>
          try {
            result = generator.next(operation.value)
          } catch (error) {
            operation.waitingSource = false
            activeOperation = undefined
            failNext(operation, error)
            pump()
            return
          }
          void Promise.resolve(result).then(
            (next) => {
              operation.waitingSource = false
              if (operation.preempted) {
                if (operation.preemptedSettled) {
                  if (!operation.preemptedTerminal && !next.done)
                    queueValue(next.value)
                  return
                }
                if (next.done) closeAfterDone(next.value)
                return
              }
              if (activeOperation === operation) activeOperation = undefined
              completeNext(operation, next)
              pump()
            },
            (error: unknown) => {
              operation.waitingSource = false
              if (operation.preempted) {
                if (operation.preemptedSettled) return
                closeAfterError(error)
                return
              }
              if (activeOperation === operation) activeOperation = undefined
              failNext(operation, error)
              pump()
            }
          )
          return
        }

        let result: PromiseLike<IteratorResult<StreamChunk>>
        try {
          const upstream = iterator
          if (!upstream?.throw) throw operation.error
          result = upstream.throw.call(upstream, operation.error)
        } catch (error) {
          if (activeOperation === operation) activeOperation = undefined
          if (!deferConcurrentThrow(operation, error)) failThrow(operation, error)
          pump()
          return
        }
        void Promise.resolve(result).then(
          (thrown) => {
            if (operation.gate.canceled) return
            if (activeOperation === operation) activeOperation = undefined
            completeThrow(operation, thrown)
            pump()
          },
          (error: unknown) => {
            if (operation.gate.canceled) return
            if (activeOperation === operation) activeOperation = undefined
            if (!deferConcurrentThrow(operation, error))
              failThrow(operation, error)
            pump()
          }
        )
      }

      const wrapped: AsyncIterator<StreamChunk> & AsyncIterable<StreamChunk> = {
        next(value?: unknown) {
          if (closed) {
            if (aborted) return Promise.reject(signal?.reason)
            return Promise.resolve(done())
          }
          let resolve!: (result: IteratorResult<StreamChunk>) => void
          let reject!: (error: unknown) => void
          const pending = {
            settled: false,
            resolve: (result: IteratorResult<StreamChunk>) => resolve(result),
            reject: (error: unknown) => reject(error),
          }
          const operation: NextOperation = {
            kind: "next",
            pending,
            value,
          }
          const result = new Promise<IteratorResult<StreamChunk>>(
            (resolveResult, rejectResult) => {
              resolve = resolveResult
              reject = rejectResult
            }
          )
          pendingNext.add(pending)
          operations.push(operation)
          pump()
          return result
        },
        return(value?: unknown) {
          clear()
          discardQueuedOperations()
          if (closed) return Promise.resolve(done(value))
          closed = true
          const aborting = signal?.aborted && signal.reason === value
          cancelPendingNext()
          if (activeOperation?.kind === "next") {
            activeOperation.preempted = true
            activeOperation = undefined
          }
          settleDelegatedThrows(aborting ? "abort" : "return", value)
          settlePreemptedNext(aborting ? "abort" : "return", value)
          settlePending(aborting ? "abort" : "return", value)
          const cleanup = beginReturn(value)
          const closing = generator.return?.(value)
          void Promise.resolve(closing).catch(() => undefined)
          return cleanup
            ? cleanup.then(() => done(value))
            : Promise.resolve(done(value))
        },
        throw(error?: unknown) {
          if (closed) return Promise.reject(error)
          cancelPendingNext()
          const upstream = iterator
          if (upstream?.throw) {
            let resolveGate!: (result: IteratorResult<StreamChunk>) => void
            let rejectGate!: (error: unknown) => void
            const closeGate = new Promise<IteratorResult<StreamChunk>>(
              (resolve, reject) => {
                resolveGate = resolve
                rejectGate = reject
              }
            )
            const gate: ThrowGate = {
              canceled: false,
              resolve: (result: IteratorResult<StreamChunk>) =>
                resolveGate(result),
              reject: (throwError: unknown) => rejectGate(throwError),
            }
            activeThrows.add(gate)
            let preempted: NextOperation | undefined
            if (
              activeOperation?.kind === "next" &&
              activeOperation.waitingSource &&
              !activeOperation.preempted
            ) {
              preempted = activeOperation
              preempted.preempted = true
              preemptedNext.add(preempted)
              losingNext.add(preempted)
              activeOperation = undefined
            }
            operations.push({
              kind: "throw",
              error,
              preemptedNext: preempted,
              concurrent:
                allowConcurrentThrow ||
                activeOperation?.kind === "throw" ||
                operations.some((operation) => operation.kind === "throw"),
              gate,
            })
            allowConcurrentThrow = false
            pump()
            void closeGate.catch(() => undefined)
            return closeGate
          }

          closed = true
          clear()
          discardQueuedOperations()
          settlePending("throw", error)
          const cleanup = beginReturn(error)
          const throwing = generator.throw?.(error)
          void Promise.resolve(throwing).catch(() => undefined)
          const rejectPrimary = () => Promise.reject(error)
          if (nextInFlight) return rejectPrimary()
          if (cleanup) return cleanup.then(rejectPrimary, rejectPrimary)
          return rejectPrimary()
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
      concurrentThrowHandlers.set(wrapped, () => {
        allowConcurrentThrow = true
      })
      return wrapped
    },
  }
}
