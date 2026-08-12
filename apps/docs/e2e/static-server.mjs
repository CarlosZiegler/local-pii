import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, resolve } from "node:path"
import { findStaticFile } from "./static-path.mjs"

const root = resolve(import.meta.dirname, "../out")
const port = Number.parseInt(process.env.PORT ?? "4173", 10)

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
])

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET"
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405).end()
      return
    }

    const pathname = decodeURIComponent(
      new URL(request.url ?? "/", "http://127.0.0.1").pathname
    )
    const file = await findStaticFile(root, pathname)
    if (!file) {
      response.writeHead(404).end()
      return
    }

    const metadata = await stat(file)
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": metadata.size,
      "content-type":
        contentTypes.get(extname(file)) ?? "application/octet-stream",
    })
    if (method === "HEAD") response.end()
    else createReadStream(file).pipe(response)
  } catch (error) {
    console.error(error)
    response.writeHead(500).end()
  }
})

server.listen(port, "127.0.0.1", () => {
  console.log(`Static export available at http://127.0.0.1:${port}`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
