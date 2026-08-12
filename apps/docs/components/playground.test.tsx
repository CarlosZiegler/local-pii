import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { RuntimePlayground } from "./playground"
import {
  createGenerationGate,
  PlaygroundBusyError,
} from "./playground/generation-gate"
import type { RuntimeController } from "./playground/model/runtime-controller"
import type {
  BrowserGenerationRuntime,
  ProtectedBrowserRequest,
} from "./playground/model/types"
import { RuntimeProviderCore } from "./playground/runtime-provider-core"
import { runtimeChoiceAriaLabel } from "./playground/runtime-choice"

const option = {
  kind: "gemini-nano" as const,
  disclosure: {
    label: "Chrome built-in Prompt API",
    model: "Gemini Nano",
    source: "Chrome built-in Prompt API",
    artifacts: { kind: "browser-managed" as const },
  },
}

describe("runtime choice accessibility", () => {
  it("names unavailable choices with their visible state and runtime", () => {
    expect(
      runtimeChoiceAriaLabel({ ...option, availability: "unavailable" })
    ).toBe("Unavailable — Chrome built-in Prompt API")
  })

  it("keeps activation and cached action names aligned with visible labels", () => {
    expect(
      runtimeChoiceAriaLabel({ ...option, availability: "requires-activation" })
    ).toBe("Activate runtime — Chrome built-in Prompt API")
    expect(runtimeChoiceAriaLabel({ ...option, availability: "ready" })).toBe(
      "Use cached runtime — Chrome built-in Prompt API"
    )
  })

  it("keeps force-mounted chats independent behind one runtime gate", async () => {
    let finishVercel!: (result: IteratorResult<string>) => void
    const vercelFinish = new Promise<IteratorResult<string>>((resolve) => {
      finishVercel = resolve
    })
    const requests: ProtectedBrowserRequest[] = []
    const runtime: BrowserGenerationRuntime = {
      id: "shared-runtime",
      disclosure: option.disclosure,
      generate(request) {
        requests.push(request)
        const placeholder = request.protectedContent.match(
          /PII[0-9A-HJKMNP-TV-Z]+/
        )?.[0]
        if (!placeholder) throw new Error("Expected protected content")
        if (requests.length > 1) {
          return {
            async *[Symbol.asyncIterator]() {
              yield `TanStack received ${placeholder}`
            },
          }
        }
        let step = 0
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (step++ === 0) {
                  return Promise.resolve({
                    done: false as const,
                    value: `Vercel received ${placeholder}.`,
                  })
                }
                return vercelFinish
              },
              async return() {
                return { done: true as const, value: undefined }
              },
            }
          },
        }
      },
      dispose: vi.fn(async () => undefined),
    }
    const readySnapshot = {
      status: "ready" as const,
      kind: "gemini-nano" as const,
      disclosure: option.disclosure,
    }
    const controller: RuntimeController = {
      activate: vi.fn(async () => undefined),
      check: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      getRuntime: () => runtime,
      getSnapshot: () => readySnapshot,
      subscribe: () => () => undefined,
    }
    const gate = createGenerationGate()
    const user = userEvent.setup()
    render(
      <RuntimeProviderCore controller={controller} gate={gate}>
        <RuntimePlayground />
      </RuntimeProviderCore>
    )
    const panelFor = (title: string): HTMLElement => {
      const panel = screen
        .getAllByText(title)
        .find((element) => element.closest("[data-slot=tabs-content]"))
        ?.closest("[data-slot=tabs-content]")
      if (!(panel instanceof HTMLElement)) {
        throw new Error(`Expected the ${title} panel`)
      }
      return panel
    }
    const vercelPanel = panelFor("Vercel AI SDK")
    const tanstackPanel = panelFor("TanStack AI")

    await user.type(
      within(vercelPanel).getByLabelText("Message"),
      "Email vercel@example.com"
    )
    await user.click(
      within(vercelPanel).getByRole("button", { name: "Submit" })
    )
    await waitFor(() => expect(gate.getSnapshot().owner).toBe("vercel"))
    const tanstackInput = within(tanstackPanel).getByLabelText("Message")
    expect(tanstackInput).toBeDisabled()
    expect(tanstackInput).toHaveAccessibleDescription(
      "Another private conversation is running browser-local inference."
    )
    expect(
      within(tanstackPanel).getByText(
        "Another private conversation is running browser-local inference."
      )
    ).toBeVisible()
    expect(() => gate.tryAcquire("tanstack")).toThrow(PlaygroundBusyError)
    expect(within(tanstackPanel).queryByText("vercel@example.com")).toBeNull()

    finishVercel({ done: true, value: undefined })
    await waitFor(() => expect(gate.getSnapshot().owner).toBeNull())
    expect(
      await within(vercelPanel).findByRole("button", {
        name: "vercel@example.com",
      })
    ).toBeVisible()

    await user.click(screen.getByRole("tab", { name: "TanStack AI" }))
    await waitFor(() =>
      expect(within(tanstackPanel).getByLabelText("Message")).toBeEnabled()
    )
    await user.type(
      within(tanstackPanel).getByLabelText("Message"),
      "Email tanstack@example.com"
    )
    await user.click(
      within(tanstackPanel).getByRole("button", { name: "Submit" })
    )
    expect(
      await within(tanstackPanel).findByRole("button", {
        name: "tanstack@example.com",
      })
    ).toBeVisible()

    expect(requests).toHaveLength(2)
    expect(requests[0]?.protectedHistory).toEqual([])
    expect(requests[1]?.protectedHistory).toEqual([])
    expect(JSON.stringify(requests)).not.toContain("@example.com")
    expect(
      within(vercelPanel).getAllByText("vercel@example.com").length
    ).toBeGreaterThan(0)
    expect(within(tanstackPanel).queryByText("vercel@example.com")).toBeNull()
    expect(within(vercelPanel).queryByText("tanstack@example.com")).toBeNull()
  })
})
