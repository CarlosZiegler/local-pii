import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode } from "react"
import { describe, expect, it, vi } from "vitest"
import {
  createRuntimeController,
  RuntimeActivationBusyError,
  type RuntimeActivationLoadOptions,
  type RuntimeController,
} from "./model/runtime-controller"
import type { BrowserGenerationRuntime } from "./model/types"
import { RuntimeProvider, useLocalRuntime } from "./runtime-provider"

function runtime(): BrowserGenerationRuntime {
  return {
    id: "gemma-3-270m",
    disclosure: {
      label: "Gemma",
      model: "gemma",
      source: "test",
      artifacts: { kind: "browser-managed" },
    },
    generate: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield "ok"
      },
    })),
    dispose: vi.fn(async () => undefined),
  }
}

function RuntimeActions() {
  const state = useLocalRuntime()
  return (
    <>
      <output data-testid="status">{state.status}</output>
      <button onClick={() => void state.activate("gemma-3-270m")} type="button">
        Activate Gemma
      </button>
      {state.status === "error" ? (
        <output data-testid="snapshot-error">{state.error.message}</output>
      ) : null}
      {state.actionError ? (
        <output data-testid="action-error" role="alert">
          {state.actionError.message}
        </output>
      ) : null}
    </>
  )
}

describe("RuntimeProvider", () => {
  it("survives StrictMode effect replay with a usable controller", async () => {
    const cached = vi.fn(async () => false)
    const controller = createRuntimeController({
      getNative: () => undefined,
      isGemmaCached: cached,
    })
    const check = vi.spyOn(controller, "check")
    const dispose = vi.spyOn(controller, "dispose")

    const { unmount } = render(
      <StrictMode>
        <RuntimeProvider controller={controller}>
          <RuntimeActions />
        </RuntimeProvider>
      </StrictMode>
    )

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("choice-required")
    )
    expect(check).toHaveBeenCalledTimes(2)
    expect(cached).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()

    unmount()
    await Promise.resolve()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("transfers abort ownership when the supplied controller changes", async () => {
    let releaseA!: (value: BrowserGenerationRuntime) => void
    let releaseB!: (value: BrowserGenerationRuntime) => void
    let signalA: AbortSignal | undefined
    let signalB: AbortSignal | undefined
    const loadingA = new Promise<BrowserGenerationRuntime>((resolve) => {
      releaseA = resolve
    })
    const loadingB = new Promise<BrowserGenerationRuntime>((resolve) => {
      releaseB = resolve
    })
    const loadA = vi.fn(({ signal }: RuntimeActivationLoadOptions) => {
      signalA = signal
      return loadingA
    })
    const loadB = vi.fn(({ signal }: RuntimeActivationLoadOptions) => {
      signalB = signal
      return loadingB
    })
    const controllerA = createRuntimeController({
      getNative: () => undefined,
      isGemmaCached: async () => false,
      loadGemma: loadA,
    })
    const controllerB = createRuntimeController({
      getNative: () => undefined,
      isGemmaCached: async () => false,
      loadGemma: loadB,
    })
    let settleProviderA!: () => void
    const activateA = controllerA.activate.bind(controllerA)
    vi.spyOn(controllerA, "activate").mockImplementation((kind, signal) =>
      activateA(kind, signal).then(
        () =>
          new Promise<void>((resolve) => {
            settleProviderA = resolve
          }),
        (cause) =>
          new Promise<void>((_, reject) => {
            settleProviderA = () => reject(cause)
          })
      )
    )
    const disposeA = vi.spyOn(controllerA, "dispose")
    const disposeB = vi.spyOn(controllerB, "dispose")
    const user = userEvent.setup()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)

    try {
      const { rerender, unmount } = render(
        <RuntimeProvider controller={controllerA}>
          <RuntimeActions />
        </RuntimeProvider>
      )
      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent(
          "choice-required"
        )
      )
      await user.click(screen.getByRole("button", { name: "Activate Gemma" }))
      await vi.waitFor(() => expect(loadA).toHaveBeenCalledOnce())

      rerender(
        <RuntimeProvider controller={controllerB}>
          <RuntimeActions />
        </RuntimeProvider>
      )
      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent(
          "choice-required"
        )
      )
      expect(signalA?.aborted).toBe(true)
      expect(signalA?.reason).toMatchObject({ name: "AbortError" })

      await user.click(screen.getByRole("button", { name: "Activate Gemma" }))
      expect(loadB).toHaveBeenCalledOnce()

      unmount()
      expect(signalB?.aborted).toBe(true)
      expect(signalB?.reason).toMatchObject({ name: "AbortError" })
      settleProviderA()
      releaseA(runtime())
      releaseB(runtime())
      await Promise.resolve()
      await Promise.resolve()

      expect(disposeA).toHaveBeenCalledOnce()
      expect(disposeB).toHaveBeenCalledOnce()
      const disposalA = disposeA.mock.results[0]?.value as Promise<void>
      const disposalB = disposeB.mock.results[0]?.value as Promise<void>
      await Promise.all([disposalA, disposalB])
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("observes a rejecting controller disposal on unmount", async () => {
    const controller = createRuntimeController({
      getNative: () => undefined,
      isGemmaCached: async () => false,
    })
    const disposalFailure = new Error("provider cleanup failed")
    const dispose = vi
      .spyOn(controller, "dispose")
      .mockRejectedValue(disposalFailure)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)

    try {
      const { unmount } = render(
        <RuntimeProvider controller={controller}>
          <RuntimeActions />
        </RuntimeProvider>
      )
      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent(
          "choice-required"
        )
      )

      unmount()
      await Promise.resolve()
      expect(dispose).toHaveBeenCalledOnce()
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("observes an initial check rejection without a second action error", async () => {
    const failure = new Error("runtime check failed")
    const controller = createRuntimeController({
      getNative: () => {
        throw failure
      },
    })
    const { unmount } = render(
      <RuntimeProvider controller={controller}>
        <RuntimeActions />
      </RuntimeProvider>
    )

    expect(await screen.findByTestId("snapshot-error")).toHaveTextContent(
      failure.message
    )
    expect(screen.queryByTestId("action-error")).not.toBeInTheDocument()

    unmount()
    await Promise.resolve()
  })

  it("keeps the first activation running and exposes a busy second action", async () => {
    let release!: (value: BrowserGenerationRuntime) => void
    const loading = new Promise<BrowserGenerationRuntime>((resolve) => {
      release = resolve
    })
    const controller: RuntimeController = createRuntimeController({
      getNative: () => undefined,
      isGemmaCached: async () => false,
      loadGemma: vi.fn(() => loading),
    })
    const user = userEvent.setup()
    render(
      <RuntimeProvider controller={controller}>
        <RuntimeActions />
      </RuntimeProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("choice-required")
    )
    const activate = screen.getByRole("button", { name: "Activate Gemma" })
    await user.click(activate)
    await user.click(activate)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already in progress"
    )
    expect(screen.getByTestId("status")).toHaveTextContent("activating")

    release(runtime())
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("ready")
    )
    expect(screen.queryByTestId("action-error")).not.toBeInTheDocument()
  })

  it("does not carry an action error across controller replacement", async () => {
    const controllerA = createRuntimeController({
      getNative: () => undefined,
      isGemmaCached: async () => false,
    })
    const controllerB = createRuntimeController({
      getNative: () => undefined,
      isGemmaCached: async () => false,
    })
    let activationCalls = 0
    vi.spyOn(controllerA, "activate").mockImplementation(() => {
      activationCalls += 1
      return activationCalls === 1
        ? new Promise<void>(() => {})
        : Promise.reject(new RuntimeActivationBusyError())
    })
    const user = userEvent.setup()
    const { rerender, unmount } = render(
      <RuntimeProvider controller={controllerA}>
        <RuntimeActions />
      </RuntimeProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("choice-required")
    )
    const activate = screen.getByRole("button", { name: "Activate Gemma" })
    await user.click(activate)
    await user.click(activate)
    expect(await screen.findByTestId("action-error")).toHaveTextContent(
      "already in progress"
    )

    rerender(
      <RuntimeProvider controller={controllerB}>
        <RuntimeActions />
      </RuntimeProvider>
    )
    expect(screen.queryByTestId("action-error")).not.toBeInTheDocument()
    unmount()
    await Promise.resolve()
  })

  it("does not duplicate an activation failure already in the controller snapshot", async () => {
    const failure = new Error("GPU preparation failed")
    const controller: RuntimeController = createRuntimeController({
      getNative: () => undefined,
      isGemmaCached: async () => false,
      loadGemma: vi.fn(async () => {
        throw failure
      }),
    })
    const user = userEvent.setup()
    render(
      <RuntimeProvider controller={controller}>
        <RuntimeActions />
      </RuntimeProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("choice-required")
    )
    await user.click(screen.getByRole("button", { name: "Activate Gemma" }))

    expect(await screen.findByTestId("snapshot-error")).toHaveTextContent(
      failure.message
    )
    expect(screen.queryByTestId("action-error")).not.toBeInTheDocument()
  })
})
