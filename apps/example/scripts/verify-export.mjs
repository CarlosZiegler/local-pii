import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

const output = await mkdtemp(join(tmpdir(), "local-pii-expo-matrix-"))

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesBelow(path) : [path]
    })
  )
  return nested.flat()
}

try {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        "x",
        "expo",
        "export",
        "--platform",
        "android",
        "--output-dir",
        output,
        "--dump-assetmap",
        "--source-maps",
      ],
      { stdio: "inherit" }
    )
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `Expo export failed${signal ? ` with signal ${signal}` : ` with code ${code}`}`
          )
        )
    })
  })

  const metadata = JSON.parse(await readFile(join(output, "metadata.json")))
  const assetMap = JSON.parse(await readFile(join(output, "assetmap.json")))
  const android = metadata.fileMetadata?.android
  const onnxAssets = android?.assets?.filter((asset) => asset.ext === "onnx")
  if (onnxAssets?.length !== 1) {
    throw new Error("Expo export must emit exactly one Android ONNX asset")
  }
  const emittedAsset = onnxAssets[0]
  const hash = emittedAsset.path.split("/").at(-1)
  const rampartAsset = assetMap[hash]
  const rampartSource = rampartAsset?.files?.[0]
  if (
    rampartAsset?.name !== "rampart-q4" ||
    rampartAsset?.type !== "onnx" ||
    typeof rampartSource !== "string" ||
    !rampartSource
      .replaceAll("\\", "/")
      .endsWith("/packages/model-rampart/assets/rampart-q4.onnx")
  ) {
    throw new Error("Expo asset map did not trace the ONNX asset to Rampart")
  }
  const emittedSize = (await stat(join(output, emittedAsset.path))).size
  const sourceSize = (await stat(rampartSource)).size
  if (emittedSize !== sourceSize || emittedSize <= 10_000_000) {
    throw new Error("Exported Rampart ONNX bytes do not match the source asset")
  }

  const sourceMap = JSON.parse(
    await readFile(join(output, `${android.bundle}.map`), "utf8")
  )
  const normalizedSources = sourceMap.sources.map((source) =>
    source.replaceAll("\\", "/")
  )
  if (
    !normalizedSources.some(
      (source) =>
        source.endsWith("/packages/local-pii/src/expo.ts") ||
        source.endsWith("/packages/local-pii/dist/expo.js") ||
        source.endsWith("/packages/local-pii/dist/expo.cjs")
    )
  ) {
    throw new Error("Expo source map did not include the local-pii Expo entry")
  }
  if (
    !normalizedSources.some((source) =>
      source.includes("onnxruntime-react-native")
    )
  ) {
    throw new Error("Expo source map did not include onnxruntime-react-native")
  }
  const forbiddenSource = normalizedSources.find(
    (source) =>
      source.includes("onnxruntime-web") ||
      source.includes("@local-pii/model-rampart/web")
  )
  if (forbiddenSource) {
    throw new Error(
      `Expo source map included browser runtime: ${forbiddenSource}`
    )
  }

  const files = await filesBelow(output)
  console.log(`verified Android Expo export with ${files.length} emitted files`)
} finally {
  await rm(output, { force: true, recursive: true })
}
