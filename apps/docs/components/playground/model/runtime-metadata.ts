import type { RuntimeDisclosure } from "./types"

export const GEMMA_MODEL_ID = "onnx-community/gemma-3-270m-it-ONNX"
export const GEMMA_MODEL_REVISION = "2dbbfdb1b59bd034eb959428c6a7da9dd7ea27f0"
export const GEMMA_ARTIFACT_BASE_URL = `https://huggingface.co/${GEMMA_MODEL_ID}/resolve/${GEMMA_MODEL_REVISION}`

export const GEMMA_RUNTIME_DISCLOSURE: RuntimeDisclosure = {
  label: "Gemma 3 270M IT",
  model: GEMMA_MODEL_ID,
  source: "Transformers.js browser runtime",
  artifacts: {
    kind: "explicit-download",
    approximateBytes: 293_284_073,
    origins: ["https://huggingface.co", "https://*.cdn.hf.co"],
  },
}

/** Files required by the pinned q4f16 WebGPU pipeline. */
export const GEMMA_ARTIFACT_FILENAMES = [
  "config.json",
  "generation_config.json",
  "tokenizer_config.json",
  "tokenizer.json",
  "onnx/model_q4f16.onnx",
  "onnx/model_q4f16.onnx_data",
] as const

/** Transformers.js uses the remote URL (including revision) as its browser cache key. */
export const GEMMA_ARTIFACT_URLS = GEMMA_ARTIFACT_FILENAMES.map(
  (filename) => `${GEMMA_ARTIFACT_BASE_URL}/${filename}`
) as readonly string[]

export const GEMMA_CACHE_NAME = "transformers-cache"
