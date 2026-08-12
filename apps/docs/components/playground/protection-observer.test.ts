import { createAnonymizer, type AnonymizeResult } from "local-pii"
import { describe, expect, it, vi } from "vitest"
import { createProtectedBrowserRequest } from "./model/protected-request"
import type { PiiSession } from "local-pii"
import {
  createGenerationGate,
  PlaygroundBusyError,
  withPlaygroundGate,
} from "./generation-gate"
import {
  createProtectionObserver,
  observeBrowserRuntime,
  type PrivacyInspection,
} from "./protection-observer"
import type { BrowserGenerationRuntime } from "./model/types"

function session(): PiiSession {
  return createAnonymizer().createSession()
}

describe("protection observer", () => {
  it("records the real session result once and commits the exact request", async () => {
    const base = session()
    const baseAnonymize = vi.spyOn(base, "anonymize")
    const publish = vi.fn<(inspection: PrivacyInspection) => void>()
    const observer = createProtectionObserver(base, publish)
    const run = observer.begin("run-a")

    const current = await observer.session.anonymize("Email ana@example.com")
    const nested = await observer.session.anonymizeJson({
      note: "Call ana@example.com",
      values: ["ana@example.com", 7],
    })
    const request = createProtectedBrowserRequest({
      protectedHistory: [
        { role: "system", protectedContent: "Be brief" },
        {
          role: "user",
          protectedContent: String((nested as { note: unknown }).note),
        },
      ],
      protectedContent: current.redactedText,
    })

    const inspection = run.commit(request)

    expect(baseAnonymize).toHaveBeenCalledTimes(3)
    expect(nested).toEqual({
      note: "Call [EMAIL_1]",
      values: ["[EMAIL_1]", 7],
    })
    expect(inspection).toMatchObject({
      generationRunId: "run-a",
      protectedHistory: request.protectedHistory,
      protectedContent: request.protectedContent,
      counts: { EMAIL: 3 },
    })
    expect(publish).toHaveBeenCalledWith(inspection)
    expect(inspection?.protectedContent).not.toContain("ana@example.com")
    expect(base.mapping).toEqual({
      "[EMAIL_1]": "ana@example.com",
    })
    expect(Object.isFrozen(inspection)).toBe(true)
    expect(Object.isFrozen(inspection?.counts)).toBe(true)
    expect(Object.isFrozen(inspection?.protectedHistory)).toBe(true)
    expect(Object.isFrozen(inspection?.protectedHistory[0])).toBe(true)
  })

  it("routes nested JSON leaves through observed anonymize without a second pass", async () => {
    const base = session()
    const observer = createProtectionObserver(base, vi.fn())
    const run = observer.begin("json")
    const result = await observer.session.anonymizeJson({
      email: "json@example.com",
      nested: [{ value: "json@example.com" }],
    })

    const request = createProtectedBrowserRequest({
      protectedHistory: [],
      protectedContent: JSON.stringify(result),
    })
    const inspection = run.commit(request)

    expect(inspection?.counts).toEqual({ EMAIL: 2 })
    expect(base.mapping).toEqual({ "[EMAIL_1]": "json@example.com" })
  })

  it("ignores a late record and commit from an older run", async () => {
    const observer = createProtectionObserver(session(), vi.fn())
    const runA = observer.begin("run-a")
    const resultA = await observer.session.anonymize("a@example.com")
    const runB = observer.begin("run-b")
    runA.record(["late"], resultA)

    const requestB = createProtectedBrowserRequest({
      protectedHistory: [],
      protectedContent: "current",
    })
    expect(runA.commit(requestB)).toBeUndefined()
    expect(runB.commit(requestB)?.generationRunId).toBe("run-b")
  })

  it("discards failed or cancelled runs without publishing", async () => {
    const publish = vi.fn()
    const observer = createProtectionObserver(session(), publish)
    const run = observer.begin("cancelled")
    await observer.session.anonymize("cancel@example.com")
    run.discard()

    const request = createProtectedBrowserRequest({
      protectedHistory: [],
      protectedContent: "discarded",
    })
    expect(run.commit(request)).toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
  })

  it("preserves a normal JSON object shape while protecting __proto__ keys", async () => {
    const observer = createProtectionObserver(session(), vi.fn())
    observer.begin("prototype")
    const input = JSON.parse(
      '{"__proto__":"proto@example.com","ok":"ok@example.com"}'
    ) as Record<string, unknown>
    const result = await observer.session.anonymizeJson(input)

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true)
    expect((result as Record<string, unknown>)["__proto__"]).toBe("[EMAIL_1]")
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("delegates mapping, rehydration, and clear to the base session", () => {
    const base = session()
    const rehydrate = vi.spyOn(base, "rehydrate")
    const clear = vi.spyOn(base, "clear")
    const observer = createProtectionObserver(base, vi.fn())

    expect(observer.session.mapping).toStrictEqual(base.mapping)
    expect(observer.session.rehydrate("hello")).toBe("hello")
    observer.session.clear()
    expect(rehydrate).toHaveBeenCalledWith("hello", undefined)
    expect(clear).toHaveBeenCalledOnce()
  })

  it("commits at the decorated runtime iterator seam without protecting again", async () => {
    const base = session()
    const publish = vi.fn()
    const observer = createProtectionObserver(base, publish)
    observer.begin("seam-run")
    const result = await observer.session.anonymize("seam@example.com")
    const request = createProtectedBrowserRequest({
      protectedHistory: [],
      protectedContent: result.redactedText,
    })
    const runtime: BrowserGenerationRuntime = {
      id: "seam",
      disclosure: {
        label: "Seam",
        model: "seam",
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
    const observed = observeBrowserRuntime(runtime, observer)
    const generation = observed.generate(request)

    expect(publish).not.toHaveBeenCalled()
    const iterator = generation[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: "ok",
    })
    expect(publish).not.toHaveBeenCalled()
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
    expect(publish).toHaveBeenCalledOnce()
    expect(base.mapping).toEqual({ "[EMAIL_1]": "seam@example.com" })
  })

  it("does not let a late run commit into the current run", async () => {
    const publish = vi.fn()
    const observer = createProtectionObserver(session(), publish)
    observer.begin("run-a")
    const requestA = createProtectedBrowserRequest({
      protectedHistory: [],
      protectedContent: "request-a",
    })
    const runtime: BrowserGenerationRuntime = {
      id: "late-run",
      disclosure: {
        label: "Late run",
        model: "late-run",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate: () => ({
        async *[Symbol.asyncIterator]() {
          yield "ok"
        },
      }),
      dispose: async () => undefined,
    }
    const observed = observeBrowserRuntime(runtime, observer)
    const runA = observed.generate(requestA)[Symbol.asyncIterator]()

    const runB = observer.begin("run-b")
    await runA.next()
    await runA.next()

    expect(publish).not.toHaveBeenCalled()
    expect(
      runB.commit(
        createProtectedBrowserRequest({
          protectedHistory: [],
          protectedContent: "request-b",
        })
      )?.generationRunId
    ).toBe("run-b")
  })

  it("does not publish a pending first result after consumer cancellation", async () => {
    let resolveNext!: (result: IteratorResult<string>) => void
    const nextResult = new Promise<IteratorResult<string>>((resolve) => {
      resolveNext = resolve
    })
    const publish = vi.fn()
    const observer = createProtectionObserver(session(), publish)
    observer.begin("cancel-race")
    const runtime: BrowserGenerationRuntime = {
      id: "cancel-race",
      disclosure: {
        label: "Cancel race",
        model: "cancel-race",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => nextResult,
            return: async () => ({ done: true, value: undefined }),
          }
        },
      }),
      dispose: async () => undefined,
    }
    const iterator = observeBrowserRuntime(runtime, observer)
      .generate(
        createProtectedBrowserRequest({
          protectedHistory: [],
          protectedContent: "protected",
        })
      )
      [Symbol.asyncIterator]()
    const pending = iterator.next()

    await iterator.return?.("cancel")
    resolveNext({ done: false, value: "late" })
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await Promise.resolve()

    expect(publish).not.toHaveBeenCalled()
  })

  it("does not publish a generation run that fails after its first chunk", async () => {
    const failure = new Error("late generation failure")
    const publish = vi.fn()
    const observer = createProtectionObserver(session(), publish)
    observer.begin("failed-run")
    const runtime: BrowserGenerationRuntime = {
      id: "late-failure",
      disclosure: {
        label: "Late failure",
        model: "late-failure",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate: () => ({
        async *[Symbol.asyncIterator]() {
          yield "first"
          throw failure
        },
      }),
      dispose: async () => undefined,
    }
    const iterator = observeBrowserRuntime(runtime, observer)
      .generate(
        createProtectedBrowserRequest({
          protectedHistory: [],
          protectedContent: "protected",
        })
      )
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: "first",
    })
    expect(publish).not.toHaveBeenCalled()
    await expect(iterator.next()).rejects.toBe(failure)
    expect(publish).not.toHaveBeenCalled()
  })

  it("does not let a busy sibling iterator discard the winning observation", async () => {
    let resolveNext!: (result: IteratorResult<string>) => void
    const nextResult = new Promise<IteratorResult<string>>((resolve) => {
      resolveNext = resolve
    })
    const publish = vi.fn()
    const observer = createProtectionObserver(session(), publish)
    observer.begin("winner")
    const source: BrowserGenerationRuntime = {
      id: "sibling-observer",
      disclosure: {
        label: "Sibling observer",
        model: "sibling-observer",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => nextResult,
            return: async () => ({ done: true, value: undefined }),
          }
        },
      }),
      dispose: async () => undefined,
    }
    const gate = createGenerationGate()
    const runtime = observeBrowserRuntime(
      withPlaygroundGate(source, gate, "vercel"),
      observer
    )
    const generated = runtime.generate(
      createProtectedBrowserRequest({
        protectedHistory: [],
        protectedContent: "protected",
      })
    )
    const winner = generated[Symbol.asyncIterator]()
    const sibling = generated[Symbol.asyncIterator]()
    const winnerNext = winner.next()
    await vi.waitFor(() =>
      expect(gate.getSnapshot()).toEqual({ owner: "vercel" })
    )

    await expect(sibling.next()).rejects.toBeInstanceOf(PlaygroundBusyError)
    resolveNext({ done: true, value: undefined })
    await expect(winnerNext).resolves.toEqual({
      done: true,
      value: undefined,
    })

    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      generationRunId: "winner",
      protectedContent: "protected",
    })
  })
})
