import { assertProtectedBrowserRequest } from "./protected-request"
import type {
  BrowserGenerationRuntime,
  ProtectedBrowserTurn,
  RuntimeDisclosure,
} from "./types"
import {
  managedGeneration,
  trackActiveGeneration,
  waitForActiveGenerations,
} from "./browser-generation-runtime"

export interface ChromePromptSession {
  promptStreaming(
    input: string,
    options?: { readonly signal?: AbortSignal }
  ): ReadableStream<string> | AsyncIterable<string>
  destroy: () => void | Promise<void>
}

export const CHROME_TEXT_EXPECTATIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
} satisfies Pick<
  LanguageModelCreateCoreOptions,
  "expectedInputs" | "expectedOutputs"
>

export interface ChromePromptCreateOptions {
  readonly expectedInputs?: readonly LanguageModelExpected[]
  readonly expectedOutputs?: readonly LanguageModelExpected[]
  readonly initialPrompts?: readonly {
    readonly role: ProtectedBrowserTurn["role"]
    readonly content: string
  }[]
  readonly signal?: AbortSignal
}

export interface ChromePromptFactory {
  create(options?: ChromePromptCreateOptions): Promise<ChromePromptSession>
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
  await session.destroy()
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
      const createGeneration = () => {
        let session: ChromePromptSession | undefined
        let sessionReleased = false

        const releaseSession = async () => {
          if (!session || sessionReleased) return
          sessionReleased = true
          await destroySession(session)
        }

        return managedGeneration(
          async () => {
            if (disposed) {
              throw new Error("The Chrome browser runtime is disposed")
            }
            const options = {
              ...CHROME_TEXT_EXPECTATIONS,
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
            if (disposed || input.signal?.aborted) {
              await releaseSession()
              throw (
                input.signal?.reason ??
                new Error("The Chrome browser runtime is disposed")
              )
            }
            return asIterator(
              created.promptStreaming(input.protectedContent, {
                ...(input.signal === undefined ? {} : { signal: input.signal }),
              })
            )
          },
          input.signal,
          () => releaseSession()
        )
      }
      return {
        [Symbol.asyncIterator]() {
          return trackActiveGeneration(createGeneration(), active)[
            Symbol.asyncIterator
          ]()
        },
      }
    },
    async dispose() {
      disposed = true
      await waitForActiveGenerations(active)
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
    (typeof candidate !== "object" && typeof candidate !== "function") ||
    typeof (candidate as { create?: unknown }).create !== "function"
  ) {
    return undefined
  }
  return candidate as ChromePromptFactory
}
