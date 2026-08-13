import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NerBackend } from "./types"
import type { OrtModule } from "./ner/rampart"

vi.mock("expo-asset", () => ({
  Asset: {
    fromModule: () => ({
      localUri: "file:///rampart.onnx",
      uri: "file:///rampart.onnx",
      async downloadAsync() {
        return this
      },
    }),
  },
}))

vi.mock("expo-file-system", () => ({
  cacheDirectory: null,
  async copyAsync() {},
}))

vi.mock("expo-crypto", () => ({
  getRandomBytes: (n: number) => new Uint8Array(n),
}))

vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}))

vi.mock("onnxruntime-react-native", () => ({
  InferenceSession: {},
  Tensor: class Tensor {},
}))

vi.mock("@local-pii/model-rampart", () => ({
  vocab: ["[PAD]", "[UNK]", "hello"],
  labels: ["O", "B-PER", "I-PER"],
}))

const JOAO = {
  start: 0,
  end: 4,
  text: "João",
  type: "GIVEN_NAME" as const,
  source: "ner" as const,
  confidence: 1,
}

const createState = vi.hoisted(() => ({
  candidates: [] as Array<{
    load: ReturnType<typeof vi.fn>
    detect: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    loaded: boolean
  }>,
  loadImpl: null as null | ((index: number) => Promise<void>),
}))

vi.mock("./ner/rampart", () => ({
  createRampartNer: () => {
    const index = createState.candidates.length
    const candidate = {
      name: `candidate-${index}`,
      loaded: false,
      load: vi.fn(async () => {
        if (createState.loadImpl) await createState.loadImpl(index)
        candidate.loaded = true
      }),
      // Mirrors createRampartNer: unloaded backends return empty Detection results.
      detect: vi.fn(async () => (candidate.loaded ? [JOAO] : [])),
      dispose: vi.fn(async () => {
        candidate.loaded = false
      }),
    }
    createState.candidates.push(candidate)
    return candidate as NerBackend
  },
}))

import { rampart } from "./expo"

describe("rampart (expo) load failure safety", () => {
  beforeEach(() => {
    createState.candidates = []
    createState.loadImpl = null
  })

  it("does not retain a candidate after load failure; retry creates a fresh one", async () => {
    createState.loadImpl = async (index) => {
      if (index === 0) throw new Error("session create failed")
    }

    const backend = rampart({
      model: "/tmp/rampart-q4.onnx",
      vocab: ["[PAD]", "[UNK]"],
      labels: ["O"],
      ort: {} as OrtModule,
    })

    await expect(backend.load()).rejects.toThrow("session create failed")
    expect(createState.candidates).toHaveLength(1)
    expect(createState.candidates[0]?.dispose).toHaveBeenCalledOnce()
    // Uninitialized / failed Detection must not look like a successful empty scan.
    await expect(backend.detect("João")).resolves.toEqual([])

    // Retry must build a new candidate and run load for real.
    await backend.load()
    expect(createState.candidates).toHaveLength(2)
    expect(createState.candidates[1]?.load).toHaveBeenCalledOnce()
    await expect(backend.detect("João")).resolves.toEqual([JOAO])
  })

  it("preserves the primary load error when candidate dispose fails", async () => {
    const primary = new Error("session create failed")

    const backend = rampart({
      model: "/tmp/rampart-q4.onnx",
      vocab: ["[PAD]", "[UNK]"],
      labels: ["O"],
      ort: {} as OrtModule,
    })

    createState.loadImpl = async (index) => {
      createState.candidates[index]!.dispose.mockRejectedValueOnce(
        new Error("dispose failed")
      )
      throw primary
    }

    await expect(backend.load()).rejects.toBe(primary)
    expect(createState.candidates[0]?.dispose).toHaveBeenCalledOnce()
  })

  it("coalesces concurrent loads into one candidate", async () => {
    let releaseLoad!: () => void
    const pending = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    createState.loadImpl = async () => pending
    const backend = rampart({
      model: "/tmp/rampart-q4.onnx",
      vocab: ["[PAD]", "[UNK]"],
      labels: ["O"],
      ort: {} as OrtModule,
    })

    const first = backend.load()
    const second = backend.load()
    await Promise.resolve()
    expect(createState.candidates).toHaveLength(1)
    releaseLoad()
    await Promise.all([first, second])
    await backend.dispose()
    expect(createState.candidates[0]?.dispose).toHaveBeenCalledOnce()
  })

  it("waits for an in-flight load before disposal", async () => {
    let releaseLoad!: () => void
    const pending = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    createState.loadImpl = async () => pending
    const backend = rampart({
      model: "/tmp/rampart-q4.onnx",
      vocab: ["[PAD]", "[UNK]"],
      labels: ["O"],
      ort: {} as OrtModule,
    })

    const loading = backend.load()
    let disposed = false
    const disposing = backend.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseLoad()
    await Promise.all([loading, disposing])
    expect(createState.candidates[0]?.dispose).toHaveBeenCalledOnce()
  })

  it("retains cleanup ownership when candidate disposal fails", async () => {
    const cleanupFailure = new Error("dispose failed")
    const backend = rampart({
      model: "/tmp/rampart-q4.onnx",
      vocab: ["[PAD]", "[UNK]"],
      labels: ["O"],
      ort: {} as OrtModule,
    })

    await backend.load()
    createState.candidates[0]!.dispose.mockRejectedValueOnce(
      cleanupFailure
    ).mockResolvedValueOnce(undefined)
    await expect(backend.dispose()).rejects.toBe(cleanupFailure)
    await backend.load()
    expect(createState.candidates).toHaveLength(1)
    await expect(backend.dispose()).resolves.toBeUndefined()
    expect(createState.candidates[0]?.dispose).toHaveBeenCalledTimes(2)
  })
})
