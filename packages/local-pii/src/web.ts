import * as ortWeb from "onnxruntime-web"
import * as modelRampart from "@local-pii/model-rampart"
import { createRampartNer, type OrtModule } from "./ner/rampart"
import { parseLabels, parseVocab } from "./ner/assets"
import type { NerBackend } from "./types"

const HF = "https://huggingface.co/nationaldesignstudio/rampart/resolve/main"

export interface RampartWebOptions {
  /** Model URL or preloaded bytes. Default: the Rampart Q4 model on the HF CDN. */
  model?: string | Uint8Array
  /** Inline vocab (e.g. from `@local-pii/model-rampart`) — skips the fetch. */
  vocab?: readonly string[]
  /** Inline labels — skips the fetch. */
  labels?: readonly string[]
  vocabUrl?: string
  labelsUrl?: string
  /** Default `["webgpu", "wasm"]` — ORT falls through to wasm automatically. */
  executionProviders?: Array<"webgpu" | "wasm">
  /** Where the ORT `.wasm` assets are served from (self-hosting). */
  wasmPaths?: string
  numThreads?: number
  /** Override the ORT module (e.g. the wasm-only bundle, or for tests). */
  ort?: OrtModule
  maxTokens?: number
}

interface OrtEnv {
  env?: { wasm?: { wasmPaths?: string; numThreads?: number } }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`local-pii/web: GET ${url} -> ${res.status}`)
  return res.text()
}

/**
 * The Rampart NER backend for the browser, wiring `onnxruntime-web` (WASM +
 * optional WebGPU) into the runtime-agnostic {@link createRampartNer} core —
 * the same code the Expo and Node paths use. Zero-config fetches the model and
 * tokenizer from the HF CDN; production apps should self-host (pass `model`,
 * `vocab`, `labels`, and `wasmPaths`).
 *
 * ```ts
 * import { createAnonymizer } from "local-pii"
 * import { rampartWeb } from "local-pii/web"
 * const pii = createAnonymizer({ ner: rampartWeb() })
 * ```
 */
export function rampartWeb(options: RampartWebOptions = {}): NerBackend {
  const ort = options.ort ?? (ortWeb as unknown as OrtModule)
  let inner: NerBackend | null = null

  return {
    name: "rampart-web",

    async load() {
      if (inner) return
      const env = (ort as unknown as OrtEnv).env
      if (env?.wasm) {
        if (options.wasmPaths) env.wasm.wasmPaths = options.wasmPaths
        if (options.numThreads) env.wasm.numThreads = options.numThreads
      }

      const model = options.model ?? `${HF}/onnx/model_q4.onnx`
      const vocab =
        options.vocab ?? parseVocab(await fetchText(options.vocabUrl ?? `${HF}/vocab.txt`))
      const labels =
        options.labels ?? parseLabels(await fetchText(options.labelsUrl ?? `${HF}/config.json`))

      inner = createRampartNer({
        ort,
        model,
        vocab,
        labels,
        maxTokens: options.maxTokens,
        sessionOptions: {
          executionProviders: options.executionProviders ?? ["webgpu", "wasm"],
        },
      })
      await inner.load()
    },

    async detect(text: string) {
      return inner ? inner.detect(text) : []
    },

    async dispose() {
      await inner?.dispose()
      inner = null
    },
  }
}

/** The bundled model assets, re-exported for convenient self-hosting. */
export const rampartAssets = {
  vocab: modelRampart.vocab,
  labels: modelRampart.labels,
}
