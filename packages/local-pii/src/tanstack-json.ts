import type { PiiSession } from "./session"
import { appendPath, capture, descriptor } from "./tanstack-capture"
import { fail, type Path } from "./tanstack-errors"
import {
  TRUSTED,
  freezeDetachedRecord,
  safeArray,
  trustedWeakSetAdd,
  trustedWeakSetDelete,
  trustedWeakSetHas,
} from "./tanstack-trusted"

const MAX_JSON_DEPTH = 128

export type PreparedJson =
  null | boolean | number | string | JsonObject | JsonArray

export interface JsonObject {
  readonly [key: string]: PreparedJson
}

export interface JsonArray {
  readonly length: number
  readonly [index: number]: PreparedJson
}

export type PreparedToolArguments =
  | { readonly kind: "json"; readonly value: PreparedJson }
  | { readonly kind: "partial" }

export type Freeform =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "json"; readonly value: PreparedJson }

export async function protectText(
  session: PiiSession,
  text: string
): Promise<string> {
  if (!text) return text
  return (await session.anonymize(text)).redactedText
}

function objectLike(value: unknown): value is object {
  return value !== null && typeof value === "object"
}

function jsonPath(path: Path): Path {
  return appendPath(path, "<field>")
}

function jsonValuePath(path: Path): Path {
  return path[path.length - 1] === "<field>" ? path : jsonPath(path)
}

export function captureJson(
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

export function strictJson(text: string, path: Path): PreparedJson {
  let parsed: unknown
  try {
    parsed = TRUSTED.jsonParse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return fail(path, "<invalid-json>")
    throw error
  }
  return captureJson(parsed, path)
}

export function lenientJson(
  text: string,
  path: Path
): PreparedJson | undefined {
  let parsed: unknown
  try {
    parsed = TRUSTED.jsonParse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  return captureJson(parsed, path)
}

export function partialJson(text: string, path: Path): PreparedToolArguments {
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

export function freeform(text: string, path: Path): Freeform {
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

export async function protectPreparedJson(
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

export async function renderFreeform(
  session: PiiSession,
  value: Freeform
): Promise<string> {
  if (value.kind === "text") {
    return protectText(session, value.value)
  }
  return TRUSTED.jsonStringify(await protectPreparedJson(session, value.value))
}
