import type { PiiSession } from "./session"

/** A structural OpenAI-compatible record. Unknown protocol fields are retained. */
export type OpenAIRecord = Record<string, unknown>

type OpenAIMessageLike = OpenAIRecord & {
  content?: unknown
  tool_calls?: unknown
}

function isRecord(value: unknown): value is OpenAIRecord {
  return value !== null && typeof value === "object"
}

async function protectText(session: PiiSession, value: string): Promise<string> {
  if (value.length === 0) return value
  return (await session.anonymize(value)).redactedText
}

/**
 * Protect a tool-call argument as text. Arguments are deliberately kept as a
 * string on the wire: tool schemas and every non-semantic JSON field must
 * remain byte-for-byte under the provider's control.
 */
export async function protectOpenAIToolArguments(
  session: PiiSession,
  value: string
): Promise<string> {
  return protectText(session, value)
}

async function protectMessage(
  session: PiiSession,
  message: unknown
): Promise<unknown> {
  if (!isRecord(message)) return message

  const source = message as OpenAIMessageLike
  const hasContent = typeof source.content === "string"
  const calls = Array.isArray(source.tool_calls) ? source.tool_calls : null
  const nextCalls: unknown[] | null = calls ? [] : null
  let changed = false
  let callsChanged = false

  let content = source.content
  if (hasContent) {
    content = await protectText(session, source.content as string)
    changed ||= content !== source.content
  }

  if (calls) {
    for (const call of calls) {
      if (!isRecord(call) || !isRecord(call.function)) {
        nextCalls!.push(call)
        continue
      }
      const fn = call.function as OpenAIRecord
      if (typeof fn.arguments !== "string") {
        nextCalls!.push(call)
        continue
      }
      const argumentsValue = await protectOpenAIToolArguments(
        session,
        fn.arguments
      )
      if (argumentsValue !== fn.arguments) {
        callsChanged = true
        nextCalls!.push({
          ...call,
          function: { ...fn, arguments: argumentsValue },
        })
      } else {
        nextCalls!.push(call)
      }
    }
  }

  changed ||= callsChanged

  if (!changed) return message
  const next: OpenAIRecord = { ...source }
  if (hasContent) next.content = content
  if (callsChanged) next.tool_calls = nextCalls
  return next
}

/** Protect only message content and tool-call function arguments. */
export async function protectOpenAIMessages<T extends readonly unknown[]>(
  session: PiiSession,
  messages: T
): Promise<T> {
  const output: unknown[] = []
  for (const message of messages)
    output.push(await protectMessage(session, message))
  return output as unknown as T
}

export function restoreOpenAIToolArguments(
  session: PiiSession,
  value: string
): string {
  try {
    return JSON.stringify(
      session.rehydrateJson(JSON.parse(value), { lenient: true })
    )
  } catch {
    return session.rehydrate(value, { lenient: true })
  }
}

/** Restore one complete assistant message without mutating the provider object. */
export function restoreOpenAIMessage<T>(
  session: PiiSession,
  message: T
): T {
  if (!isRecord(message)) return message
  const source = message as OpenAIMessageLike
  let changed = false
  let content = source.content

  if (typeof source.content === "string") {
    content = session.rehydrate(source.content, { lenient: true })
    changed ||= content !== source.content
  }

  let toolCalls: unknown[] | null = null
  let callsChanged = false
  if (Array.isArray(source.tool_calls)) {
    toolCalls = []
    for (const call of source.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function)) {
        toolCalls.push(call)
        continue
      }
      const fn = call.function as OpenAIRecord
      if (typeof fn.arguments !== "string") {
        toolCalls.push(call)
        continue
      }
      const argumentsValue = restoreOpenAIToolArguments(session, fn.arguments)
      if (argumentsValue !== fn.arguments) {
        callsChanged = true
        toolCalls.push({
          ...call,
          function: { ...fn, arguments: argumentsValue },
        })
      } else {
        toolCalls.push(call)
      }
    }
  }

  changed ||= callsChanged

  if (!changed) return message
  const next: OpenAIRecord = { ...source }
  if (typeof source.content === "string") next.content = content
  if (callsChanged) next.tool_calls = toolCalls
  return next as T
}

/** Restore a completion's changed message paths while preserving its envelope. */
export function restoreOpenAICompletion<T>(
  session: PiiSession,
  result: T
): T {
  if (!isRecord(result) || !Array.isArray(result.choices)) return result
  let changed = false
  const choices = result.choices.map((choice) => {
    if (!isRecord(choice) || !isRecord(choice.message)) return choice
    const message = restoreOpenAIMessage(session, choice.message)
    if (message === choice.message) return choice
    changed = true
    return { ...choice, message }
  })
  if (!changed) return result
  return { ...result, choices } as T
}
