import type { ModelMessage, UIMessage } from "@tanstack/ai/client"
import type { PiiSession } from "./session"

type TanStackMessages = Array<UIMessage> | Array<ModelMessage>
type PathSegment = string | number
type UnknownRecord = Record<PropertyKey, unknown>
type ContentPartFamily = "model-content" | "ui-parts"

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object"
}

/**
 * Read data properties without invoking an accessor. Protocol messages are
 * plain records, but avoiding dynamic getters keeps policy inspection safe for
 * hostile or descriptor-heavy input graphs.
 */
function readDataProperty(value: unknown, key: PropertyKey): unknown {
  if (!isRecord(value)) return undefined
  let cursor: object | null = value
  try {
    while (cursor !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key)
      if (descriptor)
        return "value" in descriptor ? descriptor.value : undefined
      cursor = Object.getPrototypeOf(cursor)
    }
  } catch {
    return undefined
  }
  return undefined
}

function createOverrides(): Map<PropertyKey, unknown> {
  return new Map<PropertyKey, unknown>()
}

/** Clone only a changed path while retaining prototypes, symbols, and descriptors. */
function cloneWithOverrides<T extends object>(
  source: T,
  overrides: ReadonlyMap<PropertyKey, unknown>
): T {
  const original = source as object
  const clone = Array.isArray(original)
    ? []
    : Object.create(Object.getPrototypeOf(original))
  if (Array.isArray(original)) {
    Object.setPrototypeOf(clone, Object.getPrototypeOf(original))
  }

  const descriptors = Object.getOwnPropertyDescriptors(original) as Record<
    PropertyKey,
    PropertyDescriptor
  >
  for (const [key, value] of overrides) {
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

function safeDiscriminant(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return "<missing>"
  if (value === null) return "null"
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  if (typeof value === "bigint") return `${value}n`
  return `<${typeof value}>`
}

function formatPath(path: readonly PathSegment[]): string {
  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") return `${formatted}[${segment}]`
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
      ? `${formatted}.${segment}`
      : `${formatted}[${JSON.stringify(segment)}]`
  }, "$")
}

/** Error raised before `connect` when a semantic part family is not classified. */
export class UnsupportedTanStackSemanticContentError extends Error {
  override readonly name = "UnsupportedTanStackSemanticContentError"
  readonly path: readonly PathSegment[]
  readonly discriminant: string

  constructor(path: readonly PathSegment[], discriminant: string) {
    const safePath = Object.freeze([...path])
    super(
      `Unsupported TanStack semantic content at ${formatPath(safePath)}: ${discriminant}`
    )
    this.path = safePath
    this.discriminant = discriminant
  }
}

function unsupportedPart(path: readonly PathSegment[], part: unknown): never {
  throw new UnsupportedTanStackSemanticContentError(
    path,
    safeDiscriminant(readDataProperty(part, "type"))
  )
}

function validateContentPart(
  part: unknown,
  path: readonly PathSegment[],
  family: ContentPartFamily
): void {
  const type = readDataProperty(part, "type")
  switch (type) {
    case "text":
    case "image":
    case "audio":
    case "video":
    case "document":
      return
    case "tool-call":
    case "tool-result":
    case "thinking":
    case "structured-output":
    case "ui-resource":
      if (family === "ui-parts") return
      return unsupportedPart(path, part)
    default:
      return unsupportedPart(path, part)
  }
}

function validateParts(
  parts: Array<unknown>,
  path: readonly PathSegment[],
  family: ContentPartFamily
): void {
  for (let index = 0; index < parts.length; index += 1) {
    const partPath = [...path, index] as const
    validateContentPart(parts[index], partPath, family)
    const type = readDataProperty(parts[index], "type")
    if (type === "tool-result") {
      const content = readDataProperty(parts[index], "content")
      if (Array.isArray(content)) {
        validateParts(content, [...partPath, "content"], "model-content")
      }
    }
  }
}

function validateMessage(message: unknown, index: number): void {
  if (!isRecord(message)) return
  const parts = readDataProperty(message, "parts")
  if (Array.isArray(parts)) validateParts(parts, [index, "parts"], "ui-parts")

  const content = readDataProperty(message, "content")
  if (Array.isArray(content)) {
    validateParts(content, [index, "content"], "model-content")
  }
}

async function protectText(session: PiiSession, text: string): Promise<string> {
  if (text.length === 0) return text
  return (await session.anonymize(text)).redactedText
}

/** Deeply protect JSON string leaves with descriptor-safe, changed-path cloning. */
async function protectJsonValue(
  session: PiiSession,
  value: unknown
): Promise<unknown> {
  if (typeof value === "string") return protectText(session, value)
  if (!isRecord(value)) return value

  const overrides = createOverrides()
  let changed = false
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      continue
    const next = await protectJsonValue(session, descriptor.value)
    if (next !== descriptor.value) {
      changed = true
      overrides.set(key, next)
    }
  }
  return changed ? cloneWithOverrides(value, overrides) : value
}

async function protectJsonText(
  session: PiiSession,
  text: string
): Promise<string> {
  try {
    return JSON.stringify(await protectJsonValue(session, JSON.parse(text)))
  } catch {
    return protectText(session, text)
  }
}

async function protectParts(
  session: PiiSession,
  parts: Array<unknown>,
  path: readonly PathSegment[],
  family: ContentPartFamily,
  jsonText = false
): Promise<Array<unknown>> {
  const overrides = createOverrides()
  let changed = false
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    const next = await protectContentPart(
      session,
      part,
      [...path, index],
      family,
      jsonText
    )
    if (next !== part) {
      changed = true
      overrides.set(index, next)
    }
  }
  return changed ? cloneWithOverrides(parts, overrides) : parts
}

async function protectContentPart(
  session: PiiSession,
  part: unknown,
  path: readonly PathSegment[],
  family: ContentPartFamily,
  jsonText = false
): Promise<unknown> {
  if (!isRecord(part)) return unsupportedPart(path, part)
  const type = readDataProperty(part, "type")

  if (type === "text") {
    const content = readDataProperty(part, "content")
    if (typeof content !== "string") return part
    const protectedContent = jsonText
      ? await protectJsonText(session, content)
      : await protectText(session, content)
    if (protectedContent === content) return part
    return cloneWithOverrides(part, new Map([["content", protectedContent]]))
  }

  if (type === "structured-output") {
    if (
      family === "ui-parts" &&
      readDataProperty(part, "status") === "complete"
    ) {
      const raw = readDataProperty(part, "raw")
      if (typeof raw === "string") {
        const protectedRaw = await protectJsonText(session, raw)
        if (protectedRaw !== raw) {
          return cloneWithOverrides(part, new Map([["raw", protectedRaw]]))
        }
      }
    }
    return family === "ui-parts" ? part : unsupportedPart(path, part)
  }

  if (type === "tool-call") {
    if (family !== "ui-parts") return unsupportedPart(path, part)
    const overrides = createOverrides()
    let changed = false
    const argumentsValue = readDataProperty(part, "arguments")
    if (typeof argumentsValue === "string") {
      const protectedArguments = await protectJsonText(session, argumentsValue)
      if (protectedArguments !== argumentsValue) {
        changed = true
        overrides.set("arguments", protectedArguments)
      }
    }
    for (const key of ["input", "output"] as const) {
      const value = readDataProperty(part, key)
      if (value === undefined) continue
      const protectedValue = await protectJsonValue(session, value)
      if (protectedValue !== value) {
        changed = true
        overrides.set(key, protectedValue)
      }
    }
    return changed ? cloneWithOverrides(part, overrides) : part
  }

  if (type === "tool-result") {
    if (family !== "ui-parts") return unsupportedPart(path, part)
    const content = readDataProperty(part, "content")
    const overrides = createOverrides()
    let changed = false
    if (typeof content === "string") {
      const protectedContent = await protectJsonText(session, content)
      if (protectedContent !== content) {
        changed = true
        overrides.set("content", protectedContent)
      }
    } else if (Array.isArray(content)) {
      const protectedContent = await protectParts(
        session,
        content,
        [...path, "content"],
        "model-content",
        true
      )
      if (protectedContent !== content) {
        changed = true
        overrides.set("content", protectedContent)
      }
    }
    const error = readDataProperty(part, "error")
    if (typeof error === "string") {
      const protectedError = await protectText(session, error)
      if (protectedError !== error) {
        changed = true
        overrides.set("error", protectedError)
      }
    }
    return changed ? cloneWithOverrides(part, overrides) : part
  }

  if (
    type === "image" ||
    type === "audio" ||
    type === "video" ||
    type === "document" ||
    type === "thinking" ||
    type === "ui-resource"
  ) {
    if (type === "thinking" || type === "ui-resource") {
      return family === "ui-parts" ? part : unsupportedPart(path, part)
    }
    return part
  }

  return unsupportedPart(path, part)
}

async function protectModelToolCall(
  session: PiiSession,
  toolCall: unknown
): Promise<unknown> {
  if (!isRecord(toolCall)) return toolCall
  const fn = readDataProperty(toolCall, "function")
  if (!isRecord(fn)) return toolCall
  const argumentsValue = readDataProperty(fn, "arguments")
  if (typeof argumentsValue !== "string") return toolCall
  const protectedArguments = await protectJsonText(session, argumentsValue)
  if (protectedArguments === argumentsValue) return toolCall
  const protectedFunction = cloneWithOverrides(
    fn,
    new Map([["arguments", protectedArguments]])
  )
  return cloneWithOverrides(
    toolCall,
    new Map([["function", protectedFunction]])
  )
}

async function protectModelToolCalls(
  session: PiiSession,
  toolCalls: Array<unknown>
): Promise<Array<unknown>> {
  const overrides = createOverrides()
  let changed = false
  for (let index = 0; index < toolCalls.length; index += 1) {
    const next = await protectModelToolCall(session, toolCalls[index])
    if (next !== toolCalls[index]) {
      changed = true
      overrides.set(index, next)
    }
  }
  return changed ? cloneWithOverrides(toolCalls, overrides) : toolCalls
}

async function protectMessage(
  session: PiiSession,
  message: UIMessage | ModelMessage,
  index: number
): Promise<UIMessage | ModelMessage> {
  if (!isRecord(message)) return message
  const overrides = createOverrides()
  let changed = false

  const parts = readDataProperty(message, "parts")
  if (Array.isArray(parts)) {
    const protectedParts = await protectParts(
      session,
      parts,
      [index, "parts"],
      "ui-parts"
    )
    if (protectedParts !== parts) {
      changed = true
      overrides.set("parts", protectedParts)
    }
  }

  const content = readDataProperty(message, "content")
  if (typeof content === "string") {
    const role = readDataProperty(message, "role")
    const protectedContent =
      role === "tool"
        ? await protectJsonText(session, content)
        : await protectText(session, content)
    if (protectedContent !== content) {
      changed = true
      overrides.set("content", protectedContent)
    }
  } else if (Array.isArray(content)) {
    const protectedContent = await protectParts(
      session,
      content,
      [index, "content"],
      "model-content",
      readDataProperty(message, "role") === "tool"
    )
    if (protectedContent !== content) {
      changed = true
      overrides.set("content", protectedContent)
    }
  }

  const toolCalls = readDataProperty(message, "toolCalls")
  if (Array.isArray(toolCalls)) {
    const protectedToolCalls = await protectModelToolCalls(session, toolCalls)
    if (protectedToolCalls !== toolCalls) {
      changed = true
      overrides.set("toolCalls", protectedToolCalls)
    }
  }

  return changed
    ? cloneWithOverrides(message, overrides)
    : (message as UIMessage | ModelMessage)
}

/** Protect only model-semantic fields and retain protocol/control values. */
export async function protectTanStackMessages(
  session: PiiSession,
  messages: TanStackMessages
): Promise<TanStackMessages> {
  // Preflight every semantic array before mutating the session or acquiring
  // the wrapped connection. Unknown parts therefore fail closed consistently.
  for (let index = 0; index < messages.length; index += 1) {
    validateMessage(messages[index], index)
  }

  const protectedMessages: Array<UIMessage | ModelMessage> = []
  for (let index = 0; index < messages.length; index += 1) {
    protectedMessages.push(
      await protectMessage(session, messages[index]!, index)
    )
  }
  return protectedMessages as TanStackMessages
}
