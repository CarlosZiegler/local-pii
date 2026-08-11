import { TRUSTED, safeArray, trustedSetHas } from "./tanstack-trusted"

export type Path = readonly (string | number)[]

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

export function isSafeSegment(value: unknown): value is string {
  return typeof value === "string" && trustedSetHas(SAFE_SEGMENTS, value)
}

export function safeReason(reason: unknown): string {
  return typeof reason === "string" && trustedSetHas(SAFE_REASONS, reason)
    ? reason
    : "<unsupported>"
}

function safePath(path: Path): Path {
  const cleaned = safeArray<string | number>()
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index]
    cleaned[index] =
      typeof part === "number" && Number.isSafeInteger(part) && part >= 0
        ? part
        : isSafeSegment(part)
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
        : isSafeSegment(part)
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

export function fail(path: Path, reason = "<unsupported>"): never {
  throw new UnsupportedTanStackSemanticContentError(path, safeReason(reason))
}
