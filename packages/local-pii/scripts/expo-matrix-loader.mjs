import { expoStubSources } from "./expo-matrix-stubs.mjs"

const prefix = "local-pii-matrix-stub:"

export async function resolve(specifier, context, nextResolve) {
  if (expoStubSources.has(specifier)) {
    return {
      shortCircuit: true,
      url: `${prefix}${encodeURIComponent(specifier)}`,
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(prefix)) {
    const specifier = decodeURIComponent(url.slice(prefix.length))
    return {
      format: "module",
      shortCircuit: true,
      source: expoStubSources.get(specifier),
    }
  }
  return nextLoad(url, context)
}
