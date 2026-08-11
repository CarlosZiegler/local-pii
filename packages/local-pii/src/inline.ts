import { createAnonymizer, type Anonymizer } from "./anonymizer"
import { token } from "./placeholder/strategies"
import { createStreamingRehydrator } from "./rehydrate"
import type { PiiSession } from "./session"

export interface InlineContext {
  readonly signal?: AbortSignal
}

export interface InlineTransformContext extends InlineContext {
  /** Available only to the caller-owned protection and restoration steps. */
  readonly session: PiiSession
}

export interface InlineSessionOptions {
  /** Borrow a session whose vault should survive this call. */
  session?: PiiSession
  /** Derive a temporary session when no session is supplied. */
  anonymizer?: Anonymizer
  signal?: AbortSignal
}

export interface RunInlineOptions<
  Input,
  Protected,
  Output,
  Restored,
> extends InlineSessionOptions {
  input: Input
  protect: (input: Input, context: InlineTransformContext) => Promise<Protected>
  call: (input: Protected, context: InlineContext) => Promise<Output>
  restore: (
    output: Output,
    context: InlineTransformContext
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
  options: RunInlineOptions<Input, Protected, Output, Restored>
): Promise<Restored> {
  const resolved = resolveSession(options)
  const transformContext: InlineTransformContext = {
    session: resolved.session,
    signal: options.signal,
  }
  const callContext: InlineContext = { signal: options.signal }
  let primaryFailed = false

  try {
    options.signal?.throwIfAborted()
    const protectedInput = await options.protect(
      options.input,
      transformContext
    )
    options.signal?.throwIfAborted()
    const output = await options.call(protectedInput, callContext)
    options.signal?.throwIfAborted()
    return await options.restore(output, transformContext)
  } catch (error) {
    primaryFailed = true
    throw error
  } finally {
    if (resolved.owned) {
      try {
        resolved.session.clear()
      } catch (cleanupError) {
        if (!primaryFailed) {
          // Cleanup is the primary failure only when the operation succeeded.
          // eslint-disable-next-line no-unsafe-finally -- preserve cleanup error contract
          throw cleanupError
        }
      }
    }
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

export interface RunInlineTextStreamOptions extends InlineSessionOptions {
  input: string
  call: (input: string, context: InlineContext) => AsyncIterable<string>
}

/** Protect a text request and safely restore an incremental text response. */
export function runInlineTextStream(
  options: RunInlineTextStreamOptions
): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      const resolved = resolveSession(options)
      const context: InlineContext = { signal: options.signal }
      let upstream: AsyncIterator<string> | undefined
      let upstreamDone = false
      let failed = false

      try {
        options.signal?.throwIfAborted()
        const protectedInput = (await resolved.session.anonymize(options.input))
          .redactedText
        options.signal?.throwIfAborted()

        upstream = options.call(protectedInput, context)[Symbol.asyncIterator]()
        const rehydrator = createStreamingRehydrator(
          () => resolved.session.mapping
        )

        while (true) {
          options.signal?.throwIfAborted()
          const next = await upstream.next()
          options.signal?.throwIfAborted()

          if (next.done) {
            upstreamDone = true
            const tail = rehydrator.flush()
            if (tail) yield tail
            return
          }

          const output = rehydrator.push(next.value)
          if (output) yield output
        }
      } catch (error) {
        failed = true
        throw error
      } finally {
        let hasCleanupError = false
        let cleanupError: unknown

        if (!upstreamDone) {
          try {
            await upstream?.return?.()
          } catch (error) {
            hasCleanupError = true
            cleanupError = error
          }
        }

        if (resolved.owned) {
          try {
            resolved.session.clear()
          } catch (error) {
            if (!hasCleanupError) {
              hasCleanupError = true
              cleanupError = error
            }
          }
        }

        // eslint-disable-next-line no-unsafe-finally -- preserve the first cleanup error
        if (!failed && hasCleanupError) throw cleanupError
      }
    },
  }
}

export interface RunInlineJsonOptions<
  Input,
  Output,
> extends InlineSessionOptions {
  input: Input
  call: (input: Input, context: InlineContext) => Promise<Output>
}

/** Protect and restore every string leaf while preserving the JSON shape. */
export function runInlineJson<Input, Output>(
  options: RunInlineJsonOptions<Input, Output>
): Promise<Output> {
  return runInline<Input, Input, Output, Output>({
    ...options,
    protect: async (input, { session }) =>
      (await session.anonymizeJson(input)) as Input,
    restore: (output, { session }) =>
      session.rehydrateJson(output, { lenient: true }) as Output,
  })
}
