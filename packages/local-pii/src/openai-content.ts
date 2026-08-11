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

/** Clone one changed path without dropping SDK metadata or descriptors. */
export function cloneOpenAIValue<T extends object>(
  source: T,
  overrides: Record<string, unknown>
): T {
  const clone = Array.isArray(source)
    ? []
    : Object.create(Object.getPrototypeOf(source))
  const descriptors = Object.getOwnPropertyDescriptors(source) as Record<
    string,
    PropertyDescriptor
  >
  for (const [key, value] of Object.entries(overrides)) {
    const descriptor = descriptors[key]
    if (descriptor && "value" in descriptor) {
      descriptors[key] = { ...descriptor, value }
    } else {
      descriptors[key] = {
        configurable: descriptor?.configurable ?? true,
        enumerable: descriptor?.enumerable ?? true,
        value,
        writable: true,
      }
    }
  }
  Object.defineProperties(clone, descriptors)
  return clone as T
}

async function protectText(
  session: PiiSession,
  value: string
): Promise<string> {
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
        nextCalls!.push(
          cloneOpenAIValue(call, {
            function: cloneOpenAIValue(fn, { arguments: argumentsValue }),
          })
        )
      } else {
        nextCalls!.push(call)
      }
    }
  }

  changed ||= callsChanged

  if (!changed) return message
  const overrides: OpenAIRecord = {}
  if (hasContent) overrides.content = content
  if (callsChanged) overrides.tool_calls = nextCalls
  return cloneOpenAIValue(source, overrides)
}

/** Protect only message content and tool-call function arguments. */
export async function protectOpenAIMessages<T extends readonly unknown[]>(
  session: PiiSession,
  messages: T
): Promise<T> {
  const output: unknown[] = []
  let changed = false
  for (const message of messages)
    output.push(await protectMessage(session, message))
  for (let index = 0; index < output.length; index++)
    changed ||= output[index] !== messages[index]
  return (changed ? output : messages) as unknown as T
}

interface JsonStringToken {
  end: number
  value: string
}

function skipJsonWhitespace(source: string, index: number): number {
  while (index < source.length && /[\t\n\r ]/.test(source[index]!)) index++
  return index
}

function parseJsonString(
  source: string,
  start: number
): JsonStringToken | undefined {
  if (source[start] !== '"') return undefined
  let index = start + 1
  while (index < source.length) {
    const character = source[index]!
    if (character === '"') {
      try {
        return {
          end: index + 1,
          value: JSON.parse(source.slice(start, index + 1)) as string,
        }
      } catch {
        return undefined
      }
    }
    if (character === "\\") {
      const escape = source[index + 1]
      if (escape === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6)))
          return undefined
        index += 6
      } else if (escape && '"\\/bfnrt'.includes(escape)) {
        index += 2
      } else {
        return undefined
      }
      continue
    }
    if (character.charCodeAt(0) < 0x20) return undefined
    index++
  }
  return undefined
}

function restoreJsonValueLexemes(
  session: PiiSession,
  source: string
): string | undefined {
  const replacements: Array<{ end: number; start: number; value: string }> = []

  const parseValue = (start: number): number | undefined => {
    let index = skipJsonWhitespace(source, start)
    const character = source[index]
    if (character === '"') {
      const token = parseJsonString(source, index)
      if (!token) return undefined
      const restored = session.rehydrate(token.value, { lenient: true })
      if (restored !== token.value) {
        replacements.push({
          start: index,
          end: token.end,
          value: JSON.stringify(restored),
        })
      }
      return token.end
    }
    if (character === "[") {
      index = skipJsonWhitespace(source, index + 1)
      if (source[index] === "]") return index + 1
      while (true) {
        const end = parseValue(index)
        if (end === undefined) return undefined
        index = skipJsonWhitespace(source, end)
        if (source[index] === "]") return index + 1
        if (source[index] !== ",") return undefined
        index = skipJsonWhitespace(source, index + 1)
      }
    }
    if (character === "{") {
      index = skipJsonWhitespace(source, index + 1)
      if (source[index] === "}") return index + 1
      while (true) {
        const key = parseJsonString(source, index)
        if (!key) return undefined
        index = skipJsonWhitespace(source, key.end)
        if (source[index] !== ":") return undefined
        const end = parseValue(index + 1)
        if (end === undefined) return undefined
        index = skipJsonWhitespace(source, end)
        if (source[index] === "}") return index + 1
        if (source[index] !== ",") return undefined
        index = skipJsonWhitespace(source, index + 1)
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, index)) {
        const end = index + literal.length
        if (end === source.length || /[\t\n\r ,\]}]/.test(source[end]!))
          return end
      }
    }
    const number = source
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (!number) return undefined
    const end = index + number[0].length
    return end === source.length || /[\t\n\r ,\]}]/.test(source[end]!)
      ? end
      : undefined
  }

  const end = parseValue(0)
  if (end === undefined || skipJsonWhitespace(source, end) !== source.length)
    return undefined
  if (replacements.length === 0) return source
  let restored = ""
  let cursor = 0
  for (const replacement of replacements) {
    restored += source.slice(cursor, replacement.start)
    restored += replacement.value
    cursor = replacement.end
  }
  return restored + source.slice(cursor)
}

export function restoreOpenAIToolArguments(
  session: PiiSession,
  value: string
): string {
  return (
    restoreJsonValueLexemes(session, value) ??
    session.rehydrate(value, { lenient: true })
  )
}

/** Restore one complete assistant message without mutating the provider object. */
export function restoreOpenAIMessage<T>(session: PiiSession, message: T): T {
  if (!isRecord(message)) return message
  const source = message as OpenAIMessageLike
  let changed = false
  let content = source.content

  if (typeof source.content === "string") {
    content = session.rehydrate(source.content, { lenient: true })
    changed ||= content !== source.content
  }

  let toolCalls: unknown[] | null = null
  const callOverrides: Record<string, unknown> = {}
  let callsChanged = false
  if (Array.isArray(source.tool_calls)) {
    toolCalls = []
    for (let index = 0; index < source.tool_calls.length; index++) {
      const call = source.tool_calls[index]
      if (!isRecord(call) || !isRecord(call.function)) {
        continue
      }
      const fn = call.function as OpenAIRecord
      if (typeof fn.arguments !== "string") continue
      const argumentsValue = restoreOpenAIToolArguments(session, fn.arguments)
      if (argumentsValue !== fn.arguments) {
        callsChanged = true
        callOverrides[index] = cloneOpenAIValue(call, {
          function: cloneOpenAIValue(fn, { arguments: argumentsValue }),
        })
      }
    }
    if (callsChanged)
      toolCalls = cloneOpenAIValue(source.tool_calls, callOverrides)
  }

  changed ||= callsChanged

  if (!changed) return message
  const overrides: OpenAIRecord = {}
  if (typeof source.content === "string") overrides.content = content
  if (callsChanged) overrides.tool_calls = toolCalls
  return cloneOpenAIValue(source, overrides) as T
}

interface RestoredSemanticValue {
  changed: boolean
  value: unknown
}

function restoreSemanticValue(
  session: PiiSession,
  value: unknown
): RestoredSemanticValue {
  if (typeof value === "string") {
    const restored = session.rehydrate(value, { lenient: true })
    return { changed: restored !== value, value: restored }
  }
  if (Array.isArray(value)) {
    const restored = value.map((item) => restoreSemanticValue(session, item))
    if (!restored.some((item) => item.changed)) return { changed: false, value }
    const overrides: Record<string, unknown> = {}
    for (let index = 0; index < restored.length; index++)
      overrides[index] = restored[index]!.value
    return {
      changed: true,
      value: cloneOpenAIValue(value, overrides),
    }
  }
  if (!isRecord(value)) return { changed: false, value }
  const overrides: Record<string, unknown> = {}
  let changed = false
  for (const [key, item] of Object.entries(value)) {
    const restored = restoreSemanticValue(session, item)
    if (restored.changed) {
      changed = true
      overrides[key] = restored.value
    }
  }
  return {
    changed,
    value: changed ? cloneOpenAIValue(value, overrides) : value,
  }
}

/** Restore parse-only structured fields in addition to ordinary messages. */
export function restoreOpenAIParseCompletion<T>(
  session: PiiSession,
  result: T
): T {
  if (!isRecord(result) || !Array.isArray(result.choices)) return result
  let changed = false
  const choiceOverrides: Record<string, unknown> = {}
  for (let index = 0; index < result.choices.length; index++) {
    const choice = result.choices[index]
    if (!isRecord(choice) || !isRecord(choice.message)) continue
    let message = restoreOpenAIMessage(session, choice.message)
    const sourceMessage = message as OpenAIMessageLike
    const messageOverrides: Record<string, unknown> = {}
    const parsed = restoreSemanticValue(session, sourceMessage.parsed)
    if (parsed.changed) messageOverrides.parsed = parsed.value

    const calls = Array.isArray(sourceMessage.tool_calls)
      ? sourceMessage.tool_calls
      : undefined
    if (calls) {
      const callOverrides: Record<string, unknown> = {}
      let callsChanged = false
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]
        if (!isRecord(call) || !isRecord(call.function)) continue
        const fn = call.function
        if (!("parsed_arguments" in fn)) continue
        const parsedArguments = restoreSemanticValue(
          session,
          fn.parsed_arguments
        )
        if (!parsedArguments.changed) continue
        callsChanged = true
        callOverrides[index] = cloneOpenAIValue(call, {
          function: cloneOpenAIValue(fn, {
            parsed_arguments: parsedArguments.value,
          }),
        })
      }
      if (callsChanged) {
        const restoredCalls = cloneOpenAIValue(calls, callOverrides)
        messageOverrides.tool_calls = restoredCalls
      }
    }
    if (Object.keys(messageOverrides).length > 0) {
      changed = true
      message = cloneOpenAIValue(message, messageOverrides)
      choiceOverrides[index] = cloneOpenAIValue(choice, { message })
      continue
    }
    if (message !== choice.message) {
      changed = true
      choiceOverrides[index] = cloneOpenAIValue(choice, { message })
      continue
    }
  }
  return changed
    ? cloneOpenAIValue(result, {
        choices: cloneOpenAIValue(result.choices, choiceOverrides),
      })
    : result
}

/** Restore a completion's changed message paths while preserving its envelope. */
export function restoreOpenAICompletion<T>(session: PiiSession, result: T): T {
  if (!isRecord(result) || !Array.isArray(result.choices)) return result
  let changed = false
  const choiceOverrides: Record<string, unknown> = {}
  for (let index = 0; index < result.choices.length; index++) {
    const choice = result.choices[index]
    if (!isRecord(choice) || !isRecord(choice.message)) continue
    const message = restoreOpenAIMessage(session, choice.message)
    if (message === choice.message) continue
    changed = true
    choiceOverrides[index] = cloneOpenAIValue(choice, { message })
  }
  if (!changed) return result
  return cloneOpenAIValue(result, {
    choices: cloneOpenAIValue(result.choices, choiceOverrides),
  })
}
