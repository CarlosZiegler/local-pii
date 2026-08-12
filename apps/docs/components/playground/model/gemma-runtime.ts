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
import type { BrowserGenerationRuntime, ProtectedBrowserTurn } from "./types"
import {
  GEMMA_ARTIFACT_BASE_URL,
  GEMMA_ARTIFACT_URLS,
  GEMMA_CACHE_NAME,
  GEMMA_MODEL_REVISION,
  GEMMA_RUNTIME_DISCLOSURE,
} from "./runtime-metadata"

export { GEMMA_RUNTIME_DISCLOSURE } from "./runtime-metadata"

/** Compatibility factory retained for the browser Prompt API test seam. */
interface LanguageModelFactory {
  availability(options?: LanguageModelCreateCoreOptions): Promise<Availability>
  create(options?: LanguageModelCreateOptions): Promise<LanguageModel>
}

const MODEL_REVISION = GEMMA_MODEL_REVISION
// Pinned Gemma 3 270M config: max_position_embeddings is 32768.
const CONTEXT_WINDOW = 32_768

function compatibleRole(role: unknown): ProtectedBrowserTurn["role"] {
  if (role === "system") return "system"
  if (role === "user") return "user"
  if (role === "assistant") return "assistant"
  throw new TypeError(
    `The Gemma fallback does not support the ${String(role)} message role`
  )
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

interface DisposableResource {
  dispose?: () => void | Promise<void>
}

interface TransformersOptions {
  readonly revision: string
  readonly config?: unknown
  readonly device?: "webgpu"
  readonly dtype?: "q4f16"
}

interface TransformersRuntime {
  env?: { experimental_useCrossOriginStorage?: boolean }
  InterruptableStoppingCriteria: new () => InterruptableCriteria
  AutoConfig: {
    from_pretrained(
      model: string,
      options: { readonly revision: string }
    ): Promise<unknown>
  }
  AutoTokenizer: {
    from_pretrained(
      model: string,
      options: TransformersOptions
    ): Promise<TextGenerator["tokenizer"]>
  }
  AutoModelForCausalLM: {
    from_pretrained(
      model: string,
      options: TransformersOptions
    ): Promise<DisposableResource>
  }
  TextGenerationPipeline: new (options: {
    readonly task: "text-generation"
    readonly model: DisposableResource
    readonly tokenizer: TextGenerator["tokenizer"]
  }) => TextGenerator
  TextStreamer: new (
    tokenizer: TextGenerator["tokenizer"],
    options: {
      callback_function(value: string): void
      skip_prompt: true
      skip_special_tokens: true
    }
  ) => TextStreamerInstance
}

interface GemmaArtifactCache {
  match(request: string): Promise<Response | undefined>
  put(request: string, response: Response): Promise<void>
}

interface GemmaArtifactCacheStorage {
  open(name: string): Promise<GemmaArtifactCache>
}

export interface GemmaRuntimeDependencies {
  /** Injected by tests; production uses the lazy Transformers.js import. */
  loadTransformers?: () => Promise<unknown>
  onProgress?: (progress: number) => void
  /** Internal seams for the cancellable, pinned artifact prefetch. */
  fetch?: (
    input: string,
    init?: { readonly signal?: AbortSignal }
  ) => Promise<Response>
  cacheStorage?: GemmaArtifactCacheStorage
}

export interface PreparedGemmaBrowserRuntime extends BrowserGenerationRuntime {
  prepare(signal?: AbortSignal): Promise<void>
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

function awaitSignal<T>(value: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return value
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const remove = () => signal.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      remove()
      reject(signal.reason)
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })
    value.then(
      (result) => {
        if (settled) return
        settled = true
        remove()
        resolve(result)
      },
      (cause) => {
        if (settled) return
        settled = true
        remove()
        reject(cause)
      }
    )
  })
}

async function ensurePinnedArtifacts(
  dependencies: GemmaRuntimeDependencies,
  signal: AbortSignal | undefined,
  onProgress: ((progress: number) => void) | undefined
): Promise<void> {
  const storage =
    dependencies.cacheStorage ??
    (typeof caches === "undefined" ? undefined : caches)
  if (!storage) {
    throw new Error("The browser Cache API is required for Gemma activation")
  }
  const cache = await storage.open(GEMMA_CACHE_NAME)
  const missing: string[] = []
  for (const url of GEMMA_ARTIFACT_URLS) {
    if (!(await cache.match(url))) missing.push(url)
  }
  let complete = GEMMA_ARTIFACT_URLS.length - missing.length
  onProgress?.(complete / GEMMA_ARTIFACT_URLS.length)
  const fetchArtifact =
    dependencies.fetch ??
    (typeof fetch === "function"
      ? (input: string, init?: { readonly signal?: AbortSignal }) =>
          fetch(input, init)
      : undefined)
  if (!fetchArtifact) throw new Error("Fetch is required for Gemma activation")

  for (const url of missing) {
    signal?.throwIfAborted()
    const response = await fetchArtifact(url, { signal })
    if (!response.ok) {
      const failure = new Error(
        `Unable to download Gemma artifact: ${response.status}`
      )
      try {
        await response.body?.cancel()
      } catch {
        // Preserve the HTTP failure as the primary error.
      }
      throw failure
    }
    await cache.put(url, response)
    complete += 1
    onProgress?.(complete / GEMMA_ARTIFACT_URLS.length)
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

function ensureContextWithinWindow(
  history: readonly ProtectedBrowserTurn[]
): void {
  const usage = estimateUsage(history)
  if (usage > CONTEXT_WINDOW) {
    throw new RangeError(
      `The Gemma compatibility context exceeds its ${CONTEXT_WINDOW}-token window`
    )
  }
}

function quotaExceeded(): DOMException {
  return new DOMException(
    `The Gemma compatibility context exceeds its ${CONTEXT_WINDOW}-token window`,
    "QuotaExceededError"
  )
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
  private contextOverflowHandler:
    ((this: LanguageModel, ev: Event) => unknown) | null = null
  private contextOverflowListener: EventListener | null = null
  private quotaOverflowHandler:
    ((this: LanguageModel, ev: Event) => unknown) | null = null
  private quotaOverflowListener: EventListener | null = null

  get oncontextoverflow():
    ((this: LanguageModel, ev: Event) => unknown) | null {
    return this.contextOverflowHandler
  }

  set oncontextoverflow(
    handler: ((this: LanguageModel, ev: Event) => unknown) | null
  ) {
    if (handler === null) {
      if (this.contextOverflowListener) {
        this.removeEventListener(
          "contextoverflow",
          this.contextOverflowListener
        )
      }
      this.contextOverflowHandler = null
      this.contextOverflowListener = null
      return
    }
    this.contextOverflowHandler = handler
    if (this.contextOverflowListener === null) {
      const listener: EventListener = (event) => {
        this.contextOverflowHandler?.call(this, event)
      }
      this.contextOverflowListener = listener
      this.addEventListener("contextoverflow", listener)
    }
  }

  get onquotaoverflow(): ((this: LanguageModel, ev: Event) => unknown) | null {
    return this.quotaOverflowHandler
  }

  set onquotaoverflow(
    handler: ((this: LanguageModel, ev: Event) => unknown) | null
  ) {
    if (handler === null) {
      if (this.quotaOverflowListener) {
        this.removeEventListener("quotaoverflow", this.quotaOverflowListener)
      }
      this.quotaOverflowHandler = null
      this.quotaOverflowListener = null
      return
    }
    this.quotaOverflowHandler = handler
    if (this.quotaOverflowListener === null) {
      const listener: EventListener = (event) => {
        this.quotaOverflowHandler?.call(this, event)
      }
      this.quotaOverflowListener = listener
      this.addEventListener("quotaoverflow", listener)
    }
  }

  private readonly sessionAbort = new AbortController()
  private readonly sessionAbortReason = new DOMException(
    "The compatibility session was destroyed",
    "AbortError"
  )
  private readonly activeIterators = new Set<AsyncIterator<string>>()
  private readonly activeReleases = new Map<AsyncIterator<string>, () => void>()
  private readonly initialHistory: ProtectedBrowserTurn[]
  private readonly history: ProtectedBrowserTurn[]
  private promptActive = false
  private destroyed = false

  constructor(
    private readonly runtime: BrowserGenerationRuntime,
    history: ProtectedBrowserTurn[],
    initialHistory: ProtectedBrowserTurn[] = history
  ) {
    super()
    validateHistory(initialHistory)
    validateHistory(history)
    if (estimateUsage(initialHistory) > CONTEXT_WINDOW) {
      throw quotaExceeded()
    }
    if (estimateUsage(history) > CONTEXT_WINDOW) {
      throw quotaExceeded()
    }
    this.history = [...history]
    this.initialHistory = [...initialHistory]
  }

  private ensureActive(): void {
    if (this.destroyed) {
      throw new DOMException(
        "The compatibility session has been destroyed",
        "InvalidStateError"
      )
    }
  }

  private ensurePromptAvailable(): void {
    if (this.promptActive) {
      throw new DOMException(
        "The compatibility session already has an active prompt",
        "InvalidStateError"
      )
    }
  }

  private fitHistory(
    candidate: ProtectedBrowserTurn[],
    protectedStart = candidate.length
  ): {
    history: ProtectedBrowserTurn[]
    evicted: boolean
  } {
    validateHistory(candidate)
    if (estimateUsage(candidate) <= CONTEXT_WINDOW) {
      return { history: candidate, evicted: false }
    }

    const fitted = [...candidate]
    let evicted = false
    let firstEvictable = this.initialHistory.length
    if (
      this.initialHistory.at(-1)?.role === "user" &&
      fitted[firstEvictable]?.role === "assistant"
    ) {
      firstEvictable += 1
    }
    let evictableEnd = Math.min(protectedStart, fitted.length)
    while (
      estimateUsage(fitted) > CONTEXT_WINDOW &&
      firstEvictable + 2 <= evictableEnd
    ) {
      const removed = fitted.splice(firstEvictable, 2)
      evictableEnd -= 2
      try {
        validateHistory(fitted)
      } catch {
        fitted.splice(firstEvictable, 0, ...removed)
        evictableEnd += 2
        break
      }
      evicted = true
    }

    if (estimateUsage(fitted) > CONTEXT_WINDOW) {
      throw quotaExceeded()
    }
    return { history: fitted, evicted }
  }

  private notifyContextOverflow(): void {
    this.dispatchEvent(new Event("contextoverflow"))
    this.dispatchEvent(new Event("quotaoverflow"))
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
    const fitted = this.fitHistory([...history, final], this.history.length)
    const current = fitted.history.at(-1)!
    return {
      history: fitted.history.slice(0, -1),
      current: current.protectedContent,
      incoming: turns,
    }
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
    const fitted = this.fitHistory(nextHistory, this.history.length)
    this.history.splice(0, this.history.length, ...fitted.history)
    if (fitted.evicted) this.notifyContextOverflow()
  }

  promptStreaming(
    input: LanguageModelPrompt,
    options: LanguageModelPromptOptions = {}
  ): ReadableStream<string> {
    this.ensureActive()
    options.signal?.throwIfAborted()
    const { history, current, incoming } = this.requestFor(input)
    this.ensurePromptAvailable()
    this.promptActive = true
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
      this.promptActive = false
      composed.cleanup()
      throw error
    }

    const session = this
    let released = false
    let output = ""
    let cancelled = false
    const release = () => {
      if (released) return
      released = true
      session.promptActive = false
      composed.cleanup()
      this.activeIterators.delete(iterator)
      this.activeReleases.delete(iterator)
    }
    this.activeReleases.set(iterator, release)
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
          // The primary generation/abort error must reach the reader even when
          // an upstream generator ignores interruption forever.
          try {
            void Promise.resolve(iterator.return?.()).catch(() => undefined)
          } catch {
            // The primary stream error remains authoritative.
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
    this.ensurePromptAvailable()
    const turns = promptTurns(input)
    const fitted = this.fitHistory(
      [...this.history, ...turns],
      this.history.length
    )
    this.history.splice(0, this.history.length, ...fitted.history)
    if (fitted.evicted) this.notifyContextOverflow()
    return undefined
  }

  async measureContextUsage(
    input: LanguageModelPrompt,
    options: LanguageModelPromptOptions = {}
  ): Promise<number> {
    this.ensureActive()
    options.signal?.throwIfAborted()
    return estimateUsage(promptTurns(input))
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
    return new GemmaCompatibilitySession(
      this.runtime,
      [...this.history],
      [...this.initialHistory]
    )
  }

  destroy(): undefined {
    if (this.destroyed) return undefined
    this.destroyed = true
    this.promptActive = false
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
 * by construction; `prepare()` performs the lazy import and caches one
 * reusable q4f16 WebGPU generator before the controller reports readiness.
 */
export function createGemmaBrowserRuntime(
  dependencies: GemmaRuntimeDependencies = {}
): PreparedGemmaBrowserRuntime {
  const shouldPrefetchArtifacts =
    dependencies.loadTransformers === undefined ||
    dependencies.fetch !== undefined ||
    dependencies.cacheStorage !== undefined
  const loadTransformers =
    dependencies.loadTransformers ??
    (async () =>
      (await import("@huggingface/transformers")) as unknown as TransformersRuntime)
  type GeneratorBundle = {
    generator: TextGenerator
    transformers: TransformersRuntime
  }
  type Preparation = {
    readonly abortController: AbortController
    readonly promise: Promise<GeneratorBundle>
    waiters: number
    settled: boolean
  }
  let generatorBundle: GeneratorBundle | undefined
  let preparation: Preparation | undefined
  let disposed = false
  const active = new Set<Promise<void>>()
  let runtimeDisposePromise: Promise<void> | undefined
  const generatorDisposals = new WeakMap<object, Promise<void>>()
  let hasCleanupFailure = false
  let firstCleanupFailure: unknown

  const recordCleanupFailure = (cause: unknown): void => {
    if (hasCleanupFailure) return
    hasCleanupFailure = true
    firstCleanupFailure = cause
  }

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

  const disposeResource = async (resource: unknown) => {
    try {
      if (
        resource !== null &&
        (typeof resource === "object" || typeof resource === "function") &&
        "dispose" in resource &&
        typeof resource.dispose === "function"
      ) {
        await resource.dispose()
      }
    } catch (cause) {
      // Preserve the acquisition/abort error as primary. Runtime disposal
      // reports the first secondary cleanup failure after all attempts.
      recordCleanupFailure(cause)
    }
  }

  const disposeGeneratorSafely = async (
    generator: TextGenerator
  ): Promise<void> => {
    try {
      await disposeGenerator(generator)
    } catch (cause) {
      recordCleanupFailure(cause)
    }
  }

  const buildGenerator = async (
    signal: AbortSignal
  ): Promise<GeneratorBundle> => {
    const loaded = await loadTransformers()
    const transformers = loaded as TransformersRuntime
    if (shouldPrefetchArtifacts) {
      await ensurePinnedArtifacts(dependencies, signal, dependencies.onProgress)
    }
    signal.throwIfAborted()
    if (transformers.env) {
      transformers.env.experimental_useCrossOriginStorage = false
    }

    let tokenizer: TextGenerator["tokenizer"] | undefined
    let model: DisposableResource | undefined
    let generator: TextGenerator | undefined
    try {
      const config = await transformers.AutoConfig.from_pretrained(
        GEMMA_ARTIFACT_BASE_URL,
        { revision: MODEL_REVISION }
      )
      signal.throwIfAborted()
      tokenizer = await transformers.AutoTokenizer.from_pretrained(
        GEMMA_ARTIFACT_BASE_URL,
        { revision: MODEL_REVISION, config }
      )
      signal.throwIfAborted()
      model = await transformers.AutoModelForCausalLM.from_pretrained(
        GEMMA_ARTIFACT_BASE_URL,
        {
          revision: MODEL_REVISION,
          config,
          device: "webgpu",
          dtype: "q4f16",
        }
      )
      signal.throwIfAborted()
      generator = new transformers.TextGenerationPipeline({
        task: "text-generation",
        model,
        tokenizer,
      })
      model = undefined
      signal.throwIfAborted()
      return { generator, transformers }
    } catch (cause) {
      if (generator) await disposeGeneratorSafely(generator)
      else await disposeResource(model)
      await disposeResource(tokenizer)
      throw cause
    }
  }

  const beginPreparation = (): Preparation => {
    const abortController = new AbortController()
    let current!: Preparation
    const promise = buildGenerator(abortController.signal).then(
      (bundle) => {
        current.settled = true
        if (preparation === current) {
          preparation = undefined
          generatorBundle = bundle
        }
        return bundle
      },
      (cause) => {
        current.settled = true
        if (preparation === current) preparation = undefined
        throw cause
      }
    )
    current = { abortController, promise, settled: false, waiters: 0 }
    preparation = current
    return current
  }

  const loadGenerator = (signal?: AbortSignal): Promise<GeneratorBundle> => {
    if (generatorBundle) return Promise.resolve(generatorBundle)
    const current = preparation ?? beginPreparation()
    current.waiters += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      current.waiters -= 1
      if (
        current.waiters === 0 &&
        !current.settled &&
        !current.abortController.signal.aborted
      ) {
        current.abortController.abort(
          new DOMException("Gemma preparation abandoned", "AbortError")
        )
      }
    }
    return awaitSignal(current.promise, signal).finally(release)
  }

  return {
    id: "gemma-3-270m",
    disclosure: GEMMA_RUNTIME_DISCLOSURE,
    async prepare(signal) {
      if (disposed) throw new Error("The Gemma browser runtime is disposed")
      signal?.throwIfAborted()
      await awaitSignal(loadGenerator(signal), signal)
    },
    generate(input) {
      const request = input
      // Runtime callers must cross the same private marker as every other
      // browser adapter. This is intentionally a runtime assertion, not a
      // cast: an unprotected object must fail before model loading.
      assertProtectedBrowserRequest(request)
      validateConversation(request.protectedHistory)
      ensureContextWithinWindow([
        ...request.protectedHistory,
        { role: "user", protectedContent: request.protectedContent },
      ])

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

        try {
          const loading = preparation?.promise
          preparation?.abortController.abort(
            new DOMException(
              "The Gemma browser runtime was disposed",
              "AbortError"
            )
          )
          await loading?.catch(() => undefined)
          const loaded = generatorBundle
          generatorBundle = undefined
          if (loaded) await disposeGeneratorSafely(loaded.generator)
        } catch (error) {
          recordCleanupFailure(error)
        }

        // Active-run cleanup has deterministic precedence, but shared
        // pipeline disposal is always attempted before reporting either.
        if (activeFailed) throw activeError
        if (hasCleanupFailure) throw firstCleanupFailure
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
