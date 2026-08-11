import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TanStackChat } from "./tanstack-chat"
import type { BrowserGenerationRuntime } from "./model/types"

describe("TanStackChat", () => {
  it("protects Prompt API input, restores output, and clears a conversation", async () => {
    let wire = ""
    const generate = vi.fn(async function* ({ protectedContent }) {
      wire = protectedContent
      const placeholder = wire.match(/PII[0-9A-HJKMNP-TV-Z]+/)?.[0]
      expect(placeholder).toBeDefined()
      yield `I received ${placeholder}`
    })
    const runtime: BrowserGenerationRuntime = {
      id: "fake-local-model",
      disclosure: {
        label: "Fake local model",
        model: "fake-local-model",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate,
      dispose: vi.fn(async () => undefined),
    }
    const user = userEvent.setup()
    render(<TanStackChat runtime={runtime} runtimeName="Fake local model" />)

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))

    await waitFor(() => expect(wire).toMatch(/PII[0-9A-HJKMNP-TV-Z]+/))
    expect(wire).not.toContain("ana@acme.com")
    expect(await screen.findByText("ana@acme.com")).toBeVisible()
    expect(generate).toHaveBeenCalledOnce()

    await user.click(screen.getByRole("button", { name: "Start a new chat" }))
    expect(screen.getByText("Private local chat")).toBeVisible()
    expect(screen.getByText("No prompt sent yet.")).toBeVisible()
  })
})
