import type {
  ContentPart,
  MessagePart,
  ModelMessage,
  UIMessage,
} from "@tanstack/ai/client"
import type { PiiSession } from "./session"

type TanStackMessages = Array<UIMessage> | Array<ModelMessage>
type PathSegment = string | number
type UnknownRecord = Record<PropertyKey, unknown>
type MessageFamily = "ui" | "model"
type PartPolicyKind =
  "text" | "opaque" | "structured-output" | "tool-call" | "tool-result"

type ModelPartType = ContentPart["type"]
type UiPartType = MessagePart["type"]

/** The pinned public discriminant matrix is the single policy source of truth. */
const PART_POLICY = {
  model: {
    text: "text",
    image: "opaque",
    audio: "opaque",
    video: "opaque",
    document: "opaque",
  },
  ui: {
    text: "text",
    image: "opaque",
    audio: "opaque",
    video: "opaque",
    document: "opaque",
    "tool-call": "tool-call",
    "tool-result": "tool-result",
    thinking: "opaque",
    "structured-output": "structured-output",
    "ui-resource": "opaque",
  },
} as const satisfies {
  model: Record<ModelPartType, PartPolicyKind>
  ui: Record<UiPartType, PartPolicyKind>
}

const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[-._:][A-Za-z0-9]+)*$/
const MAX_TOKEN_LENGTH = 64
const SAFE_REASONS = new Set([
  "<accessor>",
  "<cycle>",
  "<invalid>",
  "<invalid-json>",
  "<missing>",
  "<missing-data>",
])

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object"
}

function isSafeToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    TOKEN_PATTERN.test(value)
  )
}

function sanitizeReason(value: unknown): string {
  if (typeof value === "string") {
    if (SAFE_REASONS.has(value)) return value
    if (isSafeToken(value)) return value
  }
  return "<invalid>"
}

function sanitizePath(path: readonly PathSegment[]): readonly PathSegment[] {
  return Object.freeze(
    path.map((segment) =>
      typeof segment === "number" &&
      Number.isSafeInteger(segment) &&
      segment >= 0
        ? segment
        : typeof segment === "string" && isSafeToken(segment)
          ? segment
          : "<invalid>"
    )
  )
}

function formatPath(path: readonly PathSegment[]): string {
  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") return `${formatted}[${segment}]`
    return isSafeToken(segment)
      ? `${formatted}.${segment}`
      : `${formatted}[${JSON.stringify(segment)}]`
  }, "$")
}

/** Error raised before `connect` when a semantic part cannot be classified safely. */
export class UnsupportedTanStackSemanticContentError extends Error {
  override readonly name = "UnsupportedTanStackSemanticContentError"
  readonly path: readonly PathSegment[]
  readonly discriminant: string

  constructor(path: readonly PathSegment[], discriminant: string) {
    const safePath = sanitizePath(path)
    const safeDiscriminant = sanitizeReason(discriminant)
    super(
      `Unsupported TanStack semantic content at ${formatPath(safePath)}: ${safeDiscriminant}`
    )
    this.path = safePath
    this.discriminant = safeDiscriminant
  }
}

function unsupported(
  path: readonly PathSegment[],
  reason: unknown = "<invalid>"
): never {
  throw new UnsupportedTanStackSemanticContentError(
    path,
    sanitizeReason(reason)
  )
}

type FieldResult =
  { kind: "missing" } | { kind: "accessor" } | { kind: "data"; value: unknown }

function findField(
  value: unknown,
  key: PropertyKey,
  path: readonly PathSegment[]
): FieldResult {
  if (!isRecord(value)) return { kind: "missing" }
  let cursor: object | null = value
  const seen = new WeakSet<object>()
  let depth = 0
  try {
    while (cursor !== null) {
      depth += 1
      if (depth > 100) return unsupported(path, "<invalid>")
      if (seen.has(cursor)) return unsupported(path, "<invalid>")
      seen.add(cursor)
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key)
      if (descriptor) {
        return "value" in descriptor
          ? { kind: "data", value: descriptor.value }
          : { kind: "accessor" }
      }
      cursor = Object.getPrototypeOf(cursor)
    }
  } catch {
    return unsupported(path, "<invalid>")
  }
  return { kind: "missing" }
}

function readRequired(
  value: unknown,
  key: PropertyKey,
  path: readonly PathSegment[]
): unknown {
  const result = findField(value, key, path)
  if (result.kind === "accessor") return unsupported(path, "<accessor>")
  if (result.kind === "missing") return unsupported(path, "<missing>")
  return result.value
}

function readOptional(
  value: unknown,
  key: PropertyKey,
  path: readonly PathSegment[]
): FieldResult {
  const result = findField(value, key, path)
  if (result.kind === "accessor") return unsupported(path, "<accessor>")
  return result
}

function ownDescriptors(
  value: object,
  path: readonly PathSegment[]
): Record<PropertyKey, PropertyDescriptor> {
  try {
    return Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >
  } catch {
    return unsupported(path, "<invalid>")
  }
}

function createOverrides(): Map<PropertyKey, unknown> {
  return new Map<PropertyKey, unknown>()
}

/** Clone only a changed path while retaining prototypes, symbols, and descriptors. */
function cloneWithOverrides<T extends object>(
  source: T,
  overrides: ReadonlyMap<PropertyKey, unknown>,
  path: readonly PathSegment[]
): T {
  try {
    const original = source as object
    const prototype = Object.getPrototypeOf(original)
    const clone = Array.isArray(original) ? [] : Object.create(prototype)
    if (Array.isArray(original)) Object.setPrototypeOf(clone, prototype)
    const descriptors = ownDescriptors(original, path)
    for (const [key, value] of overrides) {
      const descriptor = descriptors[key]
      descriptors[key] =
        descriptor && "value" in descriptor
          ? { ...descriptor, value }
          : {
              configurable: descriptor?.configurable ?? true,
              enumerable: descriptor?.enumerable ?? true,
              value,
              writable: true,
            }
    }
    Object.defineProperties(clone, descriptors)
    return clone as T
  } catch {
    return unsupported(path, "<invalid>")
  }
}

function arrayEntries(
  value: unknown,
  path: readonly PathSegment[]
): Array<unknown> {
  if (!Array.isArray(value)) return unsupported(path, "<invalid>")
  const descriptors = ownDescriptors(value, path)
  const lengthDescriptor = descriptors.length
  if (!lengthDescriptor || !("value" in lengthDescriptor))
    return unsupported(path, "<invalid>")
  const length = lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 0)
    return unsupported(path, "<invalid>")
  const entries: Array<unknown> = []
  for (let index = 0; index < length; index += 1) {
    const itemPath = [...path, index] as const
    const descriptor = descriptors[index]
    if (!descriptor) return unsupported(itemPath, "<missing>")
    if (!("value" in descriptor)) return unsupported(itemPath, "<accessor>")
    entries.push(descriptor.value)
  }
  return entries
}

function policyFor(
  family: MessageFamily,
  type: unknown
): PartPolicyKind | undefined {
  if (typeof type !== "string") return undefined
  const table = PART_POLICY[family]
  return Object.prototype.hasOwnProperty.call(table, type)
    ? table[type as keyof typeof table]
    : undefined
}

function partType(part: unknown, path: readonly PathSegment[]): string {
  const type = readRequired(part, "type", path)
  return typeof type === "string" ? type : unsupported(path, "<invalid>")
}

function parseStrictJson(text: string, path: readonly PathSegment[]): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return unsupported(path, "<invalid-json>")
  }
}

/** Inspect a semantic JSON graph without invoking accessors and reject cycles/traps. */
function preflightJson(
  value: unknown,
  path: readonly PathSegment[],
  active: WeakSet<object> = new WeakSet<object>(),
  requireSerializable = false
): void {
  if (!isRecord(value)) {
    if (
      requireSerializable &&
      (value === undefined ||
        typeof value === "bigint" ||
        typeof value === "function" ||
        typeof value === "symbol" ||
        (typeof value === "number" && !Number.isFinite(value)))
    ) {
      return unsupported(path, "<invalid-json>")
    }
    return
  }
  if (active.has(value)) return unsupported(path, "<cycle>")
  active.add(value)
  const descriptors = ownDescriptors(value, path)
  if (requireSerializable && !Array.isArray(value)) {
    let prototype: object | null
    try {
      prototype = Object.getPrototypeOf(value)
    } catch {
      return unsupported(path, "<invalid-json>")
    }
    if (prototype !== null && prototype !== Object.prototype)
      return unsupported(path, "<invalid-json>")
  }
  if (requireSerializable && Array.isArray(value)) {
    const lengthDescriptor = descriptors.length
    const length =
      lengthDescriptor && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined
    if (typeof length !== "number") return unsupported(path, "<invalid-json>")
    for (let index = 0; index < length; index += 1) {
      if (!descriptors[index])
        return unsupported([...path, index], "<invalid-json>")
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (!descriptor) continue
    const childPath = [
      ...path,
      typeof key === "string" ? key : "<invalid>",
    ] as const
    if (!("value" in descriptor)) return unsupported(childPath, "<accessor>")
    if (descriptor.enumerable)
      preflightJson(descriptor.value, childPath, active, requireSerializable)
  }
  active.delete(value)
}

function prepareForJson(value: unknown, active: WeakSet<object>): unknown {
  if (typeof value === "bigint") throw new TypeError("bigint")
  if (!isRecord(value)) return value
  if (active.has(value)) throw new TypeError("cycle")
  active.add(value)
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const output: unknown[] = []
      const length = (descriptors.length as PropertyDescriptor).value as number
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[index]
        if (!descriptor || !("value" in descriptor))
          throw new TypeError("accessor")
        output.push(prepareForJson(descriptor.value, active))
      }
      return output
    }
    const output = Object.create(null) as Record<string, unknown>
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable) continue
      if (!("value" in descriptor)) throw new TypeError("accessor")
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: prepareForJson(descriptor.value, active),
        writable: true,
      })
    }
    return output
  } finally {
    active.delete(value)
  }
}

function stringifyJson(value: unknown, path: readonly PathSegment[]): string {
  try {
    const prepared = prepareForJson(value, new WeakSet<object>())
    const serialized = JSON.stringify(prepared)
    if (serialized === undefined) return unsupported(path, "<invalid-json>")
    return serialized
  } catch {
    return unsupported(path, "<invalid-json>")
  }
}

async function protectJsonValue(
  session: PiiSession,
  value: unknown,
  path: readonly PathSegment[],
  active: WeakSet<object> = new WeakSet<object>()
): Promise<unknown> {
  if (typeof value === "string") return protectText(session, value)
  if (!isRecord(value)) return value
  if (active.has(value)) return unsupported(path, "<cycle>")
  active.add(value)
  try {
    const overrides = createOverrides()
    let changed = false
    const descriptors = ownDescriptors(value, path)
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable) continue
      if (!("value" in descriptor))
        return unsupported([...path, String(key)], "<accessor>")
      const next = await protectJsonValue(
        session,
        descriptor.value,
        [...path, String(key)],
        active
      )
      if (next !== descriptor.value) {
        changed = true
        overrides.set(key, next)
      }
    }
    return changed ? cloneWithOverrides(value, overrides, path) : value
  } finally {
    active.delete(value)
  }
}

async function protectText(session: PiiSession, text: string): Promise<string> {
  if (text.length === 0) return text
  return (await session.anonymize(text)).redactedText
}

async function protectStrictJsonText(
  session: PiiSession,
  text: string,
  path: readonly PathSegment[]
): Promise<string> {
  const parsed = parseStrictJson(text, path)
  preflightJson(parsed, path)
  const protectedValue = await protectJsonValue(session, parsed, path)
  return stringifyJson(protectedValue, path)
}

async function protectFreeformText(
  session: PiiSession,
  text: string,
  path: readonly PathSegment[]
): Promise<string> {
  try {
    const parsed = JSON.parse(text)
    preflightJson(parsed, path)
    return stringifyJson(await protectJsonValue(session, parsed, path), path)
  } catch (error) {
    if (error instanceof UnsupportedTanStackSemanticContentError) throw error
    return protectText(session, text)
  }
}

function preflightPart(
  part: unknown,
  path: readonly PathSegment[],
  family: MessageFamily
): void {
  if (!isRecord(part)) return unsupported(path, "<invalid>")
  const descriptors = ownDescriptors(part, path)
  const type = partType(part, path)
  const policy = policyFor(family, type)
  if (!policy) return unsupported(path, type)

  if (policy === "text") {
    const content = readRequired(part, "content", [...path, "content"])
    if (typeof content !== "string")
      return unsupported([...path, "content"], "<invalid>")
    return
  }
  if (policy === "structured-output") {
    const status = readRequired(part, "status", [...path, "status"])
    if (status !== "streaming" && status !== "complete" && status !== "error")
      return unsupported([...path, "status"], "<invalid>")
    if (status !== "complete") return
    const raw = readRequired(part, "raw", [...path, "raw"])
    if (typeof raw !== "string")
      return unsupported([...path, "raw"], "<invalid>")
    const dataField = readOptional(part, "data", [...path, "data"])
    if (dataField.kind === "accessor")
      return unsupported([...path, "data"], "<accessor>")
    if (raw === "") {
      if (dataField.kind !== "data" || dataField.value === undefined)
        return unsupported([...path, "data"], "<missing-data>")
      preflightJson(
        dataField.value,
        [...path, "data"],
        new WeakSet<object>(),
        true
      )
    } else {
      parseStrictJson(raw, [...path, "raw"])
    }
    return
  }
  if (policy === "tool-call") {
    const argumentsValue = readRequired(part, "arguments", [
      ...path,
      "arguments",
    ])
    if (typeof argumentsValue !== "string")
      return unsupported([...path, "arguments"], "<invalid>")
    const parsed = parseStrictJson(argumentsValue, [...path, "arguments"])
    preflightJson(parsed, [...path, "arguments"])
    for (const key of ["input", "output"] as const) {
      const field = readOptional(part, key, [...path, key])
      if (field.kind === "data" && field.value !== undefined)
        preflightJson(field.value, [...path, key])
    }
    return
  }
  if (policy === "tool-result") {
    const content = readRequired(part, "content", [...path, "content"])
    if (typeof content === "string") {
      try {
        const parsed = JSON.parse(content)
        preflightJson(parsed, [...path, "content"])
      } catch {
        // Tool-result content intentionally remains freeform text when not JSON.
      }
    } else if (Array.isArray(content)) {
      preflightParts(content, [...path, "content"], "model")
    } else {
      return unsupported([...path, "content"], "<invalid>")
    }
    const error = readOptional(part, "error", [...path, "error"])
    if (
      error.kind === "data" &&
      error.value !== undefined &&
      typeof error.value !== "string"
    )
      return unsupported([...path, "error"], "<invalid>")
    return
  }

  // Opaque media, reasoning, and UI resources are preserved without reading
  // their fields. The descriptor snapshot above still catches proxy traps.
  void descriptors
}

function preflightParts(
  parts: unknown,
  path: readonly PathSegment[],
  family: MessageFamily
): void {
  const entries = arrayEntries(parts, path)
  for (let index = 0; index < entries.length; index += 1) {
    preflightPart(entries[index], [...path, index], family)
  }
}

function preflightToolCall(
  toolCall: unknown,
  path: readonly PathSegment[]
): void {
  if (!isRecord(toolCall)) return unsupported(path, "<invalid>")
  ownDescriptors(toolCall, path)
  const fn = readRequired(toolCall, "function", [...path, "function"])
  if (!isRecord(fn)) return unsupported([...path, "function"], "<invalid>")
  ownDescriptors(fn, [...path, "function"])
  const argumentsValue = readRequired(fn, "arguments", [
    ...path,
    "function",
    "arguments",
  ])
  if (typeof argumentsValue !== "string")
    return unsupported([...path, "function", "arguments"], "<invalid>")
  const parsed = parseStrictJson(argumentsValue, [
    ...path,
    "function",
    "arguments",
  ])
  preflightJson(parsed, [...path, "function", "arguments"])
}

function preflightToolCalls(
  value: unknown,
  path: readonly PathSegment[]
): void {
  const entries = arrayEntries(value, path)
  for (let index = 0; index < entries.length; index += 1)
    preflightToolCall(entries[index], [...path, index])
}

function messageShape(
  message: unknown,
  index: number
): { ui: boolean; model: boolean } {
  if (!isRecord(message)) return unsupported([index], "<invalid>")
  const ui =
    findField(message, "id", [index, "id"]).kind !== "missing" &&
    findField(message, "parts", [index, "parts"]).kind !== "missing"
  const model =
    findField(message, "content", [index, "content"]).kind !== "missing"
  if (!ui && !model) return unsupported([index], "<invalid>")
  return { ui, model }
}

function classifyMessages(messages: Array<unknown>): MessageFamily {
  let candidate: MessageFamily | undefined
  const shapes = messages.map((message, index) => messageShape(message, index))
  for (let index = 0; index < shapes.length; index += 1) {
    const shape = shapes[index]!
    const unambiguous =
      shape.ui === shape.model ? undefined : shape.ui ? "ui" : "model"
    if (unambiguous && candidate && candidate !== unambiguous)
      return unsupported([index], "<invalid>")
    if (unambiguous) candidate = unambiguous
  }
  // An all-ambiguous intersection is treated as UI because `id + parts` is
  // the richer canonical shape and avoids touching a model's unknown fields.
  return candidate ?? "ui"
}

function preflightMessage(
  message: unknown,
  index: number,
  family: MessageFamily
): void {
  if (!isRecord(message)) return unsupported([index], "<invalid>")
  if (family === "ui") {
    const id = readRequired(message, "id", [index, "id"])
    const role = readRequired(message, "role", [index, "role"])
    const parts = readRequired(message, "parts", [index, "parts"])
    if (typeof id !== "string") return unsupported([index, "id"], "<invalid>")
    if (role !== "system" && role !== "user" && role !== "assistant")
      return unsupported([index, "role"], "<invalid>")
    return preflightParts(parts, [index, "parts"], "ui")
  }

  const role = readRequired(message, "role", [index, "role"])
  const content = readRequired(message, "content", [index, "content"])
  if (role !== "user" && role !== "assistant" && role !== "tool")
    return unsupported([index, "role"], "<invalid>")
  if (typeof content === "string" || content === null) {
    // Plain text is safe to protect during transformation.
  } else if (Array.isArray(content)) {
    preflightParts(content, [index, "content"], "model")
  } else {
    return unsupported([index, "content"], "<invalid>")
  }
  const toolCalls = readOptional(message, "toolCalls", [index, "toolCalls"])
  if (toolCalls.kind === "data" && toolCalls.value !== undefined)
    preflightToolCalls(toolCalls.value, [index, "toolCalls"])
}

async function protectPart(
  session: PiiSession,
  part: unknown,
  path: readonly PathSegment[],
  family: MessageFamily,
  jsonText = false
): Promise<unknown> {
  const type = partType(part, path)
  const policy = policyFor(family, type)
  if (!policy) return unsupported(path, type)

  if (policy === "text") {
    const content = readRequired(part, "content", [...path, "content"])
    const protectedContent = jsonText
      ? await protectFreeformText(session, content as string, [
          ...path,
          "content",
        ])
      : await protectText(session, content as string)
    return protectedContent === content
      ? part
      : cloneWithOverrides(
          part as object,
          new Map([["content", protectedContent]]),
          path
        )
  }
  if (policy === "structured-output") {
    const status = readRequired(part, "status", [...path, "status"])
    if (status !== "complete") return part
    const raw = readRequired(part, "raw", [...path, "raw"]) as string
    if (raw === "") {
      const data = readRequired(part, "data", [...path, "data"])
      const protectedData = await protectJsonValue(session, data, [
        ...path,
        "data",
      ])
      const protectedRaw = stringifyJson(protectedData, [...path, "data"])
      return cloneWithOverrides(
        part as object,
        new Map([["raw", protectedRaw]]),
        path
      )
    }
    const protectedRaw = await protectStrictJsonText(session, raw, [
      ...path,
      "raw",
    ])
    return protectedRaw === raw
      ? part
      : cloneWithOverrides(
          part as object,
          new Map([["raw", protectedRaw]]),
          path
        )
  }
  if (policy === "tool-call") {
    const overrides = createOverrides()
    let changed = false
    const argumentsValue = readRequired(part, "arguments", [
      ...path,
      "arguments",
    ]) as string
    const protectedArguments = await protectStrictJsonText(
      session,
      argumentsValue,
      [...path, "arguments"]
    )
    if (protectedArguments !== argumentsValue) {
      changed = true
      overrides.set("arguments", protectedArguments)
    }
    for (const key of ["input", "output"] as const) {
      const field = readOptional(part, key, [...path, key])
      if (field.kind !== "data" || field.value === undefined) continue
      const protectedValue = await protectJsonValue(session, field.value, [
        ...path,
        key,
      ])
      if (protectedValue !== field.value) {
        changed = true
        overrides.set(key, protectedValue)
      }
    }
    return changed ? cloneWithOverrides(part as object, overrides, path) : part
  }
  if (policy === "tool-result") {
    const overrides = createOverrides()
    let changed = false
    const content = readRequired(part, "content", [...path, "content"])
    const protectedContent =
      typeof content === "string"
        ? await protectFreeformText(session, content, [...path, "content"])
        : await protectParts(
            session,
            content,
            [...path, "content"],
            "model",
            true
          )
    if (protectedContent !== content) {
      changed = true
      overrides.set("content", protectedContent)
    }
    const error = readOptional(part, "error", [...path, "error"])
    if (error.kind === "data" && typeof error.value === "string") {
      const protectedError = await protectText(session, error.value)
      if (protectedError !== error.value) {
        changed = true
        overrides.set("error", protectedError)
      }
    }
    return changed ? cloneWithOverrides(part as object, overrides, path) : part
  }
  return part
}

async function protectParts(
  session: PiiSession,
  parts: unknown,
  path: readonly PathSegment[],
  family: MessageFamily,
  jsonText = false
): Promise<Array<unknown>> {
  const entries = arrayEntries(parts, path)
  const overrides = createOverrides()
  let changed = false
  for (let index = 0; index < entries.length; index += 1) {
    const next = await protectPart(
      session,
      entries[index],
      [...path, index],
      family,
      jsonText
    )
    if (next !== entries[index]) {
      changed = true
      overrides.set(index, next)
    }
  }
  return changed
    ? cloneWithOverrides(parts as Array<unknown>, overrides, path)
    : (parts as Array<unknown>)
}

async function protectToolCall(
  session: PiiSession,
  toolCall: unknown,
  path: readonly PathSegment[]
): Promise<unknown> {
  const fn = readRequired(toolCall, "function", [...path, "function"])
  const argumentsValue = readRequired(fn, "arguments", [
    ...path,
    "function",
    "arguments",
  ]) as string
  const protectedArguments = await protectStrictJsonText(
    session,
    argumentsValue,
    [...path, "function", "arguments"]
  )
  if (protectedArguments === argumentsValue) return toolCall
  const protectedFunction = cloneWithOverrides(
    fn as object,
    new Map([["arguments", protectedArguments]]),
    [...path, "function"]
  )
  return cloneWithOverrides(
    toolCall as object,
    new Map([["function", protectedFunction]]),
    path
  )
}

async function protectToolCalls(
  session: PiiSession,
  toolCalls: unknown,
  path: readonly PathSegment[]
): Promise<Array<unknown>> {
  const entries = arrayEntries(toolCalls, path)
  const overrides = createOverrides()
  let changed = false
  for (let index = 0; index < entries.length; index += 1) {
    const next = await protectToolCall(session, entries[index], [
      ...path,
      index,
    ])
    if (next !== entries[index]) {
      changed = true
      overrides.set(index, next)
    }
  }
  return changed
    ? cloneWithOverrides(toolCalls as Array<unknown>, overrides, path)
    : (toolCalls as Array<unknown>)
}

async function protectMessage(
  session: PiiSession,
  message: unknown,
  index: number,
  family: MessageFamily
): Promise<unknown> {
  const overrides = createOverrides()
  let changed = false
  if (family === "ui") {
    const parts = readRequired(message, "parts", [index, "parts"])
    const protectedParts = await protectParts(
      session,
      parts,
      [index, "parts"],
      "ui"
    )
    if (protectedParts !== parts) {
      changed = true
      overrides.set("parts", protectedParts)
    }
  } else {
    const content = readRequired(message, "content", [index, "content"])
    if (typeof content === "string") {
      const role = readRequired(message, "role", [index, "role"])
      const protectedContent =
        role === "tool"
          ? await protectFreeformText(session, content, [index, "content"])
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
        "model",
        readRequired(message, "role", [index, "role"]) === "tool"
      )
      if (protectedContent !== content) {
        changed = true
        overrides.set("content", protectedContent)
      }
    }
    const toolCalls = readOptional(message, "toolCalls", [index, "toolCalls"])
    if (toolCalls.kind === "data" && toolCalls.value !== undefined) {
      const protectedToolCalls = await protectToolCalls(
        session,
        toolCalls.value,
        [index, "toolCalls"]
      )
      if (protectedToolCalls !== toolCalls.value) {
        changed = true
        overrides.set("toolCalls", protectedToolCalls)
      }
    }
  }
  return changed
    ? cloneWithOverrides(message as object, overrides, [index])
    : message
}

/** Protect only model-semantic fields and retain protocol/control values. */
export async function protectTanStackMessages(
  session: PiiSession,
  messages: TanStackMessages
): Promise<TanStackMessages> {
  const entries = arrayEntries(messages, [])
  const family = classifyMessages(entries)
  for (let index = 0; index < entries.length; index += 1)
    preflightMessage(entries[index], index, family)

  const protectedMessages: Array<unknown> = []
  for (let index = 0; index < entries.length; index += 1) {
    protectedMessages.push(
      await protectMessage(session, entries[index], index, family)
    )
  }
  return protectedMessages as TanStackMessages
}
