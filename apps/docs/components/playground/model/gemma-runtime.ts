import type { LanguageModelFactory } from "./prompt-runtime"

const MODEL_ID = "onnx-community/gemma-3-270m-it-ONNX"

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
      max_new_tokens: number
      return_full_text: false
      stopping_criteria: InterruptableCriteria[]
      streamer: TextStreamerInstance
    }
  ): Promise<unknown>
  tokenizer: {
    apply_chat_template(
      messages: Array<{ role: string; content: string }>,
      options: {
        add_generation_prompt: boolean
        tokenize: false
      }
    ): string
  }
}

interface TransformersRuntime {
  env: { experimental_useCrossOriginStorage?: boolean }
  InterruptableStoppingCriteria: new () => InterruptableCriteria
  pipeline(
    task: "text-generation",
    model: string,
    options: {
      device: "webgpu"
      dtype: "q4f16"
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
  loadTransformers?: () => Promise<unknown>
}

function textContent(content: LanguageModelMessageContent[] | string): string {
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

function promptMessages(
  prompt: LanguageModelPrompt
): Array<{ role: string; content: string }> {
  if (typeof prompt === "string") return [{ role: "user", content: prompt }]
  return prompt.map((message) => ({
    role: message.role,
    content: textContent(message.content),
  }))
}

function progressValue(event: { progress?: number; status?: string }) {
  if (event.status === "ready") return 1
  if (event.status === "progress_total" && event.progress !== undefined) {
    return event.progress / 100
  }
  return undefined
}

class GemmaLanguageModelSession extends EventTarget {
  readonly contextWindow = 4_096
  readonly inputQuota = this.contextWindow
  readonly temperature = 0
  readonly topK = 1
  contextUsage = 0
  inputUsage = 0
  oncontextoverflow: ((this: LanguageModel, event: Event) => unknown) | null =
    null
  onquotaoverflow: ((this: LanguageModel, event: Event) => unknown) | null =
    null

  private active = new Set<InterruptableCriteria>()
  private destroyed = false

  constructor(
    private readonly generator: TextGenerator,
    private readonly runtime: TransformersRuntime,
    private readonly history: Array<{ role: string; content: string }>
  ) {
    super()
  }

  promptStreaming(
    input: LanguageModelPrompt,
    options: LanguageModelPromptOptions = {}
  ): ReadableStream<string> {
    const incoming = promptMessages(input)
    const messages = [...this.history, ...incoming]
    const session = this
    let criteria: InterruptableCriteria | undefined
    let cancelled = false

    return new ReadableStream<string>({
      async start(controller) {
        if (session.destroyed) {
          controller.error(
            new DOMException(
              "The model session was destroyed",
              "InvalidStateError"
            )
          )
          return
        }
        if (options.signal?.aborted) {
          controller.error(options.signal.reason)
          return
        }

        criteria = new session.runtime.InterruptableStoppingCriteria()
        session.active.add(criteria)
        let response = ""
        const stop = () => criteria?.interrupt()
        options.signal?.addEventListener("abort", stop, { once: true })

        try {
          const streamer = new session.runtime.TextStreamer(
            session.generator.tokenizer,
            {
              callback_function(value) {
                if (cancelled || options.signal?.aborted) return
                response += value
                controller.enqueue(value)
              },
              skip_prompt: true,
              skip_special_tokens: true,
            }
          )
          const formatted = session.generator.tokenizer.apply_chat_template(
            messages,
            { add_generation_prompt: true, tokenize: false }
          )
          await session.generator(formatted, {
            add_special_tokens: false,
            do_sample: false,
            max_new_tokens: 512,
            return_full_text: false,
            stopping_criteria: [criteria],
            streamer,
          })

          if (cancelled) return
          if (options.signal?.aborted) {
            controller.error(options.signal.reason)
            return
          }
          session.history.push(...incoming, {
            role: "assistant",
            content: response,
          })
          controller.close()
        } catch (error) {
          if (!cancelled) controller.error(error)
        } finally {
          options.signal?.removeEventListener("abort", stop)
          if (criteria) session.active.delete(criteria)
        }
      },
      cancel() {
        cancelled = true
        criteria?.interrupt()
      },
    })
  }

  async prompt(
    input: LanguageModelPrompt,
    options?: LanguageModelPromptOptions
  ): Promise<string> {
    let response = ""
    const reader = this.promptStreaming(input, options).getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      response += next.value
    }
    return response
  }

  async append(
    input: LanguageModelPrompt,
    options: LanguageModelAppendOptions = {}
  ): Promise<undefined> {
    options.signal?.throwIfAborted()
    this.history.push(...promptMessages(input))
    return undefined
  }

  async clone(options: LanguageModelCloneOptions = {}): Promise<LanguageModel> {
    options.signal?.throwIfAborted()
    return new GemmaLanguageModelSession(this.generator, this.runtime, [
      ...this.history,
    ]) as unknown as LanguageModel
  }

  async measureContextUsage(): Promise<number> {
    return this.contextUsage
  }

  async measureInputUsage(): Promise<number> {
    return this.inputUsage
  }

  destroy(): undefined {
    this.destroyed = true
    for (const criteria of this.active) criteria.interrupt()
    this.active.clear()
    this.history.length = 0
    return undefined
  }
}

export async function createGemmaLanguageModelFactory(
  dependencies: GemmaRuntimeDependencies = {}
): Promise<LanguageModelFactory> {
  const loadTransformers =
    dependencies.loadTransformers ??
    (async () =>
      (await import("@huggingface/transformers")) as unknown as TransformersRuntime)
  const runtime = (await loadTransformers()) as TransformersRuntime
  runtime.env.experimental_useCrossOriginStorage = true
  let generatorPromise: Promise<TextGenerator> | undefined

  const loadGenerator = (monitor?: CreateMonitor) => {
    generatorPromise ??= runtime.pipeline("text-generation", MODEL_ID, {
      device: "webgpu",
      dtype: "q4f16",
      progress_callback(event) {
        const loaded = progressValue(event)
        if (loaded === undefined) return
        monitor?.dispatchEvent(
          Object.assign(new Event("downloadprogress"), {
            lengthComputable: true,
            loaded,
            total: 1,
          })
        )
      },
    })
    return generatorPromise
  }

  return {
    async availability() {
      return "available"
    },
    async create(options = {}) {
      options.signal?.throwIfAborted()
      const monitor = new EventTarget() as CreateMonitor
      options.monitor?.(monitor)
      const generator = await loadGenerator(monitor)
      options.signal?.throwIfAborted()
      const history = (options.initialPrompts ?? []).map((message) => ({
        role: message.role,
        content: textContent(message.content),
      }))
      return new GemmaLanguageModelSession(
        generator,
        runtime,
        history
      ) as unknown as LanguageModel
    },
  }
}
