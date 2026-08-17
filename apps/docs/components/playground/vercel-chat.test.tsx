import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { NerBackend } from "@local-pii/core"
import { describe, expect, it, vi } from "vitest"
import type {
  BrowserGenerationRuntime,
  ProtectedBrowserRequest,
  RuntimeDisclosure,
} from "./model/types"
import { VercelChat } from "./vercel-chat"

const DISCLOSURE: RuntimeDisclosure = {
  label: "Deterministic browser runtime",
  model: "test-runtime",
  source: "test",
  artifacts: { kind: "browser-managed" },
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function tokenFrom(request: ProtectedBrowserRequest): string {
  const placeholder = request.protectedContent.match(
    /PII[0-9A-HJKMNP-TV-Z]+/
  )?.[0]
  if (!placeholder) throw new Error("Expected protected content")
  return placeholder
}

describe("VercelChat", () => {
  it("fails closed before browser generation when model-backed Detection cannot load", async () => {
    const detectionFailure = new Error("Detection model unavailable")
    const detection: NerBackend = {
      name: "failed-rampart",
      async load() {
        throw detectionFailure
      },
      async detect() {
        return []
      },
      async dispose() {},
    }
    const generate = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield "must not run"
      },
    }))
    const runtime: BrowserGenerationRuntime = {
      id: "failed-detection-runtime",
      disclosure: DISCLOSURE,
      generate,
      dispose: vi.fn(async () => undefined),
    }
    const user = userEvent.setup()
    render(
      <VercelChat
        detection={detection}
        runtime={runtime}
        runtimeName="Fake local model"
      />
    )

    await user.type(screen.getByLabelText("Message"), "Carlos Rivera")
    await user.click(screen.getByRole("button", { name: "Submit" }))

    expect(await screen.findByText("Generation failed")).toBeVisible()
    expect(generate).not.toHaveBeenCalled()
  })

  it("uses the supplied local Detection adapter before browser generation", async () => {
    const requests: ProtectedBrowserRequest[] = []
    const detection: NerBackend = {
      name: "test-rampart",
      async load() {},
      async detect(text) {
        const start = text.indexOf("Carlos")
        return start < 0
          ? []
          : [
              {
                type: "GIVEN_NAME",
                source: "ner",
                confidence: 1,
                text: "Carlos",
                start,
                end: start + "Carlos".length,
              },
            ]
      },
      async dispose() {},
    }
    const runtime: BrowserGenerationRuntime = {
      id: "detection-runtime",
      disclosure: DISCLOSURE,
      generate(request) {
        requests.push(request)
        return {
          async *[Symbol.asyncIterator]() {
            yield "Drafted a support reply."
          },
        }
      },
      dispose: vi.fn(async () => undefined),
    }
    const user = userEvent.setup()
    render(
      <VercelChat
        detection={detection}
        runtime={runtime}
        runtimeName="Fake local model"
      />
    )

    await user.type(
      screen.getByLabelText("Message"),
      "Draft a support reply for Carlos about a delayed order."
    )
    await user.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]?.protectedContent).not.toContain("Carlos")
    expect(requests[0]?.protectedContent).toMatch(/PII[0-9A-HJKMNP-TV-Z]+/)
  })

  it("protects the real runtime request once, restores output, and inspects that exact request", async () => {
    const requests: ProtectedBrowserRequest[] = []
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "LanguageModel"
    )
    const runtime: BrowserGenerationRuntime = {
      id: "deterministic",
      disclosure: DISCLOSURE,
      generate(request) {
        requests.push(request)
        return {
          async *[Symbol.asyncIterator]() {
            yield `I received ${tokenFrom(request)}`
          },
        }
      },
      dispose: vi.fn(async () => undefined),
    }
    const user = userEvent.setup()
    render(<VercelChat runtime={runtime} runtimeName="Fake local model" />)

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))

    expect(
      await screen.findByRole("button", { name: "ana@acme.com" })
    ).toBeVisible()
    await waitFor(() => expect(requests).toHaveLength(1))
    const protectedContent = requests[0]?.protectedContent
    expect(protectedContent).not.toContain("ana@acme.com")
    expect(protectedContent).toMatch(/PII[0-9A-HJKMNP-TV-Z]+/)
    expect(
      screen.getByLabelText("Current protected content")
    ).toHaveTextContent(protectedContent ?? "")
    expect(screen.getByText("EMAIL: 1")).toBeVisible()
    expect(
      Object.getOwnPropertyDescriptor(globalThis, "LanguageModel")
    ).toEqual(descriptor)

    await user.click(screen.getByRole("button", { name: "Start a new chat" }))
    expect(
      await screen.findByText("No generation run has been committed yet.")
    ).toBeVisible()
    expect(
      screen.queryByLabelText("Current protected content")
    ).not.toBeInTheDocument()
  })

  it("keeps the old conversation until cancellation cleanup settles, then starts with a fresh privacy session", async () => {
    const requests: ProtectedBrowserRequest[] = []
    const cleanup = deferred<void>()
    const lateNext = deferred<IteratorResult<string>>()
    let returnStarted = false
    const runtime: BrowserGenerationRuntime = {
      id: "deferred-cleanup",
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
                if (step === 2)
                  return Promise.resolve({
                    done: false as const,
                    value: " received.",
                  })
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
    render(<VercelChat runtime={runtime} runtimeName="Fake local model" />)

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))
    expect(await screen.findByText("Partial")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Stop" }))
    await waitFor(() => expect(returnStarted).toBe(true))
    expect(screen.getByText("Email ana@acme.com")).toBeVisible()
    expect(screen.getByLabelText("Message")).toBeDisabled()
    lateNext.resolve({ done: false, value: "late old output" })
    expect(screen.queryByText("late old output")).not.toBeInTheDocument()

    cleanup.resolve()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled()
    )
    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Start a new chat" }))
    await waitFor(() =>
      expect(screen.getByText("Private local chat")).toBeVisible()
    )
    expect(screen.queryByText("Email ana@acme.com")).not.toBeInTheDocument()
    expect(
      screen.getByText("No generation run has been committed yet.")
    ).toBeVisible()

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]?.protectedHistory).toEqual([])
    expect(tokenFrom(requests[1]!)).not.toBe(tokenFrom(requests[0]!))
  })

  it("shows a non-abort runtime cleanup failure after Stop", async () => {
    const cleanupFailure = new Error("runtime cleanup failed")
    let returnStarted = false
    const runtime: BrowserGenerationRuntime = {
      id: "failed-cleanup",
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
                if (step === 2)
                  return Promise.resolve({
                    done: false as const,
                    value: " received.",
                  })
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
    render(<VercelChat runtime={runtime} runtimeName="Fake local model" />)

    await user.type(screen.getByLabelText("Message"), "Email ana@acme.com")
    await user.click(screen.getByRole("button", { name: "Submit" }))
    await screen.findByText("Working")
    await user.click(screen.getByRole("button", { name: "Stop" }))

    await waitFor(() => expect(returnStarted).toBe(true))
    expect(await screen.findByText("runtime cleanup failed")).toBeVisible()
    expect(
      screen.getByRole("button", { name: "Start a new chat" })
    ).toBeEnabled()
  })
})
