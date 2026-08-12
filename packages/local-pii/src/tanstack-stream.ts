import type { StreamChunk } from "@tanstack/ai/client"
import { createStreamingRehydrator } from "./rehydrate"
import type { PiiSession } from "./session"
import {
  activateNextPhase,
  activateThrowPhase,
  canPreemptWaitingNext,
  cancelThrowPhase,
  clearNextWaitingSource,
  completeThrowPhase,
  detectConcurrentThrow,
  discardQueuedOperations,
  enqueueOperation,
  idleActiveSlot,
  isNextPreempted,
  isNextPreemptedSettled,
  isNextPreemptedUnsettled,
  isNextSettled,
  isThrowCanceled,
  isThrowConcurrent,
  markNextWaitingSource,
  nextActiveSlot,
  preemptNextPhase,
  queuedNextPhase,
  queuedThrowPhase,
  settlePublicNextPhase,
  shiftQueuedOperation,
  takeQueuedByKind,
  tanStackIteratorControl,
  throwActiveSlot,
  trustedArrayPush,
  trustedArrayShift,
  type TanStackActiveSlot,
  type TanStackNextPhase,
  type TanStackThrowPhase,
} from "./tanstack-arbitration"

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
const ignoreTanStackPromiseRejection = () => undefined

function observeTanStackPromise<T>(promise: Promise<T>) {
  void promise.catch(ignoreTanStackPromiseRejection)
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

const RETIRED_TANSTACK_READ = Symbol("retired TanStack stream read")

type TanStackReadOutcome =
  IteratorResult<StreamChunk> | typeof RETIRED_TANSTACK_READ

type TanStackReadSink = {
  settled: boolean
  resolve?: (outcome: TanStackReadOutcome) => void
  reject?: (error: unknown) => void
  cancel?: () => void
}

function resolveTanStackReadSink(
  sink: TanStackReadSink,
  outcome: TanStackReadOutcome
) {
  if (sink.settled) return
  sink.settled = true
  const resolve = sink.resolve
  const cancel = sink.cancel
  sink.resolve = undefined
  sink.reject = undefined
  sink.cancel = undefined
  try {
    cancel?.()
  } catch {
    // A hostile signal method must not strand the public read gate.
  }
  resolve?.(outcome)
}

function rejectTanStackReadSink(sink: TanStackReadSink, error: unknown) {
  if (sink.settled) return
  sink.settled = true
  const reject = sink.reject
  const cancel = sink.cancel
  sink.resolve = undefined
  sink.reject = undefined
  sink.cancel = undefined
  try {
    cancel?.()
  } catch {
    // A hostile signal method must not strand the public read gate.
  }
  reject?.(error)
}

function createTanStackReadHandlers(sink: TanStackReadSink) {
  return {
    resolve: (result: IteratorResult<StreamChunk>) =>
      resolveTanStackReadSink(sink, result),
    reject: (error: unknown) => rejectTanStackReadSink(sink, error),
  }
}

function nextWithAbort(
  iterator: AsyncIterator<StreamChunk>,
  signal: AbortSignal | undefined,
  onAbort: () => void
): {
  promise: Promise<TanStackReadOutcome>
  cancel: () => void
  retire: () => void
} {
  if (signal) signal.throwIfAborted()

  const sink: TanStackReadSink = { settled: false }
  const promise = new Promise<TanStackReadOutcome>((resolve, reject) => {
    sink.resolve = resolve
    sink.reject = reject
  })
  let removeAbortListener = () => {}
  let canceled = false
  const cancel = () => {
    if (canceled) return
    canceled = true
    try {
      removeAbortListener()
    } catch {
      // Listener cleanup is best effort after the bridge has settled.
    }
  }
  sink.cancel = cancel
  if (signal) {
    const handleAbort = () => {
      onAbort()
      rejectTanStackReadSink(sink, signal.reason)
    }
    removeAbortListener = () => signal.removeEventListener("abort", handleAbort)
    signal.addEventListener("abort", handleAbort, { once: true })
  }

  const next = signal
    ? Promise.resolve().then(() => iterator.next())
    : Promise.resolve(iterator.next())
  // These handlers are created in a scope containing only the mutable sink.
  // Once it settles, all bridge callbacks and the stream-owned
  // resolver/rejector are cleared; the source may retain its raw Promise
  // without retaining this privacy session.
  const handlers = createTanStackReadHandlers(sink)
  void next.then(handlers.resolve, handlers.reject)
  return {
    promise,
    cancel,
    retire: () => {
      resolveTanStackReadSink(sink, RETIRED_TANSTACK_READ)
    },
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
      let returnStarted = false
      let aborted = false
      let pendingReturn: Promise<IteratorResult<StreamChunk>> | undefined
      let closed = false
      let nextInFlight = false
      let hasRead = false
      let cancelPendingNext = () => {}
      type PendingNext = {
        resolve: (result: IteratorResult<StreamChunk>) => void
        reject: (error: unknown) => void
      }
      type QueuedOutcome =
        | { kind: "result"; result: IteratorResult<StreamChunk> }
        | { kind: "error"; error: unknown }
      const queued: QueuedOutcome[] = []

      const queueResult = (result: IteratorResult<StreamChunk>) => {
        trustedArrayPush(queued, { kind: "result", result })
      }

      const queueValue = (value: StreamChunk) => {
        queueResult({ done: false, value })
      }

      const queueError = (error: unknown) => {
        trustedArrayPush(queued, { kind: "error", error })
      }

      type ThrowGate = {
        operation: ThrowOperation
        resolve: (result: IteratorResult<StreamChunk>) => void
        reject: (error: unknown) => void
      }
      const activeThrows = new Set<ThrowGate>()
      type NextOperation = {
        kind: "next"
        phase: TanStackNextPhase
        read?: ReadRecord
        pending: PendingNext
        value?: unknown
      }
      const pendingNext = new Set<NextOperation>()
      type ThrowOperation = {
        kind: "throw"
        phase: TanStackThrowPhase
        error: unknown
        preemptedRead?: ReadRecord
        gate: ThrowGate
      }
      type ReadRecord = {
        owner: NextOperation | undefined
        settled: boolean
        retired: boolean
        cancel: () => void
        retire: () => void
      }
      type Operation = NextOperation | ThrowOperation
      const operations: Operation[] = []
      let active: TanStackActiveSlot<NextOperation, ThrowOperation> =
        idleActiveSlot()
      const activeReads = new Set<ReadRecord>()
      const preemptedReads = new Set<ReadRecord>()
      const retireRead = (read: ReadRecord) => {
        if (read.retired) return
        read.retired = true
        activeReads.delete(read)
        preemptedReads.delete(read)
        read.cancel()
        const owner = read.owner
        if (owner) {
          owner.phase = clearNextWaitingSource(owner.phase)
          if (owner.read === read) owner.read = undefined
        }
        read.owner = undefined
        read.retire()
        nextInFlight = activeReads.size > 0
      }
      const retireActiveReads = () => {
        for (const read of activeReads) retireRead(read)
      }
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
          gate.operation.phase = cancelThrowPhase(gate.operation.phase)
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
        const terminal = kind !== "throw" || !recoverable
        for (const operation of pendingNext) {
          if (operation.pending === skip) continue
          if (isNextSettled(operation.phase)) continue
          operation.phase = settlePublicNextPhase(operation.phase, terminal)
          if (kind === "return")
            operation.pending.resolve({ done: true, value: undefined })
          else
            operation.pending.reject(
              recoverable
                ? tanStackIteratorControl.createRecoverableNextError(value)
                : value
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

      const discardQueued = () => {
        discardQueuedOperations(operations)
      }

      const beginReturn = (
        reason?: unknown
      ): Promise<IteratorResult<StreamChunk>> | undefined => {
        if (returnStarted || upstreamDone) return pendingReturn
        returnStarted = true
        let result: PromiseLike<IteratorResult<StreamChunk>> | undefined
        try {
          result = iterator?.return?.(reason)
        } catch (error) {
          result = Promise.reject(error)
        }
        pendingReturn = Promise.resolve(
          result ?? { done: true, value: undefined }
        )
        // Abort deliberately does not await a native iterator's queued
        // return while its current next() is suspended. Keep the eventual
        // cleanup observed so it cannot become an unhandled rejection.
        observeTanStackPromise(pendingReturn)
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

      const done = (value?: unknown): IteratorResult<StreamChunk> => ({
        done: true,
        value,
      })

      const resolveNext = (
        operation: NextOperation,
        result: IteratorResult<StreamChunk>,
        terminal = true
      ) => {
        if (isNextSettled(operation.phase)) return
        operation.phase = settlePublicNextPhase(operation.phase, terminal)
        pendingNext.delete(operation)
        operation.pending.resolve(result)
      }

      const rejectNext = (
        operation: NextOperation,
        error: unknown,
        terminal = true
      ) => {
        if (isNextSettled(operation.phase)) return
        operation.phase = settlePublicNextPhase(operation.phase, terminal)
        pendingNext.delete(operation)
        operation.pending.reject(error)
      }

      const settlePreemptedNext = (
        kind: "return" | "abort" | "throw",
        value?: unknown,
        recoverable = false,
        target?: ReadRecord
      ) => {
        const settle = (read: ReadRecord) => {
          const operation = read.owner
          if (!operation) {
            retireRead(read)
            return
          }
          if (isNextSettled(operation.phase)) return
          preemptedReads.delete(read)
          const terminal = kind !== "throw" || !recoverable
          if (!isNextPreempted(operation.phase)) {
            operation.phase = preemptNextPhase(operation.phase)
          }
          if (kind === "return") resolveNext(operation, done(), terminal)
          else
            rejectNext(
              operation,
              recoverable
                ? tanStackIteratorControl.createRecoverableNextError(value)
                : value,
              terminal
            )
          retireRead(read)
        }
        if (target) {
          settle(target)
          return
        }
        for (const read of preemptedReads) settle(read)
        preemptedReads.clear()
      }

      const closeAfterError = (error: unknown, skip?: PendingNext) => {
        if (errorCloseStarted) return errorCleanup
        errorCloseStarted = true
        clear()
        discardQueued()
        closed = true
        const cleanup = beginReturn(error)
        errorCleanup = cleanup
        settlePreemptedNext("throw", error)
        settlePending("throw", error, false, skip)
        settleDelegatedThrows("throw", error, cleanup)
        retireActiveReads()
        if (cleanup) observeTanStackPromise(cleanup)
        return cleanup
      }

      const closeAfterDone = (value: unknown) => {
        clear()
        discardQueued()
        upstreamDone = true
        closed = true
        settlePreemptedNext("return")
        settleDelegatedThrows("return", value)
        settlePending("return")
        retireActiveReads()
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
          operation.preemptedRead
        )
        operation.gate.resolve(outcome.result)
        if (outcome.result.done) closeAfterDone(outcome.result.value)
      }

      const deferConcurrentThrow = (
        operation: ThrowOperation,
        error: unknown
      ) => {
        if (!isThrowConcurrent(operation.phase) || queued.length === 0)
          return false
        const first = trustedArrayShift(queued) as QueuedOutcome
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
        if (isThrowCanceled(operation.phase)) return

        // A concurrent throw may finish while an earlier recovery has queued
        // output. The public operation order still owns that output: give the
        // oldest item to this throw and retain this throw's result for the
        // next public operation.
        if (isThrowConcurrent(operation.phase) && queued.length > 0) {
          const first = trustedArrayShift(queued) as QueuedOutcome
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
            operation.preemptedRead
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
        if (isNextSettled(operation.phase)) return
        const cleanup = closeAfterError(error, operation.pending)
        const reject = () => rejectNext(operation, error)
        if (cleanup) void cleanup.then(reject, reject).catch(() => undefined)
        else reject()
      }

      const failThrow = (operation: ThrowOperation, error: unknown) => {
        if (isThrowCanceled(operation.phase)) return
        closeAfterError(error)
      }

      const ensureIterator = () => {
        if (!iterator) iterator = source[Symbol.asyncIterator]()
        return iterator
      }

      cancelPendingNext = () => {
        for (const read of activeReads) read.cancel()
      }

      const finishRead = (read: ReadRecord) => {
        if (read.settled) return
        read.settled = true
        const owner = read.owner
        // A preempted read has finished its raw source call, but its public
        // next still belongs to the pending throw/terminal outcome. Retain
        // that ownership record until the outcome definitively settles it.
        if (owner && isNextPreemptedUnsettled(owner.phase)) {
          activeReads.delete(read)
          read.cancel()
          nextInFlight = activeReads.size > 0
          return
        }
        retireRead(read)
      }

      const isActiveNext = (operation: NextOperation) =>
        active.kind === "next" && active.operation === operation

      const isActiveThrow = (operation: ThrowOperation) =>
        active.kind === "throw" && active.operation === operation

      const readOne = (operation: NextOperation) => {
        let pending: ReturnType<typeof nextWithAbort>
        try {
          signal?.throwIfAborted()
          const upstream = ensureIterator()
          hasRead = true
          pending = nextWithAbort(upstream, signal, () => {
            aborted = true
            closed = true
            settleDelegatedThrows("abort", signal?.reason)
            settlePreemptedNext("abort", signal?.reason)
            settlePending("abort", signal?.reason)
            clear()
            discardQueued()
            beginReturn(signal?.reason)
            retireActiveReads()
          })
        } catch (error) {
          operation.phase = clearNextWaitingSource(operation.phase)
          if (isActiveNext(operation)) active = idleActiveSlot()
          failNext(operation, error)
          pump()
          return
        }

        const read: ReadRecord = {
          owner: operation,
          settled: false,
          retired: false,
          cancel: pending.cancel,
          retire: pending.retire,
        }
        operation.read = read
        activeReads.add(read)
        nextInFlight = true
        if (closed) {
          retireRead(read)
          return
        }
        void pending.promise.then(
          (next) => {
            finishRead(read)
            if (next === RETIRED_TANSTACK_READ) return
            operation.phase = clearNextWaitingSource(operation.phase)
            if (isNextPreempted(operation.phase)) {
              if (isNextPreemptedSettled(operation.phase)) return
              if (next.done) closeAfterDone(next.value)
              return
            }
            if (closed) return
            if (next.done) {
              upstreamDone = true
              if (isActiveNext(operation)) active = idleActiveSlot()
              let flushed: StreamChunk[]
              try {
                flushed = flushAll({} as StreamChunk)
              } catch (error) {
                failNext(operation, error)
                pump()
                return
              }
              if (flushed.length === 0) {
                completeNext(operation, done())
              } else {
                resolveNext(operation, {
                  done: false,
                  value: flushed[0] as StreamChunk,
                })
                for (let index = 1; index < flushed.length; index += 1)
                  queueValue(flushed[index] as StreamChunk)
                queueResult(done())
              }
              pump()
              return
            }

            let restored: StreamChunk[]
            try {
              restored = restoreChunk(next.value)
            } catch (error) {
              if (isActiveNext(operation)) active = idleActiveSlot()
              failNext(operation, error)
              pump()
              return
            }
            if (restored.length === 0) {
              readOne(operation)
              return
            }
            if (isActiveNext(operation)) active = idleActiveSlot()
            resolveNext(operation, {
              done: false,
              value: restored[0] as StreamChunk,
            })
            for (let index = 1; index < restored.length; index += 1)
              queueValue(restored[index] as StreamChunk)
            pump()
          },
          (error: unknown) => {
            finishRead(read)
            operation.phase = clearNextWaitingSource(operation.phase)
            if (isNextPreempted(operation.phase)) {
              if (isNextPreemptedSettled(operation.phase)) return
              closeAfterError(error)
              return
            }
            if (isActiveNext(operation)) active = idleActiveSlot()
            failNext(operation, error)
            pump()
          }
        )
      }

      const selectOperation = (): Operation | undefined => {
        const first = operations[0]
        if (!first) return undefined
        if (first.kind === "throw" && queued.length > 0) {
          const nextOp = takeQueuedByKind(operations, "next")
          if (!nextOp) {
            // A throw started while another throw was still active is a
            // concurrent control call. It must not wait for a future `next`
            // merely because the earlier restoration expanded into multiple
            // outputs. Sequential calls retain the normal output backpressure.
            if (isThrowConcurrent(first.phase))
              return shiftQueuedOperation(operations)
            return undefined
          }
          return nextOp
        }
        return shiftQueuedOperation(operations)
      }

      pump = () => {
        if (closed || active.kind !== "idle") return
        const operation = selectOperation()
        if (!operation) return

        if (operation.kind === "next") {
          active = nextActiveSlot(operation)
          operation.phase = activateNextPhase(operation.phase)
          if (queued.length > 0) {
            const outcome = trustedArrayShift(queued) as QueuedOutcome
            active = idleActiveSlot()
            if (outcome.kind === "error") failNext(operation, outcome.error)
            else completeNext(operation, outcome.result)
            pump()
            return
          }
          operation.phase = markNextWaitingSource(operation.phase)
          readOne(operation)
          return
        }

        operation.phase = activateThrowPhase(operation.phase)
        active = throwActiveSlot(operation)
        let result: PromiseLike<IteratorResult<StreamChunk>>
        try {
          const upstream = iterator
          if (!upstream?.throw) throw operation.error
          result = upstream.throw.call(upstream, operation.error)
        } catch (error) {
          if (isActiveThrow(operation)) active = idleActiveSlot()
          if (!deferConcurrentThrow(operation, error))
            failThrow(operation, error)
          pump()
          return
        }
        void Promise.resolve(result).then(
          (thrown) => {
            if (isThrowCanceled(operation.phase)) return
            if (isActiveThrow(operation)) active = idleActiveSlot()
            operation.phase = completeThrowPhase(operation.phase)
            completeThrow(operation, thrown)
            pump()
          },
          (error: unknown) => {
            if (isThrowCanceled(operation.phase)) return
            if (isActiveThrow(operation)) active = idleActiveSlot()
            operation.phase = completeThrowPhase(operation.phase)
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
            resolve: (result: IteratorResult<StreamChunk>) => resolve(result),
            reject: (error: unknown) => reject(error),
          }
          const operation: NextOperation = {
            kind: "next",
            phase: queuedNextPhase(),
            pending,
            value,
          }
          const result = new Promise<IteratorResult<StreamChunk>>(
            (resolveResult, rejectResult) => {
              resolve = resolveResult
              reject = rejectResult
            }
          )
          pendingNext.add(operation)
          enqueueOperation(operations, operation)
          pump()
          return result
        },
        return(value?: unknown) {
          clear()
          discardQueued()
          if (closed) return Promise.resolve(done(value))
          closed = true
          const aborting = signal?.aborted && signal.reason === value
          cancelPendingNext()
          if (active.kind === "next") {
            active.operation.phase = preemptNextPhase(active.operation.phase)
            if (active.operation.read) preemptedReads.add(active.operation.read)
            active = idleActiveSlot()
          }
          settleDelegatedThrows(aborting ? "abort" : "return", value)
          settlePreemptedNext(aborting ? "abort" : "return", value)
          settlePending(aborting ? "abort" : "return", value)
          const cleanup = beginReturn(value)
          retireActiveReads()
          return cleanup
            ? cleanup.then(() => done(value))
            : Promise.resolve(done(value))
        },
        throw(error?: unknown) {
          if (closed) return Promise.reject(error)
          cancelPendingNext()
          let upstream = iterator
          if (!upstream) {
            try {
              upstream = ensureIterator()
            } catch {
              upstream = undefined
            }
          }
          if (upstream?.throw && hasRead) {
            let resolveGate!: (result: IteratorResult<StreamChunk>) => void
            let rejectGate!: (error: unknown) => void
            const closeGate = new Promise<IteratorResult<StreamChunk>>(
              (resolve, reject) => {
                resolveGate = resolve
                rejectGate = reject
              }
            )
            let preemptedRead: ReadRecord | undefined
            if (
              active.kind === "next" &&
              canPreemptWaitingNext(active.operation.phase)
            ) {
              active.operation.phase = preemptNextPhase(active.operation.phase)
              preemptedRead = active.operation.read
              if (preemptedRead) preemptedReads.add(preemptedRead)
              active = idleActiveSlot()
            }
            const concurrent = detectConcurrentThrow(
              operations,
              active.kind === "throw",
              allowConcurrentThrow
            )
            const operation: ThrowOperation = {
              kind: "throw",
              phase: queuedThrowPhase(concurrent),
              error,
              preemptedRead,
              gate: undefined as unknown as ThrowGate,
            }
            const gate: ThrowGate = {
              operation,
              resolve: (result: IteratorResult<StreamChunk>) =>
                resolveGate(result),
              reject: (throwError: unknown) => rejectGate(throwError),
            }
            operation.gate = gate
            activeThrows.add(gate)
            enqueueOperation(operations, operation)
            allowConcurrentThrow = false
            pump()
            void closeGate.catch(() => undefined)
            return closeGate
          }

          closed = true
          clear()
          discardQueued()
          settlePending("throw", error)
          const hadReadInFlight = nextInFlight
          const cleanup = beginReturn(error)
          retireActiveReads()
          const rejectPrimary = () => Promise.reject(error)
          if (hadReadInFlight) return rejectPrimary()
          if (cleanup) return cleanup.then(rejectPrimary, rejectPrimary)
          return rejectPrimary()
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
      tanStackIteratorControl.armConcurrentThrow(wrapped, () => {
        allowConcurrentThrow = true
      })
      return wrapped
    },
  }
}
