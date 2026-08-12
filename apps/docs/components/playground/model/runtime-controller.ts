import {
  CHROME_TEXT_EXPECTATIONS,
  createChromeBrowserRuntime,
  discoverChromePromptFactory,
  type ChromePromptFactory,
} from "./chrome-runtime"
import type {
  BrowserGenerationRuntime,
  RuntimeDisclosure,
  RuntimeKind,
  RuntimeOption,
  RuntimeRecovery,
  RuntimeSnapshot,
} from "./types"
import {
  GEMMA_ARTIFACT_URLS,
  GEMMA_CACHE_NAME,
  GEMMA_RUNTIME_DISCLOSURE,
} from "./runtime-metadata"

export { GEMMA_ARTIFACT_URLS } from "./runtime-metadata"

type NativeFactory = ChromePromptFactory & {
  availability(options?: LanguageModelCreateCoreOptions): Promise<Availability>
}

const DISCLOSURES: Record<RuntimeKind, RuntimeDisclosure> = {
  "gemini-nano": {
    label: "Chrome built-in Prompt API",
    model: "Gemini Nano",
    source: "Chrome built-in Prompt API",
    artifacts: { kind: "browser-managed" },
  },
  "gemma-3-270m": GEMMA_RUNTIME_DISCLOSURE,
}

export interface RuntimeActivationLoadOptions {
  readonly signal?: AbortSignal
  readonly onProgress: (progress: number) => void
}

interface ActivatableBrowserRuntime extends BrowserGenerationRuntime {
  /** Complete lazy model loading before the controller publishes ready. */
  prepare?(signal?: AbortSignal): Promise<void>
}

export interface RuntimeControllerDependencies {
  /** Read-only access to Chrome's browser-managed Prompt API. */
  readonly getNative?: () => ChromePromptFactory | undefined
  /** Inspect the complete static Gemma artifact cache without loading it. */
  readonly isGemmaCached?: () => Promise<boolean>
  /** Construct the native runtime after explicit activation. */
  readonly createNativeRuntime?: (
    factory: ChromePromptFactory
  ) => BrowserGenerationRuntime | Promise<BrowserGenerationRuntime>
  /** Load/construct Gemma after explicit activation. */
  readonly loadGemma?: (
    options: RuntimeActivationLoadOptions
  ) => ActivatableBrowserRuntime | Promise<ActivatableBrowserRuntime>
  readonly availabilityTimeoutMs?: number
}

export interface RuntimeController {
  check(): Promise<void>
  activate(kind: RuntimeKind, signal?: AbortSignal): Promise<void>
  getSnapshot(): RuntimeSnapshot
  getRuntime(): BrowserGenerationRuntime | undefined
  subscribe(listener: () => void): () => void
  dispose(): Promise<void>
}

export class RuntimeActivationBusyError extends Error {
  constructor() {
    super("A browser runtime activation is already in progress")
    this.name = "RuntimeActivationBusyError"
  }
}

/**
 * Inspect the browser's complete Transformers.js artifact cache. This helper
 * deliberately lives beside the controller so discovery never imports Gemma.
 */
export async function hasCachedGemmaArtifacts(
  cacheStorage: CacheStorage | undefined = typeof caches === "undefined"
    ? undefined
    : caches
): Promise<boolean> {
  if (!cacheStorage || !(await cacheStorage.has(GEMMA_CACHE_NAME))) return false
  const cache = await cacheStorage.open(GEMMA_CACHE_NAME)
  const artifacts = await Promise.all(
    GEMMA_ARTIFACT_URLS.map((url) => cache.match(url))
  )
  return artifacts.every(Boolean)
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason
}

function clampedProgress(progress: number): number {
  return Math.min(1, Math.max(0, progress))
}

/** Await a dependency while retaining an exact AbortSignal.reason. */
function awaitWithAbort<T>(
  value: Promise<T>,
  signal: AbortSignal | undefined,
  lateValueCleanup?: (value: T) => void | Promise<void>,
  trackLateValue?: (promise: Promise<void>) => void
): Promise<T> {
  if (!signal) return value
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let aborted = false
    const hasTrackedLateCleanup =
      lateValueCleanup !== undefined && trackLateValue !== undefined
    const clean = () => signal.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (settled) return
      aborted = true
      settled = true
      clean()
      reject(signal.reason)
    }
    if (signal.aborted) {
      aborted = true
      settled = true
      reject(signal.reason)
    } else {
      signal.addEventListener("abort", onAbort, { once: true })
    }
    if (hasTrackedLateCleanup) {
      const lateCleanup = value.then(
        (result) =>
          aborted ? Promise.resolve(lateValueCleanup!(result)) : undefined,
        () => undefined
      )
      trackLateValue!(lateCleanup)
    }
    value.then(
      (result) => {
        if (settled) {
          if (!hasTrackedLateCleanup) {
            void Promise.resolve(lateValueCleanup?.(result)).catch(
              () => undefined
            )
          }
          return
        }
        settled = true
        clean()
        resolve(result)
      },
      (cause) => {
        if (settled) return
        settled = true
        clean()
        reject(cause)
      }
    )
  })
}

function optionsWithNative(
  nativeAvailability: "downloadable" | "downloading" | "unavailable",
  gemmaAvailability: RuntimeOption["availability"]
): readonly RuntimeOption[] {
  return [
    {
      kind: "gemini-nano",
      availability:
        nativeAvailability === "unavailable"
          ? "unavailable"
          : "requires-activation",
      disclosure: DISCLOSURES["gemini-nano"],
    },
    {
      kind: "gemma-3-270m",
      availability: gemmaAvailability,
      disclosure: DISCLOSURES["gemma-3-270m"],
    },
  ]
}

export function createRuntimeController(
  dependencies: RuntimeControllerDependencies = {}
): RuntimeController {
  const listeners = new Set<() => void>()
  const availabilityTimeoutMs = dependencies.availabilityTimeoutMs ?? 5_000
  const getNative = dependencies.getNative ?? discoverChromePromptFactory
  const isGemmaCached =
    dependencies.isGemmaCached ?? (() => hasCachedGemmaArtifacts())

  let snapshot: RuntimeSnapshot = { status: "checking", operationId: 0 }
  let currentRuntime: BrowserGenerationRuntime | undefined
  let nextOperationId = 0
  let currentOperationId = 0
  let currentCheck: Promise<void> | undefined
  let currentActivation: Promise<void> | undefined
  let disposed = false
  let disposal: Promise<void> | undefined
  const pendingDisposals = new Set<Promise<void>>()
  let hasBackgroundFailure = false
  let firstBackgroundFailure: unknown

  const recordBackgroundFailure = (cause: unknown): void => {
    if (hasBackgroundFailure) return
    hasBackgroundFailure = true
    firstBackgroundFailure = cause
  }

  const trackPendingDisposal = (promise: Promise<void>): void => {
    pendingDisposals.add(promise)
    void promise.then(
      () => pendingDisposals.delete(promise),
      (cause) => {
        recordBackgroundFailure(cause)
        pendingDisposals.delete(promise)
      }
    )
  }

  const scheduleDisposal = (
    cleanup: () => void | Promise<void>
  ): Promise<void> => {
    const disposal = Promise.resolve().then(cleanup)
    trackPendingDisposal(disposal)
    return disposal
  }

  const waitForPendingDisposals = async (): Promise<void> => {
    while (pendingDisposals.size > 0) {
      const pending = [...pendingDisposals]
      const results = await Promise.allSettled(pending)
      for (const result of results) {
        if (result.status === "rejected") {
          recordBackgroundFailure(result.reason)
        }
      }
    }
    if (hasBackgroundFailure) throw firstBackgroundFailure
  }

  /**
   * A retry must not start another WebGPU construction while an aborted
   * candidate is still finishing its uncancellable loader. Cleanup failures
   * remain retained for controller.dispose(), but do not replace the retry's
   * own primary activation result.
   */
  const drainPendingDisposals = async (): Promise<void> => {
    while (pendingDisposals.size > 0) {
      await Promise.allSettled([...pendingDisposals])
    }
  }

  const publish = (next: RuntimeSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const isCurrent = (operationId: number) =>
    !disposed && currentOperationId === operationId

  const publishError = (
    operationId: number,
    cause: unknown,
    kind?: RuntimeKind,
    recovery: readonly RuntimeRecovery[] = kind
      ? ["retry-activation", "choose-runtime"]
      : ["check-again", "choose-runtime"]
  ) => {
    if (!isCurrent(operationId)) return
    publish({
      status: "error",
      operationId,
      ...(kind === undefined ? {} : { kind }),
      error: errorFrom(cause),
      recovery,
    })
  }

  const replaceRuntime = async (
    next: BrowserGenerationRuntime,
    operationId: number
  ): Promise<boolean> => {
    const previous = currentRuntime
    if (previous && previous !== next) {
      await previous.dispose()
      if (currentRuntime === previous) currentRuntime = undefined
    }
    if (!isCurrent(operationId)) {
      scheduleDisposal(() => next.dispose())
      return false
    }
    currentRuntime = next
    return true
  }

  const inspectGemma = async (): Promise<RuntimeOption["availability"]> => {
    try {
      return (await isGemmaCached()) ? "ready" : "requires-activation"
    } catch {
      // Cache inspection is advisory. It must not hide the explicit choice.
      return "requires-activation"
    }
  }

  const runCheck = async (operationId: number): Promise<void> => {
    try {
      const native = getNative() as NativeFactory | undefined
      if (!native) {
        const gemmaAvailability = await inspectGemma()
        if (isCurrent(operationId)) {
          publish({
            status: "choice-required",
            options: optionsWithNative("unavailable", gemmaAvailability),
          })
        }
        return
      }

      let timeout: ReturnType<typeof setTimeout> | undefined
      const nativeAvailability = await Promise.race([
        native.availability(CHROME_TEXT_EXPECTATIONS),
        new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), availabilityTimeoutMs)
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout)
      })

      if (!isCurrent(operationId)) return
      if (nativeAvailability === "available") {
        const runtime = createChromeBrowserRuntime(native)
        if (await replaceRuntime(runtime, operationId)) {
          publish({
            status: "ready",
            kind: "gemini-nano",
            disclosure: DISCLOSURES["gemini-nano"],
          })
        }
        return
      }
      const gemmaAvailability = await inspectGemma()
      if (!isCurrent(operationId)) return
      publish({
        status: "choice-required",
        options: optionsWithNative(
          nativeAvailability === "timeout" ? "unavailable" : nativeAvailability,
          gemmaAvailability
        ),
      })
    } catch (cause) {
      publishError(operationId, cause)
    }
  }

  const check = (): Promise<void> => {
    if (disposed)
      return Promise.reject(new Error("The runtime controller is disposed"))
    if (currentCheck) return currentCheck
    const operationId = ++nextOperationId
    currentOperationId = operationId
    publish({ status: "checking", operationId })
    let operation!: Promise<void>
    operation = runCheck(operationId).finally(() => {
      if (currentCheck === operation) currentCheck = undefined
    })
    currentCheck = operation
    return operation
  }

  const warmNative = async (
    factory: ChromePromptFactory,
    operationId: number,
    signal: AbortSignal | undefined,
    onProgress: (progress: number) => void
  ): Promise<void> => {
    throwIfAborted(signal)
    type NativeCreate = (options: {
      readonly expectedInputs: readonly LanguageModelExpected[]
      readonly expectedOutputs: readonly LanguageModelExpected[]
      readonly initialPrompts: readonly []
      readonly signal?: AbortSignal
      readonly monitor: (monitor: EventTarget) => void
    }) => Promise<LanguageModel>
    const create = factory.create as unknown as NativeCreate
    const session = await awaitWithAbort(
      create({
        ...CHROME_TEXT_EXPECTATIONS,
        initialPrompts: [],
        ...(signal === undefined ? {} : { signal }),
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            const loaded = (event as Event & { loaded?: unknown }).loaded
            if (typeof loaded === "number") onProgress(loaded)
          })
        },
      }),
      signal,
      async (lateSession) => {
        await lateSession.destroy()
      },
      trackPendingDisposal
    )
    let hasPrimaryFailure = false
    let primaryFailure: unknown
    let stale = false
    try {
      throwIfAborted(signal)
      stale = !isCurrent(operationId)
    } catch (cause) {
      hasPrimaryFailure = true
      primaryFailure = cause
    }

    let hasCleanupFailure = false
    let cleanupFailure: unknown
    try {
      await session.destroy()
    } catch (cause) {
      hasCleanupFailure = true
      cleanupFailure = cause
    }

    if (!hasPrimaryFailure && signal?.aborted) {
      hasPrimaryFailure = true
      primaryFailure = signal.reason
    }
    if (hasPrimaryFailure) throw primaryFailure
    if (stale) return
    if (hasCleanupFailure) throw cleanupFailure
  }

  const loadRuntime = async (
    kind: RuntimeKind,
    operationId: number,
    signal: AbortSignal | undefined,
    onProgress: (progress: number) => void
  ): Promise<BrowserGenerationRuntime> => {
    await drainPendingDisposals()
    throwIfAborted(signal)
    if (kind === "gemini-nano") {
      const factory = getNative()
      if (!factory) throw new Error("Chrome Prompt API is not available")
      await warmNative(factory, operationId, signal, onProgress)
      throwIfAborted(signal)
      const createNative =
        dependencies.createNativeRuntime ??
        ((selected: ChromePromptFactory) =>
          createChromeBrowserRuntime(selected))
      const result = createNative(factory)
      return await awaitWithAbort(
        Promise.resolve(result),
        signal,
        (lateRuntime) => lateRuntime.dispose(),
        trackPendingDisposal
      )
    }

    const loadGemma =
      dependencies.loadGemma ??
      (async ({ onProgress: progress }: RuntimeActivationLoadOptions) => {
        const { createGemmaBrowserRuntime } = await import("./gemma-runtime")
        return createGemmaBrowserRuntime({ onProgress: progress })
      })
    const result = loadGemma({ signal, onProgress })
    const runtime = await awaitWithAbort(
      Promise.resolve(result),
      signal,
      (lateRuntime) => lateRuntime.dispose(),
      trackPendingDisposal
    )
    try {
      await runtime.prepare?.(signal)
      return runtime
    } catch (cause) {
      // The candidate is not returned to runActivation when prepare fails, so
      // this is the sole owner of its cleanup. The barrier retains any late
      // disposal failure without replacing the preparation error.
      scheduleDisposal(() => runtime.dispose())
      throw cause
    }
  }

  const runActivation = async (
    operationId: number,
    kind: RuntimeKind,
    signal: AbortSignal | undefined
  ): Promise<void> => {
    const disclosure = DISCLOSURES[kind]
    let progress = 0
    const publishProgress = (value: number) => {
      if (!isCurrent(operationId) || snapshot.status !== "activating") return
      progress = Math.max(progress, clampedProgress(value))
      publish({
        status: "activating",
        operationId,
        kind,
        disclosure,
        progress,
      })
    }

    publish({
      status: "activating",
      operationId,
      kind,
      disclosure,
      progress: 0,
    })

    let runtime: BrowserGenerationRuntime | undefined
    let installed = false
    try {
      throwIfAborted(signal)
      runtime = await loadRuntime(kind, operationId, signal, publishProgress)
      throwIfAborted(signal)
      if (!isCurrent(operationId)) {
        scheduleDisposal(() => runtime!.dispose())
        return
      }
      if (!(await replaceRuntime(runtime, operationId))) return
      installed = true
      throwIfAborted(signal)
      publishProgress(1)
      if (isCurrent(operationId)) {
        publish({ status: "ready", kind, disclosure })
      }
    } catch (cause) {
      if (runtime && installed && currentRuntime === runtime) {
        currentRuntime = undefined
        scheduleDisposal(() => runtime!.dispose())
      }
      if (runtime && !installed) scheduleDisposal(() => runtime!.dispose())
      if (!isCurrent(operationId)) return
      publishError(operationId, cause, kind)
      throw cause
    }
  }

  const activate = (kind: RuntimeKind, signal?: AbortSignal): Promise<void> => {
    if (disposed)
      return Promise.reject(new Error("The runtime controller is disposed"))
    if (currentActivation)
      return Promise.reject(new RuntimeActivationBusyError())

    if (snapshot.status === "choice-required") {
      const selected = snapshot.options.find((option) => option.kind === kind)
      if (!selected || selected.availability === "unavailable") {
        return Promise.reject(new Error(`The ${kind} runtime is unavailable`))
      }
    } else if (
      snapshot.status !== "error" ||
      snapshot.kind !== kind ||
      !snapshot.recovery.includes("retry-activation")
    ) {
      return Promise.reject(
        new Error(`The ${kind} runtime is not available for activation`)
      )
    }

    const operationId = ++nextOperationId
    currentOperationId = operationId
    let operation!: Promise<void>
    operation = runActivation(operationId, kind, signal).finally(() => {
      if (currentActivation === operation) currentActivation = undefined
    })
    currentActivation = operation
    return operation
  }

  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposed = true
    currentOperationId = ++nextOperationId
    disposal = (async () => {
      const pending = [currentCheck, currentActivation].filter(
        (value): value is Promise<void> => value !== undefined
      )
      await Promise.allSettled(pending)
      const runtime = currentRuntime
      currentRuntime = undefined
      let hasRuntimeError = false
      let runtimeError: unknown
      if (runtime) {
        try {
          await runtime.dispose()
        } catch (cause) {
          hasRuntimeError = true
          runtimeError = cause
        }
      }
      let hasPendingDisposalError = false
      let pendingDisposalError: unknown
      try {
        await waitForPendingDisposals()
      } catch (cause) {
        hasPendingDisposalError = true
        pendingDisposalError = cause
      }
      if (hasRuntimeError) throw runtimeError
      if (hasPendingDisposalError) throw pendingDisposalError
    })()
    return disposal
  }

  return {
    check,
    activate,
    getSnapshot: () => snapshot,
    getRuntime: () =>
      snapshot.status === "ready" ? currentRuntime : undefined,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose,
  }
}

export { DISCLOSURES as RUNTIME_DISCLOSURES }
