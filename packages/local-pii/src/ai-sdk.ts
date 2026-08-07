import { wrapLanguageModel, type LanguageModelMiddleware } from "ai"
import { createAnonymizer, type Anonymizer } from "./anonymizer"
import { createStreamingRehydrator } from "./rehydrate"
import { token } from "./placeholder/strategies"
import type { PiiSession } from "./session"

export interface PiiMiddlewareOptions {
  /** Reuse a session (share the vault across a conversation / tool loop). */
  session?: PiiSession
  /** Or derive a session from an anonymizer. */
  anonymizer?: Anonymizer
}

function resolveSession(opts: PiiMiddlewareOptions): PiiSession {
  if (opts.session) return opts.session
  return (opts.anonymizer ?? createAnonymizer({ placeholders: token() })).createSession()
}

// We touch only text / tool-call input / tool-result output — never file parts,
// tool schemas, ids or role strings — so the adapter tolerates SDK version drift.
type AnyPart = Record<string, unknown>

async function anonymizePart(session: PiiSession, part: AnyPart): Promise<AnyPart> {
  const p: AnyPart = { ...part }
  if (typeof p.text === "string" && p.text.length > 0) {
    p.text = (await session.anonymize(p.text)).redactedText
  }
  if ("input" in p) p.input = await session.anonymizeJson(p.input) // tool-call args
  if ("output" in p) p.output = await session.anonymizeJson(p.output) // tool-result
  return p
}

async function anonymizePrompt(session: PiiSession, prompt: unknown): Promise<unknown> {
  if (!Array.isArray(prompt)) return prompt
  const out: unknown[] = []
  for (const message of prompt) {
    const m = message as AnyPart
    const next: AnyPart = { ...m }
    if (typeof m.content === "string") {
      next.content = (await session.anonymize(m.content)).redactedText
    } else if (Array.isArray(m.content)) {
      const parts: unknown[] = []
      for (const part of m.content) parts.push(await anonymizePart(session, part as AnyPart))
      next.content = parts
    }
    out.push(next)
  }
  return out
}

function rehydratePart(session: PiiSession, part: AnyPart): AnyPart {
  const p: AnyPart = { ...part }
  if (typeof p.text === "string") p.text = session.rehydrate(p.text, { lenient: true })
  if ("input" in p) p.input = session.rehydrateJson(p.input, { lenient: true })
  return p
}

function rehydrateContent(session: PiiSession, content: unknown): unknown {
  return Array.isArray(content)
    ? content.map((part) => rehydratePart(session, part as AnyPart))
    : content
}

/**
 * Vercel AI SDK middleware that anonymizes every prompt (text, history,
 * tool-call arguments, tool results) on the way to the provider and rehydrates
 * everything on the way back — generated text, tool-call arguments (so the
 * SDK's agent loop runs your tools with REAL values), and streamed deltas
 * across chunk boundaries. Use one session per conversation.
 *
 * ```ts
 * import { streamText } from "ai"
 * import { withPii } from "local-pii/ai-sdk"
 * const result = streamText({ model: withPii(openai("gpt-5.2")), tools, prompt })
 * ```
 */
export function piiMiddleware(opts: PiiMiddlewareOptions = {}): LanguageModelMiddleware {
  const session = resolveSession(opts)

  return {
    async transformParams({ params }) {
      return { ...params, prompt: (await anonymizePrompt(session, params.prompt)) as never }
    },

    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate()
      return { ...result, content: rehydrateContent(session, result.content) as never }
    },

    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream()
      const rehydrators = new Map<string, ReturnType<typeof createStreamingRehydrator>>()
      const rehydratorFor = (id: string) => {
        let r = rehydrators.get(id)
        if (!r) {
          r = createStreamingRehydrator(() => session.mapping)
          rehydrators.set(id, r)
        }
        return r
      }

      const transformed = (stream as unknown as ReadableStream<AnyPart>).pipeThrough(
        new TransformStream<AnyPart, AnyPart>({
          transform(part, controller) {
            if (part.type === "text-delta" && typeof part.delta === "string") {
              const out = rehydratorFor(String(part.id)).push(part.delta)
              if (out) controller.enqueue({ ...part, delta: out })
              return
            }
            if (part.type === "text-end") {
              const tail = rehydrators.get(String(part.id))?.flush()
              if (tail) controller.enqueue({ type: "text-delta", id: part.id, delta: tail })
              controller.enqueue(part)
              return
            }
            if (part.type === "tool-call") {
              controller.enqueue(rehydratePart(session, part))
              return
            }
            controller.enqueue(part)
          },
          flush(controller) {
            for (const [id, r] of rehydrators) {
              const tail = r.flush()
              if (tail) controller.enqueue({ type: "text-delta", id, delta: tail })
            }
          },
        }),
      )
      return { stream: transformed as never, ...rest }
    },
  }
}

/** Sugar: `wrapLanguageModel({ model, middleware: piiMiddleware(opts) })`. */
export function withPii<M>(model: M, opts: PiiMiddlewareOptions = {}): M {
  return wrapLanguageModel({
    model: model as never,
    middleware: piiMiddleware(opts),
  }) as M
}
