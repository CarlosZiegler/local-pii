import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createRampartNer, type OrtModule } from "./rampart"
import { createAnonymizer } from "../anonymizer"
import { rehydrate } from "../rehydrate"
import type { NerBackend } from "../types"

// Real-model tests: only run when the assets were fetched (`bun run fetch-model`).
const MODEL = fileURLToPath(
  new URL("../../../model-rampart/assets/rampart-q4.onnx", import.meta.url)
)
const suite = existsSync(MODEL) ? describe : describe.skip

suite("Rampart ONNX NER (real model, onnxruntime-node)", () => {
  let ort: OrtModule
  let assets: { modelPath: string; vocab: string[]; labels: string[] }
  let ner: NerBackend

  beforeAll(async () => {
    ort = (await import("onnxruntime-node")) as unknown as OrtModule
    const mod = (await import("@local-pii/model-rampart")) as {
      default?: typeof assets
    } & typeof assets
    assets = mod.default ?? mod
    ner = createRampartNer({
      ort,
      model: assets.modelPath,
      vocab: assets.vocab,
      labels: assets.labels,
    })
    await ner.load()
  }, 60_000)

  afterAll(async () => {
    await ner?.dispose()
  })

  it("uses the ONNX tensor names the backend assumes", async () => {
    const session = await ort.InferenceSession.create(assets.modelPath)
    expect(session.inputNames).toEqual([
      "input_ids",
      "attention_mask",
      "token_type_ids",
    ])
    expect(session.outputNames).toEqual(["logits"])
  })

  it("detects person names with offsets that map back onto the raw text", async () => {
    const text = "My name is João Silva and my colleague is Anna Meyer."
    const entities = await ner.detect(text)
    // Offset integrity: every entity slices back to its own surface text.
    for (const e of entities) expect(text.slice(e.start, e.end)).toBe(e.text)
    expect(
      entities.some((e) => e.type === "GIVEN_NAME" || e.type === "SURNAME")
    ).toBe(true)
    expect(entities.some((e) => /João|Silva|Anna|Meyer/.test(e.text))).toBe(
      true
    )
  })

  it("anonymizes + round-trips a mixed note end-to-end", async () => {
    const pii = createAnonymizer({ ner })
    const text =
      "Contact João Silva at joao@example.com or call +49 151 12345678."
    const { redactedText, mapping } = await pii.anonymize(text)
    expect(redactedText).not.toContain("joao@example.com")
    expect(redactedText).not.toContain("+49 151 12345678")
    expect(rehydrate(redactedText, mapping)).toBe(text)
    expect(pii.status).toBe("ready")
  })
})
