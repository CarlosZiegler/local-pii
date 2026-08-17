import type { NerBackend } from "../types"

/**
 * The default backend: finds nothing. With no NER configured the anonymizer
 * still runs the full deterministic + dictionary pipeline. Swap in a real
 * backend (e.g. `rampart()` from `@local-pii/core/expo`) to add name/address
 * detection.
 */
export const noopNer: NerBackend = {
  name: "noop",
  async load() {},
  async detect() {
    return []
  },
  async dispose() {},
}
