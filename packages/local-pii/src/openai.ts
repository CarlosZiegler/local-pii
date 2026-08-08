import { createAnonymizer, type Anonymizer } from "./anonymizer"
import { createStreamingRehydrator } from "./rehydrate"
import { token } from "./placeholder/strategies"
import type { PiiSession } from "./session"
import type { Mapping } from "./types"

/**
 * An OpenAI-style chat message — the lingua franca of the OpenAI SDK and
 * OpenAI-compatible providers (xAI/Grok, Groq, Together, OpenRouter, Ollama…),
 * so this adapter is provider-agnostic and has no SDK dependency.
 */
export interface ChatMessage {
  role: string
  content?: string | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ChatToolCall {
  id?: string
  type?: string
  function: { name: string; arguments: string }
}

export interface PiiChatOptions {
  /** Reuse an existing session (share the vault across a conversation). */
  session?: PiiSession
  /** Or supply an anonymizer to derive a session from. */
  anonymizer?: Anonymizer
}

function resolveSession(opts: PiiChatOptions): PiiSession {
  if (opts.session) return opts.session
  // Default to opaque tokens — they survive JSON/tool-call round-trips.
  return (
    opts.anonymizer ?? createAnonymizer({ placeholders: token() })
  ).createSession()
}

async function anonymizeMessages(
  session: PiiSession,
  messages: readonly ChatMessage[]
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = []
  for (const message of messages) {
    const next: ChatMessage = { ...message }
    if (typeof message.content === "string" && message.content.length > 0) {
      next.content = (await session.anonymize(message.content)).redactedText
    }
    if (message.tool_calls) {
      next.tool_calls = []
      for (const call of message.tool_calls) {
        const args = (await session.anonymize(call.function.arguments))
          .redactedText
        next.tool_calls.push({
          ...call,
          function: { ...call.function, arguments: args },
        })
      }
    }
    out.push(next)
  }
  return out
}

function rehydrateArgs(session: PiiSession, argsJson: string): string {
  try {
    return JSON.stringify(
      session.rehydrateJson(JSON.parse(argsJson), { lenient: true })
    )
  } catch {
    return session.rehydrate(argsJson, { lenient: true })
  }
}

function rehydrateMessage(
  session: PiiSession,
  message: ChatMessage
): ChatMessage {
  const next: ChatMessage = { ...message }
  if (typeof message.content === "string") {
    next.content = session.rehydrate(message.content, { lenient: true })
  }
  if (message.tool_calls) {
    next.tool_calls = message.tool_calls.map((call) => ({
      ...call,
      function: {
        ...call.function,
        arguments: rehydrateArgs(session, call.function.arguments),
      },
    }))
  }
  return next
}

export interface PiiChat {
  anonymizeMessages(messages: readonly ChatMessage[]): Promise<ChatMessage[]>
  rehydrateText(text: string): string
  rehydrateMessage(message: ChatMessage): ChatMessage
  readonly session: PiiSession
  readonly mapping: Mapping
}

/**
 * Lower-level helper for a manual OpenAI/Grok tool loop: redact messages (incl.
 * tool results + tool-call args) with one shared vault, and rehydrate what the
 * model returns (incl. tool-call argument JSON) so you execute tools with real
 * values. See {@link withPiiOpenAI} for a drop-in client wrapper.
 */
export function createPiiChat(opts: PiiChatOptions = {}): PiiChat {
  const session = resolveSession(opts)
  return {
    anonymizeMessages: (messages) => anonymizeMessages(session, messages),
    rehydrateText: (text) => session.rehydrate(text, { lenient: true }),
    rehydrateMessage: (message) => rehydrateMessage(session, message),
    session,
    get mapping() {
      return session.mapping
    },
  }
}

// --- Drop-in client wrapper --------------------------------------------------

interface CompletionsLike {
  create(params: Record<string, unknown>): unknown
}
interface OpenAILike {
  chat: { completions: CompletionsLike }
}

async function* wrapStream(
  stream: AsyncIterable<unknown>,
  session: PiiSession
): AsyncIterable<unknown> {
  const rehydrators = new Map<
    number,
    ReturnType<typeof createStreamingRehydrator>
  >()
  const rehydratorFor = (i: number) => {
    let r = rehydrators.get(i)
    if (!r) {
      r = createStreamingRehydrator(() => session.mapping)
      rehydrators.set(i, r)
    }
    return r
  }

  for await (const raw of stream) {
    const chunk = raw as {
      choices?: Array<{ index?: number; delta?: { content?: string | null } }>
    }
    if (chunk.choices) {
      chunk.choices = chunk.choices.map((choice) => {
        const delta = choice.delta
        if (delta && typeof delta.content === "string") {
          return {
            ...choice,
            delta: {
              ...delta,
              content: rehydratorFor(choice.index ?? 0).push(delta.content),
            },
          }
        }
        return choice
      })
    }
    yield chunk
  }

  for (const [index, r] of rehydrators) {
    const tail = r.flush()
    if (tail) yield { choices: [{ index, delta: { content: tail } }] }
  }
}

/**
 * Wrap an OpenAI (or OpenAI-compatible, e.g. Grok via
 * `baseURL: "https://api.x.ai/v1"`) client so every `chat.completions.create`
 * call is anonymized on the way out and rehydrated on the way back — including
 * streaming deltas and tool-call arguments. The mapping stays in the session;
 * for tools, keep the whole conversation on one wrapped client (one session).
 *
 * ```ts
 * const client = withPiiOpenAI(new OpenAI({ baseURL: "https://api.x.ai/v1", apiKey }))
 * const res = await client.chat.completions.create({ model: "grok-4", messages, tools })
 * ```
 */
export function withPiiOpenAI<T extends OpenAILike>(
  client: T,
  opts: PiiChatOptions = {}
): T {
  const session = resolveSession(opts)
  const create = client.chat.completions.create.bind(client.chat.completions)

  const wrappedCreate = async (params: Record<string, unknown>) => {
    const messages = await anonymizeMessages(
      session,
      (params.messages as ChatMessage[]) ?? []
    )
    const result = await create({ ...params, messages })
    if (params.stream)
      return wrapStream(result as AsyncIterable<unknown>, session)
    const res = result as { choices?: Array<{ message?: ChatMessage }> }
    if (res.choices) {
      res.choices = res.choices.map((c) =>
        c.message ? { ...c, message: rehydrateMessage(session, c.message) } : c
      )
    }
    return res
  }

  const proxyPath = (target: unknown, key: string, value: unknown): unknown =>
    new Proxy(target as object, {
      get(t, p) {
        return p === key ? value : Reflect.get(t, p)
      },
    })

  const completions = proxyPath(
    client.chat.completions,
    "create",
    wrappedCreate
  )
  const chat = proxyPath(client.chat, "completions", completions)
  return proxyPath(client, "chat", chat) as T
}
