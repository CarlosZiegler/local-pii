import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
      {state.actionError ? (
        <output role="alert">{state.actionError.message}</output>
      ) : null}
    </>
  )
}

describe("RuntimeProvider", () => {
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
})
