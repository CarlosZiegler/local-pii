import type {
  ContentPart,
  MessagePart,
  ModelMessage,
  UIMessage,
} from "@tanstack/ai/client"
import type { PiiSession } from "./session"

type TanStackMessages = Array<UIMessage> | Array<ModelMessage>
type Path = readonly (string | number)[]
type Family = "ui" | "model"
type Policy = "text" | "opaque" | "structured" | "tool-call" | "tool-result"
type ModelPartType = ContentPart["type"]
type UiPartType = MessagePart["type"]

/** Exhaustive pinned protocol policy. Additions to either public union fail here. */
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
    "structured-output": "structured",
    "ui-resource": "opaque",
  },
} as const satisfies {
  model: Record<ModelPartType, Policy>
  ui: Record<UiPartType, Policy>
}

const MAX_JSON_DEPTH = 128
const SAFE_SEGMENTS = new Set([
  "id",
  "role",
  "type",
  "content",
  "parts",
  "toolCalls",
  "function",
  "arguments",
  "input",
  "output",
  "data",
  "raw",
  "error",
  "status",
  "state",
])
const SAFE_REASONS = new Set([
  "<accessor>",
  "<ambiguous>",
  "<cycle>",
  "<depth>",
  "<invalid>",
  "<invalid-json>",
  "<missing>",
  "<missing-data>",
  "<unsupported>",
])

function safeReason(reason: unknown): string {
  return typeof reason === "string" && SAFE_REASONS.has(reason)
    ? reason
    : "<unsupported>"
}

function safePath(path: Path): Path {
  const cleaned: Array<string | number> = []
  Object.setPrototypeOf(cleaned, SAFE_ARRAY_PROTOTYPE)
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index]
    cleaned.push(
      typeof part === "number" && Number.isSafeInteger(part) && part >= 0
        ? part
        : typeof part === "string" && SAFE_SEGMENTS.has(part)
          ? part
          : "<field>"
    )
  }
  return Object.freeze(cleaned)
}

function printPath(path: Path): string {
  let result = "$"
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index]
    result =
      typeof part === "number"
        ? `${result}[${part}]`
        : typeof part === "string" && SAFE_SEGMENTS.has(part)
          ? `${result}.${part}`
          : `${result}["<field>"]`
  }
  return result
}

/** Safe public error for unsupported semantic protocol input. */
export class UnsupportedTanStackSemanticContentError extends Error {
  override readonly name = "UnsupportedTanStackSemanticContentError"
  readonly path: Path
  readonly discriminant: string

  constructor(path: Path, discriminant: string) {
    const cleanedPath = safePath(path)
    const cleanedReason = safeReason(discriminant)
    super(
      `Unsupported TanStack semantic content at ${printPath(cleanedPath)}: ${cleanedReason}`
    )
    this.path = cleanedPath
    this.discriminant = cleanedReason
  }
}

function fail(path: Path, reason = "<unsupported>"): never {
  throw new UnsupportedTanStackSemanticContentError(path, safeReason(reason))
}

type DescriptorEntry = readonly [PropertyKey, PropertyDescriptor]
interface Captured {
  readonly prototype: object | null
  readonly array: boolean
  readonly descriptors: readonly DescriptorEntry[]
  readonly lookup: ReadonlyMap<PropertyKey, PropertyDescriptor>
}

function objectLike(value: unknown): value is object {
  return value !== null && typeof value === "object"
}

function hasToJSON(prototype: object | null): boolean {
  const seen = new WeakSet<object>()
  let current = prototype
  while (current !== null) {
    if (seen.has(current)) return true
    seen.add(current)
    if (Object.getOwnPropertyDescriptor(current, "toJSON")) return true
    current = Object.getPrototypeOf(current)
  }
  return false
}

function capture(value: unknown, path: Path): Captured {
  if (!objectLike(value)) return fail(path, "<invalid>")
  try {
    const prototype = Object.getPrototypeOf(value)
    const raw = Object.getOwnPropertyDescriptors(value)
    const descriptors: DescriptorEntry[] = []
    const descriptorMap = raw as Record<PropertyKey, PropertyDescriptor>
    for (const key of Reflect.ownKeys(raw)) {
      const descriptor = descriptorMap[key]
      if (!descriptor) return fail(path, "<invalid>")
      if (!("value" in descriptor))
        return fail(descriptorPath(path, key), "<accessor>")
      descriptors.push([key, Object.freeze({ ...descriptor })])
    }
    if (
      Object.prototype.hasOwnProperty.call(raw, "toJSON") ||
      hasToJSON(prototype)
    )
      return fail(path, "<unsupported>")
    const lookup = new Map<PropertyKey, PropertyDescriptor>()
    for (const [key, descriptor] of descriptors)
      lookup.set(keyOf(key), descriptor)
    return Object.freeze({
      prototype,
      array: Array.isArray(value),
      descriptors: Object.freeze(descriptors),
      lookup,
    })
  } catch (error) {
    if (error instanceof UnsupportedTanStackSemanticContentError) throw error
    return fail(path, "<invalid>")
  }
}

function keyOf(key: PropertyKey): PropertyKey {
  return typeof key === "number" ? String(key) : key
}

function descriptorPath(path: Path, key: PropertyKey): Path {
  if (typeof key === "string" && SAFE_SEGMENTS.has(key)) return [...path, key]
  if (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key)) {
    const index = Number(key)
    if (Number.isSafeInteger(index) && index >= 0) return [...path, index]
  }
  return [...path, "<field>"]
}

function descriptor(
  record: Captured,
  key: PropertyKey
): PropertyDescriptor | undefined {
  const wanted = keyOf(key)
  return record.lookup.get(wanted)
}

type Field =
  | { readonly kind: "missing" }
  | { readonly kind: "data"; readonly value: unknown }

function field(record: Captured, key: PropertyKey): Field {
  const found = descriptor(record, key)
  if (!found) return { kind: "missing" }
  return { kind: "data", value: found.value }
}

function required(record: Captured, key: PropertyKey, path: Path): unknown {
  const result = field(record, key)
  if (result.kind !== "data") return fail(path, "<missing>")
  return result.value
}

function optional(record: Captured, key: PropertyKey): Field {
  return field(record, key)
}

interface ArrayPrototypeFingerprint {
  readonly prototype: object
  readonly keys: readonly PropertyKey[]
  readonly descriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>
}

function snapshotArrayPrototype(): ArrayPrototypeFingerprint | null {
  try {
    const prototype = Array.prototype as object
    const keys = Reflect.ownKeys(prototype)
    const descriptors = new Map<PropertyKey, PropertyDescriptor>()
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
      if (!descriptor) return null
      descriptors.set(key, Object.freeze({ ...descriptor }))
    }
    return Object.freeze({
      prototype,
      keys: Object.freeze(keys),
      descriptors,
    })
  } catch {
    return null
  }
}

const ARRAY_PROTOTYPE_BASELINE = snapshotArrayPrototype()

function sameDescriptor(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined
): boolean {
  if (!left || !right) return false
  if (
    left.configurable !== right.configurable ||
    left.enumerable !== right.enumerable
  )
    return false
  if ("value" in left !== "value" in right) return false
  if ("value" in left && "value" in right)
    return left.writable === right.writable && left.value === right.value
  return left.get === right.get && left.set === right.set
}

function arrayPrototypeMatchesBaseline(): boolean {
  const baseline = ARRAY_PROTOTYPE_BASELINE
  const current = snapshotArrayPrototype()
  if (!baseline || !current || baseline.prototype !== current.prototype)
    return false
  if (baseline.keys.length !== current.keys.length) return false
  for (let index = 0; index < baseline.keys.length; index += 1) {
    const key = baseline.keys[index]
    if (key !== current.keys[index]) return false
    if (
      !sameDescriptor(
        baseline.descriptors.get(key!),
        current.descriptors.get(key!)
      )
    )
      return false
  }
  return true
}

function assertArrayPrototypeStable(): void {
  if (!arrayPrototypeMatchesBaseline()) fail([], "<invalid>")
}

export function assertTanStackArrayPrototypeStable(): void {
  assertArrayPrototypeStable()
}

const SAFE_ARRAY_PROTOTYPE = (() => {
  const prototype = Object.create(null) as object
  const baseline = ARRAY_PROTOTYPE_BASELINE
  if (baseline)
    for (let index = 0; index < baseline.keys.length; index += 1) {
      const key = baseline.keys[index]!
      if (key === "length" || key === "toJSON") continue
      const descriptor = baseline.descriptors.get(key)
      if (!descriptor) continue
      if (!("value" in descriptor)) continue
      if (typeof descriptor.value !== "function") continue
      Object.defineProperty(prototype, key, {
        configurable: false,
        enumerable: descriptor.enumerable,
        writable: false,
        value: descriptor.value,
      })
    }
  Object.defineProperty(prototype, "toJSON", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: undefined,
  })
  return Object.freeze(prototype)
})()

function appendPath(
  path: Path,
  ...segments: readonly (string | number)[]
): Path {
  const result: Array<string | number> = []
  Object.setPrototypeOf(result, SAFE_ARRAY_PROTOTYPE)
  for (let index = 0; index < path.length; index += 1) result.push(path[index]!)
  for (let index = 0; index < segments.length; index += 1)
    result.push(segments[index]!)
  return result
}

function cloneRecord(
  record: Captured,
  overrides: ReadonlyMap<PropertyKey, unknown>,
  path: Path
): object {
  try {
    const target = record.array ? [] : Object.create(null)
    if (record.array) Object.setPrototypeOf(target, SAFE_ARRAY_PROTOTYPE)
    const define = (key: PropertyKey, original: PropertyDescriptor) => {
      const normalized = keyOf(key)
      const replacement = overrides.has(normalized)
        ? { ...original, value: overrides.get(normalized) }
        : original
      Object.defineProperty(target, key, replacement)
    }
    for (let index = 0; index < record.descriptors.length; index += 1) {
      const entry = record.descriptors[index]!
      const key = entry[0]
      const original = entry[1]
      if (record.array && key === "length") continue
      define(key, original)
    }
    const length = descriptor(record, "length")
    if (record.array && length) define("length", length)
    return target
  } catch {
    return fail(path, "<invalid>")
  }
}

interface CapturedArray {
  readonly record: Captured
  readonly values: readonly unknown[]
}

function captureArray(value: unknown, path: Path): CapturedArray {
  const record = capture(value, path)
  if (!record.array) return fail(path, "<invalid>")
  const length = descriptor(record, "length")
  if (
    !length ||
    !("value" in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  )
    return fail(path, "<invalid>")
  for (const [key, item] of record.descriptors) {
    if (key === "length") continue
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9]\d*)$/.test(key) ||
      Number(key) >= length.value ||
      !Number.isSafeInteger(Number(key)) ||
      !("value" in item)
    )
      return fail(descriptorPath(path, key), "<invalid>")
  }
  const values: unknown[] = []
  for (let index = 0; index < length.value; index += 1) {
    const item = descriptor(record, index)
    if (!item) return fail([...path, index], "<missing>")
    if (!("value" in item)) return fail([...path, index], "<accessor>")
    values.push(item.value)
  }
  return Object.freeze({ record, values: Object.freeze(values) })
}

type PreparedJson = null | boolean | number | string | JsonObject | JsonArray
interface JsonObject {
  readonly [key: string]: PreparedJson
}
interface JsonArray {
  readonly length: number
  readonly [index: number]: PreparedJson
}

function jsonPath(path: Path): Path {
  return [...path, "<field>"]
}

function jsonValuePath(path: Path): Path {
  return path[path.length - 1] === "<field>" ? path : jsonPath(path)
}

function captureJson(
  value: unknown,
  path: Path,
  depth = 0,
  active = new WeakSet<object>()
): PreparedJson {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value
  if (typeof value === "number")
    return Number.isFinite(value)
      ? value
      : fail(jsonValuePath(path), "<invalid-json>")
  if (!objectLike(value)) return fail(jsonValuePath(path), "<invalid-json>")
  if (depth > MAX_JSON_DEPTH) return fail(path, "<depth>")
  if (active.has(value)) return fail(path, "<cycle>")
  active.add(value)
  try {
    const record = capture(value, path)
    if (record.array) {
      if (record.prototype !== null && record.prototype !== Array.prototype)
        return fail(path, "<invalid-json>")
      const length = descriptor(record, "length")
      if (
        !length ||
        !("value" in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0
      )
        return fail(path, "<invalid-json>")
      for (const [key, item] of record.descriptors) {
        if (key === "length") continue
        if (
          typeof key !== "string" ||
          !/^\d+$/.test(key) ||
          Number(key) >= length.value
        )
          return fail(jsonPath(path), "<invalid-json>")
        if (!item.enumerable || !("value" in item))
          return fail(jsonPath(path), "<accessor>")
      }
      const output: PreparedJson[] = []
      for (let index = 0; index < length.value; index += 1) {
        const item = descriptor(record, index)
        if (!item) return fail([...path, index], "<invalid-json>")
        if (!item.enumerable || !("value" in item))
          return fail([...path, index], "<accessor>")
        output.push(
          captureJson(item.value, [...path, index], depth + 1, active)
        )
      }
      Object.setPrototypeOf(output, null)
      return Object.freeze(output) as JsonArray
    }
    if (record.prototype !== null && record.prototype !== Object.prototype)
      return fail(path, "<invalid-json>")
    const output = Object.create(null) as JsonObject
    for (const [key, item] of record.descriptors) {
      if (typeof key !== "string" || key === "toJSON")
        return fail(jsonPath(path), "<invalid-json>")
      if (!item.enumerable || !("value" in item))
        return fail(jsonPath(path), "<accessor>")
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        writable: false,
        value: captureJson(item.value, jsonPath(path), depth + 1, active),
      })
    }
    return Object.freeze(output)
  } finally {
    active.delete(value)
  }
}

function strictJson(text: string, path: Path): PreparedJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return fail(path, "<invalid-json>")
    throw error
  }
  return captureJson(parsed, path)
}

type PreparedToolArguments =
  | { readonly kind: "json"; readonly value: PreparedJson }
  | { readonly kind: "partial" }

function partialJson(text: string, path: Path): PreparedToolArguments {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: "partial" }
    throw error
  }
  return { kind: "json", value: captureJson(parsed, path) }
}

type Freeform =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "json"; readonly value: PreparedJson }

function freeform(text: string, path: Path): Freeform {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError)
      return Object.freeze({ kind: "text", value: text })
    throw error
  }
  return Object.freeze({ kind: "json", value: captureJson(parsed, path) })
}

type PreparedPart =
  | { readonly kind: "opaque"; readonly template: Captured }
  | {
      readonly kind: "text"
      readonly template: Captured
      readonly text: string
    }
  | {
      readonly kind: "freeform-text"
      readonly template: Captured
      readonly value: Freeform
    }
  | {
      readonly kind: "structured-fallback"
      readonly template: Captured
      readonly json: PreparedJson
    }
  | {
      readonly kind: "tool-call"
      readonly template: Captured
      readonly args: PreparedToolArguments
      readonly input?: PreparedJson
      readonly output?: PreparedJson
    }
  | {
      readonly kind: "tool-result"
      readonly template: Captured
      readonly content: Freeform | PreparedPartList
      readonly error?: string
    }
interface PreparedPartList {
  readonly template: Captured
  readonly items: readonly PreparedPart[]
}

function policy(family: Family, type: unknown): Policy | undefined {
  if (typeof type !== "string") return undefined
  const table = PART_POLICY[family]
  return Object.prototype.hasOwnProperty.call(table, type)
    ? table[type as keyof typeof table]
    : undefined
}

function prepareParts(
  value: unknown,
  path: Path,
  family: Family,
  jsonText: boolean
): PreparedPartList {
  const captured = captureArray(value, path)
  return Object.freeze({
    template: captured.record,
    items: Object.freeze(
      captured.values.map((item, index) =>
        Object.freeze(preparePart(item, [...path, index], family, jsonText))
      )
    ),
  })
}

function preparePart(
  value: unknown,
  path: Path,
  family: Family,
  jsonText: boolean
): PreparedPart {
  const template = capture(value, path)
  const type = required(template, "type", [...path, "type"])
  const kind = policy(family, type)
  if (!kind) return fail(path, "<unsupported>")
  if (kind === "opaque") return { kind, template }
  if (kind === "text") {
    const content = required(template, "content", [...path, "content"])
    if (typeof content !== "string")
      return fail([...path, "content"], "<invalid>")
    return jsonText
      ? {
          kind: "freeform-text",
          template,
          value: freeform(content, [...path, "content"]),
        }
      : { kind, template, text: content }
  }
  if (kind === "structured") {
    const status = required(template, "status", [...path, "status"])
    if (status !== "streaming" && status !== "complete" && status !== "error")
      return fail([...path, "status"], "<invalid>")
    if (status !== "complete") return { kind: "opaque", template }
    const raw = required(template, "raw", [...path, "raw"])
    if (typeof raw !== "string") return fail([...path, "raw"], "<invalid>")
    return {
      kind: "structured-fallback",
      template,
      json:
        raw === ""
          ? captureJson(required(template, "data", [...path, "data"]), [
              ...path,
              "data",
            ])
          : strictJson(raw, [...path, "raw"]),
    }
  }
  if (kind === "tool-call") {
    const argumentsValue = required(template, "arguments", [
      ...path,
      "arguments",
    ])
    if (typeof argumentsValue !== "string")
      return fail([...path, "arguments"], "<invalid>")
    const state = required(template, "state", [...path, "state"])
    const validState =
      state === "awaiting-input" ||
      state === "input-streaming" ||
      state === "input-complete" ||
      state === "approval-requested" ||
      state === "approval-responded" ||
      state === "complete" ||
      state === "error"
    if (!validState) return fail([...path, "state"], "<invalid>")
    const input = optional(template, "input")
    const output = optional(template, "output")
    const preparedInput =
      input.kind === "data" && input.value !== undefined
        ? captureJson(input.value, [...path, "input"])
        : undefined
    const preparedOutput =
      output.kind === "data" && output.value !== undefined
        ? captureJson(output.value, [...path, "output"])
        : undefined
    const partialState =
      state === "awaiting-input" || state === "input-streaming"
    return {
      kind,
      template,
      args: partialState
        ? partialJson(argumentsValue, [...path, "arguments"])
        : {
            kind: "json",
            value: strictJson(argumentsValue, [...path, "arguments"]),
          },
      ...(preparedInput !== undefined ? { input: preparedInput } : {}),
      ...(preparedOutput !== undefined ? { output: preparedOutput } : {}),
    }
  }
  const content = required(template, "content", [...path, "content"])
  const preparedContent =
    typeof content === "string"
      ? freeform(content, [...path, "content"])
      : Array.isArray(content)
        ? prepareParts(content, [...path, "content"], "model", true)
        : fail([...path, "content"], "<invalid>")
  const error = optional(template, "error")
  if (
    error.kind === "data" &&
    error.value !== undefined &&
    typeof error.value !== "string"
  )
    return fail([...path, "error"], "<invalid>")
  return {
    kind,
    template,
    content: preparedContent,
    ...(error.kind === "data" && typeof error.value === "string"
      ? { error: error.value }
      : {}),
  }
}

interface PreparedToolCall {
  readonly template: Captured
  readonly functionTemplate: Captured
  readonly args: PreparedJson
}
interface PreparedToolCalls {
  readonly template: Captured
  readonly items: readonly PreparedToolCall[]
}

function prepareToolCalls(value: unknown, path: Path): PreparedToolCalls {
  const captured = captureArray(value, path)
  const items = captured.values.map((item, index) => {
    const template = capture(item, [...path, index])
    const functionValue = required(template, "function", [
      ...path,
      index,
      "function",
    ])
    const functionTemplate = capture(functionValue, [
      ...path,
      index,
      "function",
    ])
    const args = required(functionTemplate, "arguments", [
      ...path,
      index,
      "function",
      "arguments",
    ])
    if (typeof args !== "string")
      return fail([...path, index, "function", "arguments"], "<invalid>")
    return Object.freeze({
      template,
      functionTemplate,
      args: strictJson(args, [...path, index, "function", "arguments"]),
    })
  })
  return Object.freeze({
    template: captured.record,
    items: Object.freeze(items),
  })
}

type PreparedMessage =
  | {
      readonly family: "ui"
      readonly template: Captured
      readonly parts: PreparedPartList
    }
  | {
      readonly family: "model"
      readonly template: Captured
      readonly content: string | null | Freeform | PreparedPartList
      readonly toolCalls?: PreparedToolCalls
    }
interface PreparedMessages {
  readonly template: Captured
  readonly items: readonly PreparedMessage[]
}

function shape(record: Captured): { ui: boolean; model: boolean } {
  const id = descriptor(record, "id")
  const parts = descriptor(record, "parts")
  const content = descriptor(record, "content")
  const ui = !!id && !!parts
  // Presence is the model signal even for an accessor or malformed value.
  // Otherwise a UI parts array could preserve a live fallback getter that
  // the pinned wire serializer would read after this phase.
  const model = !!content
  return { ui, model }
}

function classify(records: readonly Captured[]): Family {
  let candidate: Family | undefined
  let ambiguousIndex: number | undefined
  // A record that matches both structural families wins neither: reject it
  // after scanning so a later unambiguous record cannot reinterpret it.
  records.forEach((record, index) => {
    const current = shape(record)
    const family =
      current.ui === current.model ? undefined : current.ui ? "ui" : "model"
    if (!family) {
      ambiguousIndex ??= index
      return
    }
    if (candidate && candidate !== family) return fail([index], "<unsupported>")
    candidate = family
  })
  if (ambiguousIndex !== undefined) return fail([ambiguousIndex], "<ambiguous>")
  if (candidate) return candidate
  return fail([], "<unsupported>")
}

function prepareMessage(
  record: Captured,
  index: number,
  family: Family
): PreparedMessage {
  const role = required(record, "role", [index, "role"])
  if (family === "ui") {
    const id = required(record, "id", [index, "id"])
    if (typeof id !== "string") return fail([index, "id"], "<invalid>")
    if (role !== "system" && role !== "user" && role !== "assistant")
      return fail([index, "role"], "<invalid>")
    return {
      family,
      template: record,
      parts: prepareParts(
        required(record, "parts", [index, "parts"]),
        [index, "parts"],
        "ui",
        false
      ),
    }
  }
  if (role !== "user" && role !== "assistant" && role !== "tool")
    return fail([index, "role"], "<invalid>")
  const content = required(record, "content", [index, "content"])
  const prepared =
    typeof content === "string"
      ? role === "tool"
        ? freeform(content, [index, "content"])
        : content
      : content === null
        ? null
        : Array.isArray(content)
          ? prepareParts(content, [index, "content"], "model", role === "tool")
          : fail([index, "content"], "<invalid>")
  const toolCalls = optional(record, "toolCalls")
  return {
    family,
    template: record,
    content: prepared,
    ...(toolCalls.kind === "data" && toolCalls.value !== undefined
      ? { toolCalls: prepareToolCalls(toolCalls.value, [index, "toolCalls"]) }
      : {}),
  }
}

/** The sole caller-object phase: captures and compiles the complete graph synchronously. */
function captureMessages(messages: TanStackMessages): PreparedMessages {
  const root = captureArray(messages, [])
  const records = root.values.map((value, index) => capture(value, [index]))
  if (records.length === 0)
    return Object.freeze({ template: root.record, items: Object.freeze([]) })
  const family = classify(records)
  return Object.freeze({
    template: root.record,
    items: Object.freeze(
      records.map((record, index) =>
        Object.freeze(prepareMessage(record, index, family))
      )
    ),
  })
}

async function protectText(session: PiiSession, text: string): Promise<string> {
  if (!text) return text
  return (await session.anonymize(text)).redactedText
}

async function protectPreparedJson(
  session: PiiSession,
  value: PreparedJson
): Promise<PreparedJson> {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value
  if (typeof value === "string") return protectText(session, value)
  if (Array.isArray(value)) {
    const output: PreparedJson[] = []
    Object.setPrototypeOf(output, SAFE_ARRAY_PROTOTYPE)
    for (let index = 0; index < value.length; index += 1)
      output.push(await protectPreparedJson(session, value[index]!))
    return Object.freeze(output) as JsonArray
  }
  const output = Object.create(null) as JsonObject
  const objectValue = value as JsonObject
  const keys = Object.keys(objectValue)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      writable: false,
      value: await protectPreparedJson(session, objectValue[key]!),
    })
  }
  return Object.freeze(output)
}

function isFreeform(value: Freeform | PreparedPartList): value is Freeform {
  return "kind" in value
}

async function renderFreeform(
  session: PiiSession,
  value: Freeform
): Promise<string> {
  return value.kind === "text"
    ? protectText(session, value.value)
    : JSON.stringify(await protectPreparedJson(session, value.value))
}

async function renderParts(
  session: PiiSession,
  plan: PreparedPartList,
  path: Path
): Promise<object> {
  const overrides = new Map<PropertyKey, unknown>()
  for (let index = 0; index < plan.items.length; index += 1)
    overrides.set(
      String(index),
      await renderPart(session, plan.items[index]!, appendPath(path, index))
    )
  return cloneRecord(plan.template, overrides, path)
}

async function renderPart(
  session: PiiSession,
  plan: PreparedPart,
  path: Path
): Promise<object> {
  if (plan.kind === "opaque") return cloneRecord(plan.template, new Map(), path)
  if (plan.kind === "text") {
    const overrides = new Map<PropertyKey, unknown>()
    overrides.set("content", await protectText(session, plan.text))
    return cloneRecord(plan.template, overrides, path)
  }
  if (plan.kind === "freeform-text") {
    const overrides = new Map<PropertyKey, unknown>()
    overrides.set("content", await renderFreeform(session, plan.value))
    return cloneRecord(plan.template, overrides, path)
  }
  if (plan.kind === "structured-fallback") {
    const overrides = new Map<PropertyKey, unknown>()
    overrides.set(
      "raw",
      JSON.stringify(await protectPreparedJson(session, plan.json))
    )
    return cloneRecord(plan.template, overrides, path)
  }
  if (plan.kind === "tool-call") {
    const overrides = new Map<PropertyKey, unknown>()
    overrides.set(
      "arguments",
      plan.args.kind === "partial"
        ? ""
        : JSON.stringify(await protectPreparedJson(session, plan.args.value))
    )
    if (plan.input !== undefined)
      overrides.set("input", await protectPreparedJson(session, plan.input))
    if (plan.output !== undefined)
      overrides.set("output", await protectPreparedJson(session, plan.output))
    return cloneRecord(plan.template, overrides, path)
  }
  const content = isFreeform(plan.content)
    ? await renderFreeform(session, plan.content)
    : await renderParts(session, plan.content, appendPath(path, "content"))
  const overrides = new Map<PropertyKey, unknown>()
  overrides.set("content", content)
  if (plan.error !== undefined)
    overrides.set("error", await protectText(session, plan.error))
  return cloneRecord(plan.template, overrides, path)
}

async function renderToolCalls(
  session: PiiSession,
  plan: PreparedToolCalls,
  path: Path
): Promise<object> {
  const overrides = new Map<PropertyKey, unknown>()
  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index]!
    const functionOverrides = new Map<PropertyKey, unknown>()
    functionOverrides.set(
      "arguments",
      JSON.stringify(await protectPreparedJson(session, item.args))
    )
    const functionValue = cloneRecord(
      item.functionTemplate,
      functionOverrides,
      appendPath(path, index, "function")
    )
    const itemOverrides = new Map<PropertyKey, unknown>()
    itemOverrides.set("function", functionValue)
    overrides.set(
      String(index),
      cloneRecord(item.template, itemOverrides, appendPath(path, index))
    )
  }
  return cloneRecord(plan.template, overrides, path)
}

async function renderMessage(
  session: PiiSession,
  plan: PreparedMessage,
  index: number
): Promise<object> {
  if (plan.family === "ui") {
    const overrides = new Map<PropertyKey, unknown>()
    overrides.set(
      "parts",
      await renderParts(session, plan.parts, [index, "parts"])
    )
    return cloneRecord(plan.template, overrides, [index])
  }
  const overrides = new Map<PropertyKey, unknown>()
  if (typeof plan.content === "string")
    overrides.set("content", await protectText(session, plan.content))
  else if (plan.content === null) overrides.set("content", null)
  else if (isFreeform(plan.content))
    overrides.set("content", await renderFreeform(session, plan.content))
  else
    overrides.set(
      "content",
      await renderParts(session, plan.content, [index, "content"])
    )
  if (plan.toolCalls)
    overrides.set(
      "toolCalls",
      await renderToolCalls(session, plan.toolCalls, [index, "toolCalls"])
    )
  return cloneRecord(plan.template, overrides, [index])
}

export async function protectTanStackMessages(
  session: PiiSession,
  messages: TanStackMessages
): Promise<TanStackMessages> {
  assertArrayPrototypeStable()
  const plan = captureMessages(messages)
  const overrides = new Map<PropertyKey, unknown>()
  for (let index = 0; index < plan.items.length; index += 1)
    overrides.set(
      String(index),
      await renderMessage(session, plan.items[index]!, index)
    )
  const protectedMessages = cloneRecord(
    plan.template,
    overrides,
    []
  ) as TanStackMessages
  assertArrayPrototypeStable()
  return protectedMessages
}
