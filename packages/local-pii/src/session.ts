import { anonymizeJson, rehydrateJson } from "./json"
import { rehydrate } from "./rehydrate"
import type {
  AnonymizeResult,
  Mapping,
  PlaceholderStrategy,
  RehydrateOptions,
} from "./types"
import { Vault } from "./pipeline/vault"

/**
 * A stateful wrapper that keeps one {@link Vault} across multiple turns, so a
 * value gets the SAME placeholder in every message of a conversation and across
 * a multi-step tool loop (`João` → `[GIVEN_NAME_1]` everywhere). Its rehydrate
 * methods are bound to the accumulated mapping and the session's strategy (so
 * lenient recovery of opaque tokens works automatically).
 */
export interface PiiSession {
  anonymize(text: string): Promise<AnonymizeResult>
  /** Deep-anonymize the string leaves of any JSON value (tool args/results). */
  anonymizeJson(value: unknown): Promise<unknown>
  rehydrate(text: string, opts?: RehydrateOptions): string
  /** Deep-rehydrate the string leaves of any JSON value. */
  rehydrateJson(value: unknown, opts?: RehydrateOptions): unknown
  readonly mapping: Readonly<Mapping>
  clear(): void
}

export function createSession(
  strategy: PlaceholderStrategy,
  anonymizeWith: (text: string, vault: Vault) => Promise<AnonymizeResult>
): PiiSession {
  const vault = new Vault(strategy)
  const session: PiiSession = {
    anonymize(text) {
      return anonymizeWith(text, vault)
    },
    anonymizeJson(value) {
      return anonymizeJson(
        async (text) => (await session.anonymize(text)).redactedText,
        value
      )
    },
    rehydrate(text, opts) {
      return rehydrate(text, vault.mapping, { strategy, ...opts })
    },
    rehydrateJson(value, opts) {
      return rehydrateJson(value, vault.mapping, { strategy, ...opts })
    },
    get mapping() {
      return vault.mapping
    },
    clear() {
      vault.clear()
    },
  }
  return session
}
