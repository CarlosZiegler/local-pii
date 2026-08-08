import { describe, expect, it, vi } from "vitest"
import { createPromptRuntimeController } from "./prompt-runtime"

function session(): LanguageModel {
  return { destroy: vi.fn() } as unknown as LanguageModel
}

function factory(availability: Availability) {
  return {
    availability: vi.fn(async () => availability),
    create: vi.fn(async (options?: LanguageModelCreateOptions) => {
      const monitor = new EventTarget() as CreateMonitor
      options?.monitor?.(monitor)
      monitor.dispatchEvent(
        Object.assign(new Event("downloadprogress"), { loaded: 0.5 })
      )
      return session()
    }),
  }
}

describe("Prompt runtime controller", () => {
  it.each([
    ["available", "native-ready"],
    ["downloadable", "native-downloadable"],
    ["downloading", "native-downloadable"],
    ["unavailable", "fallback-available"],
  ] as const)("maps native %s without creating or loading", async (value, status) => {
    const native = factory(value)
    const loadFallback = vi.fn()
    const controller = createPromptRuntimeController({
      getNative: () => native,
      loadFallback,
    })

    await controller.check()

    expect(controller.getSnapshot()).toMatchObject({
      nativeAvailability: value,
      status,
    })
    expect(native.create).not.toHaveBeenCalled()
    expect(loadFallback).not.toHaveBeenCalled()
  })

  it("does not touch fallback code until explicit activation", async () => {
    const loadFallback = vi.fn(async () => factory("available"))
    const configureFallback = vi.fn()
    const controller = createPromptRuntimeController({
      getNative: () => undefined,
      loadFallback,
      configureFallback,
    })

    expect(loadFallback).not.toHaveBeenCalled()
    await controller.check()
    expect(loadFallback).not.toHaveBeenCalled()

    await controller.activateFallback()

    expect(configureFallback).toHaveBeenCalledOnce()
    expect(loadFallback).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      kind: "gemma-3-270m",
      progress: 1,
      status: "ready",
    })
  })

  it("activates native only on request and exposes a reusable runtime", async () => {
    const native = factory("downloadable")
    const controller = createPromptRuntimeController({
      getNative: () => native,
      loadFallback: vi.fn(),
    })
    await controller.check()

    await controller.activateNative()

    expect(native.create).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      kind: "gemini-nano",
      progress: 1,
      status: "ready",
    })
    await controller.getSnapshot().runtime?.create()
    expect(native.create).toHaveBeenCalledTimes(2)
  })

  it("reports activation errors and supports retry", async () => {
    const native = factory("downloadable")
    native.create.mockRejectedValueOnce(new Error("download failed"))
    const controller = createPromptRuntimeController({
      getNative: () => native,
      loadFallback: vi.fn(),
    })

    await expect(controller.activateNative()).rejects.toThrow("download failed")
    expect(controller.getSnapshot()).toMatchObject({ status: "error" })

    await controller.activateNative()
    expect(controller.getSnapshot()).toMatchObject({ status: "ready" })
  })
})
