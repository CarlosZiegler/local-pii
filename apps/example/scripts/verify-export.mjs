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
      ["x", "expo", "export", "--platform", "android", "--output-dir", output],
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

  const files = await filesBelow(output)
  const sizes = await Promise.all(
    files.map((file) => stat(file).then((item) => item.size))
  )
  if (!sizes.some((size) => size > 10_000_000)) {
    throw new Error("Expo export did not emit the Rampart ONNX asset")
  }
  for (const file of files) {
    const content = await readFile(file)
    if (
      content.includes(Buffer.from("onnxruntime-web")) ||
      content.includes(Buffer.from("@local-pii/model-rampart/web"))
    ) {
      throw new Error(
        `Expo export included a browser-only dependency in ${file}`
      )
    }
  }
  console.log(`verified Android Expo export with ${files.length} emitted files`)
} finally {
  await rm(output, { force: true, recursive: true })
}
