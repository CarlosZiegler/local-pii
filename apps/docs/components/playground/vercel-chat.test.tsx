import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"
import { VercelChat } from "./vercel-chat"

const EMPTY_USAGE = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: undefined,
  },
  outputTokens: { reasoning: undefined, text: undefined, total: undefined },
}

describe("VercelChat", () => {
  it("protects model input and restores the streamed response", async () => {
    let wire = ""
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        wire = JSON.stringify(options.prompt)
        const placeholder = wire.match(/PII[0-9A-HJKMNP-TV-Z]+/)?.[0]
        expect(placeholder).toBeDefined()
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] })
              controller.enqueue({ type: "text-start", id: "text-1" })
              controller.enqueue({
                type: "text-delta",
                id: "text-1",
                delta: `I received ${placeholder}`,
              })
              controller.enqueue({ type: "text-end", id: "text-1" })
              controller.enqueue({
                type: "finish",
                finishReason: { raw: "stop", unified: "stop" },
                usage: EMPTY_USAGE,
              })
              controller.close()
            },
          }),
        }
      },
    })
    const user = userEvent.setup()
    render(<VercelChat model={model} runtimeName="Fake local model" />)

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))

    await waitFor(() => expect(wire).not.toContain("ana@acme.com"))
    expect(wire).toMatch(/PII[0-9A-HJKMNP-TV-Z]+/)
    expect(await screen.findByText("ana@acme.com")).toBeVisible()
    expect(screen.getByText(/What the model receives/)).toBeVisible()
  })
})
