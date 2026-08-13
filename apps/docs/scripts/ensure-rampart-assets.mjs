// Ensures packages/model-rampart/assets exists before copy-model / e2e.
// Missing assets are fetched via the root checksum-verifying fetch-model script.
import { access } from "node:fs/promises"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const docsDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = join(docsDir, "../..")
const assetDirectory = join(repoRoot, "packages", "model-rampart", "assets")
const requiredAssets = ["rampart-q4.onnx", "vocab.json", "labels.json"]
const fetchScript = join(repoRoot, "scripts", "fetch-model.mjs")

async function assetsPresent() {
  const results = await Promise.all(
    requiredAssets.map(async (name) => {
      try {
        await access(join(assetDirectory, name))
        return true
      } catch {
        return false
      }
    })
  )
  return results.every(Boolean)
}

if (await assetsPresent()) {
  process.exit(0)
}

console.log(
  "Rampart Detection assets missing; running scripts/fetch-model.mjs …"
)
const child = spawn(process.execPath, [fetchScript], {
  cwd: repoRoot,
  stdio: "inherit",
})
const code = await new Promise((resolve, reject) => {
  child.on("error", reject)
  child.on("exit", (exitCode, signal) => {
    if (signal) reject(new Error(`fetch-model killed by ${signal}`))
    else resolve(exitCode ?? 1)
  })
})
if (code !== 0) process.exit(code)
