import { rehydrate } from "./rehydrate"
import type { Mapping, RehydrateOptions } from "./types"

/**
 * Deep-anonymize every string LEAF of a JSON value (object/array recursion),
 * leaving object keys and non-strings untouched. Used for tool-call arguments
 * and tool results, whose PII lives in string values. `redact` is a
 * session-bound redactor so one shared vault spans the whole tool loop.
 */
export async function anonymizeJson(
  redact: (text: string) => Promise<string>,
  value: unknown,
): Promise<unknown> {
  if (typeof value === "string") return value.length > 0 ? redact(value) : value
  if (Array.isArray(value)) {
    const out: unknown[] = []
    // Sequential so the shared vault's numbering stays deterministic.
    for (const item of value) out.push(await anonymizeJson(redact, item))
    return out
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = await anonymizeJson(redact, v)
    return out
  }
  return value
}

/** Deep-rehydrate every string leaf of a JSON value. Pure. */
export function rehydrateJson(
  value: unknown,
  mapping: Mapping,
  opts?: RehydrateOptions,
): unknown {
  if (typeof value === "string") return rehydrate(value, mapping, opts)
  if (Array.isArray(value)) return value.map((v) => rehydrateJson(v, mapping, opts))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rehydrateJson(v, mapping, opts)]),
    )
  }
  return value
}

export interface RehydratedToolArgs {
  /** The tool-call arguments JSON with placeholders replaced by real values. */
  readonly args: string
  /** True when the JSON parsed cleanly; false when the fallback path was used. */
  readonly clean: boolean
}

/**
 * Rehydrate an LLM-produced tool-call `arguments` JSON string so you execute
 * the tool with REAL values. Always parse → deep-rehydrate string leaves →
 * re-serialize, so a restored value containing `"`/`\`/newlines stays valid
 * JSON. If the model emitted invalid/truncated JSON, falls back to raw
 * replacement and reports `clean: false`.
 */
export function rehydrateToolArgs(
  argsJson: string,
  mapping: Mapping,
  opts?: RehydrateOptions,
): RehydratedToolArgs {
  try {
    const parsed: unknown = JSON.parse(argsJson)
    return { args: JSON.stringify(rehydrateJson(parsed, mapping, opts)), clean: true }
  } catch {
    return { args: rehydrate(argsJson, mapping, opts), clean: false }
  }
}
