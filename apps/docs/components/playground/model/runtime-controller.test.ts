import { describe, expect, it, vi } from "vitest"
import {
  GEMMA_ARTIFACT_URLS,
  RuntimeActivationBusyError,
  createRuntimeController,
  hasCachedGemmaArtifacts,
  type RuntimeControllerDependencies,
} from "./runtime-controller"
import { createGemmaBrowserRuntime } from "./gemma-runtime"
import { CHROME_TEXT_EXPECTATIONS } from "./chrome-runtime"
import type { BrowserGenerationRuntime, RuntimeDisclosure } from "./types"
import type { ChromePromptFactory } from "./chrome-runtime"

const disclosure: RuntimeDisclosure = {
  label: "Test runtime",
  model: "test-model",
  source: "test source",
  artifacts: { kind: "browser-managed" },
}

function runtime(id: string): BrowserGenerationRuntime {
  return {
    id,
    disclosure,
    generate: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield "ok"
      },
    })),
    dispose: vi.fn(async () => undefined),
  }
}

function nativeFactory(
  availability: Availability = "available"
): ChromePromptFactory & {
  availability(options?: LanguageModelCreateCoreOptions): Promise<Availability>
} {
  return {
    availability: vi.fn(async () => availability),
    create: vi.fn(
      async (options?: {
        readonly initialPrompts?: readonly {
          readonly role: "system" | "user" | "assistant"
          readonly content: string
        }[]
        readonly signal?: AbortSignal
        readonly monitor?: (monitor: EventTarget) => void
      }) => {
        const monitor = new EventTarget()
        options?.monitor?.(monitor)
        return {
          destroy: vi.fn(async () => undefined),
        } as unknown as LanguageModel
      }
    ),
  }
}

function controllerDependencies(
  overrides: Partial<RuntimeControllerDependencies> = {}
): RuntimeControllerDependencies {
  return {
    getNative: () => undefined,
    isGemmaCached: async () => false,
    loadGemma: async () => runtime("gemma-3-270m"),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe("browser runtime controller", () => {
  it("recognizes only the complete pinned Gemma cache", async () => {
    const cached = new Set(GEMMA_ARTIFACT_URLS)
    const match = vi.fn(async (url: string) =>
      cached.has(url) ? new Response() : undefined
    )
    const cacheStorage = {
      has: vi.fn(async () => true),
      open: vi.fn(async () => ({ match })),
    } as unknown as CacheStorage

    await expect(hasCachedGemmaArtifacts(cacheStorage)).resolves.toBe(true)
    expect(match.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([...GEMMA_ARTIFACT_URLS])
    )
    cached.delete(GEMMA_ARTIFACT_URLS.at(-1)!)
    await expect(hasCachedGemmaArtifacts(cacheStorage)).resolves.toBe(false)
  })

  it("publishes ready for available native capability without acquiring a session", async () => {
    const native = nativeFactory("available")
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native })
    )

    await controller.check()

    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      kind: "gemini-nano",
    })
    expect(controller.getRuntime()?.id).toBe("gemini-nano")
    expect(native.create).not.toHaveBeenCalled()
  })

  it("uses the shared English text expectations for native availability", async () => {
    const native = nativeFactory("downloadable")
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native })
    )

    await controller.check()

    expect(native.availability).toHaveBeenCalledWith(CHROME_TEXT_EXPECTATIONS)
  })

  it("hides the runtime whenever the public snapshot is not ready", async () => {
    const native = nativeFactory("available")
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native })
    )

    await controller.check()
    expect(controller.getSnapshot().status).toBe("ready")
    expect(controller.getRuntime()).toBeDefined()

    native.availability = vi.fn(async () => "downloadable" as Availability)
    await controller.check()

    expect(controller.getSnapshot().status).toBe("choice-required")
    expect(controller.getRuntime()).toBeUndefined()
  })

  it("requires an explicit choice when native needs activation", async () => {
    const native = nativeFactory("downloadable")
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native })
    )

    await controller.check()

    expect(controller.getSnapshot()).toMatchObject({
      status: "choice-required",
    })
    if (controller.getSnapshot().status !== "choice-required") return
    const choice = controller.getSnapshot()
    if (choice.status !== "choice-required") return
    expect(choice.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "gemini-nano",
          availability: "requires-activation",
        }),
        expect.objectContaining({ kind: "gemma-3-270m" }),
      ])
    )
    expect(native.create).not.toHaveBeenCalled()
  })

  it("offers Gemma without importing or loading it during inspection", async () => {
    const loadGemma = vi.fn(async () => runtime("gemma-3-270m"))
    const controller = createRuntimeController(
      controllerDependencies({ loadGemma })
    )

    await controller.check()

    expect(controller.getSnapshot()).toMatchObject({
      status: "choice-required",
    })
    expect(loadGemma).not.toHaveBeenCalled()
  })

  it("coalesces concurrent checks", async () => {
    let release!: (value: Availability) => void
    const availability = new Promise<Availability>((resolve) => {
      release = resolve
    })
    const native = {
      availability: vi.fn(() => availability),
      create: vi.fn(),
    }
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native })
    )

    const first = controller.check()
    const second = controller.check()
    expect(first).toBe(second)
    release("available")
    await first
    expect(native.availability).toHaveBeenCalledOnce()
  })

  it("activates only the selected runtime and reports progress before ready", async () => {
    const native = nativeFactory("downloadable")
    const selected = runtime("gemini-nano")
    const controller = createRuntimeController(
      controllerDependencies({
        getNative: () => native,
        createNativeRuntime: () => selected,
      })
    )
    const snapshots: ReturnType<typeof controller.getSnapshot>[] = []
    controller.subscribe(() => snapshots.push(controller.getSnapshot()))
    await controller.check()

    const activation = controller.activate("gemini-nano")
    expect(controller.getSnapshot()).toMatchObject({
      status: "activating",
      kind: "gemini-nano",
      progress: 0,
    })
    await activation

    expect(controller.getRuntime()).toBe(selected)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      kind: "gemini-nano",
    })
    expect(snapshots.some((snapshot) => snapshot.status === "activating")).toBe(
      true
    )
    expect(native.create).toHaveBeenCalledOnce()
    expect(native.create).toHaveBeenCalledWith(
      expect.objectContaining(CHROME_TEXT_EXPECTATIONS)
    )
  })

  it("preserves an abort reason over a warm-session cleanup failure", async () => {
    const abort = new AbortController()
    const reason = new DOMException("Stop warming", "AbortError")
    const cleanupFailure = new Error("session cleanup")
    const destroyStarted = deferred<void>()
    const releaseDestroy = deferred<void>()
    const session = {
      destroy: vi.fn(async () => {
        destroyStarted.resolve()
        await releaseDestroy.promise
        throw cleanupFailure
      }),
    }
    const native = {
      availability: vi.fn(async () => "downloadable" as Availability),
      create: vi.fn(async () => session as unknown as LanguageModel),
    }
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native })
    )
    await controller.check()

    const activation = controller.activate("gemini-nano", abort.signal)
    await destroyStarted.promise
    abort.abort(reason)
    releaseDestroy.resolve()

    await expect(activation).rejects.toBe(reason)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: reason,
    })
  })

  it("reports a warm-session cleanup failure when activation succeeds", async () => {
    const cleanupFailure = new Error("session cleanup")
    const native = {
      availability: vi.fn(async () => "downloadable" as Availability),
      create: vi.fn(async () => ({
        destroy: vi.fn(async () => {
          throw cleanupFailure
        }),
      })) as unknown as ChromePromptFactory["create"],
    }
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native })
    )
    await controller.check()

    await expect(controller.activate("gemini-nano")).rejects.toBe(
      cleanupFailure
    )
  })

  it("destroys a warm session when its activation becomes stale", async () => {
    const native = nativeFactory("downloadable")
    const opening = deferred<LanguageModel>()
    const session = {
      promptStreaming: vi.fn(),
      destroy: vi.fn(async () => undefined),
    }
    native.create = vi.fn(() => opening.promise as Promise<LanguageModel>)
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native })
    )

    await controller.check()
    const activation = controller.activate("gemini-nano")
    await vi.waitFor(() => expect(native.create).toHaveBeenCalledOnce())

    await controller.check()
    opening.resolve(session as unknown as LanguageModel)
    await activation

    expect(session.destroy).toHaveBeenCalledOnce()
    await controller.dispose()
    expect(session.destroy).toHaveBeenCalledOnce()
  })

  it("prepares Gemma before ready without starting generation", async () => {
    const selected = runtime("gemma-3-270m") as BrowserGenerationRuntime & {
      prepare: ReturnType<typeof vi.fn>
    }
    selected.prepare = vi.fn(async () => undefined)
    const loadGemma = vi.fn(async () => selected)
    const controller = createRuntimeController(
      controllerDependencies({ loadGemma })
    )

    await controller.check()
    await controller.activate("gemma-3-270m")

    expect(loadGemma).toHaveBeenCalledOnce()
    expect(selected.prepare).toHaveBeenCalledOnce()
    expect(selected.generate).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      kind: "gemma-3-270m",
    })
  })

  it("owns failed preparation cleanup exactly once", async () => {
    const candidate = runtime("gemma-3-270m") as BrowserGenerationRuntime & {
      prepare: ReturnType<typeof vi.fn>
    }
    const failure = new Error("preparation failed")
    candidate.prepare = vi.fn(async () => {
      throw failure
    })
    const controller = createRuntimeController(
      controllerDependencies({ loadGemma: async () => candidate })
    )

    await controller.check()
    await expect(controller.activate("gemma-3-270m")).rejects.toBe(failure)
    await controller.dispose()
    expect(candidate.dispose).toHaveBeenCalledOnce()
  })

  it("rejects prewarm abort promptly while disposal drains a late pipeline", async () => {
    let releaseLoader!: (value: unknown) => void
    const loading = new Promise<unknown>((resolve) => {
      releaseLoader = resolve
    })
    const generatorDispose = vi.fn(async () => undefined)
    const loadTransformers = vi.fn(() => loading)
    const candidate = createGemmaBrowserRuntime({
      loadTransformers,
    })
    const controller = createRuntimeController(
      controllerDependencies({ loadGemma: async () => candidate })
    )
    await controller.check()

    const abort = new AbortController()
    const reason = new DOMException("Preparation stopped", "AbortError")
    const activation = controller.activate("gemma-3-270m", abort.signal)
    await vi.waitFor(() => expect(loadTransformers).toHaveBeenCalledOnce())
    abort.abort(reason)
    const timeout = Symbol("timed out")
    const started = performance.now()
    const result = await Promise.race([
      activation.then(
        () => "resolved" as const,
        (cause) => cause
      ),
      new Promise<typeof timeout>((resolve) =>
        setTimeout(() => resolve(timeout), 50)
      ),
    ])

    expect(result).toBe(reason)
    expect(performance.now() - started).toBeLessThan(50)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: reason,
      recovery: ["retry-activation", "choose-runtime"],
    })

    let disposalSettled = false
    const disposing = controller.dispose().finally(() => {
      disposalSettled = true
    })
    await Promise.resolve()
    expect(disposalSettled).toBe(false)

    const model = {
      tokenizer: { apply_chat_template: () => "" },
      dispose: generatorDispose,
    }
    releaseLoader({
      env: {},
      InterruptableStoppingCriteria: class {},
      AutoConfig: { from_pretrained: vi.fn(async () => ({})) },
      AutoTokenizer: {
        from_pretrained: vi.fn(async () => model.tokenizer),
      },
      AutoModelForCausalLM: {
        from_pretrained: vi.fn(async () => model),
      },
      TextGenerationPipeline: vi.fn(function (options: { model: object }) {
        return options.model
      }),
      TextStreamer: class {},
    })
    await disposing
    await expect(activation).rejects.toBe(reason)
    expect(generatorDispose).not.toHaveBeenCalled()
  })

  it("fails overlapping activation visibly", async () => {
    const native = nativeFactory("downloadable")
    let release!: (value: BrowserGenerationRuntime) => void
    const loading = new Promise<BrowserGenerationRuntime>((resolve) => {
      release = resolve
    })
    const controller = createRuntimeController(
      controllerDependencies({
        getNative: () => native,
        createNativeRuntime: () => loading,
      })
    )
    await controller.check()
    const first = controller.activate("gemini-nano")
    await expect(controller.activate("gemma-3-270m")).rejects.toBeInstanceOf(
      RuntimeActivationBusyError
    )
    release(runtime("gemini-nano"))
    await first
  })

  it("preserves activation errors and allows retrying the same kind", async () => {
    const native = nativeFactory("downloadable")
    const failure = new DOMException("Stopped", "AbortError")
    const selected = runtime("gemini-nano")
    const createNativeRuntime = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(selected)
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native, createNativeRuntime })
    )
    await controller.check()

    await expect(controller.activate("gemini-nano")).rejects.toBe(failure)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      kind: "gemini-nano",
      error: failure,
      recovery: ["retry-activation", "choose-runtime"],
    })
    await controller.activate("gemini-nano")
    expect(controller.getSnapshot()).toMatchObject({ status: "ready" })
  })

  it("checks again after an activation error and returns to runtime choice", async () => {
    const native = nativeFactory("downloadable")
    const createNativeRuntime = vi.fn().mockRejectedValue(new Error("No GPU"))
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native, createNativeRuntime })
    )
    await controller.check()
    await expect(controller.activate("gemini-nano")).rejects.toThrow("No GPU")
    expect(controller.getSnapshot().status).toBe("error")

    await controller.check()

    expect(controller.getSnapshot().status).toBe("choice-required")
  })

  it("does not publish stale activation completion or progress", async () => {
    const native = nativeFactory("downloadable")
    let release!: (value: BrowserGenerationRuntime) => void
    const loading = new Promise<BrowserGenerationRuntime>((resolve) => {
      release = resolve
    })
    const controller = createRuntimeController(
      controllerDependencies({
        getNative: () => native,
        createNativeRuntime: () => loading,
      })
    )
    await controller.check()
    const activation = controller.activate("gemini-nano")
    const check = controller.check()
    await check
    const snapshotAfterCheck = controller.getSnapshot()
    release(runtime("gemini-nano"))
    await activation
    expect(controller.getSnapshot()).toEqual(snapshotAfterCheck)
  })

  it("does not publish progress from a superseded activation", async () => {
    let release!: (value: BrowserGenerationRuntime) => void
    const loading = new Promise<BrowserGenerationRuntime>((resolve) => {
      release = resolve
    })
    let reportProgress!: (progress: number) => void
    const controller = createRuntimeController(
      controllerDependencies({
        loadGemma: ({ onProgress }) => {
          reportProgress = onProgress
          return loading
        },
      })
    )
    await controller.check()
    const activation = controller.activate("gemma-3-270m")
    await vi.waitFor(() => expect(reportProgress).toBeTypeOf("function"))
    reportProgress(0.4)
    expect(controller.getSnapshot()).toMatchObject({ progress: 0.4 })

    const check = controller.check()
    await check
    const supersedingSnapshot = controller.getSnapshot()
    reportProgress(0.9)
    release(runtime("gemma-3-270m"))
    await activation
    expect(controller.getSnapshot()).toEqual(supersedingSnapshot)
  })

  it("keeps an abort reason observable and exposes recovery choices", async () => {
    const native = nativeFactory("downloadable")
    const abort = new AbortController()
    const reason = new DOMException("User stopped activation", "AbortError")
    const createNativeRuntime = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      abort.signal.throwIfAborted()
      return runtime("gemini-nano")
    })
    const controller = createRuntimeController(
      controllerDependencies({ getNative: () => native, createNativeRuntime })
    )
    await controller.check()

    const activation = controller.activate("gemini-nano", abort.signal)
    abort.abort(reason)
    await expect(activation).rejects.toBe(reason)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: reason,
      recovery: ["retry-activation", "choose-runtime"],
    })
  })

  it("waits for the current runtime before replacement and disposal", async () => {
    const native = nativeFactory("downloadable")
    const previous = runtime("gemini-nano")
    let releaseDispose!: () => void
    const disposeDone = new Promise<void>((resolve) => {
      releaseDispose = resolve
    })
    previous.dispose = vi.fn(() => disposeDone)
    const replacement = runtime("gemma-3-270m")
    const controller = createRuntimeController(
      controllerDependencies({
        getNative: () => native,
        createNativeRuntime: () => previous,
        loadGemma: async () => replacement,
      })
    )
    await controller.check()
    await controller.activate("gemini-nano")
    await controller.check()
    const activation = controller.activate("gemma-3-270m")
    await vi.waitFor(() => expect(previous.dispose).toHaveBeenCalledOnce())
    expect(controller.getSnapshot().status).toBe("activating")
    releaseDispose()
    await activation
    expect(controller.getSnapshot().status).toBe("ready")

    await controller.dispose()
    expect(replacement.dispose).toHaveBeenCalledOnce()
  })

  it("disposes an uninstalled candidate when replacement cleanup fails", async () => {
    const native = nativeFactory("downloadable")
    const previous = runtime("gemini-nano")
    const previousFailure = new Error("previous runtime cleanup")
    previous.dispose = vi.fn(async () => {
      throw previousFailure
    })
    const candidate = runtime("gemma-3-270m")
    const controller = createRuntimeController(
      controllerDependencies({
        getNative: () => native,
        createNativeRuntime: () => previous,
        loadGemma: async () => candidate,
      })
    )
    await controller.check()
    await controller.activate("gemini-nano")
    await controller.check()

    await expect(controller.activate("gemma-3-270m")).rejects.toBe(
      previousFailure
    )
    expect(controller.getRuntime()).toBeUndefined()
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: previousFailure,
    })
    expect(candidate.dispose).toHaveBeenCalledOnce()

    await expect(controller.dispose()).rejects.toBe(previousFailure)
    expect(candidate.dispose).toHaveBeenCalledOnce()
  })

  it("retains a completed background cleanup failure until disposal", async () => {
    const native = nativeFactory("downloadable")
    const previous = runtime("gemini-nano")
    const activationFailure = new Error("previous runtime cleanup")
    const backgroundFailure = new Error("candidate cleanup")
    previous.dispose = vi
      .fn()
      .mockRejectedValueOnce(activationFailure)
      .mockResolvedValue(undefined)
    const candidate = runtime("gemma-3-270m")
    candidate.dispose = vi.fn(async () => {
      throw backgroundFailure
    })
    const controller = createRuntimeController(
      controllerDependencies({
        getNative: () => native,
        createNativeRuntime: () => previous,
        loadGemma: async () => candidate,
      })
    )
    await controller.check()
    await controller.activate("gemini-nano")
    await controller.check()
    await expect(controller.activate("gemma-3-270m")).rejects.toBe(
      activationFailure
    )
    await vi.waitFor(() => expect(candidate.dispose).toHaveBeenCalledOnce())

    const firstDispose = controller.dispose()
    expect(controller.dispose()).toBe(firstDispose)
    const result = await firstDispose.then(
      () => ({ status: "resolved" as const }),
      (cause) => ({ status: "rejected" as const, cause })
    )
    expect(result).toEqual({ status: "rejected", cause: backgroundFailure })
    expect(candidate.dispose).toHaveBeenCalledOnce()
  })

  it("retains cleanup failure while current runtime disposal is pending", async () => {
    const native = nativeFactory("downloadable")
    const previous = runtime("gemini-nano")
    const activationFailure = new Error("previous runtime cleanup")
    const backgroundFailure = new Error("candidate cleanup")
    let releaseCurrent!: () => void
    const currentDisposal = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    let releaseCandidate!: (cause?: unknown) => void
    const candidateDisposal = new Promise<void>((_, reject) => {
      releaseCandidate = reject
    })
    previous.dispose = vi
      .fn()
      .mockRejectedValueOnce(activationFailure)
      .mockReturnValueOnce(currentDisposal)
    const candidate = runtime("gemma-3-270m")
    candidate.dispose = vi.fn(() => candidateDisposal)
    const controller = createRuntimeController(
      controllerDependencies({
        getNative: () => native,
        createNativeRuntime: () => previous,
        loadGemma: async () => candidate,
      })
    )
    await controller.check()
    await controller.activate("gemini-nano")
    await controller.check()
    await expect(controller.activate("gemma-3-270m")).rejects.toBe(
      activationFailure
    )
    await vi.waitFor(() => expect(candidate.dispose).toHaveBeenCalledOnce())

    let settled = false
    const disposing = controller.dispose().finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(previous.dispose).toHaveBeenCalledTimes(2))
    releaseCandidate(backgroundFailure)
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseCurrent()
    const result = await disposing.then(
      () => ({ status: "resolved" as const }),
      (cause) => ({ status: "rejected" as const, cause })
    )
    expect(result).toEqual({ status: "rejected", cause: backgroundFailure })
  })

  it("prefers current runtime disposal failure over background cleanup failure", async () => {
    const native = nativeFactory("downloadable")
    const previous = runtime("gemini-nano")
    const activationFailure = new Error("previous runtime cleanup")
    const currentFailure = new Error("current runtime disposal")
    const backgroundFailure = new Error("candidate cleanup")
    previous.dispose = vi
      .fn()
      .mockRejectedValueOnce(activationFailure)
      .mockRejectedValue(currentFailure)
    const candidate = runtime("gemma-3-270m")
    candidate.dispose = vi.fn(async () => {
      throw backgroundFailure
    })
    const controller = createRuntimeController(
      controllerDependencies({
        getNative: () => native,
        createNativeRuntime: () => previous,
        loadGemma: async () => candidate,
      })
    )
    await controller.check()
    await controller.activate("gemini-nano")
    await controller.check()
    await expect(controller.activate("gemma-3-270m")).rejects.toBe(
      activationFailure
    )
    await vi.waitFor(() => expect(candidate.dispose).toHaveBeenCalledOnce())

    const result = await controller.dispose().then(
      () => ({ status: "resolved" as const }),
      (cause) => ({ status: "rejected" as const, cause })
    )
    expect(result).toEqual({ status: "rejected", cause: currentFailure })
  })

  it("retains an undefined background cleanup rejection", async () => {
    const native = nativeFactory("downloadable")
    const previous = runtime("gemini-nano")
    const activationFailure = new Error("previous runtime cleanup")
    previous.dispose = vi
      .fn()
      .mockRejectedValueOnce(activationFailure)
      .mockResolvedValue(undefined)
    const candidate = runtime("gemma-3-270m")
    candidate.dispose = vi.fn(async () => {
      throw undefined
    })
    const controller = createRuntimeController(
      controllerDependencies({
        getNative: () => native,
        createNativeRuntime: () => previous,
        loadGemma: async () => candidate,
      })
    )
    await controller.check()
    await controller.activate("gemini-nano")
    await controller.check()
    await expect(controller.activate("gemma-3-270m")).rejects.toBe(
      activationFailure
    )
    await vi.waitFor(() => expect(candidate.dispose).toHaveBeenCalledOnce())

    const result = await controller.dispose().then(
      () => ({ status: "resolved" as const }),
      (cause) => ({ status: "rejected" as const, cause })
    )
    expect(result).toEqual({ status: "rejected", cause: undefined })
    expect(candidate.dispose).toHaveBeenCalledOnce()
  })

  it("retains an undefined current runtime disposal rejection", async () => {
    const native = nativeFactory("downloadable")
    const selected = runtime("gemini-nano")
    selected.dispose = vi.fn(async () => {
      throw undefined
    })
    const controller = createRuntimeController(
      controllerDependencies({
        getNative: () => native,
        createNativeRuntime: () => selected,
      })
    )
    await controller.check()
    await controller.activate("gemini-nano")

    const firstDispose = controller.dispose()
    expect(controller.dispose()).toBe(firstDispose)
    const result = await firstDispose.then(
      () => ({ status: "resolved" as const }),
      (cause) => ({ status: "rejected" as const, cause })
    )
    expect(result).toEqual({ status: "rejected", cause: undefined })
    expect(selected.dispose).toHaveBeenCalledOnce()
  })
})
