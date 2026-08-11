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

export { TRUSTED }

export function trustedApply<T>(
  fn: (...args: never[]) => T,
  receiver: unknown,
  args: readonly unknown[]
): T {
  return TRUSTED.reflectApply(fn, receiver, args) as T
}

export function trustedMapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  trustedApply(TRUSTED.mapSet, map, [key, value])
}

export function trustedMapGet<K, V>(
  map: ReadonlyMap<K, V>,
  key: K
): V | undefined {
  return trustedApply(TRUSTED.mapGet, map, [key])
}

export function trustedMapHas<K, V>(map: ReadonlyMap<K, V>, key: K): boolean {
  return trustedApply(TRUSTED.mapHas, map, [key])
}

export function trustedSetHas<T>(set: ReadonlySet<T>, value: T): boolean {
  return trustedApply(TRUSTED.setHas, set, [value])
}

export function trustedWeakSetAdd<T extends object>(
  set: WeakSet<T>,
  value: T
): void {
  trustedApply(TRUSTED.weakSetAdd, set, [value])
}

export function trustedWeakSetHas<T extends object>(
  set: WeakSet<T>,
  value: T
): boolean {
  return trustedApply(TRUSTED.weakSetHas, set, [value])
}

export function trustedWeakSetDelete<T extends object>(
  set: WeakSet<T>,
  value: T
): void {
  trustedApply(TRUSTED.weakSetDelete, set, [value])
}

export function freezeDetachedRecord<T extends object>(value: T): T {
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

export const SAFE_ARRAY_PROTOTYPE = (() => {
  const prototype = TRUSTED.objectCreate(null) as object
  const keys = TRUSTED.ownKeys(TRUSTED.arrayPrototype)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!
    if (key === "length" || key === "toJSON") continue
    const descriptor = TRUSTED.objectGetOwnPropertyDescriptor(
      TRUSTED.arrayPrototype,
      key
    )
    if (!descriptor || !("value" in descriptor)) continue
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

export function safeArray<T>(): T[] {
  const result: T[] = []
  TRUSTED.objectSetPrototypeOf(result, SAFE_ARRAY_PROTOTYPE)
  return result
}
