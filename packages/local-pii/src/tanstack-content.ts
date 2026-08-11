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
  return Object.freeze(
    path.map((part) =>
      typeof part === "number" && Number.isSafeInteger(part) && part >= 0
        ? part
        : typeof part === "string" && SAFE_SEGMENTS.has(part)
          ? part
          : "<field>"
    )
  )
}

function printPath(path: Path): string {
  return path.reduce<string>(
    (result, part) =>
      typeof part === "number"
        ? `${result}[${part}]`
        : SAFE_SEGMENTS.has(part)
          ? `${result}.${part}`
          : `${result}["<field>"]`,
    "$"
  )
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
}

function objectLike(value: unknown): value is object {
  return value !== null && typeof value === "object"
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
      descriptors.push([key, Object.freeze({ ...descriptor })])
    }
    return Object.freeze({
      prototype,
      array: Array.isArray(value),
      descriptors: Object.freeze(descriptors),
    })
  } catch {
    return fail(path, "<invalid>")
  }
}

function keyOf(key: PropertyKey): PropertyKey {
  return typeof key === "number" ? String(key) : key
}

function descriptor(
  record: Captured,
  key: PropertyKey
): PropertyDescriptor | undefined {
  const wanted = keyOf(key)
  return record.descriptors.find(([candidate]) => candidate === wanted)?.[1]
}

type Field =
  | { readonly kind: "missing" }
  | { readonly kind: "accessor" }
  | { readonly kind: "data"; readonly value: unknown }

function field(record: Captured, key: PropertyKey, path: Path): Field {
  const found = descriptor(record, key)
  if (!found) return { kind: "missing" }
  if (!("value" in found)) return fail(path, "<accessor>")
  return { kind: "data", value: found.value }
}

function required(record: Captured, key: PropertyKey, path: Path): unknown {
  const result = field(record, key, path)
  if (result.kind !== "data") return fail(path, "<missing>")
  return result.value
}

function optional(record: Captured, key: PropertyKey, path: Path): Field {
  return field(record, key, path)
}

function cloneRecord(
  record: Captured,
  overrides: ReadonlyMap<PropertyKey, unknown>,
  path: Path
): object {
  try {
    const target = record.array ? [] : Object.create(record.prototype)
    if (record.array) Object.setPrototypeOf(target, record.prototype)
    const define = (key: PropertyKey, original: PropertyDescriptor) => {
      const normalized = keyOf(key)
      const replacement = overrides.has(normalized)
        ? { ...original, value: overrides.get(normalized) }
        : original
      Object.defineProperty(target, key, replacement)
    }
    for (const [key, original] of record.descriptors) {
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
  | { readonly kind: "tool-call-incomplete"; readonly template: Captured }
  | {
      readonly kind: "tool-call"
      readonly template: Captured
      readonly args: PreparedJson
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
    const input = optional(template, "input", [...path, "input"])
    const output = optional(template, "output", [...path, "output"])
    const incomplete = state === "awaiting-input" || state === "input-streaming"
    if (
      incomplete &&
      (output.kind === "missing" ||
        (output.kind === "data" && output.value === undefined))
    )
      return { kind: "tool-call-incomplete", template }
    return {
      kind,
      template,
      args: strictJson(argumentsValue, [...path, "arguments"]),
      ...(input.kind === "data"
        ? { input: captureJson(input.value, [...path, "input"]) }
        : {}),
      ...(output.kind === "data"
        ? { output: captureJson(output.value, [...path, "output"]) }
        : {}),
    }
  }
  const content = required(template, "content", [...path, "content"])
  const preparedContent =
    typeof content === "string"
      ? freeform(content, [...path, "content"])
      : Array.isArray(content)
        ? prepareParts(content, [...path, "content"], "model", true)
        : fail([...path, "content"], "<invalid>")
  const error = optional(template, "error", [...path, "error"])
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
  const ui = !!id && "value" in id && !!parts && "value" in parts
  const model =
    !!content &&
    (("value" in content &&
      (typeof content.value === "string" ||
        content.value === null ||
        Array.isArray(content.value))) ||
      (!ui && !("value" in content)))
  return { ui, model }
}

function classify(records: readonly Captured[]): Family {
  let candidate: Family | undefined
  let ambiguous = false
  records.forEach((record, index) => {
    const current = shape(record)
    const family =
      current.ui === current.model ? undefined : current.ui ? "ui" : "model"
    if (!family) {
      ambiguous = true
      return
    }
    if (candidate && candidate !== family) return fail([index], "<unsupported>")
    candidate = family
  })
  if (candidate) return candidate
  return fail([], ambiguous ? "<ambiguous>" : "<unsupported>")
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
  const toolCalls = optional(record, "toolCalls", [index, "toolCalls"])
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
    for (const item of value)
      output.push(await protectPreparedJson(session, item))
    Object.setPrototypeOf(output, null)
    return Object.freeze(output) as JsonArray
  }
  const output = Object.create(null) as JsonObject
  const objectValue = value as JsonObject
  for (const key of Object.keys(objectValue))
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      writable: false,
      value: await protectPreparedJson(session, objectValue[key]!),
    })
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
      await renderPart(session, plan.items[index]!, [...path, index])
    )
  return cloneRecord(plan.template, overrides, path)
}

async function renderPart(
  session: PiiSession,
  plan: PreparedPart,
  path: Path
): Promise<object> {
  if (plan.kind === "opaque" || plan.kind === "tool-call-incomplete")
    return cloneRecord(plan.template, new Map(), path)
  if (plan.kind === "text")
    return cloneRecord(
      plan.template,
      new Map([["content", await protectText(session, plan.text)]]),
      path
    )
  if (plan.kind === "freeform-text")
    return cloneRecord(
      plan.template,
      new Map([["content", await renderFreeform(session, plan.value)]]),
      path
    )
  if (plan.kind === "structured-fallback")
    return cloneRecord(
      plan.template,
      new Map([
        ["raw", JSON.stringify(await protectPreparedJson(session, plan.json))],
      ]),
      path
    )
  if (plan.kind === "tool-call") {
    const overrides = new Map<PropertyKey, unknown>([
      [
        "arguments",
        JSON.stringify(await protectPreparedJson(session, plan.args)),
      ],
    ])
    if (plan.input !== undefined)
      overrides.set("input", await protectPreparedJson(session, plan.input))
    if (plan.output !== undefined)
      overrides.set("output", await protectPreparedJson(session, plan.output))
    return cloneRecord(plan.template, overrides, path)
  }
  const content = isFreeform(plan.content)
    ? await renderFreeform(session, plan.content)
    : await renderParts(session, plan.content, [...path, "content"])
  const overrides = new Map<PropertyKey, unknown>([["content", content]])
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
    const functionValue = cloneRecord(
      item.functionTemplate,
      new Map([
        [
          "arguments",
          JSON.stringify(await protectPreparedJson(session, item.args)),
        ],
      ]),
      [...path, index, "function"]
    )
    overrides.set(
      String(index),
      cloneRecord(item.template, new Map([["function", functionValue]]), [
        ...path,
        index,
      ])
    )
  }
  return cloneRecord(plan.template, overrides, path)
}

async function renderMessage(
  session: PiiSession,
  plan: PreparedMessage,
  index: number
): Promise<object> {
  if (plan.family === "ui")
    return cloneRecord(
      plan.template,
      new Map([
        ["parts", await renderParts(session, plan.parts, [index, "parts"])],
      ]),
      [index]
    )
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
  const plan = captureMessages(messages)
  const overrides = new Map<PropertyKey, unknown>()
  for (let index = 0; index < plan.items.length; index += 1)
    overrides.set(
      String(index),
      await renderMessage(session, plan.items[index]!, index)
    )
  return cloneRecord(plan.template, overrides, []) as TanStackMessages
}
