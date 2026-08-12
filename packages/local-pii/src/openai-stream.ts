import { createStreamingRehydrator } from "./rehydrate"
import { cloneOpenAIValue } from "./openai-content"
import type { PiiSession } from "./session"
import type { OpenAIRecord } from "./openai-content"
import type { Mapping } from "./types"

type TextState = ReturnType<typeof createStreamingRehydrator>

interface ToolState {
  rehydrator: TextState
}

function escapedToolMapping(session: PiiSession): Mapping {
  const mapping: Mapping = {}
  for (const [placeholder, value] of Object.entries(session.mapping))
    mapping[placeholder] = JSON.stringify(value).slice(1, -1)
  return mapping
}

const NO_PRIMARY_ERROR = Symbol("no primary error")

function isRecord(value: unknown): value is OpenAIRecord {
  return value !== null && typeof value === "object"
}

function numericIndex(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { aborted?: unknown }).aborted === "boolean"
  )
}

/** Make the abort error only when AbortSignal.reason is unavailable. */
export function openAIAbortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      })
    : signal.reason
}

export function throwIfOpenAIAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw openAIAbortReason(signal)
}

function textStateFor(
  states: Map<number, TextState>,
  session: PiiSession,
  index: number
): TextState {
  let state = states.get(index)
  if (!state) {
    state = createStreamingRehydrator(() => session.mapping)
    states.set(index, state)
  }
  return state
}

function toolStateFor(
  states: Map<string, ToolState>,
  session: PiiSession,
  choiceIndex: number,
  toolIndex: number
): ToolState {
  const key = `${choiceIndex}:${toolIndex}`
  let state = states.get(key)
  if (!state) {
    state = {
      rehydrator: createStreamingRehydrator(() => escapedToolMapping(session)),
    }
    states.set(key, state)
  }
  return state
}

function restoreChoice(
  session: PiiSession,
  textStates: Map<number, TextState>,
  toolStates: Map<string, ToolState>,
  choice: unknown
): unknown {
  if (!isRecord(choice) || !isRecord(choice.delta)) return choice
  const choiceIndex = numericIndex(choice.index, 0)
  const delta = choice.delta
  let changed = false
  const deltaOverrides: OpenAIRecord = {}

  if (typeof delta.content === "string") {
    deltaOverrides.content = textStateFor(
      textStates,
      session,
      choiceIndex
    ).push(delta.content)
    changed = true
  }

  if (Array.isArray(delta.tool_calls)) {
    const toolCallOverrides: Record<string, unknown> = {}
    let toolCallsChanged = false
    for (let index = 0; index < delta.tool_calls.length; index++) {
      const toolCall = delta.tool_calls[index]
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue
      const fn = toolCall.function
      if (typeof fn.arguments !== "string") continue
      const toolIndex = numericIndex(toolCall.index, 0)
      const restoredArguments = toolStateFor(
        toolStates,
        session,
        choiceIndex,
        toolIndex
      ).rehydrator.push(fn.arguments)
      toolCallOverrides[index] = cloneOpenAIValue(toolCall, {
        function: cloneOpenAIValue(fn, { arguments: restoredArguments }),
      })
      toolCallsChanged = true
      changed = true
    }
    if (toolCallsChanged)
      deltaOverrides.tool_calls = cloneOpenAIValue(
        delta.tool_calls,
        toolCallOverrides
      )
  }

  return changed
    ? cloneOpenAIValue(choice, {
        delta: cloneOpenAIValue(delta, deltaOverrides),
      })
    : choice
}

function flushStates(
  session: PiiSession,
  textStates: Map<number, TextState>,
  toolStates: Map<string, ToolState>
): unknown[] {
  const output: unknown[] = []
  for (const [choiceIndex, state] of textStates) {
    const tail = state.flush()
    if (tail) {
      output.push({
        choices: [{ index: choiceIndex, delta: { content: tail } }],
      })
    }
  }
  for (const [key, state] of toolStates) {
    const tail = state.rehydrator.flush()
    if (!tail) continue
    const separator = key.indexOf(":")
    const choiceIndex = Number(key.slice(0, separator))
    const toolIndex = Number(key.slice(separator + 1))
    output.push({
      choices: [
        {
          index: choiceIndex,
          delta: {
            tool_calls: [{ index: toolIndex, function: { arguments: tail } }],
          },
        },
      ],
    })
  }
  textStates.clear()
  toolStates.clear()
  return output
}

/**
 * Restore one OpenAI stream. All buffers live in this one iterator, so
 * concurrent wrapped create calls cannot exchange placeholder state.
 */
export function restoreOpenAIStream(
  session: PiiSession,
  source: AsyncIterable<unknown>,
  signal?: AbortSignal,
  failClosed?: (helper: string) => never
): AsyncIterable<unknown> {
  const sourceController = isRecord(source) ? source.controller : undefined
  const sourceSignal =
    isRecord(sourceController) && isAbortSignal(sourceController.signal)
      ? sourceController.signal
      : undefined
  const checkAborted = (): void => {
    throwIfOpenAIAborted(signal)
    throwIfOpenAIAborted(sourceSignal)
  }
  const helperError =
    failClosed ??
    ((helper: string): never => {
      const error = new Error(
        `OpenAI stream helper ${helper}() cannot be wrapped safely`
      )
      error.name = "PiiOpenAIHelperError"
      throw error
    })
  const iteratorFactory = (): AsyncIterator<unknown> => {
    let upstream: AsyncIterator<unknown> | undefined
    const textStates = new Map<number, TextState>()
    const toolStates = new Map<string, ToolState>()
    let upstreamDone = false
    let returned = false
    let done = false
    let flushQueue: unknown[] = []
    let primaryError: unknown = NO_PRIMARY_ERROR

    const cleanup = async (): Promise<void> => {
      if (upstreamDone || returned || !upstream) return
      returned = true
      await upstream.return?.()
    }

    const fail = async (error: unknown): Promise<never> => {
      primaryError = error
      done = true
      textStates.clear()
      toolStates.clear()
      flushQueue = []
      try {
        await cleanup()
      } catch {
        // A generation/iteration/consumer failure always wins cleanup failure.
      }
      throw error
    }

    const iterator: AsyncIterator<unknown> = {
      async next() {
        if (done) return { done: true, value: undefined }
        if (flushQueue.length > 0) {
          try {
            checkAborted()
            return { done: false, value: flushQueue.shift() }
          } catch (error) {
            return fail(error)
          }
        }
        if (upstreamDone) {
          done = true
          return { done: true, value: undefined }
        }

        try {
          checkAborted()
          if (!upstream) upstream = source[Symbol.asyncIterator]()
          const next = await upstream.next()
          checkAborted()
          if (next.done) {
            upstreamDone = true
            flushQueue = flushStates(session, textStates, toolStates)
            if (flushQueue.length > 0) {
              checkAborted()
              return { done: false, value: flushQueue.shift() }
            }
            done = true
            return { done: true, value: undefined }
          }
          if (!isRecord(next.value) || !Array.isArray(next.value.choices)) {
            return { done: false, value: next.value }
          }
          let choicesChanged = false
          const choiceOverrides: Record<string, unknown> = {}
          next.value.choices.forEach((choice, index) => {
            const restored = restoreChoice(
              session,
              textStates,
              toolStates,
              choice
            )
            choicesChanged ||= restored !== choice
            if (restored !== choice) choiceOverrides[index] = restored
          })
          return {
            done: false,
            value: choicesChanged
              ? cloneOpenAIValue(next.value, {
                  choices: cloneOpenAIValue(
                    next.value.choices,
                    choiceOverrides
                  ),
                })
              : next.value,
          }
        } catch (error) {
          return fail(error)
        }
      },

      async return(value?: unknown) {
        if (done) return { done: true, value }
        done = true
        textStates.clear()
        toolStates.clear()
        flushQueue = []
        try {
          await cleanup()
        } catch (error) {
          if (primaryError === NO_PRIMARY_ERROR) throw error
        }
        return { done: true, value }
      },

      async throw(error?: unknown) {
        if (done) throw error
        done = true
        return fail(error)
      },
    }
    return iterator
  }

  const toReadableStream = (): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder()
    let iterator: AsyncIterator<unknown> | undefined
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          iterator ??= iteratorFactory()
          const next = await iterator.next()
          if (next.done) {
            controller.close()
            return
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`))
        } catch (error) {
          controller.error(error)
        }
      },
      async cancel() {
        await iterator?.return?.()
      },
    })
  }

  return new Proxy(source as object, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return () => iteratorFactory()
      if (property === "tee") {
        return (...args: unknown[]) => {
          const tee = Reflect.get(target, property, target)
          if (typeof tee !== "function")
            throw new TypeError("OpenAI stream does not support tee()")
          const branches = tee.apply(target, args)
          if (!Array.isArray(branches)) return branches
          return branches.map((branch) =>
            restoreOpenAIStream(
              session,
              branch as AsyncIterable<unknown>,
              signal,
              helperError
            )
          )
        }
      }
      if (property === "toReadableStream") return toReadableStream
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      return () => helperError(String(property))
    },
  }) as unknown as AsyncIterable<unknown>
}
