import type { LanguageModelFactory } from "./prompt-runtime"
import {
  generationAbort,
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
const CONTEXT_WINDOW = 4096

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

function promptMessageContent(
  content: string | readonly { type: string; value: unknown }[]
): string {
  if (typeof content === "string") return content
  return content
    .map((part) => {
      if (part.type !== "text" || typeof part.value !== "string") {
        throw new DOMException(
          "The Gemma fallback supports text content only",
          "NotSupportedError"
        )
      }
      return part.value
    })
    .join("")
}

function promptTurns(input: LanguageModelPrompt): ProtectedBrowserTurn[] {
  if (typeof input === "string") {
    return [{ role: "user", protectedContent: input }]
  }
  return input.map((message) => ({
    role: compatibleRole(message.role),
    protectedContent: promptMessageContent(message.content),
  }))
}

function validateHistory(history: readonly ProtectedBrowserTurn[]): void {
  let expected: "user" | "assistant" = "user"
  let sawSystem = false
  for (const [index, turn] of history.entries()) {
    if (turn.role === "system") {
      if (sawSystem || index !== 0) {
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
}

function validateConversation(history: readonly ProtectedBrowserTurn[]): void {
  validateHistory(history)
  // The current protected content is always a user turn.
  if (history.at(-1)?.role === "user") {
    throw new TypeError(
      "Gemma generation requires the current turn after an assistant turn"
    )
  }
}

/** A stable, deliberately simple estimate for the compatibility API. */
function estimateUsage(history: readonly ProtectedBrowserTurn[]): number {
  const characters = history.reduce(
    (total, turn) => total + turn.protectedContent.length,
    0
  )
  return Math.ceil(characters / 4)
}

function composeAbortSignals(
  sessionSignal: AbortSignal,
  callerSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  let cleaned = false
  let cleanup = () => {}

  const abortFrom = (source: AbortSignal) => {
    if (controller.signal.aborted) return
    controller.abort(source.reason)
    cleanup()
  }
  const onSessionAbort = () => abortFrom(sessionSignal)
  const onCallerAbort = () => {
    if (callerSignal) abortFrom(callerSignal)
  }

  if (callerSignal?.aborted) {
    abortFrom(callerSignal)
  } else if (sessionSignal.aborted) {
    abortFrom(sessionSignal)
  } else {
    sessionSignal.addEventListener("abort", onSessionAbort)
    callerSignal?.addEventListener("abort", onCallerAbort)
  }

  cleanup = () => {
    if (cleaned) return
    cleaned = true
    sessionSignal.removeEventListener("abort", onSessionAbort)
    callerSignal?.removeEventListener("abort", onCallerAbort)
  }
  return { signal: controller.signal, cleanup }
}

class GemmaCompatibilitySession extends EventTarget implements LanguageModel {
  get contextUsage(): number {
    return estimateUsage(this.history)
  }

  get inputUsage(): number {
    return this.contextUsage
  }

  get contextWindow(): number {
    return CONTEXT_WINDOW
  }

  get inputQuota(): number {
    return CONTEXT_WINDOW
  }

  topK = 0
  temperature = 0
  oncontextoverflow: ((this: LanguageModel, ev: Event) => unknown) | null = null
  onquotaoverflow: ((this: LanguageModel, ev: Event) => unknown) | null = null

  private readonly sessionAbort = new AbortController()
  private readonly sessionAbortReason = new DOMException(
    "The compatibility session was destroyed",
    "AbortError"
  )
  private readonly activeIterators = new Set<AsyncIterator<string>>()
  private readonly activeReleases = new Map<AsyncIterator<string>, () => void>()
  private destroyed = false

  constructor(
    private readonly runtime: BrowserGenerationRuntime,
    private readonly history: ProtectedBrowserTurn[]
  ) {
    super()
    validateHistory(history)
  }

  private ensureActive(): void {
    if (this.destroyed) {
      throw new DOMException(
        "The compatibility session has been destroyed",
        "InvalidStateError"
      )
    }
  }

  private requestFor(input: LanguageModelPrompt): {
    history: ProtectedBrowserTurn[]
    current: string
    incoming: ProtectedBrowserTurn[]
  } {
    const turns = promptTurns(input)
    const final = turns.at(-1)
    if (
      !final ||
      final.role !== "user" ||
      final.protectedContent.trim() === ""
    ) {
      throw new TypeError(
        "The final compatibility prompt must be non-empty user text"
      )
    }
    const history = [...this.history, ...turns.slice(0, -1)]
    validateConversation(history)
    validateHistory([...history, final])
    return { history, current: final.protectedContent, incoming: turns }
  }

  private commitPrompt(
    incoming: readonly ProtectedBrowserTurn[],
    output: string
  ): void {
    this.ensureActive()
    const nextHistory: ProtectedBrowserTurn[] = [
      ...this.history,
      ...incoming,
      { role: "assistant", protectedContent: output },
    ]
    validateHistory(nextHistory)
    this.history.splice(0, this.history.length, ...nextHistory)
  }

  promptStreaming(
    input: LanguageModelPrompt,
    options: LanguageModelPromptOptions = {}
  ): ReadableStream<string> {
    this.ensureActive()
    options.signal?.throwIfAborted()
    const { history, current, incoming } = this.requestFor(input)
    const composed = composeAbortSignals(
      this.sessionAbort.signal,
      options.signal
    )
    let iterator: AsyncIterator<string>
    try {
      const request = createProtectedBrowserRequest({
        protectedHistory: history,
        protectedContent: current,
        signal: composed.signal,
      })
      iterator = this.runtime.generate(request)[Symbol.asyncIterator]()
      this.activeIterators.add(iterator)
    } catch (error) {
      composed.cleanup()
      throw error
    }

    let released = false
    let output = ""
    let cancelled = false
    const release = () => {
      if (released) return
      released = true
      composed.cleanup()
      this.activeIterators.delete(iterator)
      this.activeReleases.delete(iterator)
    }
    this.activeReleases.set(iterator, release)
    const session = this
    return new ReadableStream<string>({
      async pull(controller) {
        try {
          const next = await iterator.next()
          if (cancelled) {
            release()
            return
          }
          if (next.done) {
            try {
              session.commitPrompt(incoming, output)
              release()
              controller.close()
            } catch (error) {
              release()
              controller.error(error)
            }
          } else {
            output += next.value
            controller.enqueue(next.value)
          }
        } catch (error) {
          try {
            await iterator.return?.()
          } catch {
            // Preserve the generation or abort error as the primary stream error.
          }
          release()
          controller.error(error)
        }
      },
      async cancel(reason) {
        cancelled = true
        try {
          await iterator.return?.(reason)
        } finally {
          release()
        }
      },
    })
  }

  async prompt(
    input: LanguageModelPrompt,
    options: LanguageModelPromptOptions = {}
  ): Promise<string> {
    const stream = this.promptStreaming(input, options)
    const reader = stream.getReader()
    let output = ""
    while (true) {
      const next = await reader.read()
      if (next.done) return output
      output += next.value
    }
  }

  async append(
    input: LanguageModelPrompt,
    options: LanguageModelAppendOptions = {}
  ): Promise<undefined> {
    this.ensureActive()
    options.signal?.throwIfAborted()
    const turns = promptTurns(input)
    validateHistory([...this.history, ...turns])
    this.history.push(...turns)
    return undefined
  }

  async measureContextUsage(
    input: LanguageModelPrompt,
    options: LanguageModelPromptOptions = {}
  ): Promise<number> {
    this.ensureActive()
    options.signal?.throwIfAborted()
    const { incoming } = this.requestFor(input)
    return estimateUsage(incoming)
  }

  async measureInputUsage(
    input: LanguageModelPrompt,
    options: LanguageModelPromptOptions = {}
  ): Promise<number> {
    return this.measureContextUsage(input, options)
  }

  async clone(options: LanguageModelCloneOptions = {}): Promise<LanguageModel> {
    this.ensureActive()
    options.signal?.throwIfAborted()
    return new GemmaCompatibilitySession(this.runtime, [...this.history])
  }

  destroy(): undefined {
    if (this.destroyed) return undefined
    this.destroyed = true
    this.sessionAbort.abort(this.sessionAbortReason)
    for (const iterator of this.activeIterators) {
      this.activeReleases.get(iterator)?.()
      void Promise.resolve()
        .then(() => {
          const abort = (
            iterator as AsyncIterator<string> & {
              [generationAbort]?: (
                reason: unknown
              ) => Promise<IteratorResult<string>>
            }
          )[generationAbort]
          return (
            abort?.(this.sessionAbortReason) ??
            iterator.throw?.(this.sessionAbortReason)
          )
        })
        .catch(() => undefined)
        .then(() => iterator.return?.(this.sessionAbortReason))
        .catch(() => undefined)
        .finally(() => this.activeIterators.delete(iterator))
    }
    return undefined
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
      const history = (options.initialPrompts ?? []).map((message) => ({
        role: compatibleRole(message.role),
        protectedContent: promptMessageContent(message.content),
      })) as ProtectedBrowserTurn[]
      validateHistory(history)
      return new GemmaCompatibilitySession(runtime, history)
    },
  }
}
