import {
  cloneAiSdkValue,
  restoreAiSdkJsonString,
  restoreAiSdkStreamPart,
} from "./ai-sdk-content"
import { createStreamingRehydrator } from "./rehydrate"
import type { PiiSession } from "./session"

type UnknownRecord = Record<string, unknown>
type TextState = ReturnType<typeof createStreamingRehydrator>

interface TextChannel {
  last?: UnknownRecord
  rehydrator: TextState
}

interface ToolChannel {
  chunks: string
  lastDelta?: UnknownRecord
}

const NO_PRIMARY_ERROR = Symbol("no primary error")

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object"
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

function textChannelFor(
  channels: Map<string, TextChannel>,
  session: PiiSession,
  id: string
): TextChannel {
  let channel = channels.get(id)
  if (!channel) {
    channel = {
      rehydrator: createStreamingRehydrator(() => session.mapping),
    }
    channels.set(id, channel)
  }
  return channel
}

function toolChannelFor(
  channels: Map<string, ToolChannel>,
  id: string
): ToolChannel {
  let channel = channels.get(id)
  if (!channel) {
    channel = { chunks: "" }
    channels.set(id, channel)
  }
  return channel
}

function restoreTextDelta(
  session: PiiSession,
  channels: Map<string, TextChannel>,
  part: UnknownRecord
): UnknownRecord {
  const id = String(part.id)
  const channel = textChannelFor(channels, session, id)
  channel.last = part
  const delta = typeof part.delta === "string" ? part.delta : ""
  return cloneAiSdkValue(part, {
    delta: channel.rehydrator.push(delta),
  }) as UnknownRecord
}

function restoreTextEnd(
  session: PiiSession,
  channels: Map<string, TextChannel>,
  part: UnknownRecord
): UnknownRecord[] {
  const id = String(part.id)
  const channel = channels.get(id)
  if (!channel) return [part]
  channels.delete(id)
  const tail = channel.rehydrator.flush()
  if (!tail) return [part]
  return [
    cloneAiSdkValue(part, { type: "text-delta", delta: tail }) as UnknownRecord,
    part,
  ]
}

function restoreToolInputDelta(
  channels: Map<string, ToolChannel>,
  part: UnknownRecord
): UnknownRecord {
  const id = String(part.id)
  const channel = toolChannelFor(channels, id)
  channel.lastDelta = part
  if (typeof part.delta === "string") channel.chunks += part.delta
  // Tool JSON is held until its protocol end marker. Empty deltas retain the
  // event/channel cadence without exposing a partially restored JSON string.
  return cloneAiSdkValue(part, { delta: "" }) as UnknownRecord
}

function completeToolInputDelta(
  session: PiiSession,
  channels: Map<string, ToolChannel>,
  part: UnknownRecord
): UnknownRecord[] {
  const id = String(part.id)
  const channel = channels.get(id)
  if (!channel) return [part]
  channels.delete(id)
  const restored = restoreAiSdkJsonString(session, channel.chunks)
  if (restored === undefined) return [part]
  const base = channel.lastDelta ?? part
  return [
    cloneAiSdkValue(base, {
      type: "tool-input-delta",
      id,
      delta: restored,
    }) as UnknownRecord,
    part,
  ]
}

function flushTextChannels(
  channels: Map<string, TextChannel>
): UnknownRecord[] {
  const output: UnknownRecord[] = []
  for (const [id, channel] of channels) {
    const tail = channel.rehydrator.flush()
    if (!tail) continue
    const base = channel.last ?? { type: "text-delta", id, delta: "" }
    output.push(
      cloneAiSdkValue(base, {
        type: "text-delta",
        id,
        delta: tail,
      }) as UnknownRecord
    )
  }
  channels.clear()
  return output
}

function flushToolChannels(
  session: PiiSession,
  channels: Map<string, ToolChannel>
): UnknownRecord[] {
  const output: UnknownRecord[] = []
  for (const [id, channel] of channels) {
    const restored = restoreAiSdkJsonString(session, channel.chunks)
    if (restored === undefined) continue
    const base = channel.lastDelta ?? {
      type: "tool-input-delta",
      id,
      delta: "",
    }
    output.push(
      cloneAiSdkValue(base, {
        type: "tool-input-delta",
        id,
        delta: restored,
      }) as UnknownRecord
    )
  }
  channels.clear()
  return output
}

function clearChannels(
  textChannels: Map<string, TextChannel>,
  toolChannels: Map<string, ToolChannel>
): void {
  textChannels.clear()
  toolChannels.clear()
}

/**
 * Transform one LanguageModelV4 stream. All channels and terminal state are
 * created per invocation, so concurrent calls cannot exchange Private mapping
 * state.
 */
export function restoreAiSdkStream<T extends ReadableStream<unknown>>(
  session: PiiSession,
  source: T,
  signal?: AbortSignal
): T {
  let pullFn: () => Promise<void> = async () => undefined
  let cancelFn: (reason: unknown) => Promise<void> = async () => undefined
  const transformed = new ReadableStream<unknown>({
    start(controller) {
      let reader: ReadableStreamDefaultReader<unknown> | undefined
      let sourceDone = false
      let sourceCancelled = false
      let terminal = false
      let primaryError: unknown = NO_PRIMARY_ERROR
      let abortListener: (() => void) | undefined
      const textChannels = new Map<string, TextChannel>()
      const toolChannels = new Map<string, ToolChannel>()
      const pending: UnknownRecord[] = []

      const removeAbortListener = () => {
        if (abortListener && signal)
          signal.removeEventListener("abort", abortListener)
        abortListener = undefined
      }

      const cancelSource = async (reason: unknown): Promise<void> => {
        if (sourceDone || sourceCancelled) return
        sourceCancelled = true
        reader ??= source.getReader()
        await reader.cancel(reason)
      }

      const cleanup = async (
        reason?: unknown,
        cancel = false
      ): Promise<void> => {
        removeAbortListener()
        try {
          if (cancel) await cancelSource(reason)
        } finally {
          reader?.releaseLock()
          reader = undefined
        }
      }

      const fail = async (error: unknown): Promise<never> => {
        primaryError = error
        terminal = true
        clearChannels(textChannels, toolChannels)
        pending.length = 0
        try {
          await cleanup(error, true)
        } catch {
          // The source failure is the primary stream error.
        }
        throw error
      }

      const finishNormally = async (): Promise<void> => {
        sourceDone = true
        for (const chunk of flushTextChannels(textChannels)) pending.push(chunk)
        for (const chunk of flushToolChannels(session, toolChannels))
          pending.push(chunk)
        if (pending.length > 0) return
        terminal = true
        await cleanup()
        controller.close()
      }

      const read = async (): Promise<void> => {
        if (terminal) return
        throwIfAborted(signal)
        reader ??= source.getReader()
        const next = await reader.read()
        throwIfAborted(signal)
        if (next.done) {
          await finishNormally()
          return
        }

        const part = next.value
        if (!isRecord(part)) {
          controller.enqueue(part)
          return
        }
        if (part.type === "error") {
          clearChannels(textChannels, toolChannels)
          controller.enqueue(part)
          return
        }
        if (part.type === "text-delta" && typeof part.id === "string") {
          controller.enqueue(restoreTextDelta(session, textChannels, part))
          return
        }
        if (part.type === "text-end" && typeof part.id === "string") {
          for (const output of restoreTextEnd(session, textChannels, part))
            controller.enqueue(output)
          return
        }
        if (part.type === "tool-input-delta" && typeof part.id === "string") {
          controller.enqueue(restoreToolInputDelta(toolChannels, part))
          return
        }
        if (part.type === "tool-input-end" && typeof part.id === "string") {
          for (const output of completeToolInputDelta(
            session,
            toolChannels,
            part
          ))
            controller.enqueue(output)
          return
        }
        if (part.type === "tool-call" || part.type === "tool-result") {
          const restored = restoreAiSdkStreamPart(session, part)
          if (part.type === "tool-call" && typeof part.toolCallId === "string")
            toolChannels.delete(part.toolCallId)
          controller.enqueue(restored)
          return
        }
        controller.enqueue(part)
      }

      if (signal) {
        abortListener = () => {
          void (async () => {
            terminal = true
            clearChannels(textChannels, toolChannels)
            const reason = abortReason(signal)
            try {
              await cleanup(reason, true)
            } catch {
              // The abort reason remains primary.
            }
            try {
              controller.error(reason)
            } catch {
              // The consumer may have cancelled/closed the transformed stream.
            }
          })()
        }
        signal.addEventListener("abort", abortListener, { once: true })
        if (signal.aborted) abortListener()
      }

      pullFn = async () => {
        try {
          if (pending.length > 0) {
            controller.enqueue(pending.shift())
            return
          }
          await read()
          if (pending.length > 0) controller.enqueue(pending.shift())
        } catch (error) {
          await fail(error)
        }
      }
      cancelFn = async (reason: unknown) => {
        if (terminal) {
          if (primaryError !== NO_PRIMARY_ERROR) return
          return
        }
        terminal = true
        clearChannels(textChannels, toolChannels)
        await cleanup(reason, true)
      }
    },
    async pull() {
      await pullFn()
    },
    async cancel(reason) {
      await cancelFn(reason)
    },
  })

  return transformed as T
}
