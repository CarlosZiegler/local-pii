import { createAnonymizer, type Anonymizer } from "./anonymizer"
import {
  cloneOpenAIValue,
  protectOpenAIMessages,
  restoreOpenAICompletion,
  restoreOpenAIMessage,
  restoreOpenAIParseCompletion,
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
  create(params: Record<string, unknown>, options?: unknown): unknown
}
type ParseLike = (params: Record<string, unknown>, options?: unknown) => unknown
interface OpenAILike {
  chat: { completions: CompletionsLike }
}

/** Thrown when an SDK helper would bypass the protected create path. */
export class PiiOpenAIHelperError extends Error {
  constructor(helper: string) {
    super(
      `OpenAI ${helper}() cannot be wrapped safely; call chat.completions.create({ stream: true }) through the protected client`
    )
    this.name = "PiiOpenAIHelperError"
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { aborted?: unknown }).aborted === "boolean"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

function requestSignal(
  body: Record<string, unknown>,
  options: unknown
): AbortSignal | undefined {
  const optionsSignal = isRecord(options) ? options.signal : undefined
  return isAbortSignal(optionsSignal)
    ? optionsSignal
    : isAbortSignal(body.signal)
      ? body.signal
      : undefined
}

type ApiInvocation<T> = Promise<T> & {
  asResponse?: (...args: unknown[]) => Promise<unknown>
  withResponse?: (...args: unknown[]) => Promise<unknown>
}

const COMPLETION_CRUD_HELPERS = new Set([
  "retrieve",
  "update",
  "list",
  "delete",
])
const OBJECT_FUNCTIONS = new Set([
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
])

function deferredApiPromise<T>(
  handleReady: Promise<{ value: unknown }>,
  restore: (value: unknown) => T
): ApiInvocation<T> {
  void handleReady.catch(() => undefined)
  let operation: Promise<T> | undefined
  const getOperation = (): Promise<T> => {
    if (!operation) {
      operation = handleReady
        .then(({ value }) => value)
        .then((value) => restore(value))
      void operation.catch(() => undefined)
    }
    return operation
  }
  const helper =
    (name: "asResponse" | "withResponse") =>
    (...args: unknown[]): Promise<unknown> =>
      handleReady.then(async ({ value: rawResult }) => {
        const raw = rawResult as ApiInvocation<unknown> | undefined
        const method = raw?.[name]
        if (typeof method !== "function") {
          if (name === "withResponse")
            return getOperation().then((restored) => ({ data: restored }))
          throw new TypeError(`OpenAI APIPromise does not support ${name}()`)
        }
        const envelope = await method.apply(raw, args)
        if (name === "asResponse") return envelope
        if (isRecord(envelope) && "data" in envelope)
          return cloneOpenAIValue(envelope, {
            data: restore(envelope.data),
          })
        return isRecord(envelope)
          ? cloneOpenAIValue(envelope, { data: restore(undefined) })
          : { data: restore(undefined), envelope }
      })

  const target = Promise.resolve(undefined) as ApiInvocation<T>
  return new Proxy(target, {
    get(target, property) {
      if (
        property === "then" ||
        property === "catch" ||
        property === "finally"
      ) {
        const operationTarget = getOperation()
        return Reflect.get(operationTarget, property, operationTarget).bind(
          operationTarget
        )
      }
      if (property === "asResponse" || property === "withResponse")
        return helper(property)
      const value = Reflect.get(target, property, target)
      if (value !== undefined) return value
      return () => {
        throw new PiiOpenAIHelperError(`APIPromise.${String(property)}`)
      }
    },
  })
}

function protectedInvocation<T>(
  session: PiiSession,
  body: Record<string, unknown>,
  options: unknown,
  invoke: (body: Record<string, unknown>, options?: unknown) => unknown,
  restore: (result: unknown) => T
): ApiInvocation<T> {
  let resolveHandle: (value: { value: unknown }) => void = () => undefined
  let rejectHandle: (reason: unknown) => void = () => undefined
  const handleReady = new Promise<{ value: unknown }>((resolve, reject) => {
    resolveHandle = resolve
    rejectHandle = reject
  })
  void (async () => {
    try {
      const signal = requestSignal(body, options)
      // Check before protection and before invoking the provider.
      throwIfOpenAIAborted(signal)
      const originalMessages = Array.isArray(body.messages) ? body.messages : []
      const messages = await protectOpenAIMessages(session, originalMessages)
      throwIfOpenAIAborted(signal)
      const rawResult =
        options === undefined
          ? invoke({ ...body, messages })
          : invoke({ ...body, messages }, options)
      resolveHandle({ value: rawResult })
    } catch (error) {
      rejectHandle(error)
    }
  })()
  return deferredApiPromise(handleReady, restore)
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
  const targetCompletions = client.chat.completions
  const create = targetCompletions.create.bind(targetCompletions)
  const parse =
    typeof (targetCompletions as unknown as { parse?: unknown }).parse ===
    "function"
      ? (targetCompletions as unknown as { parse: ParseLike }).parse.bind(
          targetCompletions
        )
      : undefined

  const failClosedError = (helper: string): never => {
    throw new PiiOpenAIHelperError(helper)
  }

  const wrappedCreate = (params: Record<string, unknown>, options?: unknown) =>
    protectedInvocation(session, params, options, create, (result) =>
      params.stream
        ? (restoreOpenAIStream(
            session,
            result as AsyncIterable<unknown>,
            requestSignal(params, options),
            failClosedError
          ) as never)
        : restoreOpenAICompletion(session, result)
    )

  const wrappedParse = parse
    ? (params: Record<string, unknown>, options?: unknown) =>
        protectedInvocation(session, params, options, parse, (result) =>
          restoreOpenAIParseCompletion(session, result)
        )
    : undefined

  const failClosed = (helper: string) => () => failClosedError(helper)

  const completions = new Proxy(targetCompletions as object, {
    get(target, property) {
      if (property === "create") return wrappedCreate
      if (property === "parse" && wrappedParse) return wrappedParse
      if (property === "stream" || property === "runTools")
        return failClosed(String(property))
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (
        typeof property === "string" &&
        (COMPLETION_CRUD_HELPERS.has(property) ||
          OBJECT_FUNCTIONS.has(property))
      )
        return value.bind(target)
      return failClosed(property.toString())
    },
  })

  const chat = new Proxy(client.chat as object, {
    get(target, property) {
      if (property === "completions") return completions
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return new Proxy(client as object, {
    get(target, property) {
      if (property === "chat") return chat
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as T
}
