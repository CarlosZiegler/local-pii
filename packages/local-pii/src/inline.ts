import { createAnonymizer, type Anonymizer } from "./anonymizer"
import { token } from "./placeholder/strategies"
import type { PiiSession } from "./session"

export interface InlineContext {
  readonly session: PiiSession
  readonly signal?: AbortSignal
}

export interface InlineSessionOptions {
  /** Borrow a session whose vault should survive this call. */
  session?: PiiSession
  /** Create an owned session from this anonymizer when no session is supplied. */
  anonymizer?: Anonymizer
  signal?: AbortSignal
}

export interface RunInlineOptions<Input, Protected, Output, Restored>
  extends InlineSessionOptions {
  input: Input
  protect: (input: Input, context: InlineContext) => Promise<Protected>
  call: (input: Protected, context: InlineContext) => Promise<Output>
  restore: (
    output: Output,
    context: InlineContext,
  ) => Promise<Restored> | Restored
}

interface ResolvedSession {
  readonly session: PiiSession
  readonly owned: boolean
}

function resolveSession(options: InlineSessionOptions): ResolvedSession {
  if (options.session) return { session: options.session, owned: false }

  const anonymizer =
    options.anonymizer ?? createAnonymizer({ placeholders: token() })
  return { session: anonymizer.createSession(), owned: true }
}

/**
 * Run one protected in-process operation. The adapter owns the ordering, while
 * callers provide the input/output transforms required by their model API.
 */
export async function runInline<Input, Protected, Output, Restored>(
  options: RunInlineOptions<Input, Protected, Output, Restored>,
): Promise<Restored> {
  const resolved = resolveSession(options)
  const context: InlineContext = {
    session: resolved.session,
    signal: options.signal,
  }

  try {
    options.signal?.throwIfAborted()
    const protectedInput = await options.protect(options.input, context)
    options.signal?.throwIfAborted()
    const output = await options.call(protectedInput, context)
    options.signal?.throwIfAborted()
    return await options.restore(output, context)
  } finally {
    if (resolved.owned) resolved.session.clear()
  }
}

export interface RunInlineTextOptions extends InlineSessionOptions {
  input: string
  call: (input: string, context: InlineContext) => Promise<string>
}

/** Protect a complete text request and restore the complete text response. */
export function runInlineText(options: RunInlineTextOptions): Promise<string> {
  return runInline({
    ...options,
    protect: async (input, { session }) =>
      (await session.anonymize(input)).redactedText,
    restore: (output, { session }) =>
      session.rehydrate(output, { lenient: true }),
  })
}

export interface RunInlineJsonOptions<Input, Output>
  extends InlineSessionOptions {
  input: Input
  call: (input: Input, context: InlineContext) => Promise<Output>
}

/** Protect and restore every string leaf while preserving the JSON shape. */
export function runInlineJson<Input, Output>(
  options: RunInlineJsonOptions<Input, Output>,
): Promise<Output> {
  return runInline<Input, Input, Output, Output>({
    ...options,
    protect: async (input, { session }) =>
      (await session.anonymizeJson(input)) as Input,
    restore: (output, { session }) =>
      session.rehydrateJson(output, { lenient: true }) as Output,
  })
}
