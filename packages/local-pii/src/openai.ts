import { createAnonymizer, type Anonymizer } from "./anonymizer"
import {
  protectOpenAIMessages,
  restoreOpenAICompletion,
  restoreOpenAIMessage,
} from "./openai-content"
import { restoreOpenAIStream, throwIfOpenAIAborted } from "./openai-stream"
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
  [key: string]: unknown
}

export interface ChatToolCall {
  id?: string
  type?: string
  function: {
    name: string
    arguments: string
    [key: string]: unknown
  }
  [key: string]: unknown
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
    anonymizeMessages: (messages) =>
      protectOpenAIMessages(session, messages) as Promise<ChatMessage[]>,
    rehydrateText: (text) => session.rehydrate(text, { lenient: true }),
    rehydrateMessage: (message) => restoreOpenAIMessage(session, message),
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

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { aborted?: unknown }).aborted === "boolean"
  )
}

/**
 * Wrap an OpenAI (or OpenAI-compatible, e.g. Grok via
 * `baseURL: "https://api.x.ai/v1"`) client so every
 * `chat.completions.create` call is anonymized on the way out and rehydrated
 * on the way back — including streaming deltas and tool-call arguments. The
 * mapping stays in the session; for tools, keep the whole conversation on one
 * wrapped client (one session).
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
    const signal = isAbortSignal(params.signal) ? params.signal : undefined
    // This check must happen before touching the session or provider.
    throwIfOpenAIAborted(signal)
    const originalMessages = Array.isArray(params.messages)
      ? params.messages
      : []
    const messages = await protectOpenAIMessages(session, originalMessages)
    // Protection may itself be asynchronous; aborting during it must prevent
    // the provider call and preserve the signal's reason identity.
    throwIfOpenAIAborted(signal)

    const result = await create({ ...params, messages })
    if (params.stream) {
      return restoreOpenAIStream(
        session,
        result as AsyncIterable<unknown>,
        signal
      )
    }
    return restoreOpenAICompletion(session, result)
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
