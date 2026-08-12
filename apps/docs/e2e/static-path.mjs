import { stat } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"

export function staticCandidates(pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "")
  if (extname(relative)) return [relative]
  if (relative === "") return ["index.html"]
  return [`${relative}.html`, `${relative}/index.html`]
}

export async function findStaticFile(root, pathname) {
  for (const candidate of staticCandidates(pathname)) {
    const file = resolve(root, candidate)
    if (file !== root && !file.startsWith(`${root}${sep}`)) continue
    try {
      if ((await stat(file)).isFile()) return file
    } catch {
      // Try the next static-export candidate.
    }
  }
}
