// Node/bundler entry for the Rampart assets. In React Native, import the asset
// subpaths directly (`@local-pii/model-rampart/assets/rampart-q4.onnx`) so Metro
// bundles the binary; this module is the convenient path/data accessor for
// Node (tests, tooling). Assets are fetched by `bun run fetch-model`.
const vocab = require("./assets/vocab.json")
const labels = require("./assets/labels.json")
const tokenizerConfig = require("./assets/tokenizer-config.json")

module.exports = {
  modelPath: `${__dirname}/assets/rampart-q4.onnx`,
  vocab,
  labels,
  tokenizerConfig,
  ATTRIBUTION:
    "Rampart NER model © National Design Studio, licensed CC BY 4.0. " +
    "https://huggingface.co/nationaldesignstudio/rampart",
}
