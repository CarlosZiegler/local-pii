import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"
import { parseLabels, parseVocab } from "./ner/assets"
import { rampartWeb } from "./web"
import type { OrtModule } from "./ner/rampart"
import type { NerBackend } from "./types"

describe("asset parsing", () => {
  it("parses vocab.txt into an id-indexed array", () => {
    expect(parseVocab("[PAD]\n[UNK]\nhello\n")).toEqual(["[PAD]", "[UNK]", "hello"])
  })
  it("parses config.json id2label in id order", () => {
    const json = JSON.stringify({ id2label: { "0": "O", "2": "I-X", "1": "B-X" } })
    expect(parseLabels(json)).toEqual(["O", "B-X", "I-X"])
  })
})

// Golden parity: the browser wiring (onnxruntime-web WASM EP) must detect the
// same entities as the onnxruntime-node run — proven in Node with model bytes.
const MODEL = fileURLToPath(
  new URL("../../model-rampart/assets/rampart-q4.onnx", import.meta.url),
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
