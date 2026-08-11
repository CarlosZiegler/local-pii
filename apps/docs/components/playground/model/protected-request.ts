import type { ProtectedBrowserRequest, ProtectedBrowserTurn } from "./types"

const markedRequests = new WeakSet<object>()

export class InvalidProtectedBrowserRequestError extends TypeError {
  override name = "InvalidProtectedBrowserRequestError"
}

function isTurn(value: unknown): value is ProtectedBrowserTurn {
  if (value === null || typeof value !== "object") return false
  const turn = value as Record<string, unknown>
  return (
    (turn.role === "system" ||
      turn.role === "user" ||
      turn.role === "assistant") &&
    typeof turn.protectedContent === "string"
  )
}

function validateInput(input: ProtectedBrowserRequest): void {
  if (input === null || typeof input !== "object") {
    throw new InvalidProtectedBrowserRequestError(
      "Browser generation requires a protected request"
    )
  }
  if (!Array.isArray(input.protectedHistory)) {
    throw new InvalidProtectedBrowserRequestError(
      "Protected history must be an array"
    )
  }
  if (!input.protectedHistory.every(isTurn)) {
    throw new InvalidProtectedBrowserRequestError(
      "Protected history contains an unsupported turn"
    )
  }
  let sawSystem = false
  for (const [index, turn] of input.protectedHistory.entries()) {
    if (turn.role !== "system") continue
    if (sawSystem || index !== 0) {
      throw new InvalidProtectedBrowserRequestError(
        "Protected history allows only one leading system turn"
      )
    }
    sawSystem = true
  }
  if (typeof input.protectedContent !== "string") {
    throw new InvalidProtectedBrowserRequestError(
      "Protected current content must be text"
    )
  }
  if (
    input.signal !== undefined &&
    (typeof input.signal !== "object" ||
      typeof input.signal.addEventListener !== "function")
  ) {
    throw new InvalidProtectedBrowserRequestError(
      "Protected request signal must be an AbortSignal"
    )
  }
}

/**
 * Mint the only request object accepted by a BrowserGenerationRuntime.
 *
 * The marker is intentionally private. A structurally identical object made
 * by a caller cannot cross the internal seam and cause browser model
 * acquisition.
 */
export function createProtectedBrowserRequest(input: {
  protectedHistory: readonly ProtectedBrowserTurn[]
  protectedContent: string
  signal?: AbortSignal
}): ProtectedBrowserRequest {
  validateInput(input as ProtectedBrowserRequest)
  const protectedHistory = input.protectedHistory.map((turn) =>
    Object.freeze({
      role: turn.role,
      protectedContent: turn.protectedContent,
    })
  )
  Object.freeze(protectedHistory)
  const request: ProtectedBrowserRequest = {
    protectedHistory,
    protectedContent: input.protectedContent,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
  validateInput(request)
  Object.freeze(request)
  markedRequests.add(request)
  return request
}

/** Assert that a request was minted by createProtectedBrowserRequest. */
export function assertProtectedBrowserRequest(
  input: ProtectedBrowserRequest
): asserts input is ProtectedBrowserRequest {
  validateInput(input)
  if (!markedRequests.has(input as object)) {
    throw new InvalidProtectedBrowserRequestError(
      "Browser generation requires a request minted by the protected adapter"
    )
  }
}
