/**
 * Domain model / ubiquitous language for local-pii.
 *
 * Pipeline: text -> deterministic detectors + dictionary -> premask -> NER ->
 * merge/overlap resolution -> placeholder engine -> { redactedText, entities,
 * mapping }. The reverse path is the pure `rehydrate(text, mapping)`.
 */

/**
 * Canonical category of PII. The named members are Rampart's 17 NER labels
 * plus the deterministic-only and dictionary/custom types, so a Rampart tag
 * maps to a {@link PiiType} with zero translation. The `(string & {})` keeps
 * editor autocomplete for the known types while allowing custom labels.
 */
export type PiiType =
  // NER (Rampart head) — names identical to the model's labels
  | "GIVEN_NAME"
  | "SURNAME"
  | "EMAIL"
  | "PHONE"
  | "URL"
  | "TAX_ID"
  | "BANK_ACCOUNT"
  | "ROUTING_NUMBER"
  | "GOVERNMENT_ID"
  | "PASSPORT"
  | "DRIVERS_LICENSE"
  | "BUILDING_NUMBER"
  | "STREET_NAME"
  | "SECONDARY_ADDRESS"
  | "CITY"
  | "STATE"
  | "ZIP_CODE"
  // Deterministic-only
  | "SSN"
  | "CREDIT_CARD"
  | "IP_ADDRESS"
  | "IBAN"
  // Dictionary / custom
  | "PERSON"
  | "ORGANIZATION"
  | "CUSTOM"
  // Escape hatch for user-defined / future NER labels
  | (string & {})

/** Where an entity came from — drives priority when detections overlap. */
export type EntitySource = "deterministic" | "ner" | "dictionary"

/**
 * A half-open range `[start, end)` in UTF-16 code units of the original text,
 * such that `text.slice(start, end) === span.text`.
 */
export interface Span {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** A detected {@link Span} classified as a kind of PII. */
export interface Entity extends Span {
  readonly type: PiiType
  readonly source: EntitySource
  /** Confidence in [0, 1]. Deterministic detectors and the dictionary report 1. */
  readonly confidence: number
}

/**
 * Anything that maps text -> entities. Built-in deterministic detectors are
 * sync and pure. Returned entities need not be sorted or non-overlapping — the
 * pipeline resolves that.
 */
export interface Detector {
  readonly name: string
  /** The primary type this detector emits (used for toggling / display). */
  readonly type?: PiiType
  detect(text: string): Entity[]
}

/**
 * A pluggable async recognizer wrapping a model. Rampart/ONNX is the first
 * implementation; the default anonymizer runs with no backend at all.
 */
export interface NerBackend {
  readonly name: string
  /** Load weights/tokenizer. Idempotent; called lazily on first anonymize. */
  load(): Promise<void>
  detect(text: string): Promise<Entity[]>
  /** Release native resources (ONNX session). Safe to call more than once. */
  dispose(): Promise<void>
}

/**
 * Plain, serializable snapshot of the reverse index: placeholder -> original
 * value. This is what {@link rehydrate} consumes. It is the secret that must
 * never leave the device — the SDK only ever keeps it in memory.
 */
export type Mapping = Record<string, string>

/**
 * Generates placeholders and recognizes its own output. Strategies are the
 * extension point for the sequential / keyed-hash schemes.
 */
export interface PlaceholderStrategy {
  readonly name: string
  /**
   * Deterministic token for a `(type, value)`. `index` is the per-type,
   * 1-based counter of the value's first occurrence (the first PERSON is 1).
   */
  placeholderFor(type: PiiType, value: string, index: number): string
  /** Global regex matching any placeholder this strategy emits. */
  pattern(): RegExp
  /**
   * Optional. Map a possibly LLM-mangled candidate (case-folded, `O`/`0`
   * confusions, stray spaces…) to the exact canonical placeholder this strategy
   * would have emitted, or `""` if it is not one of ours. Enables lenient
   * rehydration of opaque tokens. When present, {@link lenientPattern} should
   * match the mangled shapes to feed this.
   */
  normalizeMatch?(candidate: string): string
  /** Optional. Global regex matching mangled variants (defaults to {@link pattern}). */
  lenientPattern?(): RegExp
}

/** A user-supplied exact term to always treat as PII. */
export interface DictionaryEntry {
  readonly value: string
  /** Default "CUSTOM". */
  readonly type?: PiiType
  /** Case-sensitive matching. Default false. */
  readonly caseSensitive?: boolean
  /** Match only on word boundaries. Default true. */
  readonly wholeWord?: boolean
}

export interface AnonymizeResult {
  /** The text with PII replaced by placeholders — safe to send to an LLM. */
  readonly redactedText: string
  /** Resolved, non-overlapping entities, sorted by `start`. */
  readonly entities: readonly Entity[]
  /** placeholder -> original. Hold in memory only; never serialize off-device. */
  readonly mapping: Mapping
}

export interface RehydrateOptions {
  /** Also match mangled placeholders (`PERSON_1`, `[[PERSON_1]]`, case/`O`/`0`). */
  readonly lenient?: boolean
  /**
   * The strategy that produced the mapping. When it provides
   * {@link PlaceholderStrategy.normalizeMatch}, lenient mode uses it to recover
   * opaque tokens the model altered. Without it, lenient falls back to
   * bracket-variant matching (works for `sequential`/`hashed`).
   */
  readonly strategy?: PlaceholderStrategy
}
