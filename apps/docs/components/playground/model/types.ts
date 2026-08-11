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

export type RuntimeKind = "gemini-nano" | "gemma-3-270m"

/** Compatibility shape used by the adapters until they consume the direct seam. */
export interface BrowserModelRuntime {
  kind: RuntimeKind
  availability(options?: LanguageModelCreateCoreOptions): Promise<Availability>
  create(options?: LanguageModelCreateOptions): Promise<LanguageModel>
}

export type RuntimeAvailability =
  "ready" | "requires-activation" | "unavailable"

export interface RuntimeOption {
  readonly kind: RuntimeKind
  readonly availability: RuntimeAvailability
  readonly disclosure: RuntimeDisclosure
}

export type RuntimeRecovery =
  "check-again" | "retry-activation" | "choose-runtime"

export type RuntimeSnapshot =
  | { readonly status: "checking"; readonly operationId: number }
  | {
      readonly status: "choice-required"
      readonly options: readonly RuntimeOption[]
    }
  | {
      readonly status: "activating"
      readonly operationId: number
      readonly kind: RuntimeKind
      readonly disclosure: RuntimeDisclosure
      readonly progress?: number
    }
  | {
      readonly status: "ready"
      readonly kind: RuntimeKind
      readonly disclosure: RuntimeDisclosure
    }
  | {
      readonly status: "error"
      readonly operationId: number
      readonly kind?: RuntimeKind
      readonly error: Error
      readonly recovery: readonly RuntimeRecovery[]
    }
