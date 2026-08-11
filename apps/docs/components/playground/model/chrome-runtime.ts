import { assertProtectedBrowserRequest } from "./protected-request"
import type {
  BrowserGenerationRuntime,
  ProtectedBrowserTurn,
  RuntimeDisclosure,
} from "./types"
import { managedGeneration } from "./browser-generation-runtime"

export interface ChromePromptSession {
  promptStreaming(
    input: string,
    options?: { readonly signal?: AbortSignal }
  ): ReadableStream<string> | AsyncIterable<string>
  destroy?: () => void | Promise<void>
  close?: () => void | Promise<void>
}

export interface ChromePromptFactory {
  create(options?: {
    readonly initialPrompts?: readonly {
      readonly role: ProtectedBrowserTurn["role"]
      readonly content: string
    }[]
    readonly signal?: AbortSignal
  }): Promise<ChromePromptSession>
}

const CHROME_DISCLOSURE: RuntimeDisclosure = {
  label: "Chrome built-in Prompt API",
  model: "Gemini Nano",
  source: "Chrome built-in Prompt API",
  artifacts: { kind: "browser-managed" },
}

function streamIterator(stream: ReadableStream<string>): AsyncIterator<string> {
  const reader = stream.getReader()
  return {
    next: () => reader.read(),
    async return(reason?: unknown) {
      await reader.cancel(reason)
      return { done: true, value: undefined }
    },
  }
}

function asIterator(
  stream: ReadableStream<string> | AsyncIterable<string>
): AsyncIterator<string> {
  return stream instanceof ReadableStream
    ? streamIterator(stream)
    : stream[Symbol.asyncIterator]()
}

async function destroySession(session: ChromePromptSession): Promise<void> {
  if (session.destroy) {
    await session.destroy()
    return
  }
  await session.close?.()
}

/**
 * Adapt Chrome's browser-managed Prompt API to the generation seam. Discovery
 * is read-only; callers pass the discovered factory after explicit runtime
 * activation.
 */
export function createChromeBrowserRuntime(
  factory: ChromePromptFactory
): BrowserGenerationRuntime {
  let disposed = false
  const active = new Set<Promise<void>>()

  return {
    id: "gemini-nano",
    disclosure: CHROME_DISCLOSURE,
    generate(input) {
      assertProtectedBrowserRequest(input)
      if (disposed) throw new Error("The Chrome browser runtime is disposed")
      let settle!: () => void
      const settled = new Promise<void>((resolve) => {
        settle = resolve
      })
      let started = false
      let session: ChromePromptSession | undefined
      let sessionReleased = false

      const releaseSession = async () => {
        if (!session || sessionReleased) return
        sessionReleased = true
        await destroySession(session)
      }

      const generation = managedGeneration(
        async () => {
          const options = {
            initialPrompts: input.protectedHistory.map(
              ({ role, protectedContent }) => ({
                role,
                content: protectedContent,
              })
            ),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }
          const created = await factory.create(options)
          session = created
          if (input.signal?.aborted) {
            await releaseSession()
            throw input.signal.reason
          }
          return asIterator(
            created.promptStreaming(input.protectedContent, {
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            })
          )
        },
        input.signal,
        async () => {
          // The session is captured by the iterator wrapper so every path,
          // including factory/stream errors, releases exactly one session.
          try {
            await releaseSession()
          } finally {
            settle()
            active.delete(settled)
          }
        }
      )
      return {
        [Symbol.asyncIterator]() {
          const iterator = generation[Symbol.asyncIterator]()
          return {
            [Symbol.asyncIterator]() {
              return this
            },
            next(...args: [] | [undefined]) {
              if (!started) {
                started = true
                active.add(settled)
              }
              return iterator.next(...args)
            },
            return(reason?: unknown) {
              return (
                iterator.return?.(reason) ??
                Promise.resolve({ done: true, value: undefined })
              )
            },
            throw(error?: unknown) {
              return (
                iterator.throw?.(error) ??
                Promise.reject(
                  error ?? new Error("The generation cannot throw")
                )
              )
            },
          }
        },
      }
    },
    async dispose() {
      disposed = true
      await Promise.all([...active])
    },
  }
}

/** Read-only Chrome Prompt API discovery. It never installs or replaces it. */
export function discoverChromePromptFactory(): ChromePromptFactory | undefined {
  if (typeof window === "undefined" || !("LanguageModel" in window)) {
    return undefined
  }
  const candidate = (window as unknown as { LanguageModel?: unknown })
    .LanguageModel
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as { create?: unknown }).create !== "function"
  ) {
    return undefined
  }
  return candidate as ChromePromptFactory
}
