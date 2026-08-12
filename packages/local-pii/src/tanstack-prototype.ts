import {
  TRUSTED,
  trustedMapGet,
  trustedMapSet,
  trustedWeakSetAdd,
  trustedWeakSetHas,
} from "./tanstack-trusted"
import { fail } from "./tanstack-errors"

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

export function assertTanStackArrayPrototypeStable(): void {
  if (!arrayPrototypeMatchesBaseline()) fail([], "<invalid>")
}
