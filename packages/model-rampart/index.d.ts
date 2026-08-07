export interface RampartTokenizerConfig {
  doLowerCase: boolean
  stripAccents: boolean | null
  unkToken: string
  clsToken: string
  sepToken: string
  padToken: string
  modelMaxLength: number
}

/** Absolute filesystem path to the Q4 ONNX model (Node/tooling use). */
export const modelPath: string
/** WordPiece vocabulary, index = token id (19,730 entries). */
export const vocab: string[]
/** BIO label per class id (35 entries: `O` + B/I for 17 types). */
export const labels: string[]
export const tokenizerConfig: RampartTokenizerConfig
export const ATTRIBUTION: string
