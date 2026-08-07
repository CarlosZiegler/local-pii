/** Parse a BERT `vocab.txt` (one token per line) into an id-indexed array. */
export function parseVocab(vocabTxt: string): string[] {
  return vocabTxt.replace(/\r/g, "").replace(/\n$/, "").split("\n")
}

/** Parse a HF `config.json` string into the BIO label array (id order). */
export function parseLabels(configJson: string): string[] {
  const config = JSON.parse(configJson) as { id2label: Record<string, string> }
  return Object.keys(config.id2label)
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => config.id2label[id]!)
}
