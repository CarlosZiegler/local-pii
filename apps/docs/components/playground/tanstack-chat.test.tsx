import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ModelMessage } from "@tanstack/ai/client"
import { createAnonymizer } from "local-pii"
import { describe, expect, it, vi } from "vitest"
import { TanStackChat } from "./tanstack-chat"
import { createTanStackPlaygroundConnection } from "./tanstack-playground-connection"
import { createProtectionObserver } from "./protection-observer"
import type {
  BrowserGenerationRuntime,
  ProtectedBrowserRequest,
  RuntimeDisclosure,
} from "./model/types"

const DISCLOSURE: RuntimeDisclosure = {
  label: "Fake local model",
  model: "fake-local-model",
  source: "test",
  artifacts: { kind: "browser-managed" },
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function tokenFrom(request: ProtectedBrowserRequest): string {
  const placeholder = request.protectedContent.match(
    /PII[0-9A-HJKMNP-TV-Z]+/
  )?.[0]
  if (!placeholder) throw new Error("Expected protected content")
  return placeholder
}

describe("TanStackChat", () => {
  it("protects the real adapter request once, restores output, and resets its session", async () => {
    const requests: ProtectedBrowserRequest[] = []
    const generate = vi.fn(async function* (request: ProtectedBrowserRequest) {
      requests.push(request)
      const placeholder = request.protectedContent.match(
        /PII[0-9A-HJKMNP-TV-Z]+/
      )?.[0]
      expect(placeholder).toBeDefined()
      yield `I received ${placeholder}`
    })
    const runtime: BrowserGenerationRuntime = {
      id: "fake-local-model",
      disclosure: DISCLOSURE,
      generate,
      dispose: vi.fn(async () => undefined),
    }
    const user = userEvent.setup()
    render(<TanStackChat runtime={runtime} runtimeName="Fake local model" />)

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]?.protectedContent).not.toContain("ana@acme.com")
    expect(requests[0]?.protectedContent).toMatch(/PII[0-9A-HJKMNP-TV-Z]+/)
    expect(
      screen.getByLabelText("Current protected content")
    ).toHaveTextContent(requests[0]?.protectedContent ?? "")
    expect(await screen.findByText("ana@acme.com")).toBeVisible()
    expect(screen.getByText("EMAIL: 1")).toBeVisible()
    expect(generate).toHaveBeenCalledOnce()

    await user.clear(screen.getByLabelText("Message"))
    await user.type(screen.getByLabelText("Message"), "Call +49 151 12345678")
    await user.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]?.protectedHistory).toEqual([
      expect.objectContaining({
        role: "user",
        protectedContent: expect.stringMatching(/PII[0-9A-HJKMNP-TV-Z]+/),
      }),
      expect.objectContaining({ role: "assistant" }),
    ])
    expect(JSON.stringify(requests[1])).not.toContain("ana@acme.com")
    expect(JSON.stringify(requests[1])).not.toContain("+49 151 12345678")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled()
    )

    await user.click(screen.getByRole("button", { name: "Start a new chat" }))
    expect(await screen.findByText("Private local chat")).toBeVisible()
    expect(
      screen.getByText("No generation run has been committed yet.")
    ).toBeVisible()

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2]?.protectedHistory).toEqual([])
    expect(requests[2]?.protectedContent).not.toBe(
      requests[0]?.protectedContent
    )
  })

  it("does not mutate frozen TanStack input objects in the component adapter path", async () => {
    const session = createAnonymizer({
      detectors: "none",
      dictionary: [{ type: "EMAIL", value: "ana@example.com" }],
    }).createSession()
    const observer = createProtectionObserver(session, () => undefined)
    observer.begin("run-frozen-input")
    const requests: ProtectedBrowserRequest[] = []
    const runtime: BrowserGenerationRuntime = {
      id: "frozen-input-runtime",
      disclosure: DISCLOSURE,
      generate(request) {
        requests.push(request)
        return {
          async *[Symbol.asyncIterator]() {
            yield "ok"
          },
        }
      },
      dispose: vi.fn(async () => undefined),
    }
    const prior = Object.freeze({
      role: "user" as const,
      content: "Email ana@example.com",
    })
    const current = Object.freeze({
      role: "user" as const,
      content: "Current",
    })
    const messages = [prior, current] as ModelMessage[]
    Object.freeze(messages)
    const connection = createTanStackPlaygroundConnection({
      getRun: () => null,
      observer,
      runtime,
    })

    for await (const _chunk of connection.connect(messages)) {
      // Consume the exact adapter path used by the component.
    }

    expect(messages[0]).toBe(prior)
    expect(messages[1]).toBe(current)
    expect(messages).toEqual([prior, current])
    expect(requests[0]?.protectedHistory[0]?.protectedContent).not.toContain(
      "ana@example.com"
    )
  })

  it("keeps the conversation blocked until Stop cleanup settles and hides late output", async () => {
    const requests: ProtectedBrowserRequest[] = []
    const cleanup = deferred<void>()
    const lateNext = deferred<IteratorResult<string>>()
    let returnStarted = false
    const runtime: BrowserGenerationRuntime = {
      id: "deferred-tanstack",
      disclosure: DISCLOSURE,
      generate(request) {
        requests.push(request)
        if (requests.length > 1) {
          return {
            async *[Symbol.asyncIterator]() {
              yield `Fresh ${tokenFrom(request)}`
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
                    value: `Partial ${tokenFrom(request)}`,
                  })
                }
                if (step === 2) {
                  return Promise.resolve({
                    done: false as const,
                    value: " received.",
                  })
                }
                return lateNext.promise
              },
              async return() {
                returnStarted = true
                await cleanup.promise
                return { done: true as const, value: undefined }
              },
            }
          },
        }
      },
      dispose: vi.fn(async () => undefined),
    }
    const user = userEvent.setup()
    render(<TanStackChat runtime={runtime} runtimeName="Fake local model" />)

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))
    expect(await screen.findByText("Partial")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Stop" }))
    await waitFor(() => expect(returnStarted).toBe(true))
    expect(screen.getByLabelText("Message")).toBeDisabled()
    expect(screen.getByText("Email ana@acme.com")).toBeVisible()
    lateNext.resolve({ done: false, value: "late old output" })
    expect(screen.queryByText("late old output")).not.toBeInTheDocument()

    cleanup.resolve()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled()
    )
    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Start a new chat" }))
    expect(await screen.findByText("Private local chat")).toBeVisible()
    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]?.protectedHistory).toEqual([])
    expect(tokenFrom(requests[1]!)).not.toBe(tokenFrom(requests[0]!))
  })

  it("shows a runtime cleanup failure after Stop", async () => {
    const cleanupFailure = new Error("tanstack cleanup failed")
    let returnStarted = false
    const runtime: BrowserGenerationRuntime = {
      id: "failed-tanstack-cleanup",
      disclosure: DISCLOSURE,
      generate(request) {
        let step = 0
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (step++ === 0) {
                  return Promise.resolve({
                    done: false as const,
                    value: `Working ${tokenFrom(request)}`,
                  })
                }
                if (step === 2) {
                  return Promise.resolve({
                    done: false as const,
                    value: " received.",
                  })
                }
                return new Promise<IteratorResult<string>>(() => {})
              },
              async return() {
                returnStarted = true
                throw cleanupFailure
              },
            }
          },
        }
      },
      dispose: vi.fn(async () => undefined),
    }
    const user = userEvent.setup()
    render(<TanStackChat runtime={runtime} runtimeName="Fake local model" />)

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))
    await screen.findByText("Working")
    await user.click(screen.getByRole("button", { name: "Stop" }))

    await waitFor(() => expect(returnStarted).toBe(true))
    expect(await screen.findByText("tanstack cleanup failed")).toBeVisible()
    expect(
      screen.getByRole("button", { name: "Start a new chat" })
    ).toBeEnabled()
  })
})
