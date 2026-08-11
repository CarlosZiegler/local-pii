import type { LanguageModelFactory } from "./prompt-runtime"
import {
  managedGeneration,
  trackActiveGeneration,
  waitForActiveGenerations,
} from "./browser-generation-runtime"
import {
  assertProtectedBrowserRequest,
  createProtectedBrowserRequest,
} from "./protected-request"
import type {
  BrowserGenerationRuntime,
  ProtectedBrowserTurn,
  RuntimeDisclosure,
} from "./types"

const MODEL_ID = "onnx-community/gemma-3-270m-it-ONNX"
const MODEL_REVISION = "2dbbfdb1b59bd034eb959428c6a7da9dd7ea27f0"

function compatibleRole(role: unknown): ProtectedBrowserTurn["role"] {
  if (role === "system") return "system"
  if (role === "assistant") return "assistant"
  return "user"
}

interface InterruptableCriteria {
  interrupt(): void
}

interface TextStreamerInstance {}

interface TextGenerator {
  (
    prompt: string,
    options: {
      add_special_tokens: false
      do_sample: false
      max_new_tokens: 512
      return_full_text: false
      stopping_criteria: InterruptableCriteria[]
      streamer: TextStreamerInstance
    }
  ): Promise<unknown>
  tokenizer: {
    apply_chat_template(
      messages: Array<{ role: string; content: string }>,
      options: {
        add_generation_prompt: true
        tokenize: false
      }
    ): string
  }
  dispose: () => void | Promise<void>
}

interface TransformersRuntime {
  env?: { experimental_useCrossOriginStorage?: boolean }
  InterruptableStoppingCriteria: new () => InterruptableCriteria
  pipeline(
    task: "text-generation",
    model: string,
    options: {
      device: "webgpu"
      dtype: "q4f16"
      revision: string
      progress_callback(event: { progress?: number; status?: string }): void
    }
  ): Promise<TextGenerator>
  TextStreamer: new (
    tokenizer: TextGenerator["tokenizer"],
    options: {
      callback_function(value: string): void
      skip_prompt: true
      skip_special_tokens: true
    }
  ) => TextStreamerInstance
}

export interface GemmaRuntimeDependencies {
  /** Injected by tests; production uses the lazy Transformers.js import. */
  loadTransformers?: () => Promise<unknown>
  onProgress?: (progress: number) => void
}

export const GEMMA_RUNTIME_DISCLOSURE: RuntimeDisclosure = {
  label: "Gemma 3 270M IT",
  model: MODEL_ID,
  source: "Transformers.js browser runtime",
  artifacts: {
    kind: "explicit-download",
    approximateBytes: 293_284_073,
    origins: ["https://huggingface.co", "https://*.cdn.hf.co"],
  },
}

function createTextIterator(
  generator: TextGenerator,
  transformers: TransformersRuntime,
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal
): AsyncIterator<string> {
  const criteria = new transformers.InterruptableStoppingCriteria()
  let finished = false
  let returned = false
  let failed = false
  let failure: unknown
  const queue: string[] = []
  let waiter:
    | {
        resolve: (result: IteratorResult<string>) => void
        reject: (reason: unknown) => void
      }
    | undefined

  const finish = () => {
    finished = true
    if (failed) waiter?.reject(failure)
    else waiter?.resolve({ done: true, value: undefined })
    waiter = undefined
  }

  const push = (value: string) => {
    if (returned || signal?.aborted) return
    if (waiter) {
      waiter.resolve({ done: false, value })
      waiter = undefined
    } else {
      queue.push(value)
    }
  }

  const formatted = generator.tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    tokenize: false,
  })
  const streamer = new transformers.TextStreamer(generator.tokenizer, {
    callback_function: push,
    skip_prompt: true,
    skip_special_tokens: true,
  })
  const generation = generator(formatted, {
    add_special_tokens: false,
    do_sample: false,
    max_new_tokens: 512,
    return_full_text: false,
    stopping_criteria: [criteria],
    streamer,
  }).catch((error) => {
    if (!returned) {
      failed = true
      failure = error
    }
  })
  void generation.then(finish)

  return {
    async next() {
      if (queue.length > 0) return { done: false, value: queue.shift()! }
      if (failed) throw failure
      if (finished || returned) return { done: true, value: undefined }
      return new Promise<IteratorResult<string>>((resolve, reject) => {
        waiter = { resolve, reject }
      })
    },
    async return() {
      returned = true
      criteria.interrupt()
      waiter?.resolve({ done: true, value: undefined })
      waiter = undefined
      await generation
      return { done: true, value: undefined }
    },
  }
}

function protectedMessages(
  history: readonly ProtectedBrowserTurn[],
  current: string
): Array<{ role: string; content: string }> {
  return [
    ...history.map(({ role, protectedContent }) => ({
      role,
      content: protectedContent,
    })),
    { role: "user", content: current },
  ]
}

function validateConversation(history: readonly ProtectedBrowserTurn[]): void {
  let expected: "system" | "user" | "assistant" =
    history[0]?.role === "system" ? "system" : "user"
  let sawSystem = false
  for (const turn of history) {
    if (turn.role === "system") {
      if (sawSystem || turn !== history[0]) {
        throw new TypeError(
          "Gemma generation accepts at most one leading system turn"
        )
      }
      sawSystem = true
      expected = "user"
      continue
    }
    if (turn.role !== expected) {
      throw new TypeError(
        "Gemma generation requires alternating user and assistant turns"
      )
    }
    expected = turn.role === "user" ? "assistant" : "user"
  }
  // The current protected content is always a user turn.
  if (expected !== "user") {
    throw new TypeError(
      "Gemma generation requires the current turn after an assistant turn"
    )
  }
}

/**
 * Explicitly activated Gemma browser runtime. Transformers.js is not loaded
 * by construction; the first generation performs the lazy import and caches
 * one reusable q4f16 WebGPU generator for subsequent runs.
 */
export function createGemmaBrowserRuntime(
  dependencies: GemmaRuntimeDependencies = {}
): BrowserGenerationRuntime {
  const loadTransformers =
    dependencies.loadTransformers ??
    (async () =>
      (await import("@huggingface/transformers")) as unknown as TransformersRuntime)
  let generatorPromise:
    | Promise<{
        generator: TextGenerator
        transformers: TransformersRuntime
      }>
    | undefined
  let disposed = false
  const active = new Set<Promise<void>>()
  let runtimeDisposePromise: Promise<void> | undefined
  const generatorDisposals = new WeakMap<object, Promise<void>>()

  const disposeGenerator = (generator: TextGenerator): Promise<void> => {
    const key = generator as object
    const existing = generatorDisposals.get(key)
    if (existing) return existing
    let resolveDisposal!: () => void
    let rejectDisposal!: (error: unknown) => void
    const disposal = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve
      rejectDisposal = reject
    })
    generatorDisposals.set(key, disposal)
    void Promise.resolve()
      .then(() => generator.dispose())
      .then(resolveDisposal, rejectDisposal)
    void disposal.catch(() => undefined)
    return disposal
  }

  const loadGenerator = () => {
    generatorPromise ??= loadTransformers()
      .then(async (loaded) => {
        const transformers = loaded as TransformersRuntime
        if (transformers.env) {
          transformers.env.experimental_useCrossOriginStorage = false
        }
        const generator = await transformers.pipeline(
          "text-generation",
          MODEL_ID,
          {
            device: "webgpu",
            dtype: "q4f16",
            revision: MODEL_REVISION,
            progress_callback(event) {
              if (event.status === "ready") dependencies.onProgress?.(1)
              else if (
                event.status === "progress_total" &&
                event.progress !== undefined
              ) {
                dependencies.onProgress?.(event.progress / 100)
              }
            },
          }
        )
        return { generator, transformers }
      })
      .catch((error) => {
        generatorPromise = undefined
        throw error
      })
    return generatorPromise
  }

  return {
    id: "gemma-3-270m",
    disclosure: GEMMA_RUNTIME_DISCLOSURE,
    generate(input) {
      const request = input
      // Runtime callers must cross the same private marker as every other
      // browser adapter. This is intentionally a runtime assertion, not a
      // cast: an unprotected object must fail before model loading.
      assertProtectedBrowserRequest(request)
      validateConversation(request.protectedHistory)

      const createGeneration = () =>
        managedGeneration(async () => {
          if (disposed) {
            throw new Error("The Gemma browser runtime is disposed")
          }
          request.signal?.throwIfAborted()
          const loading = loadGenerator()
          const { generator, transformers } = await loading
          if (disposed) {
            await disposeGenerator(generator)
            throw new Error("The Gemma browser runtime is disposed")
          }
          if (request.signal?.aborted) {
            // The pipeline is shared by all runs. A run-level abort only
            // interrupts that run; runtime.dispose owns the shared cache.
            throw request.signal.reason
          }
          return createTextIterator(
            generator,
            transformers,
            protectedMessages(
              request.protectedHistory,
              request.protectedContent
            ),
            request.signal
          )
        }, request.signal)
      return {
        [Symbol.asyncIterator]() {
          return trackActiveGeneration(createGeneration(), active)[
            Symbol.asyncIterator
          ]()
        },
      }
    },
    async dispose() {
      runtimeDisposePromise ??= (async () => {
        disposed = true
        let activeFailed = false
        let activeError: unknown
        try {
          await waitForActiveGenerations(active)
        } catch (error) {
          activeFailed = true
          activeError = error
        }

        let disposalFailed = false
        let disposalError: unknown
        try {
          const loaded = generatorPromise
          generatorPromise = undefined
          if (loaded) {
            const { generator } = await loaded
            await disposeGenerator(generator)
          }
        } catch (error) {
          disposalFailed = true
          disposalError = error
        }

        // Active-run cleanup has deterministic precedence, but shared
        // pipeline disposal is always attempted before reporting either.
        if (activeFailed) throw activeError
        if (disposalFailed) throw disposalError
      })()
      return runtimeDisposePromise
    },
  }
}

/**
 * Compatibility factory for the pre-seam controller. It delegates generation
 * to the same runtime and never mutates the Prompt API global. New code should
 * use createGemmaBrowserRuntime directly.
 */
export async function createGemmaLanguageModelFactory(
  dependencies: GemmaRuntimeDependencies = {}
): Promise<LanguageModelFactory> {
  const runtime = createGemmaBrowserRuntime(dependencies)
  return {
    async availability() {
      return "available"
    },
    async create(options = {}) {
      options.signal?.throwIfAborted()
      let destroyed = false
      const activeIterators = new Set<AsyncIterator<string>>()
      const history = (options.initialPrompts ?? []).map((message) => ({
        role: compatibleRole(message.role),
        protectedContent:
          typeof message.content === "string"
            ? message.content
            : message.content
                .map((part) => {
                  if (part.type !== "text")
                    throw new DOMException(
                      "The Gemma fallback supports text content only",
                      "NotSupportedError"
                    )
                  return part.value
                })
                .join(""),
      })) as ProtectedBrowserTurn[]
      const session = {
        async promptStreaming(
          input: LanguageModelPrompt,
          promptOptions: LanguageModelPromptOptions = {}
        ) {
          if (destroyed) {
            throw new DOMException(
              "The compatibility session has been destroyed",
              "InvalidStateError"
            )
          }
          const content =
            typeof input === "string"
              ? input
              : (input
                  .map((message) => ({
                    role: compatibleRole(message.role as unknown),
                    content:
                      typeof message.content === "string"
                        ? message.content
                        : message.content
                            .map((part) => {
                              if (part.type !== "text")
                                throw new DOMException(
                                  "The Gemma fallback supports text content only",
                                  "NotSupportedError"
                                )
                              return part.value
                            })
                            .join(""),
                  }))
                  .at(-1)?.content ?? "")
          const request = createProtectedBrowserRequest({
            protectedHistory: history,
            protectedContent: content,
            signal: promptOptions.signal,
          })
          const iterator = runtime.generate(request)[Symbol.asyncIterator]()
          activeIterators.add(iterator)
          const release = () => activeIterators.delete(iterator)
          return new ReadableStream<string>({
            async pull(controller) {
              try {
                const next = await iterator.next()
                if (next.done) {
                  release()
                  controller.close()
                } else controller.enqueue(next.value)
              } catch (error) {
                try {
                  await iterator.return?.()
                } catch {
                  // Preserve the generation error as the primary stream error.
                }
                release()
                controller.error(error)
              }
            },
            async cancel(reason) {
              try {
                await iterator.return?.(reason)
              } finally {
                release()
              }
            },
          })
        },
        destroy() {
          destroyed = true
          for (const iterator of activeIterators) {
            void Promise.resolve(iterator.return?.())
              .catch(() => undefined)
              .finally(() => activeIterators.delete(iterator))
          }
        },
      }
      return session as unknown as LanguageModel
    },
  }
}
