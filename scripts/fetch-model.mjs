// Downloads the Rampart Q4 ONNX model + tokenizer assets from Hugging Face into
// packages/model-rampart/assets. Run with `bun run fetch-model`.
//
// The model is CC BY 4.0 (National Design Studio). Assets are gitignored and
// fetched on demand; they are included when @local-pii/model-rampart is published.
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS = join(ROOT, "packages", "model-rampart", "assets")
const BASE =
  "https://huggingface.co/nationaldesignstudio/rampart/resolve/main"

// Pinned sha256 of the model artifact — verified against upstream.
const EXPECTED_MODEL_SHA =
  process.env.EXPECT_MODEL_SHA ??
  "9f27d24949b0581701071ea5ef522d77ccd3f50c525cc91eac4d265b0fc2afe5"

async function download(path) {
  const res = await fetch(`${BASE}/${path}`)
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

async function main() {
  await mkdir(ASSETS, { recursive: true })

  console.log("↓ model_q4.onnx …")
  const model = await download("onnx/model_q4.onnx")
  const modelSha = sha256(model)
  console.log(`  ${(model.length / 1e6).toFixed(1)} MB  sha256=${modelSha}`)
  if (EXPECTED_MODEL_SHA && modelSha !== EXPECTED_MODEL_SHA) {
    throw new Error(`model sha mismatch: got ${modelSha}`)
  }
  await writeFile(join(ASSETS, "rampart-q4.onnx"), model)

  console.log("↓ vocab.txt …")
  const vocabTxt = (await download("vocab.txt")).toString("utf8")
  const vocab = vocabTxt.replace(/\n$/, "").split("\n")
  await writeFile(join(ASSETS, "vocab.json"), JSON.stringify(vocab))
  console.log(`  ${vocab.length} tokens`)

  console.log("↓ config.json …")
  const config = JSON.parse((await download("config.json")).toString("utf8"))
  const labels = Object.keys(config.id2label)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => config.id2label[k])
  await writeFile(join(ASSETS, "labels.json"), JSON.stringify(labels))
  console.log(`  ${labels.length} labels`)

  console.log("↓ tokenizer_config.json …")
  const tconf = JSON.parse(
    (await download("tokenizer_config.json")).toString("utf8"),
  )
  await writeFile(
    join(ASSETS, "tokenizer-config.json"),
    JSON.stringify({
      doLowerCase: tconf.do_lower_case ?? true,
      stripAccents: tconf.strip_accents ?? null,
      unkToken: tconf.unk_token ?? "[UNK]",
      clsToken: tconf.cls_token ?? "[CLS]",
      sepToken: tconf.sep_token ?? "[SEP]",
      padToken: tconf.pad_token ?? "[PAD]",
      modelMaxLength: tconf.model_max_length ?? 512,
    }),
  )

  console.log("✓ assets written to packages/model-rampart/assets")
}

main().catch((err) => {
  console.error("✗", err.message)
  process.exit(1)
})
