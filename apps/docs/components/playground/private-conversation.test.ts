import { describe, expect, it, vi } from "vitest"
import {
  createGenerationRunRegistry,
  recordGenerationRunFailures,
  resetPrivateConversation,
} from "./private-conversation"
import type { BrowserGenerationRuntime } from "./model/types"

describe("private conversation lifecycle", () => {
  it("runs the reset sequence in order and returns the primary failure", async () => {
    const events: string[] = []
    const primary = new Error("stop failed")
    const result = await resetPrivateConversation({
      blockSubmissions(blocked) {
        events.push(blocked ? "block-submissions" : "enable-submissions")
      },
      abortActiveRun() {
        events.push("abort-active-run")
      },
      async stopFramework() {
        events.push("stop-framework")
        return primary
      },
      async awaitRunSettlement() {
        events.push("run-settled")
      },
      async awaitRuntimeCleanup() {
        events.push("runtime-cleanup-settled")
      },
      clearFramework() {
        events.push("clear-framework-history")
      },
      clearFrameworkError() {
        events.push("clear-framework-error")
      },
      clearOldSession() {
        events.push("clear-old-session")
      },
      clearInspection() {
        events.push("clear-inspection")
      },
      createNewSession() {
        events.push("create-new-session")
      },
    })

    expect(result).toBe(primary)
    expect(events).toEqual([
      "block-submissions",
      "abort-active-run",
      "stop-framework",
      "run-settled",
      "runtime-cleanup-settled",
      "clear-framework-history",
      "clear-framework-error",
      "clear-old-session",
      "clear-inspection",
      "create-new-session",
      "enable-submissions",
    ])
  })

  it("treats an expected abort as non-error but retains cleanup failures", async () => {
    const cleanup = new Error("cleanup failed")
    const result = await resetPrivateConversation({
      blockSubmissions() {},
      abortActiveRun() {},
      async stopFramework() {
        return undefined
      },
      async awaitRunSettlement() {
        throw new DOMException("cancelled", "AbortError")
      },
      async awaitRuntimeCleanup() {
        throw cleanup
      },
      clearFramework() {},
      clearFrameworkError() {},
      clearOldSession() {},
      clearInspection() {},
      createNewSession() {},
    })

    expect(result).toBe(cleanup)
  })

  it("continues cleanup and enables submissions after a synchronous cleanup failure", async () => {
    const events: string[] = []
    const primary = new Error("framework history failed")

    const result = await resetPrivateConversation({
      blockSubmissions(blocked) {
        events.push(blocked ? "blocked" : "enabled")
      },
      abortActiveRun() {},
      async stopFramework() {
        return undefined
      },
      async awaitRunSettlement() {},
      async awaitRuntimeCleanup() {},
      clearFramework() {
        events.push("clear-framework")
        throw primary
      },
      clearFrameworkError() {
        events.push("clear-error")
      },
      clearOldSession() {
        events.push("clear-session")
      },
      clearInspection() {
        events.push("clear-inspection")
      },
      createNewSession() {
        events.push("create-session")
      },
    })

    expect(result).toBe(primary)
    expect(events).toEqual([
      "blocked",
      "clear-framework",
      "clear-error",
      "clear-session",
      "clear-inspection",
      "create-session",
      "enabled",
    ])
  })

  it("suppresses late callbacks after a new run begins", async () => {
    const registry = createGenerationRunRegistry()
    const first = registry.begin()
    const second = registry.begin()

    expect(first.id).not.toBe(second.id)
    expect(registry.isCurrent(first.id)).toBe(false)
    expect(registry.isCurrent(second.id)).toBe(true)
    first.settle()
    expect(registry.isCurrent(second.id)).toBe(true)
    second.settle()
    await registry.waitForActive()
    expect(registry.isCurrent(second.id)).toBe(false)
  })

  it("reports a non-abort generation cleanup failure after the run settles", async () => {
    const registry = createGenerationRunRegistry()
    const cleanup = new Error("runtime cleanup failed")
    const run = registry.begin()
    const settlement = registry.waitForActive()

    run.recordFailure(cleanup)
    run.settle()

    await expect(settlement).rejects.toBe(cleanup)
  })

  it("keeps a run active until every tracked runtime cleanup settles", async () => {
    const registry = createGenerationRunRegistry()
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const run = registry.begin()
    run.track(cleanup)
    run.settle()

    let finished = false
    const settlement = registry.waitForActive().then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(registry.isCurrent(run.id)).toBe(true)

    releaseCleanup()
    await settlement
    expect(registry.isCurrent(run.id)).toBe(false)
  })

  it("settles the owning run after an upstream next failure", async () => {
    const registry = createGenerationRunRegistry()
    const run = registry.begin()
    const failure = new Error("stream failed")
    const runtime: BrowserGenerationRuntime = {
      id: "failed-runtime",
      disclosure: {
        label: "Failed runtime",
        model: "test",
        source: "test",
        artifacts: { kind: "browser-managed" },
      },
      generate() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: vi.fn(async () => {
                throw failure
              }),
            }
          },
        }
      },
      dispose: vi.fn(async () => undefined),
    }
    const observed = recordGenerationRunFailures(runtime, () => run)
    const iterator = observed
      .generate({ protectedContent: "hello", protectedHistory: [] })
      [Symbol.asyncIterator]()
    const settlement = registry.waitForActive()

    await expect(iterator.next()).rejects.toBe(failure)
    run.settle()

    await expect(settlement).rejects.toBe(failure)
    expect(registry.isCurrent(run.id)).toBe(false)
  })
})
