import {
  SAFE_ARRAY_PROTOTYPE,
  TRUSTED,
  freezeDetachedRecord,
  safeArray,
  trustedApply,
  trustedMapGet,
  trustedMapHas,
  trustedMapSet,
  trustedWeakSetAdd,
  trustedWeakSetHas,
} from "./tanstack-trusted"
import {
  fail,
  isSafeSegment,
  UnsupportedTanStackSemanticContentError,
  type Path,
} from "./tanstack-errors"

export type DescriptorEntry = readonly [PropertyKey, PropertyDescriptor]

export interface Captured {
  readonly prototype: object | null
  readonly array: boolean
  readonly descriptors: readonly DescriptorEntry[]
  readonly lookup: ReadonlyMap<PropertyKey, PropertyDescriptor>
}

type Field =
  | { readonly kind: "missing" }
  | { readonly kind: "data"; readonly value: unknown }

export interface CapturedArray {
  readonly record: Captured
  readonly values: readonly unknown[]
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

export function appendPath(
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

function keyOf(key: PropertyKey): PropertyKey {
  return typeof key === "number" ? TRUSTED.string(key) : key
}

function descriptorPath(path: Path, key: PropertyKey): Path {
  if (isSafeSegment(key)) return appendPath(path, key)
  if (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key)) {
    const index = Number(key)
    if (Number.isSafeInteger(index) && index >= 0)
      return appendPath(path, index)
  }
  return appendPath(path, "<field>")
}

export function descriptor(
  record: Captured,
  key: PropertyKey
): PropertyDescriptor | undefined {
  return trustedMapGet(record.lookup, keyOf(key))
}

function field(record: Captured, key: PropertyKey): Field {
  const found = descriptor(record, key)
  if (!found) return freezeDetachedRecord({ kind: "missing" })
  return freezeDetachedRecord({ kind: "data", value: found.value })
}

export function required(
  record: Captured,
  key: PropertyKey,
  path: Path
): unknown {
  const result = field(record, key)
  if (result.kind !== "data") return fail(path, "<missing>")
  return result.value
}

export function optional(record: Captured, key: PropertyKey): Field {
  return field(record, key)
}

export function capture(value: unknown, path: Path): Captured {
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
      const item = descriptorMap[key]
      if (!item) return fail(path, "<invalid>")
      if (!("value" in item))
        return fail(descriptorPath(path, key), "<accessor>")
      const entry = safeArray<
        PropertyKey | PropertyDescriptor
      >() as unknown as [PropertyKey, PropertyDescriptor]
      entry[0] = key
      entry[1] = TRUSTED.objectFreeze({ ...item })
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

export function cloneRecord(
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

export function captureArray(value: unknown, path: Path): CapturedArray {
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
