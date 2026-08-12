import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode } from "react"
import { describe, expect, it, vi } from "vitest"
import {
  createRuntimeController,
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
