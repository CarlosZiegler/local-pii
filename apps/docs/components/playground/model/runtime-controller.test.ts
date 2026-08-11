import { describe, expect, it, vi } from "vitest"
import {
  RuntimeActivationBusyError,
  createRuntimeController,
  type RuntimeControllerDependencies,
} from "./runtime-controller"
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

describe("browser runtime controller", () => {
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
})
