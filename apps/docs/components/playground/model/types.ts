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
