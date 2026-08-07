import type { Mapping, RehydrateOptions } from "./types"
import { escapeRegex } from "./util"

/**
 * Replace placeholders in `text` with their original values from `mapping`.
 * Pure and side-effect free — the mapping is the only secret needed, and it
 * stays in the caller's memory.
 *
 * Longest keys are matched first, so `[PHONE_10]` wins over `[PHONE_1]`.
 * Unknown or model-invented placeholders are left untouched (never guessed).
 * With `{ lenient: true }`, bracket-mangled variants an LLM might emit
 * (`GIVEN_NAME_1`, `[[GIVEN_NAME_1]]`) are also restored.
 */
export function rehydrate(
  text: string,
  mapping: Mapping,
  opts?: RehydrateOptions,
): string {
  const keys = Object.keys(mapping)
  if (keys.length === 0) return text

  // Strategy-aware lenient path: recover opaque tokens the model mangled by
  // normalizing each candidate back to its canonical form (case, O/0, I/L/1…).
  const normalize = opts?.lenient ? opts.strategy?.normalizeMatch : undefined
  if (normalize) {
    const index = new Map<string, string>()
    for (const key of keys) index.set(normalize.call(opts!.strategy!, key) || key, mapping[key]!)
    const scan = opts!.strategy!.lenientPattern?.() ?? opts!.strategy!.pattern()
    const flags = scan.flags.includes("g") ? scan.flags : `${scan.flags}g`
    return text.replace(new RegExp(scan.source, flags), (match) => {
      const canonical = normalize.call(opts!.strategy!, match)
      return (canonical && index.get(canonical)) ?? match
    })
  }

  // Default path: exact match, plus bracket-variant tolerance when lenient
  // (covers the sequential / hashed strategies).
  const variants = new Map<string, string>()
  for (const [placeholder, value] of Object.entries(mapping)) {
    variants.set(placeholder, value)
    if (opts?.lenient) {
      const inner =
        placeholder.startsWith("[") && placeholder.endsWith("]")
          ? placeholder.slice(1, -1)
          : placeholder
      variants.set(inner, value)
      variants.set(`[[${inner}]]`, value)
    }
  }

  const alternation = [...variants.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|")
  const pattern = new RegExp(alternation, "g")
  return text.replace(pattern, (match) => variants.get(match) ?? match)
}

export interface StreamingRehydrator {
  /** Feed the next chunk; returns the text that is now safe to emit. */
  push(chunk: string): string
  /** Emit whatever is still buffered. Call once when the stream ends. */
  flush(): string
}

/**
 * Rehydrate a response that arrives in pieces (LLM streaming). A placeholder
 * can be split across deltas — `[[EMA` in one, `IL_…` in the next — so the
 * rehydrator holds back a tail as long as the longest placeholder until enough
 * text follows that no placeholder could still be growing into it. A stream
 * with no placeholders (empty mapping) passes straight through with no latency.
 *
 * Use with the opaque {@link token} strategy, whose tokens LLMs don't mangle.
 */
export function createStreamingRehydrator(
  source: Mapping | (() => Mapping),
): StreamingRehydrator {
  // A getter lets the rehydrator see entries added mid-loop (e.g. a tool result
  // that introduced new PII part-way through a streamed answer).
  const getMapping = typeof source === "function" ? source : () => source
  let buffer = ""

  return {
    push(chunk) {
      buffer += chunk
      const mapping = getMapping()
      const keys = Object.keys(mapping).sort((a, b) => b.length - a.length)
      const holdback = keys.reduce((max, k) => Math.max(max, k.length), 0)
      let cut = Math.max(0, buffer.length - holdback)
      if (keys.length > 0) {
        const scanner = new RegExp(keys.map(escapeRegex).join("|"), "g")
        let m: RegExpExecArray | null
        while ((m = scanner.exec(buffer)) !== null) {
          // A full placeholder straddling the cut must not be split.
          if (m.index < cut && m.index + m[0].length > cut) cut = m.index
        }
      }
      const head = buffer.slice(0, cut)
      buffer = buffer.slice(cut)
      return head ? rehydrate(head, mapping) : ""
    },
    flush() {
      const mapping = getMapping()
      const out = buffer ? rehydrate(buffer, mapping) : ""
      buffer = ""
      return out
    },
  }
}
