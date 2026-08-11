/** What the playground tells a user about a browser-local generation model. */
export interface RuntimeDisclosure {
  readonly label: string
  readonly model: string
  readonly source: string
  readonly artifacts:
    | { readonly kind: "browser-managed" }
    | {
        readonly kind: "explicit-download"
        readonly approximateBytes: number
        readonly origins: readonly string[]
      }
}

export interface ProtectedBrowserTurn {
  readonly role: "system" | "user" | "assistant"
  readonly protectedContent: string
}

export interface ProtectedBrowserRequest {
  readonly protectedHistory: readonly ProtectedBrowserTurn[]
  readonly protectedContent: string
  readonly signal?: AbortSignal
}

/**
 * The docs-only seam between privacy adapters and browser-local generation.
 * Implementations must not retain protected conversation state between runs.
 */
export interface BrowserGenerationRuntime {
  readonly id: string
  readonly disclosure: RuntimeDisclosure
  generate(input: ProtectedBrowserRequest): AsyncIterable<string>
  dispose(): Promise<void>
}

export type LocalRuntimeKind = "gemini-nano" | "gemma-3-270m"

export type LocalRuntimeStatus =
  | "checking"
  | "native-ready"
  | "native-downloadable"
  | "fallback-available"
  | "downloading"
  | "ready"
  | "error"

export interface BrowserModelRuntime {
  kind: LocalRuntimeKind
  availability(options?: LanguageModelCreateCoreOptions): Promise<Availability>
  create(options?: LanguageModelCreateOptions): Promise<LanguageModel>
}

export interface LocalRuntimeMetadata {
  artifactSize?: string
  device: "browser"
  execution: "local"
  model: string
  source: string
}

export interface LocalRuntimeSnapshot {
  error?: Error
  fallbackCached?: boolean
  kind?: LocalRuntimeKind
  metadata?: LocalRuntimeMetadata
  nativeAvailability?: Availability
  progress?: number
  runtime?: BrowserModelRuntime
  status: LocalRuntimeStatus
}
