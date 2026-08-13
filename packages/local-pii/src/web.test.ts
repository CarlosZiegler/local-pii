import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { parseLabels, parseVocab } from "./ner/assets"
import { rampartWeb } from "./web"
import type { OrtModule } from "./ner/rampart"
import type { NerBackend } from "./types"

describe("asset parsing", () => {
  it("parses vocab.txt into an id-indexed array", () => {
    expect(parseVocab("[PAD]\n[UNK]\nhello\n")).toEqual([
      "[PAD]",
      "[UNK]",
      "hello",
    ])
  })
  it("parses config.json id2label in id order", () => {
    const json = JSON.stringify({
      id2label: { "0": "O", "2": "I-X", "1": "B-X" },
    })
    expect(parseLabels(json)).toEqual(["O", "B-X", "I-X"])
  })
})

describe("rampartWeb load failure safety", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((next) => {
      resolve = next
    })
    return { promise, resolve }
  }

  function session(release = vi.fn(async () => undefined)) {
    return {
      inputNames: [],
      outputNames: [],
      run: vi.fn(async () => ({})),
      release,
    }
  }

  it("retries with a fresh model session after load failure", async () => {
    const failure = new Error("session create failed")
    const create = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        inputNames: [],
        outputNames: [],
        run: vi.fn(async () => ({})),
        release: vi.fn(async () => undefined),
      })
    const backend = rampartWeb({
      ort: {
        InferenceSession: { create },
        Tensor: class Tensor {
          data: BigInt64Array
          dims: readonly number[]
          constructor(
            _type: string,
            data: BigInt64Array,
            dims: readonly number[]
          ) {
            this.data = data
            this.dims = dims
          }
        },
      },
      model: new Uint8Array(),
      vocab: ["[PAD]", "[UNK]"],
      labels: ["O"],
      executionProviders: ["wasm"],
    })

    await expect(backend.load()).rejects.toBe(failure)
    await expect(backend.load()).resolves.toBeUndefined()
    expect(create).toHaveBeenCalledTimes(2)
  })

  it("coalesces concurrent loads into one model session", async () => {
    const pending = deferred<ReturnType<typeof session>>()
    const create = vi.fn(() => pending.promise)
    const release = vi.fn(async () => undefined)
    const backend = rampartWeb({
      ort: {
        InferenceSession: { create },
        Tensor: class Tensor {
          data: BigInt64Array
          dims: readonly number[]
          constructor(
            _type: string,
            data: BigInt64Array,
            dims: readonly number[]
          ) {
            this.data = data
            this.dims = dims
          }
        },
      },
      model: new Uint8Array(),
      vocab: ["[PAD]", "[UNK]"],
      labels: ["O"],
      executionProviders: ["wasm"],
    })

    const first = backend.load()
    const second = backend.load()
    expect(create).toHaveBeenCalledOnce()
    pending.resolve(session(release))
    await Promise.all([first, second])
    await backend.dispose()
    expect(release).toHaveBeenCalledOnce()
  })

  it("waits for an in-flight load before disposal and cannot resurrect it", async () => {
    const pending = deferred<ReturnType<typeof session>>()
    const release = vi.fn(async () => undefined)
    const backend = rampartWeb({
      ort: {
        InferenceSession: { create: vi.fn(() => pending.promise) },
        Tensor: class Tensor {
          data: BigInt64Array
          dims: readonly number[]
          constructor(
            _type: string,
            data: BigInt64Array,
            dims: readonly number[]
          ) {
            this.data = data
            this.dims = dims
          }
        },
      },
      model: new Uint8Array(),
      vocab: ["[PAD]", "[UNK]"],
      labels: ["O"],
      executionProviders: ["wasm"],
    })

    const loading = backend.load()
    let disposed = false
    const disposing = backend.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    pending.resolve(session(release))
    await Promise.all([loading, disposing])
    expect(release).toHaveBeenCalledOnce()
  })

  it("retains cleanup ownership when session disposal fails", async () => {
    const cleanupFailure = new Error("release failed")
    const release = vi
      .fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const create = vi.fn(async () => session(release))
    const backend = rampartWeb({
      ort: {
        InferenceSession: { create },
        Tensor: class Tensor {
          data: BigInt64Array
          dims: readonly number[]
          constructor(
            _type: string,
            data: BigInt64Array,
            dims: readonly number[]
          ) {
            this.data = data
            this.dims = dims
          }
        },
      },
      model: new Uint8Array(),
      vocab: ["[PAD]", "[UNK]"],
      labels: ["O"],
      executionProviders: ["wasm"],
    })

    await backend.load()
    await expect(backend.dispose()).rejects.toBe(cleanupFailure)
    await backend.load()
    expect(create).toHaveBeenCalledOnce()
    await expect(backend.dispose()).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledTimes(2)
  })
})

// Golden parity: the browser wiring (onnxruntime-web WASM EP) must detect the
// same entities as the onnxruntime-node run — proven in Node with model bytes.
const MODEL = fileURLToPath(
  new URL("../../model-rampart/assets/rampart-q4.onnx", import.meta.url)
)
const suite = existsSync(MODEL) ? describe : describe.skip

suite("rampartWeb (onnxruntime-web WASM EP)", () => {
  let ner: NerBackend

  beforeAll(async () => {
    const ort = (await import("onnxruntime-web")) as unknown as OrtModule
    const mod = (await import("@local-pii/model-rampart")) as {
      default?: { vocab: string[]; labels: string[] }
      vocab: string[]
      labels: string[]
    }
    const assets = mod.default ?? mod
    ner = rampartWeb({
      ort,
      model: new Uint8Array(readFileSync(MODEL)),
      vocab: assets.vocab,
      labels: assets.labels,
      executionProviders: ["wasm"],
    })
    await ner.load()
  }, 60_000)

  it("detects a person name with offsets mapping back onto the raw text", async () => {
    const text = "My name is João Silva and I live in Berlin."
    const entities = await ner.detect(text)
    for (const e of entities) expect(text.slice(e.start, e.end)).toBe(e.text)
    expect(entities.some((e) => /João|Silva/.test(e.text))).toBe(true)
  })
})
