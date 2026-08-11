import type {
  ContentPart,
  MessagePart,
  ModelMessage,
  UIMessage,
} from "@tanstack/ai/client"
import type { PiiSession } from "./session"

const TRUSTED = {
  arrayIsArray: Array.isArray,
  arrayPrototype: Array.prototype,
  objectPrototype: Object.prototype,
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
  objectCreate: Object.create,
  objectDefineProperty: Object.defineProperty,
  objectFreeze: Object.freeze,
  objectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
  objectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
  objectGetPrototypeOf: Object.getPrototypeOf,
  objectKeys: Object.keys,
  objectSetPrototypeOf: Object.setPrototypeOf,
  ownKeys: Reflect.ownKeys,
  reflectApply: Reflect.apply,
  hasOwnProperty: Object.prototype.hasOwnProperty,
  mapConstructor: Map,
  mapSet: Map.prototype.set,
  mapGet: Map.prototype.get,
  mapHas: Map.prototype.has,
  setConstructor: Set,
  setHas: Set.prototype.has,
  weakSetConstructor: WeakSet,
  weakSetAdd: WeakSet.prototype.add,
  weakSetHas: WeakSet.prototype.has,
  weakSetDelete: WeakSet.prototype.delete,
  string: String,
} as const

function trustedApply<T>(
  fn: (...args: never[]) => T,
  receiver: unknown,
  args: readonly unknown[]
): T {
  return TRUSTED.reflectApply(fn, receiver, args) as T
}

function trustedMapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  trustedApply(TRUSTED.mapSet, map, [key, value])
}

function trustedMapGet<K, V>(map: ReadonlyMap<K, V>, key: K): V | undefined {
  return trustedApply(TRUSTED.mapGet, map, [key])
}

function trustedMapHas<K, V>(map: ReadonlyMap<K, V>, key: K): boolean {
  return trustedApply(TRUSTED.mapHas, map, [key])
}

function trustedSetHas<T>(set: ReadonlySet<T>, value: T): boolean {
  return trustedApply(TRUSTED.setHas, set, [value])
}

function trustedWeakSetAdd<T extends object>(set: WeakSet<T>, value: T): void {
  trustedApply(TRUSTED.weakSetAdd, set, [value])
}

function trustedWeakSetHas<T extends object>(
  set: WeakSet<T>,
  value: T
): boolean {
  return trustedApply(TRUSTED.weakSetHas, set, [value])
}

function trustedWeakSetDelete<T extends object>(
  set: WeakSet<T>,
  value: T
): void {
  trustedApply(TRUSTED.weakSetDelete, set, [value])
}

function freezeDetachedRecord<T extends object>(value: T): T {
  const detached = TRUSTED.objectCreate(null) as T
  const descriptors = TRUSTED.objectGetOwnPropertyDescriptors(value)
  const keys = TRUSTED.ownKeys(descriptors)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!
    TRUSTED.objectDefineProperty(
      detached,
      key,
      descriptors[key as keyof typeof descriptors] as PropertyDescriptor
    )
  }
  return TRUSTED.objectFreeze(detached)
}

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
const SAFE_SEGMENTS = new TRUSTED.setConstructor([
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
const SAFE_REASONS = new TRUSTED.setConstructor([
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
  return typeof reason === "string" && trustedSetHas(SAFE_REASONS, reason)
    ? reason
    : "<unsupported>"
}

function safePath(path: Path): Path {
  const cleaned: Array<string | number> = []
  TRUSTED.objectSetPrototypeOf(cleaned, SAFE_ARRAY_PROTOTYPE)
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index]
    cleaned[index] =
      typeof part === "number" && Number.isSafeInteger(part) && part >= 0
        ? part
        : typeof part === "string" && trustedSetHas(SAFE_SEGMENTS, part)
          ? part
          : "<field>"
  }
  return TRUSTED.objectFreeze(cleaned)
}

function printPath(path: Path): string {
  let result = "$"
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index]
    result =
      typeof part === "number"
        ? `${result}[${part}]`
        : typeof part === "string" && trustedSetHas(SAFE_SEGMENTS, part)
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
  const seen = new TRUSTED.weakSetConstructor<object>()
  let current = prototype
  while (current !== null) {
    if (trustedWeakSetHas(seen, current)) return true
    trustedWeakSetAdd(seen, current)
    const descriptor = TRUSTED.objectGetOwnPropertyDescriptor(current, "toJSON")
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value === "function")
        return true
      return false
    }
    current = TRUSTED.objectGetPrototypeOf(current)
  }
  return false
}

function capture(value: unknown, path: Path): Captured {
  if (!objectLike(value)) return fail(path, "<invalid>")
  try {
    const prototype = TRUSTED.objectGetPrototypeOf(value)
    const raw = TRUSTED.objectGetOwnPropertyDescriptors(value)
    const descriptors: DescriptorEntry[] = []
    TRUSTED.objectSetPrototypeOf(descriptors, SAFE_ARRAY_PROTOTYPE)
    const descriptorMap = raw as Record<PropertyKey, PropertyDescriptor>
    const keys = TRUSTED.ownKeys(raw)
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!
      const descriptor = descriptorMap[key]
      if (!descriptor) return fail(path, "<invalid>")
      if (!("value" in descriptor))
        return fail(descriptorPath(path, key), "<accessor>")
      const entry = safeArray<
        PropertyKey | PropertyDescriptor
      >() as unknown as [PropertyKey, PropertyDescriptor]
      entry[0] = key
      entry[1] = TRUSTED.objectFreeze({ ...descriptor })
      descriptors[index] = TRUSTED.objectFreeze(entry)
    }
    const ownToJSON = trustedApply(TRUSTED.hasOwnProperty, raw, ["toJSON"])
      ? descriptorMap.toJSON
      : undefined
    if (
      ownToJSON
        ? !("value" in ownToJSON) || typeof ownToJSON.value === "function"
        : hasToJSON(prototype)
    )
      return fail(path, "<unsupported>")
    const lookup = new TRUSTED.mapConstructor<PropertyKey, PropertyDescriptor>()
    for (let index = 0; index < descriptors.length; index += 1) {
      const entry = descriptors[index]!
      trustedMapSet(lookup, keyOf(entry[0]), entry[1])
    }
    return freezeDetachedRecord({
      prototype,
      array: TRUSTED.arrayIsArray(value),
      descriptors: TRUSTED.objectFreeze(descriptors),
      lookup,
    })
  } catch (error) {
    if (error instanceof UnsupportedTanStackSemanticContentError) throw error
    return fail(path, "<invalid>")
  }
}

function keyOf(key: PropertyKey): PropertyKey {
  return typeof key === "number" ? TRUSTED.string(key) : key
}

function descriptorPath(path: Path, key: PropertyKey): Path {
  if (typeof key === "string" && trustedSetHas(SAFE_SEGMENTS, key))
    return appendPath(path, key)
  if (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key)) {
    const index = Number(key)
    if (Number.isSafeInteger(index) && index >= 0)
      return appendPath(path, index)
  }
  return appendPath(path, "<field>")
}

function descriptor(
  record: Captured,
  key: PropertyKey
): PropertyDescriptor | undefined {
  const wanted = keyOf(key)
  return trustedMapGet(record.lookup, wanted)
}

type Field =
  | { readonly kind: "missing" }
  | { readonly kind: "data"; readonly value: unknown }

function field(record: Captured, key: PropertyKey): Field {
  const found = descriptor(record, key)
  if (!found) return freezeDetachedRecord({ kind: "missing" })
  return freezeDetachedRecord({ kind: "data", value: found.value })
}

function required(record: Captured, key: PropertyKey, path: Path): unknown {
  const result = field(record, key)
  if (result.kind !== "data") return fail(path, "<missing>")
  return result.value
}

function optional(record: Captured, key: PropertyKey): Field {
  return field(record, key)
}

interface ArrayPrototypeChainNode {
  readonly value: object
  readonly parent: object | null
  readonly keys: readonly PropertyKey[]
  readonly descriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>
}

interface ArrayPrototypeFingerprint {
  readonly nodes: readonly ArrayPrototypeChainNode[]
}

function snapshotArrayPrototype(): ArrayPrototypeFingerprint | null {
  try {
    const nodes: Array<ArrayPrototypeChainNode> = []
    let current: object | null = TRUSTED.arrayPrototype as object
    const seen = new TRUSTED.weakSetConstructor<object>()
    while (current !== null) {
      if (trustedWeakSetHas(seen, current)) return null
      trustedWeakSetAdd(seen, current)
      const keys = TRUSTED.ownKeys(current)
      const descriptors = new TRUSTED.mapConstructor<
        PropertyKey,
        PropertyDescriptor
      >()
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!
        const descriptor = TRUSTED.objectGetOwnPropertyDescriptor(current, key)
        if (!descriptor) return null
        trustedMapSet(descriptors, key, TRUSTED.objectFreeze({ ...descriptor }))
      }
      const parent = TRUSTED.objectGetPrototypeOf(current)
      const node = TRUSTED.objectFreeze({
        value: current,
        parent,
        keys: TRUSTED.objectFreeze(keys),
        descriptors,
      })
      TRUSTED.objectDefineProperty(nodes, TRUSTED.string(nodes.length), {
        configurable: true,
        enumerable: true,
        writable: true,
        value: node,
      })
      current = parent
    }
    return TRUSTED.objectFreeze({ nodes: TRUSTED.objectFreeze(nodes) })
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
  if (!baseline || !current || baseline.nodes.length !== current.nodes.length)
    return false
  for (let nodeIndex = 0; nodeIndex < baseline.nodes.length; nodeIndex += 1) {
    const expected = baseline.nodes[nodeIndex]!
    const actual = current.nodes[nodeIndex]!
    if (
      expected.value !== actual.value ||
      expected.parent !== actual.parent ||
      expected.keys.length !== actual.keys.length
    )
      return false
    for (let keyIndex = 0; keyIndex < expected.keys.length; keyIndex += 1) {
      const key = expected.keys[keyIndex]
      if (key !== actual.keys[keyIndex]) return false
      if (
        !sameDescriptor(
          trustedMapGet(expected.descriptors, key!),
          trustedMapGet(actual.descriptors, key!)
        )
      )
        return false
    }
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
  const prototype = TRUSTED.objectCreate(null) as object
  const baseline = ARRAY_PROTOTYPE_BASELINE
  const arrayNode = baseline?.nodes[0]
  if (arrayNode)
    for (let index = 0; index < arrayNode.keys.length; index += 1) {
      const key = arrayNode.keys[index]!
      if (key === "length" || key === "toJSON") continue
      const descriptor = trustedMapGet(arrayNode.descriptors, key)
      if (!descriptor) continue
      if (!("value" in descriptor)) continue
      if (typeof descriptor.value !== "function") continue
      TRUSTED.objectDefineProperty(prototype, key, {
        configurable: false,
        enumerable: descriptor.enumerable,
        writable: false,
        value: descriptor.value,
      })
    }
  TRUSTED.objectDefineProperty(prototype, "toJSON", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: undefined,
  })
  return TRUSTED.objectFreeze(prototype)
})()

function appendPath(
  path: Path,
  ...segments: readonly (string | number)[]
): Path {
  const result: Array<string | number> = []
  TRUSTED.objectSetPrototypeOf(result, SAFE_ARRAY_PROTOTYPE)
  for (let index = 0; index < path.length; index += 1)
    result[index] = path[index]!
  for (let index = 0; index < segments.length; index += 1)
    result[path.length + index] = segments[index]!
  return result
}

function safeArray<T>(): T[] {
  const result: T[] = []
  TRUSTED.objectSetPrototypeOf(result, SAFE_ARRAY_PROTOTYPE)
  return result
}

function cloneRecord(
  record: Captured,
  overrides: ReadonlyMap<PropertyKey, unknown>,
  path: Path
): object {
  try {
    const target = record.array ? [] : TRUSTED.objectCreate(null)
    if (record.array) TRUSTED.objectSetPrototypeOf(target, SAFE_ARRAY_PROTOTYPE)
    const define = (key: PropertyKey, original: PropertyDescriptor) => {
      const normalized = keyOf(key)
      const replacement = trustedMapHas(overrides, normalized)
        ? { ...original, value: trustedMapGet(overrides, normalized) }
        : original
      TRUSTED.objectDefineProperty(target, key, replacement)
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
  for (
    let descriptorIndex = 0;
    descriptorIndex < record.descriptors.length;
    descriptorIndex += 1
  ) {
    const entry = record.descriptors[descriptorIndex]!
    const key = entry[0]
    const item = entry[1]
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
  const values = safeArray<unknown>()
  for (let index = 0; index < length.value; index += 1) {
    const item = descriptor(record, index)
    if (!item) return fail(appendPath(path, index), "<missing>")
    if (!("value" in item)) return fail(appendPath(path, index), "<accessor>")
    values[index] = item.value
  }
  return freezeDetachedRecord({
    record,
    values: TRUSTED.objectFreeze(values),
  })
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
  return appendPath(path, "<field>")
}

function jsonValuePath(path: Path): Path {
  return path[path.length - 1] === "<field>" ? path : jsonPath(path)
}

function captureJson(
  value: unknown,
  path: Path,
  depth = 0,
  active = new TRUSTED.weakSetConstructor<object>()
): PreparedJson {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value
  if (typeof value === "number")
    return Number.isFinite(value)
      ? value
      : fail(jsonValuePath(path), "<invalid-json>")
  if (!objectLike(value)) return fail(jsonValuePath(path), "<invalid-json>")
  if (depth > MAX_JSON_DEPTH) return fail(path, "<depth>")
  if (trustedWeakSetHas(active, value)) return fail(path, "<cycle>")
  trustedWeakSetAdd(active, value)
  try {
    const record = capture(value, path)
    if (record.array) {
      if (
        record.prototype !== null &&
        record.prototype !== TRUSTED.arrayPrototype
      )
        return fail(path, "<invalid-json>")
      const length = descriptor(record, "length")
      if (
        !length ||
        !("value" in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0
      )
        return fail(path, "<invalid-json>")
      for (
        let descriptorIndex = 0;
        descriptorIndex < record.descriptors.length;
        descriptorIndex += 1
      ) {
        const entry = record.descriptors[descriptorIndex]!
        const key = entry[0]
        const item = entry[1]
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
      const output = safeArray<PreparedJson>()
      for (let index = 0; index < length.value; index += 1) {
        const item = descriptor(record, index)
        if (!item) return fail(appendPath(path, index), "<invalid-json>")
        if (!item.enumerable || !("value" in item))
          return fail(appendPath(path, index), "<accessor>")
        output[index] = captureJson(
          item.value,
          appendPath(path, index),
          depth + 1,
          active
        )
      }
      return TRUSTED.objectFreeze(output) as JsonArray
    }
    if (
      record.prototype !== null &&
      record.prototype !== TRUSTED.objectPrototype
    )
      return fail(path, "<invalid-json>")
    const output = TRUSTED.objectCreate(null) as JsonObject
    for (
      let descriptorIndex = 0;
      descriptorIndex < record.descriptors.length;
      descriptorIndex += 1
    ) {
      const entry = record.descriptors[descriptorIndex]!
      const key = entry[0]
      const item = entry[1]
      if (typeof key !== "string") return fail(jsonPath(path), "<invalid-json>")
      if (!item.enumerable || !("value" in item))
        return fail(jsonPath(path), "<accessor>")
      TRUSTED.objectDefineProperty(output, key, {
        configurable: true,
        enumerable: true,
        writable: false,
        value: captureJson(item.value, jsonPath(path), depth + 1, active),
      })
    }
    return TRUSTED.objectFreeze(output)
  } finally {
    trustedWeakSetDelete(active, value)
  }
}

function strictJson(text: string, path: Path): PreparedJson {
  let parsed: unknown
  try {
    parsed = TRUSTED.jsonParse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return fail(path, "<invalid-json>")
    throw error
  }
  return captureJson(parsed, path)
}

function lenientJson(text: string, path: Path): PreparedJson | undefined {
  let parsed: unknown
  try {
    parsed = TRUSTED.jsonParse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
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
    parsed = TRUSTED.jsonParse(text)
  } catch (error) {
    if (error instanceof SyntaxError)
      return freezeDetachedRecord({ kind: "partial" })
    throw error
  }
  return freezeDetachedRecord({
    kind: "json",
    value: captureJson(parsed, path),
  })
}

type Freeform =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "json"; readonly value: PreparedJson }

function freeform(text: string, path: Path): Freeform {
  let parsed: unknown
  try {
    parsed = TRUSTED.jsonParse(text)
  } catch (error) {
    if (error instanceof SyntaxError)
      return freezeDetachedRecord({ kind: "text", value: text })
    throw error
  }
  return freezeDetachedRecord({
    kind: "json",
    value: captureJson(parsed, path),
  })
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
      readonly json?: PreparedJson
      readonly data?: PreparedJson
      readonly partial?: PreparedJson
      readonly errorMessage?: string
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
  return trustedApply(TRUSTED.hasOwnProperty, table, [type])
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
  const items = safeArray<PreparedPart>()
  for (let index = 0; index < captured.values.length; index += 1)
    items[index] = freezeDetachedRecord(
      preparePart(
        captured.values[index],
        appendPath(path, index),
        family,
        jsonText
      )
    )
  return freezeDetachedRecord({
    template: captured.record,
    items: TRUSTED.objectFreeze(items),
  })
}

function preparePart(
  value: unknown,
  path: Path,
  family: Family,
  jsonText: boolean
): PreparedPart {
  const template = capture(value, path)
  const type = required(template, "type", appendPath(path, "type"))
  const kind = policy(family, type)
  if (!kind) return fail(path, "<unsupported>")
  if (kind === "opaque") return { kind, template }
  if (kind === "text") {
    const content = required(template, "content", appendPath(path, "content"))
    if (typeof content !== "string")
      return fail(appendPath(path, "content"), "<invalid>")
    return jsonText
      ? {
          kind: "freeform-text",
          template,
          value: freeform(content, appendPath(path, "content")),
        }
      : { kind, template, text: content }
  }
  if (kind === "structured") {
    const status = required(template, "status", appendPath(path, "status"))
    if (status !== "streaming" && status !== "complete" && status !== "error")
      return fail(appendPath(path, "status"), "<invalid>")
    const raw = required(template, "raw", appendPath(path, "raw"))
    if (typeof raw !== "string")
      return fail(appendPath(path, "raw"), "<invalid>")
    const data = optional(template, "data")
    const partial = optional(template, "partial")
    const errorMessage = optional(template, "errorMessage")
    if (
      errorMessage.kind === "data" &&
      errorMessage.value !== undefined &&
      typeof errorMessage.value !== "string"
    )
      return fail(appendPath(path, "errorMessage"), "<invalid>")
    const preparedData =
      data.kind === "data" && data.value !== undefined
        ? captureJson(data.value, appendPath(path, "data"))
        : undefined
    const preparedPartial =
      partial.kind === "data" && partial.value !== undefined
        ? captureJson(partial.value, appendPath(path, "partial"))
        : undefined
    const json =
      status === "complete"
        ? raw === ""
          ? preparedData !== undefined
            ? preparedData
            : captureJson(
                required(template, "data", appendPath(path, "data")),
                appendPath(path, "data")
              )
          : strictJson(raw, appendPath(path, "raw"))
        : lenientJson(raw, appendPath(path, "raw"))
    return freezeDetachedRecord({
      kind: "structured-fallback",
      template,
      ...(json !== undefined ? { json } : {}),
      ...(preparedData !== undefined ? { data: preparedData } : {}),
      ...(preparedPartial !== undefined ? { partial: preparedPartial } : {}),
      ...(errorMessage.kind === "data" && typeof errorMessage.value === "string"
        ? { errorMessage: errorMessage.value }
        : {}),
    })
  }
  if (kind === "tool-call") {
    const argumentsPath = appendPath(path, "arguments")
    const argumentsValue = required(template, "arguments", argumentsPath)
    if (typeof argumentsValue !== "string")
      return fail(argumentsPath, "<invalid>")
    const state = required(template, "state", appendPath(path, "state"))
    const validState =
      state === "awaiting-input" ||
      state === "input-streaming" ||
      state === "input-complete" ||
      state === "approval-requested" ||
      state === "approval-responded" ||
      state === "complete" ||
      state === "error"
    if (!validState) return fail(appendPath(path, "state"), "<invalid>")
    const input = optional(template, "input")
    const output = optional(template, "output")
    const preparedInput =
      input.kind === "data" && input.value !== undefined
        ? captureJson(input.value, appendPath(path, "input"))
        : undefined
    const preparedOutput =
      output.kind === "data" && output.value !== undefined
        ? captureJson(output.value, appendPath(path, "output"))
        : undefined
    const partialState =
      state === "awaiting-input" ||
      state === "input-streaming" ||
      state === "error"
    return {
      kind,
      template,
      args: partialState
        ? partialJson(argumentsValue, argumentsPath)
        : {
            kind: "json",
            value: strictJson(argumentsValue, argumentsPath),
          },
      ...(preparedInput !== undefined ? { input: preparedInput } : {}),
      ...(preparedOutput !== undefined ? { output: preparedOutput } : {}),
    }
  }
  const content = required(template, "content", appendPath(path, "content"))
  const preparedContent =
    typeof content === "string"
      ? freeform(content, appendPath(path, "content"))
      : TRUSTED.arrayIsArray(content)
        ? prepareParts(content, appendPath(path, "content"), "model", true)
        : fail(appendPath(path, "content"), "<invalid>")
  const error = optional(template, "error")
  if (
    error.kind === "data" &&
    error.value !== undefined &&
    typeof error.value !== "string"
  )
    return fail(appendPath(path, "error"), "<invalid>")
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
  const items = safeArray<PreparedToolCall>()
  for (let index = 0; index < captured.values.length; index += 1) {
    const itemPath = appendPath(path, index)
    const functionPath = appendPath(itemPath, "function")
    const argumentsPath = appendPath(functionPath, "arguments")
    const template = capture(captured.values[index], itemPath)
    const functionValue = required(template, "function", functionPath)
    const functionTemplate = capture(functionValue, functionPath)
    const args = required(functionTemplate, "arguments", argumentsPath)
    if (typeof args !== "string") return fail(argumentsPath, "<invalid>")
    items[index] = freezeDetachedRecord({
      template,
      functionTemplate,
      args: strictJson(args, argumentsPath),
    })
  }
  return freezeDetachedRecord({
    template: captured.record,
    items: TRUSTED.objectFreeze(items),
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
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    const current = shape(record)
    const family =
      current.ui === current.model ? undefined : current.ui ? "ui" : "model"
    if (!family) {
      ambiguousIndex ??= index
      continue
    }
    if (candidate && candidate !== family)
      return fail(appendPath([], index), "<unsupported>")
    candidate = family
  }
  if (ambiguousIndex !== undefined)
    return fail(appendPath([], ambiguousIndex), "<ambiguous>")
  if (candidate) return candidate
  return fail([], "<unsupported>")
}

function prepareMessage(
  record: Captured,
  index: number,
  family: Family
): PreparedMessage {
  const messagePath = appendPath([], index)
  const rolePath = appendPath(messagePath, "role")
  const role = required(record, "role", rolePath)
  if (family === "ui") {
    const idPath = appendPath(messagePath, "id")
    const id = required(record, "id", idPath)
    if (typeof id !== "string") return fail(idPath, "<invalid>")
    if (role !== "system" && role !== "user" && role !== "assistant")
      return fail(rolePath, "<invalid>")
    return {
      family,
      template: record,
      parts: prepareParts(
        required(record, "parts", appendPath(messagePath, "parts")),
        appendPath(messagePath, "parts"),
        "ui",
        false
      ),
    }
  }
  if (role !== "user" && role !== "assistant" && role !== "tool")
    return fail(rolePath, "<invalid>")
  const contentPath = appendPath(messagePath, "content")
  const content = required(record, "content", contentPath)
  const prepared =
    typeof content === "string"
      ? role === "tool"
        ? freeform(content, contentPath)
        : content
      : content === null
        ? null
        : TRUSTED.arrayIsArray(content)
          ? prepareParts(content, contentPath, "model", role === "tool")
          : fail(contentPath, "<invalid>")
  const toolCalls = optional(record, "toolCalls")
  return {
    family,
    template: record,
    content: prepared,
    ...(toolCalls.kind === "data" && toolCalls.value !== undefined
      ? {
          toolCalls: prepareToolCalls(
            toolCalls.value,
            appendPath(messagePath, "toolCalls")
          ),
        }
      : {}),
  }
}

/** The sole caller-object phase: captures and compiles the complete graph synchronously. */
function captureMessages(messages: TanStackMessages): PreparedMessages {
  const root = captureArray(messages, [])
  const records = safeArray<Captured>()
  for (let index = 0; index < root.values.length; index += 1)
    records[index] = capture(root.values[index], appendPath([], index))
  if (records.length === 0)
    return freezeDetachedRecord({
      template: root.record,
      items: TRUSTED.objectFreeze(safeArray<PreparedMessage>()),
    })
  const family = classify(records)
  const items = safeArray<PreparedMessage>()
  for (let index = 0; index < records.length; index += 1)
    items[index] = freezeDetachedRecord(
      prepareMessage(records[index]!, index, family)
    )
  return freezeDetachedRecord({
    template: root.record,
    items: TRUSTED.objectFreeze(items),
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
  if (TRUSTED.arrayIsArray(value)) {
    const output = safeArray<PreparedJson>()
    for (let index = 0; index < value.length; index += 1)
      output[index] = await protectPreparedJson(session, value[index]!)
    return TRUSTED.objectFreeze(output) as JsonArray
  }
  const output = TRUSTED.objectCreate(null) as JsonObject
  const objectValue = value as JsonObject
  const keys = TRUSTED.objectKeys(objectValue)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!
    TRUSTED.objectDefineProperty(output, key, {
      configurable: true,
      enumerable: true,
      writable: false,
      value: await protectPreparedJson(session, objectValue[key]!),
    })
  }
  return TRUSTED.objectFreeze(output)
}

function isFreeform(value: Freeform | PreparedPartList): value is Freeform {
  const kind = TRUSTED.objectGetOwnPropertyDescriptor(value, "kind")
  return (
    !!kind &&
    "value" in kind &&
    (kind.value === "text" || kind.value === "json")
  )
}

async function renderFreeform(
  session: PiiSession,
  value: Freeform
): Promise<string> {
  return value.kind === "text"
    ? protectText(session, value.value)
    : TRUSTED.jsonStringify(await protectPreparedJson(session, value.value))
}

async function renderParts(
  session: PiiSession,
  plan: PreparedPartList,
  path: Path
): Promise<object> {
  const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
  for (let index = 0; index < plan.items.length; index += 1)
    trustedMapSet(
      overrides,
      TRUSTED.string(index),
      await renderPart(session, plan.items[index]!, appendPath(path, index))
    )
  return cloneRecord(plan.template, overrides, path)
}

async function renderPart(
  session: PiiSession,
  plan: PreparedPart,
  path: Path
): Promise<object> {
  if (plan.kind === "opaque")
    return cloneRecord(
      plan.template,
      new TRUSTED.mapConstructor<PropertyKey, unknown>(),
      path
    )
  if (plan.kind === "text") {
    const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(overrides, "content", await protectText(session, plan.text))
    return cloneRecord(plan.template, overrides, path)
  }
  if (plan.kind === "freeform-text") {
    const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      overrides,
      "content",
      await renderFreeform(session, plan.value)
    )
    return cloneRecord(plan.template, overrides, path)
  }
  if (plan.kind === "structured-fallback") {
    const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      overrides,
      "raw",
      plan.json === undefined
        ? ""
        : TRUSTED.jsonStringify(await protectPreparedJson(session, plan.json))
    )
    if (plan.data !== undefined)
      trustedMapSet(
        overrides,
        "data",
        await protectPreparedJson(session, plan.data)
      )
    if (plan.partial !== undefined)
      trustedMapSet(
        overrides,
        "partial",
        await protectPreparedJson(session, plan.partial)
      )
    if (plan.errorMessage !== undefined)
      trustedMapSet(
        overrides,
        "errorMessage",
        await protectText(session, plan.errorMessage)
      )
    return cloneRecord(plan.template, overrides, path)
  }
  if (plan.kind === "tool-call") {
    const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      overrides,
      "arguments",
      plan.args.kind === "partial"
        ? ""
        : TRUSTED.jsonStringify(
            await protectPreparedJson(session, plan.args.value)
          )
    )
    if (plan.input !== undefined)
      trustedMapSet(
        overrides,
        "input",
        await protectPreparedJson(session, plan.input)
      )
    if (plan.output !== undefined)
      trustedMapSet(
        overrides,
        "output",
        await protectPreparedJson(session, plan.output)
      )
    return cloneRecord(plan.template, overrides, path)
  }
  const content = isFreeform(plan.content)
    ? await renderFreeform(session, plan.content)
    : await renderParts(session, plan.content, appendPath(path, "content"))
  const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
  trustedMapSet(overrides, "content", content)
  if (plan.error !== undefined)
    trustedMapSet(overrides, "error", await protectText(session, plan.error))
  return cloneRecord(plan.template, overrides, path)
}

async function renderToolCalls(
  session: PiiSession,
  plan: PreparedToolCalls,
  path: Path
): Promise<object> {
  const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index]!
    const functionOverrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      functionOverrides,
      "arguments",
      TRUSTED.jsonStringify(await protectPreparedJson(session, item.args))
    )
    const functionValue = cloneRecord(
      item.functionTemplate,
      functionOverrides,
      appendPath(path, index, "function")
    )
    const itemOverrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(itemOverrides, "function", functionValue)
    trustedMapSet(
      overrides,
      TRUSTED.string(index),
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
    const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
    trustedMapSet(
      overrides,
      "parts",
      await renderParts(session, plan.parts, appendPath([], index, "parts"))
    )
    return cloneRecord(plan.template, overrides, appendPath([], index))
  }
  const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
  if (typeof plan.content === "string")
    trustedMapSet(
      overrides,
      "content",
      await protectText(session, plan.content)
    )
  else if (plan.content === null) trustedMapSet(overrides, "content", null)
  else if (isFreeform(plan.content))
    trustedMapSet(
      overrides,
      "content",
      await renderFreeform(session, plan.content)
    )
  else
    trustedMapSet(
      overrides,
      "content",
      await renderParts(session, plan.content, appendPath([], index, "content"))
    )
  if (plan.toolCalls)
    trustedMapSet(
      overrides,
      "toolCalls",
      await renderToolCalls(
        session,
        plan.toolCalls,
        appendPath([], index, "toolCalls")
      )
    )
  return cloneRecord(plan.template, overrides, appendPath([], index))
}

export async function protectTanStackMessages(
  session: PiiSession,
  messages: TanStackMessages
): Promise<TanStackMessages> {
  assertArrayPrototypeStable()
  const plan = captureMessages(messages)
  const overrides = new TRUSTED.mapConstructor<PropertyKey, unknown>()
  for (let index = 0; index < plan.items.length; index += 1)
    trustedMapSet(
      overrides,
      TRUSTED.string(index),
      await renderMessage(session, plan.items[index]!, index)
    )
  const protectedMessages = cloneRecord(
    plan.template,
    overrides,
    []
  ) as TanStackMessages
  return protectedMessages
}
