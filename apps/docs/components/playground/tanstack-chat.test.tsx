import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TanStackChat } from "./tanstack-chat"
import type { BrowserModelRuntime } from "./model/types"

describe("TanStackChat", () => {
  it("protects Prompt API input, restores output, and clears a conversation", async () => {
    let wire = ""
    const destroy = vi.fn()
    const create = vi.fn(async () => {
      const model = {
        destroy,
        promptStreaming(prompt: LanguageModelPrompt) {
          wire = String(prompt)
          const placeholder = wire.match(/PII[0-9A-HJKMNP-TV-Z]+/)?.[0]
          expect(placeholder).toBeDefined()
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`I received ${placeholder}`)
              controller.close()
            },
          })
        },
      }
      return model as unknown as LanguageModel
    })
    const runtime: BrowserModelRuntime = {
      availability: vi.fn(async () => "available" as const),
      kind: "gemini-nano",
      create,
    }
    const user = userEvent.setup()
    render(<TanStackChat runtime={runtime} runtimeName="Fake local model" />)

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))

    await waitFor(() => expect(wire).toMatch(/PII[0-9A-HJKMNP-TV-Z]+/))
    expect(wire).not.toContain("ana@acme.com")
    expect(await screen.findByText("ana@acme.com")).toBeVisible()
    expect(destroy).toHaveBeenCalledOnce()

    await user.click(screen.getByRole("button", { name: "Start a new chat" }))
    expect(screen.getByText("Private local chat")).toBeVisible()
    expect(screen.getByText("No prompt sent yet.")).toBeVisible()
  })
})
