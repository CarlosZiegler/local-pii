import type { PiiSession } from "./session"

/** Structural records keep provider-specific extension fields intact. */
export type AiSdkRecord = Record<string, unknown>

function isRecord(value: unknown): value is AiSdkRecord {
  return value !== null && typeof value === "object"
}

/**
 * Clone only a changed object path.  Own descriptors, prototypes, symbols,
 * and non-enumerable provider fields survive the adapter unchanged.
 */
export function cloneAiSdkValue<T>(
  source: T,
  overrides: Record<PropertyKey, unknown>
): T {
  if (source === null || typeof source !== "object") return source
  const original = source as object
  const clone = Array.isArray(original)
    ? []
    : Object.create(Object.getPrototypeOf(original))
  if (Array.isArray(original))
    Object.setPrototypeOf(clone, Object.getPrototypeOf(original))

  const descriptors = Object.getOwnPropertyDescriptors(original)
  for (const key of Reflect.ownKeys(overrides)) {
    const descriptor = descriptors[key as string]
    const value = overrides[key]
    if (descriptor && "value" in descriptor) {
      descriptors[key as string] = { ...descriptor, value }
    } else {
      descriptors[key as string] = {
        configurable: descriptor?.configurable ?? true,
        enumerable: descriptor?.enumerable ?? true,
        writable: true,
        value,
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

function restoreText(session: PiiSession, value: string): string {
  return session.rehydrate(value, { lenient: true })
}

/** Deeply protect JSON values without cloning unchanged branches. */
export async function protectAiSdkJson(
  session: PiiSession,
  value: unknown
): Promise<{ changed: boolean; value: unknown }> {
  if (typeof value === "string") {
    const protectedValue = await protectText(session, value)
    return { changed: protectedValue !== value, value: protectedValue }
  }
  if (Array.isArray(value)) {
    const overrides: Record<PropertyKey, unknown> = {}
    let changed = false
    for (let index = 0; index < value.length; index++) {
      const child = await protectAiSdkJson(session, value[index])
      if (child.changed) {
        changed = true
        overrides[index] = child.value
      }
    }
    return {
      changed,
      value: changed ? cloneAiSdkValue(value, overrides) : value,
    }
  }
  if (!isRecord(value)) return { changed: false, value }

  const overrides: Record<PropertyKey, unknown> = {}
  let changed = false
  for (const key of Object.keys(value)) {
    const child = await protectAiSdkJson(session, value[key])
    if (child.changed) {
      changed = true
      overrides[key] = child.value
    }
  }
  return {
    changed,
    value: changed ? cloneAiSdkValue(value, overrides) : value,
  }
}

/** Deeply restore JSON values without rewriting numbers or unchanged fields. */
export function restoreAiSdkJson(
  session: PiiSession,
  value: unknown
): { changed: boolean; value: unknown } {
  if (typeof value === "string") {
    const restored = restoreText(session, value)
    return { changed: restored !== value, value: restored }
  }
  if (Array.isArray(value)) {
    const overrides: Record<PropertyKey, unknown> = {}
    let changed = false
    for (let index = 0; index < value.length; index++) {
      const child = restoreAiSdkJson(session, value[index])
      if (child.changed) {
        changed = true
        overrides[index] = child.value
      }
    }
    return {
      changed,
      value: changed ? cloneAiSdkValue(value, overrides) : value,
    }
  }
  if (!isRecord(value)) return { changed: false, value }

  const overrides: Record<PropertyKey, unknown> = {}
  let changed = false
  for (const key of Object.keys(value)) {
    const child = restoreAiSdkJson(session, value[key])
    if (child.changed) {
      changed = true
      overrides[key] = child.value
    }
  }
  return {
    changed,
    value: changed ? cloneAiSdkValue(value, overrides) : value,
  }
}

interface JsonStringToken {
  end: number
  value: string
}

function skipWhitespace(source: string, index: number): number {
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

/**
 * Restore JSON string leaves while retaining every unrelated lexeme.  This is
 * important for provider tool calls: parse/stringify would round large
 * numbers, whitespace, and escaping that the provider may depend on.
 */
export function restoreAiSdkJsonString(
  session: PiiSession,
  source: string
): string | undefined {
  const replacements: Array<{ end: number; start: number; value: string }> = []

  const parseValue = (start: number): number | undefined => {
    let index = skipWhitespace(source, start)
    const character = source[index]
    if (character === '"') {
      const token = parseJsonString(source, index)
      if (!token) return undefined
      const restored = restoreText(session, token.value)
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
      index = skipWhitespace(source, index + 1)
      if (source[index] === "]") return index + 1
      while (true) {
        const end = parseValue(index)
        if (end === undefined) return undefined
        index = skipWhitespace(source, end)
        if (source[index] === "]") return index + 1
        if (source[index] !== ",") return undefined
        index = skipWhitespace(source, index + 1)
      }
    }
    if (character === "{") {
      index = skipWhitespace(source, index + 1)
      if (source[index] === "}") return index + 1
      while (true) {
        const key = parseJsonString(source, index)
        if (!key) return undefined
        index = skipWhitespace(source, key.end)
        if (source[index] !== ":") return undefined
        const end = parseValue(index + 1)
        if (end === undefined) return undefined
        index = skipWhitespace(source, end)
        if (source[index] === "}") return index + 1
        if (source[index] !== ",") return undefined
        index = skipWhitespace(source, index + 1)
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
  if (end === undefined || skipWhitespace(source, end) !== source.length)
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

export function restoreAiSdkToolJson(
  session: PiiSession,
  source: string
): string {
  return restoreAiSdkJsonString(session, source) ?? restoreText(session, source)
}

async function protectToolResultOutput(
  session: PiiSession,
  output: unknown
): Promise<{ changed: boolean; value: unknown }> {
  if (!isRecord(output)) return { changed: false, value: output }
  // These are the semantic text/JSON output variants in the pinned v4 union.
  if (
    (output.type === "text" || output.type === "error-text") &&
    typeof output.value === "string"
  ) {
    const value = await protectText(session, output.value)
    return value === output.value
      ? { changed: false, value: output }
      : { changed: true, value: cloneAiSdkValue(output, { value }) }
  }
  if (
    (output.type === "json" || output.type === "error-json") &&
    "value" in output
  ) {
    const restored = await protectAiSdkJson(session, output.value)
    return restored.changed
      ? {
          changed: true,
          value: cloneAiSdkValue(output, { value: restored.value }),
        }
      : { changed: false, value: output }
  }
  return { changed: false, value: output }
}

async function protectPart(
  session: PiiSession,
  part: unknown
): Promise<{ changed: boolean; value: unknown }> {
  if (!isRecord(part)) return { changed: false, value: part }
  if (part.type === "text" && typeof part.text === "string") {
    const text = await protectText(session, part.text)
    return text === part.text
      ? { changed: false, value: part }
      : { changed: true, value: cloneAiSdkValue(part, { text }) }
  }
  if (part.type === "tool-call") {
    const input = await protectAiSdkJson(session, part.input)
    return input.changed
      ? { changed: true, value: cloneAiSdkValue(part, { input: input.value }) }
      : { changed: false, value: part }
  }
  if (part.type === "tool-result" && part.output !== undefined) {
    const output = await protectToolResultOutput(session, part.output)
    return output.changed
      ? {
          changed: true,
          value: cloneAiSdkValue(part, { output: output.value }),
        }
      : { changed: false, value: part }
  }
  return { changed: false, value: part }
}

async function protectMessage(
  session: PiiSession,
  message: unknown
): Promise<{ changed: boolean; value: unknown }> {
  if (!isRecord(message)) return { changed: false, value: message }
  const overrides: Record<PropertyKey, unknown> = {}
  let changed = false

  if (message.role === "system" && typeof message.content === "string") {
    const content = await protectText(session, message.content)
    if (content !== message.content) {
      changed = true
      overrides.content = content
    }
  } else if (Array.isArray(message.content)) {
    const parts: unknown[] = []
    let partsChanged = false
    for (const part of message.content) {
      const protectedPart = await protectPart(session, part)
      parts.push(protectedPart.value)
      partsChanged ||= protectedPart.changed
    }
    if (partsChanged) {
      changed = true
      overrides.content = cloneAiSdkValue(message.content, {
        ...Object.fromEntries(parts.map((part, index) => [index, part])),
      })
    }
  }
  return {
    changed,
    value: changed ? cloneAiSdkValue(message, overrides) : message,
  }
}

/** Protect only semantic LanguageModelV4 prompt locations. */
export async function protectAiSdkPrompt<T>(
  session: PiiSession,
  prompt: T
): Promise<T> {
  if (!Array.isArray(prompt)) return prompt
  const messages: unknown[] = []
  let changed = false
  for (const message of prompt) {
    const protectedMessage = await protectMessage(session, message)
    messages.push(protectedMessage.value)
    changed ||= protectedMessage.changed
  }
  if (!changed) return prompt
  const overrides: Record<PropertyKey, unknown> = {}
  for (let index = 0; index < messages.length; index++) {
    if (messages[index] !== prompt[index]) overrides[index] = messages[index]
  }
  return cloneAiSdkValue(prompt, overrides)
}

function restoreToolResultOutput(
  session: PiiSession,
  output: unknown
): { changed: boolean; value: unknown } {
  if (!isRecord(output)) return { changed: false, value: output }
  if (
    (output.type === "text" || output.type === "error-text") &&
    typeof output.value === "string"
  ) {
    const value = restoreText(session, output.value)
    return value === output.value
      ? { changed: false, value: output }
      : { changed: true, value: cloneAiSdkValue(output, { value }) }
  }
  if (
    (output.type === "json" || output.type === "error-json") &&
    "value" in output
  ) {
    const value = restoreAiSdkJson(session, output.value)
    return value.changed
      ? {
          changed: true,
          value: cloneAiSdkValue(output, { value: value.value }),
        }
      : { changed: false, value: output }
  }
  return { changed: false, value: output }
}

function restorePart(
  session: PiiSession,
  part: unknown
): { changed: boolean; value: unknown } {
  if (!isRecord(part)) return { changed: false, value: part }
  if (part.type === "text" && typeof part.text === "string") {
    const text = restoreText(session, part.text)
    return text === part.text
      ? { changed: false, value: part }
      : { changed: true, value: cloneAiSdkValue(part, { text }) }
  }
  if (part.type === "tool-call" && typeof part.input === "string") {
    const input = restoreAiSdkToolJson(session, part.input)
    return input === part.input
      ? { changed: false, value: part }
      : { changed: true, value: cloneAiSdkValue(part, { input }) }
  }
  if (part.type === "tool-result" && part.output !== undefined) {
    const output = restoreToolResultOutput(session, part.output)
    return output.changed
      ? {
          changed: true,
          value: cloneAiSdkValue(part, { output: output.value }),
        }
      : { changed: false, value: part }
  }
  if (part.type === "tool-result" && part.result !== undefined) {
    const result = restoreAiSdkJson(session, part.result)
    return result.changed
      ? {
          changed: true,
          value: cloneAiSdkValue(part, { result: result.value }),
        }
      : { changed: false, value: part }
  }
  return { changed: false, value: part }
}

/** Restore semantic generated content while retaining the result envelope. */
export function restoreAiSdkContent<T>(session: PiiSession, content: T): T {
  if (!Array.isArray(content)) return content
  const overrides: Record<PropertyKey, unknown> = {}
  let changed = false
  for (let index = 0; index < content.length; index++) {
    const part = restorePart(session, content[index])
    if (part.changed) {
      changed = true
      overrides[index] = part.value
    }
  }
  return changed ? cloneAiSdkValue(content, overrides) : content
}

/** Restore a complete v4 tool-call or provider-executed tool-result chunk. */
export function restoreAiSdkStreamPart<T>(session: PiiSession, part: T): T {
  if (!isRecord(part)) return part
  if (part.type === "tool-call" && typeof part.input === "string") {
    const input = restoreAiSdkToolJson(session, part.input)
    return input === part.input ? part : cloneAiSdkValue(part, { input })
  }
  if (part.type === "tool-result") {
    const result = restoreAiSdkJson(session, part.result)
    return result.changed
      ? cloneAiSdkValue(part, { result: result.value })
      : part
  }
  return part
}
