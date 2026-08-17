import type { Entity, NerBackend } from "../types"
import { createBertTokenizer, type BertTokenizer } from "../tokenizer/wordpiece"
import { chunkTokens } from "./chunk"
import { decodeBio } from "./bio"

/**
 * Minimal structural subset of the `onnxruntime-common` API shared by
 * `onnxruntime-node` and `onnxruntime-react-native`. Injecting it keeps this
 * NER core runtime-agnostic and testable in Node.
 */
export interface OrtTensor {
  readonly data: ArrayLike<number> | BigInt64Array
  readonly dims: readonly number[]
}
export interface OrtSession {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
  release?(): Promise<void>
}
export interface OrtModule {
  InferenceSession: {
    create(model: string | Uint8Array, options?: unknown): Promise<OrtSession>
  }
  Tensor: new (
    type: string,
    data: BigInt64Array,
    dims: readonly number[]
  ) => OrtTensor
}

export interface RampartNerConfig {
  /** An `onnxruntime-node`/`-react-native`/`-web` compatible module. */
  ort: OrtModule
  /** The model: a path/URL the runtime can load, or the raw ONNX bytes. */
  model: string | Uint8Array
  /** WordPiece vocabulary (index = token id). */
  vocab: readonly string[]
  /** BIO label per class id. */
  labels: readonly string[]
  maxTokens?: number
  sessionOptions?: unknown
}

/** Build an int64 tensor of token ids (ONNX BertForTokenClassification feeds). */
function idTensor(ort: OrtModule, ids: readonly number[]): OrtTensor {
  if (typeof BigInt64Array === "undefined") {
    throw new Error(
      "local-pii: BigInt64Array unavailable — enable it on this JS engine to run the Rampart model."
    )
  }
  const data = BigInt64Array.from(ids, (v) => BigInt(v))
  return new ort.Tensor("int64", data, [1, ids.length])
}

/**
 * The Rampart ONNX NER backend. Tokenizes with the bundled WordPiece tokenizer,
 * runs the model over 512-token windows, and decodes BIO logits into entities
 * with original-text offsets. Runtime-agnostic via the injected `ort` module;
 * `@local-pii/core/expo` wires the React Native runtime and model asset for you.
 */
export function createRampartNer(config: RampartNerConfig): NerBackend {
  const { ort, labels } = config
  const maxTokens = config.maxTokens ?? 512
  const numLabels = labels.length
  const tokenizer: BertTokenizer = createBertTokenizer(config.vocab)
  let session: OrtSession | null = null

  return {
    name: "rampart",

    async load() {
      if (session) return
      session = await ort.InferenceSession.create(
        config.model,
        config.sessionOptions
      )
    },

    async detect(text: string): Promise<Entity[]> {
      if (!session) return []
      const s = session
      const entities: Entity[] = []

      for (const window of chunkTokens(tokenizer.encode(text), maxTokens)) {
        const ids = window.map((t) => t.id)
        const feeds: Record<string, OrtTensor> = {}
        for (const name of s.inputNames) {
          if (name === "attention_mask") {
            feeds[name] = idTensor(
              ort,
              window.map(() => 1)
            )
          } else if (name === "input_ids") {
            feeds[name] = idTensor(ort, ids)
          } else {
            // token_type_ids (or any other expected int64 input): zeros.
            feeds[name] = idTensor(
              ort,
              window.map(() => 0)
            )
          }
        }

        const outputs = await s.run(feeds)
        const outName = s.outputNames[0]
        const logitsTensor = outName ? outputs[outName] : undefined
        if (!logitsTensor) continue
        const flat = logitsTensor.data as ArrayLike<number>

        const logits: number[][] = []
        for (let i = 0; i < window.length; i++) {
          const row: number[] = new Array(numLabels)
          for (let j = 0; j < numLabels; j++)
            row[j] = Number(flat[i * numLabels + j])
          logits.push(row)
        }
        entities.push(...decodeBio({ tokens: window, logits, labels, text }))
      }
      return entities
    },

    async dispose() {
      await session?.release?.()
      session = null
    },
  }
}
