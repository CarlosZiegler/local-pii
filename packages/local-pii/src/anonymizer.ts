import { defaultDetectors } from "./detectors/builtin"
import { createDictionaryDetector } from "./detectors/dictionary"
import { mergeEntities } from "./pipeline/merge"
import { redactText } from "./pipeline/replace"
import { Vault } from "./pipeline/vault"
import { sequential } from "./placeholder/strategies"
import { createSession, type PiiSession } from "./session"
import type {
  AnonymizeResult,
  Detector,
  DetectionModel,
  DictionaryEntry,
  Entity,
  NerBackend,
  PiiType,
  PlaceholderStrategy,
} from "./types"

export type AnonymizerStatus = "idle" | "loading" | "ready" | "degraded"

export interface AnonymizerOptions {
  /** Deterministic detectors. `"default"` (built-ins), `"none"`, or a custom list. */
  detectors?: Detector[] | "default" | "none"
  /** Detection model for names/addresses. `false`/omitted = regex + dictionary only. */
  detection?: DetectionModel | false
  /** Legacy name for the detection model. `false`/omitted = regex + dictionary only. */
  ner?: NerBackend | false
  /** User terms to always redact (own name, family, employer…). */
  dictionary?: DictionaryEntry[]
  /** Placeholder scheme. Default {@link sequential}. */
  placeholders?: PlaceholderStrategy
  /** NER types left in the text (not redacted). Default CITY/STATE/ZIP_CODE. */
  keep?: PiiType[]
  /** NER types to redact even if in {@link AnonymizerOptions.keep}. */
  redact?: PiiType[]
  /** Minimum NER confidence to keep. Default 0 (argmax; recall-first). */
  nerThreshold?: number
  /** If true, a NER load/inference failure throws instead of degrading. */
  strict?: boolean
  /** Called when NER fails and the anonymizer degrades to deterministic-only. */
  onDegraded?: (error: Error) => void
}

export interface Anonymizer {
  /** Full pipeline (deterministic + dictionary + NER if configured). */
  anonymize(text: string): Promise<AnonymizeResult>
  /** Deterministic + dictionary only — synchronous, never touches the model. */
  anonymizeSync(text: string): AnonymizeResult
  /** Preload the NER backend so the first {@link anonymize} isn't slow. */
  warmup(): Promise<void>
  readonly status: AnonymizerStatus
  addDictionaryEntries(entries: DictionaryEntry[]): void
  /** A multi-turn session with stable placeholders across calls. */
  createSession(): PiiSession
  dispose(): Promise<void>
}

const DEFAULT_KEEP: readonly PiiType[] = ["CITY", "STATE", "ZIP_CODE"]

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * Create an anonymizer. Cheap and synchronous — the NER model (if any) loads
 * lazily on the first {@link Anonymizer.anonymize}. Zero-config by default:
 * `createAnonymizer()` runs all built-in deterministic detectors.
 */
export function createAnonymizer(options: AnonymizerOptions = {}): Anonymizer {
  const detectionSupplied = options.detection !== undefined
  const nerSupplied = options.ner !== undefined
  if (detectionSupplied && nerSupplied) {
    throw new TypeError(
      '"detection" and "ner" configure the same Detection model; supply only one'
    )
  }
  const configuredDetection = detectionSupplied
    ? options.detection
    : options.ner
  const ner: NerBackend | null =
    configuredDetection === false || configuredDetection == null
      ? null
      : configuredDetection

  const strategy = options.placeholders ?? sequential()
  const baseDetectors: Detector[] =
    options.detectors === "none"
      ? []
      : Array.isArray(options.detectors)
        ? options.detectors
        : defaultDetectors()

  let dictionaryEntries: DictionaryEntry[] = [...(options.dictionary ?? [])]
  let dictionaryDetector: Detector | null = dictionaryEntries.length
    ? createDictionaryDetector(dictionaryEntries)
    : null

  const strict = options.strict ?? false
  const threshold = options.nerThreshold ?? 0
  const keep = new Set<PiiType>(options.keep ?? DEFAULT_KEEP)
  for (const type of options.redact ?? []) keep.delete(type)

  let status: AnonymizerStatus = "idle"
  let loadPromise: Promise<void> | null = null
  // Read through a function so TS keeps the full union across `await` (the
  // status is mutated inside promise callbacks it can't track otherwise).
  const readStatus = (): AnonymizerStatus => status

  function runDeterministic(text: string): Entity[] {
    const detectors = dictionaryDetector
      ? [...baseDetectors, dictionaryDetector]
      : baseDetectors
    const entities: Entity[] = []
    for (const detector of detectors) entities.push(...detector.detect(text))
    return entities
  }

  async function ensureNerLoaded(): Promise<boolean> {
    if (!ner || readStatus() === "degraded") return false
    if (readStatus() === "ready") return true
    if (!loadPromise) {
      status = "loading"
      loadPromise = ner.load().then(
        () => {
          status = "ready"
        },
        (e) => {
          if (strict) {
            status = "idle"
            loadPromise = null
            throw e
          }
          status = "degraded"
          options.onDegraded?.(toError(e))
        }
      )
    }
    await loadPromise
    return readStatus() === "ready"
  }

  async function runNer(text: string): Promise<Entity[]> {
    if (!(await ensureNerLoaded()) || !ner) return []
    try {
      const entities = await ner.detect(text)
      return entities.filter(
        (e) => e.confidence >= threshold && !keep.has(e.type)
      )
    } catch (e) {
      if (strict) throw e
      status = "degraded"
      options.onDegraded?.(toError(e))
      return []
    }
  }

  function finalize(
    text: string,
    entities: Entity[],
    vault: Vault
  ): AnonymizeResult {
    const merged = mergeEntities(entities)
    return {
      redactedText: redactText(text, merged, vault),
      entities: merged,
      mapping: vault.mapping,
    }
  }

  // Values already in the vault are re-matched as a high-priority dictionary,
  // so a value seen earlier in the conversation gets the SAME placeholder even
  // if NER now misses it — the key to a stable multi-step tool loop. It also
  // makes re-anonymizing an already-redacted string a no-op (idempotence): the
  // placeholders contain no raw values for any detector to match.
  function vaultDictionaryDetect(text: string, vault: Vault): Entity[] {
    const known = vault.knownEntries()
    if (known.length === 0) return []
    const detector = createDictionaryDetector(
      known.map((e) => ({ value: e.value, type: e.type }))
    )
    return detector.detect(text)
  }

  async function anonymizeWith(
    text: string,
    vault: Vault
  ): Promise<AnonymizeResult> {
    const deterministic = runDeterministic(text)
    const fromVault = vaultDictionaryDetect(text, vault)
    const nerEntities = ner ? await runNer(text) : []
    return finalize(
      text,
      [...deterministic, ...fromVault, ...nerEntities],
      vault
    )
  }

  return {
    get status() {
      return status
    },
    anonymize(text) {
      return anonymizeWith(text, new Vault(strategy))
    },
    anonymizeSync(text) {
      return finalize(text, runDeterministic(text), new Vault(strategy))
    },
    async warmup() {
      await ensureNerLoaded()
    },
    addDictionaryEntries(entries) {
      dictionaryEntries = [...dictionaryEntries, ...entries]
      dictionaryDetector = createDictionaryDetector(dictionaryEntries)
    },
    createSession() {
      return createSession(strategy, anonymizeWith)
    },
    async dispose() {
      if (ner) await ner.dispose()
    },
  }
}
