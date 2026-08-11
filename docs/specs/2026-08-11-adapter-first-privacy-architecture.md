# Adapter-first privacy architecture

## Purpose

`local-pii` should feel like AI SDK or TanStack AI: a small cross-platform core with opinionated adapters at real seams and an inline path for callers that do not use a supported framework. It must not become a remote detection endpoint, a registry of model providers, or a browser-generation runtime.

The canonical protection flow is:

```text
Detection adapter
Rampart Expo | Rampart Web | custom
          ↓
createAnonymizer()
          ↓
Privacy session per private conversation
          ↓
Generation adapter
AI SDK | OpenAI | TanStack | inline
          ↓
Caller-selected generation model
local or external
```

Rampart Q4 is a Detection model. It finds personal information locally and replaces the need for a remote detection endpoint. Gemini Nano, Gemma, and provider models are Generation models. They produce application responses from protected content and do not belong to the Detection-model interface.

This design deepens the architecture described by [Local browser AI adapters and static playground](./2026-08-08-local-browser-ai-adapters.md). The browser playground remains a proof that the public generation adapters can run without an application backend.

## Current baseline

The repository already has the correct major seams:

- `createAnonymizer({ ner })` owns deterministic detection, dictionary detection, optional NER, entity merging, placeholder allocation, and lazy Detection-model lifecycle.
- `rampart()` and `rampartWeb()` adapt Expo/React Native and browser ONNX runtimes to `NerBackend`.
- `PiiSession` owns one conversation-scoped private mapping.
- `withPiiOpenAI`, `withPii`, `piiConnection`, and `runInline*` adapt distinct generation contracts.
- `createStreamingRehydrator` safely restores placeholders split across stream chunks.
- The static Fumadocs playground exercises Vercel AI SDK and TanStack AI against a browser-local Generation model.

The architecture review found five related opportunities:

1. Vercel browser-generation acquisition, cancellation, cleanup, and temporary global runtime installation are spread across helpers.
2. Browser runtime discovery, activation, download progress, retry, and selection are represented by a shallow state interface.
3. The Vercel and TanStack chats duplicate privacy-session, stop, reset, and inspection ownership with different ordering.
4. TanStack semantic protection and restoration policy is split across modules that callers must mentally combine.
5. Generic `runInline` is useful as an advanced escape hatch but should not become the primary interface.

The work is additive. Existing public imports, call forms, subpaths, ESM/CJS output, and type declarations remain supported.

## Domain language

The canonical language lives in the root `CONTEXT.md`.

- **Detection model** finds and classifies personal information. Rampart is the reference implementation.
- **Generation model** produces an application response from protected content. It may be browser-local or external.
- **Privacy session** owns the private mapping for one private conversation.
- **Generation run** is one independently completed, failed, or cancelled attempt within a private conversation.
- **Browser runtime** owns reusable browser-generation resources, not privacy state or conversation history.

Code and documentation should avoid calling Rampart a local LLM or a Generation model. User-facing documentation may describe the overall behavior as anonymization, but architectural prose should use protection because the private mapping makes the transformation reversible.

## Goals

- Make the two axes of extension obvious: Detection adapters before protection and Generation adapters after protection.
- Make the common cross-platform workflow easy without hiding privacy-session ownership.
- Improve public vocabulary additively without breaking `NerBackend` or `ner` users.
- Keep framework-native generation contracts rather than flattening them into a lowest-common-denominator interface.
- Concentrate protocol semantics, cancellation, streaming restoration, and cleanup behind deep modules.
- Make the Fumadocs playground a faithful consumer of public adapters with no gateway, route, server action, key, or inference endpoint.
- Preserve static export, lazy artifact loading, explicit fallback activation, accessibility, and localized documentation.

## Non-goals

- A universal Generation-model interface across AI SDK, OpenAI, TanStack, and inline callbacks.
- A public registry such as `privacy.attach(vercel(...))`.
- A public Gemini Nano, Gemma, Chrome Prompt API, or browser-generation package.
- A remote Detection-model fallback.
- Persistence of private mappings or chat history.
- Automatic artifact downloads or silent runtime switching.
- A configurable TanStack semantic-field registry.
- Removal or immediate deprecation of existing exports.

## Public module design

### Detection-model vocabulary

Add a vocabulary alias while preserving the existing structural interface:

```ts
export type DetectionModel = NerBackend

export interface AnonymizerOptions {
  detection?: DetectionModel | false
  ner?: NerBackend | false
  // existing options remain unchanged
}
```

`detection` and `ner` identify the same seam. New documentation prefers `detection`; existing documentation examples may migrate incrementally. Supplying both with values other than `undefined` is a synchronous configuration error because precedence would otherwise be surprising. `false` counts as a supplied value, while an omitted property or an explicit `undefined` does not. `NerBackend` and `ner` remain supported compatibility names.

`DetectionModel` is an alias, not a second declaration. The existing `NerBackend` structure remains the lifecycle interface:

```ts
interface NerBackend {
  readonly name: string
  load(): Promise<void>
  detect(userContent: string): Promise<Entity[]>
  dispose(): Promise<void>
}
```

No remote fallback is introduced. Existing `strict` behavior remains authoritative: strict failure throws; non-strict failure enters deterministic-only degradation and reports `onDegraded`.

### Privacy orchestration

`createAnonymizer()` remains the deep public module. A caller may name the value `privacy`, but a second `createPrivacy()` façade is not added.

```ts
const privacy = createAnonymizer({
  detection: rampartWeb(),
  placeholders: token(),
})

const conversation = privacy.createSession()
```

One anonymizer may share loaded Detection-model resources across many private conversations. One `PiiSession` represents exactly one privacy session and must not be shared between users or unrelated threads. Supplied sessions are borrowed by generation adapters and are never cleared by them.

The explicit session is the recommended multi-turn path. Existing implicit adapter-lifetime sessions remain compatible for OpenAI and AI SDK. TanStack continues requiring a session because its connection contract has no reliable disposal hook.

### Generation adapters

The framework contracts remain separate real seams:

| Generation seam           | Public adapter                    | Ownership                                                            |
| ------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| Vercel AI SDK model       | `withPii` / `piiMiddleware`       | Borrows an explicit session or retains its existing implicit session |
| OpenAI-compatible client  | `withPiiOpenAI` / `createPiiChat` | Borrows an explicit session or retains its existing implicit session |
| TanStack connection       | `piiConnection`                   | Requires and borrows an explicit session                             |
| Arbitrary in-process call | `runInline*`                      | Borrows a supplied session or owns a temporary one                   |

Every adapter owns its framework-semantic policy. Only model-semantic content is protected. Roles, identifiers, protocol discriminants, schemas, metadata, files, URLs, reasoning data, and run context remain unchanged unless the pinned framework contract explicitly defines them as model content.

Each generation adapter publishes a pinned field matrix with four classifications:

- protected semantic values;
- restored semantic values;
- known preserved control/opaque values, which remain caller responsibility;
- unsupported semantic variants and the adapter's error behavior.

The built-in adapters guarantee protection only for values listed as protected in their field matrix. A generic inline callback and caller-supplied Detection model are trusted caller code and may move data outside the guarantees of the built-in adapters.

No universal public Generation-model interface is added. Deleting such a façade would remove almost no complexity because callers would still need the native framework contracts; it would fail the deletion test.

### Inline interface

Add `anonymizer` to the shared inline options:

```ts
export interface InlineSessionOptions {
  session?: PiiSession
  anonymizer?: Anonymizer
  signal?: AbortSignal
}
```

Resolution follows the established adapter convention:

1. A supplied session is borrowed and wins over `anonymizer`.
2. Otherwise, a temporary session is created from the supplied anonymizer.
3. Otherwise, a temporary token-based anonymizer and session are created.
4. Temporary sessions are cleared after completion, failure, cancellation, or early iterator return.

The recommended interfaces remain `runInlineText`, `runInlineTextStream`, and `runInlineJson`. Generic `runInline` stays public as the advanced escape hatch for custom protected and restored shapes. It is not expanded into a policy registry or public generation kernel.

## Internal deep modules

### Protocol-specific generation lifecycle

The protection flow has shared invariants but materially different host contracts. The implementation should deepen each protocol adapter rather than force all protocols through one public or internal mega-interface.

Shared in-process primitives may concentrate:

- privacy-session source resolution;
- abort checks around awaited work;
- original error precedence over cleanup errors;
- early iterator/stream cancellation;
- successful-tail flush versus failure-tail discard;
- run-local streaming-restoration state.

Framework-semantic traversal stays inside each adapter. A helper is retained only when deleting it would redistribute lifecycle complexity across at least two adapters.

For every generation run:

1. Reject if the caller signal is already aborted.
2. Protect all known model-semantic input.
3. Recheck cancellation before crossing the generation seam.
4. Invoke exactly the caller-selected Generation model or connection.
5. Restore complete or streamed output using run-local buffers.
6. Flush valid tails only on successful completion.
7. Discard incomplete tails on failure, abort, protocol error, or early return.
8. Forward upstream cleanup.
9. Preserve the original generation failure; cleanup failure is primary only after otherwise successful processing.

Library adapters continue supporting concurrent generation runs. Mapping mutation may be serialized only if required for deterministic placeholder allocation; generation itself must not be globally serialized.

### TanStack semantic policy

Deepen `tanstack-content.ts` and `tanstack-stream.ts` into one conceptual semantic-policy module behind the unchanged `piiConnection(inner, { session })` interface.

The implementation owns:

- protection of message text and textual message parts;
- structured values that the pinned protocol sends to a Generation model;
- tool arguments, inputs, outputs, results, and textual tool errors;
- non-mutating cloning of changed paths;
- preservation of control fields;
- restoration state keyed first by generation run and then by message or tool-call identifier;
- normal-terminal flushing and error/abort discard;
- `connect` and same-session `joinRun` restoration.

The pinned TanStack matrix is:

| Structural location                                                                                       | Classification                                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Message `content` strings and `text` parts                                                                | Protect before `connect`; restore corresponding output text                     |
| Complete structured-output raw JSON                                                                       | Protect/restore as structured values                                            |
| Supported tool arguments, inputs, outputs, results, and textual errors                                    | Protect/restore at their protocol boundary                                      |
| Roles, identifiers, names, schemas, metadata, files, URLs, reasoning data, discriminants, and run context | Preserve unchanged; caller is responsible for personal information placed there |
| Unknown discriminant inside a semantic content/parts array                                                | Reject before `connect`                                                         |
| Unknown key at an explicitly supported message/control location                                           | Preserve unchanged                                                              |

Unknown content-part discriminants throw an exported `UnsupportedTanStackSemanticContentError`. The error includes only a structural path and discriminant, never user content. This is an intentional privacy-hardening behavior change for the `0.1.0` release, even though imports and existing supported call forms remain compatible. Callers do not configure field lists.

`hydrate` and `hydrateGeneration` continue to pass through unchanged for source compatibility; `piiConnection` does not claim to protect or restore their snapshots. `joinRun` restores only while the caller reuses the same live privacy session and mapping. Persistence, full-page reload restoration, cross-tab resumption, and a new session rejoining an old run are unsupported. Documentation must require ephemeral TanStack usage with `piiConnection`. Secure resumability would require a separate explicit mapping-storage design and remains out of scope.

### Browser-generation seam in Fumadocs

The browser-generation seam remains internal to `apps/docs` and is justified by two production adapters plus a fake:

```ts
interface RuntimeDisclosure {
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

interface ProtectedBrowserTurn {
  readonly role: "user" | "assistant"
  readonly protectedContent: string
}

interface BrowserGenerationRuntime {
  /** Stable identity; tests may inject `fake`. */
  readonly id: string
  readonly disclosure: RuntimeDisclosure

  generate(input: {
    /** Prior turns only; every semantic value is already protected. */
    protectedHistory: readonly ProtectedBrowserTurn[]
    /** The current protected user turn, not repeated in protectedHistory. */
    protectedContent: string
    signal?: AbortSignal
  }): AsyncIterable<string>

  dispose(): Promise<void>
}
```

Adapters:

- Chrome Prompt API / browser-managed Gemini Nano;
- Transformers.js / Gemma fallback;
- deterministic fake used by tests.

The interface describes what the playground needs rather than mirroring Chrome's global `LanguageModel`. Both history and the current turn have already crossed the applicable public privacy adapter before this seam. An unprotected turn or unsupported role is rejected before model-session acquisition. The Vercel and TanStack framework adapters consume the interface independently. The Vercel implementation should satisfy the pinned AI SDK model contract directly instead of temporarily replacing `globalThis.LanguageModel`. This removes global mutation and the accidental serialization it requires.

Each `generate` iterator creates and releases its model session. Abort, thrown errors, consumer `return()`, and normal completion all cancel or close the upstream stream before releasing the session. `dispose()` releases only reusable runtime resources after active iterators have settled. Loaded weights, factories, and other reusable resources may survive across runs and private conversations. Browser runtime resources never own a privacy session, private mapping, or chat history.

### Runtime state machine

The docs-internal runtime controller owns capability discovery, selection, activation, download disclosure, progress, retry, and reusable runtime resources behind this interface:

```ts
type RuntimeKind = "gemini-nano" | "gemma-3-270m"

interface RuntimeOption {
  readonly kind: RuntimeKind
  readonly availability: "ready" | "requires-activation" | "unavailable"
  readonly disclosure: RuntimeDisclosure
  readonly cached?: boolean
}

type RuntimeRecovery = "check-again" | "retry-activation" | "choose-runtime"

type RuntimeSnapshot =
  | { status: "checking"; operationId: number }
  | { status: "choice-required"; options: readonly RuntimeOption[] }
  | {
      status: "activating"
      operationId: number
      kind: RuntimeKind
      disclosure: RuntimeDisclosure
      progress?: number
    }
  | { status: "ready"; kind: RuntimeKind; disclosure: RuntimeDisclosure }
  | {
      status: "error"
      operationId: number
      kind?: RuntimeKind
      error: Error
      recovery: readonly RuntimeRecovery[]
    }

interface BrowserRuntimeController {
  check(): Promise<void>
  activate(kind: RuntimeKind, signal?: AbortSignal): Promise<void>
  getSnapshot(): RuntimeSnapshot
  getRuntime(): BrowserGenerationRuntime | undefined
  subscribe(listener: () => void): () => void
}
```

`check()` coalesces concurrent checks and inspects capability/cache state without acquiring fallback artifacts. `activate()` is accepted only from `choice-required` or a recoverable `error`; a second activation while one is active fails with `RuntimeActivationBusyError` rather than queues. Every asynchronous operation carries an increasing `operationId`, and completions from stale operations are ignored. `getRuntime()` returns a value only while the snapshot is `ready`.

Native availability reported as already available may become ready without a model download. Browser-managed or fallback downloads require explicit activation. An activation or generation failure never switches runtime automatically. Artifact requests may reach their declared host but never contain user content.

### Private-conversation lifecycle in Fumadocs

Each Vercel and TanStack chat owns an independent private conversation:

- separate visible history;
- exactly one privacy session;
- separate inspection state;
- at most one active generation run in that chat.

Both chats may share reusable browser runtime resources. A playground-level generation gate prevents simultaneous expensive browser generation across the two force-mounted examples without changing library concurrency guarantees.

The docs implementation provides a run-scoped observed-session adapter used by both framework paths:

```ts
interface ProtectionObservation {
  record(path: readonly (string | number)[], result: AnonymizeResult): void
  commit(request: {
    protectedHistory: readonly ProtectedBrowserTurn[]
    protectedContent: string
  }): PrivacyInspection
  discard(): void
}

interface ProtectionObserver {
  begin(generationRunId: string): ProtectionObservation
}
```

It delegates to the real `PiiSession`, attributes every protection result to one generation-run identity, aggregates entity counts, and commits only the normalized protected request that actually crosses the browser-generation seam. Failure or cancellation before that seam discards the observation. Late observations from an older run are ignored. This replaces the current extra inspection anonymization pass, so the inspector cannot drift from model-facing protected content.

The playground generation gate is in-page and non-queuing. A racing acquisition fails with `PlaygroundBusyError`; normal controls are disabled before that race. The lease is released only after iterator cancellation and model-session cleanup, not merely when a framework stop method returns.

Stop affects only the active generation run. New conversation follows strict ordering:

1. Prevent new submissions.
2. Abort the active generation run.
3. Await framework stop settlement, upstream cancellation, restoration discard, and model-session cleanup.
4. Clear visible history and framework error state.
5. Clear the old privacy session and inspection.
6. Create a new privacy session and re-enable submission.

Late events from an old generation run are ignored by run identity. Expected user cancellation returns the chat to ready state; unexpected stop or cleanup failures remain observable.

## Privacy and failure invariants

- The bundled Rampart Detection adapters receive original user content only inside the caller's local process or device runtime. A caller-supplied Detection model is trusted caller code and may have different behavior.
- Built-in adapters protect the semantic values listed in their pinned field matrix before those values cross a Generation-model seam. Preserved fields remain caller responsibility.
- The library itself never transmits, logs, reports, or persists the private mapping. Because `PiiSession.mapping`, manual helpers, and generic inline callbacks are public, callers remain responsible for code outside the built-in adapters.
- A remote Generation model may retain protected content according to its own policy; the library does not claim otherwise.
- Browser-local inference sends no prompts, restored values, or private mappings to an application backend or inference endpoint.
- Detection-model artifact downloads and Generation-model artifact downloads are distinct and disclosed separately; artifact requests contain no user content.
- Detection failure uses the configured strict/degraded behavior; there is no cloud Detection-model fallback.
- Generation failure never triggers a different Generation model automatically.
- Unknown TanStack content-part discriminants fail closed before `connect`; every other adapter follows its documented pinned field matrix.
- Original errors and abort reasons remain observable wherever the host framework permits.

## Performance and platform constraints

- The dependency-free core remains importable without native or browser runtime packages.
- Expo, web, AI SDK, OpenAI, inline, and TanStack integrations remain isolated in subpath exports.
- Rampart loads lazily and may be warmed once per anonymizer.
- Fumadocs remains a static Next.js export. Browser globals are accessed only from hydrated client modules and according to the installed Next.js documentation.
- Fallback Generation-model code and artifacts are not loaded on page visit.
- Stream restoration memory is bounded by active semantic channels and the placeholder holdback required for incomplete tails.
- Tool JSON may remain buffered until a safe protocol boundary when incremental restoration cannot be proven correct.

The required import/build matrix is:

| Subpath              | Required consumers                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `local-pii`          | Node ESM/CJS, browser bundler, Expo/React Native bundler, declarations                   |
| `local-pii/inline`   | Node ESM/CJS, browser bundler, Expo/React Native bundler, declarations                   |
| `local-pii/openai`   | Node ESM/CJS, browser bundler where the caller permits its provider client, declarations |
| `local-pii/ai-sdk`   | Node ESM/CJS and browser bundler supported by the pinned AI SDK peer, declarations       |
| `local-pii/tanstack` | Node ESM/CJS and browser bundler supported by the pinned TanStack peers, declarations    |
| `local-pii/expo`     | Expo/React Native bundler and declarations; it must not enter browser/Node core bundles  |
| `local-pii/web`      | Browser bundler and declarations; it must not enter Expo/core bundles                    |
| `local-pii/metro`    | Node ESM/CJS Metro configuration and declarations                                        |

Every currently advertised `import` and `require` export remains loadable. Fixtures cover legacy `ner`, new `detection`, explicit/implicit sessions, and declaration-only consumers.

## Testing design

Implementation uses TDD through public or deep-module interfaces.

### Public package contracts

- `DetectionModel` is assignable to and from `NerBackend`.
- `detection` and `ner` produce identical observable behavior.
- Supplying both fails synchronously without loading a model.
- Omitted/`undefined` aliases do not conflict; `false` combined with the other alias does conflict.
- Existing `ner` call forms and declarations remain green.
- Inline `anonymizer` uses the configured Detection model, clears a temporary session, and preserves a supplied session.
- Every public subpath passes its required import/build-matrix fixtures.

### Generation behavior

- Original input is not mutated.
- Only protected semantic values reach controlled Generation-model adapters.
- Complete, JSON, streamed text, and tool values restore correctly.
- Every relevant placeholder split point is covered by property or fuzz-style chunking tests.
- Abort, early return, upstream failure, cleanup failure, and concurrent runs obey lifecycle invariants.
- OpenAI, AI SDK, and TanStack pinned contracts have field-matrix and lifecycle tests covering their explicitly supported behavior.
- TanStack unknown content-part discriminants throw `UnsupportedTanStackSemanticContentError`; unknown keys at listed control locations survive unchanged.
- TanStack `hydrate` and `hydrateGeneration` pass through unchanged, same-live-session `joinRun` restores, and reload/new-session resume is documented and tested as unsupported.

### Playground behavior

- Both chats exercise their real public privacy adapter and the same fake browser runtime seam.
- The privacy inspector observes the actual protection pass.
- Vercel does not mutate `globalThis.LanguageModel`.
- Runtime checking does not download artifacts.
- Native and fallback activation, progress, retry, explicit selection, and errors render accessibly.
- Stop and new conversation await cleanup before clearing the privacy session.
- Cross-chat, same-page generation arbitration prevents simultaneous runs without merging histories or mappings.
- Static export, type checking, localization, keyboard behavior, and accessible status announcements remain green.
- Automated browser request interception enforces an origin/method allowlist containing only same-origin static assets and disclosed model-artifact hosts; human network inspection remains supplementary.

Existing shallow helper tests are removed only after equivalent behavior is covered through the deeper interface. Tests must not assert private helper structure.

## Migration sequence

1. Add domain vocabulary and compatibility tests for `DetectionModel`/`detection`.
2. Add inline `anonymizer` support and document the canonical cross-platform flow.
3. Audit and align OpenAI and AI SDK field matrices, streaming/tool lifecycle, abort, early return, tail discard, cleanup-error precedence, and concurrency for the behavior claimed by their documentation.
4. Deepen TanStack semantic policy, publish its field matrix and ephemeral-only persistence limitation, add the explicit unsupported-content error, and release the privacy-hardening behavior in `0.1.0`.
5. Introduce the docs-internal browser-generation seam and direct Vercel adapter; remove global runtime mutation.
6. Deepen the runtime state machine with explicit transitions, activation identity, consent, and recovery.
7. Concentrate private-conversation lifecycle, run-scoped observed protection, and same-page cross-chat generation arbitration.
8. Refresh package and localized Fumadocs documentation. Correct the stale `withExpoPiiMetro` name because the new canonical Expo example would otherwise be invalid.
9. Add the cross-platform import/build fixtures and run package, docs, static-export, type, React, accessibility, automated network, and browser smoke verification.

Each step is independently testable and preserves a working public path. Tickets should declare blocking edges so implementation can proceed blockers-first.

## Rejected designs

### Public policy-and-driver kernel

A public kernel exposing stream restorers, semantic policies, runtime catalogs, and run registries maximizes extension but makes callers learn most of the implementation. It is shallow and makes privacy correctness configurable.

### `createPrivacy()` façade

An opaque conversation façade makes the common example shorter but duplicates `createAnonymizer` and `PiiSession`, introduces a second lifecycle, and promises cross-framework cancellation guarantees before every pinned framework contract proves them. The existing session is the real reusable seam.

### Universal generation registry

AI SDK, OpenAI, TanStack, and inline contracts differ in message structure, streams, tools, errors, and ownership. A universal registry hides names but not complexity. The framework adapters remain separate.

### Public browser runtime

Gemini Nano and Gemma are Generation models used by one documentation application. Moving their runtime selection into `local-pii` would create a hypothetical public seam and confuse generation with detection.

## Success criteria

- A new caller can identify and compose a Detection adapter, `createAnonymizer`, one privacy session, and a framework or inline Generation adapter from the primary documentation.
- Rampart is consistently described as a Detection model rather than a Generation model.
- Existing imports and supported call forms compile unchanged. The documented TanStack unknown-content rejection is the sole planned compatibility hardening and ships with its error type and migration note in `0.1.0`.
- No gateway, application backend, remote Detection fallback, universal model registry, or silent Generation-model fallback is introduced.
- Vercel browser generation no longer mutates a global runtime and releases its model session on every terminal path.
- Runtime-controller transition tests cover checking, explicit activation, progress, stale completion, retry, and error recovery.
- New-conversation tests prove stop and cleanup settle before the old privacy mapping is cleared.
- The pinned TanStack field matrix is enforced through its unchanged connection call form, with the documented privacy-hardening error for unknown content parts.
- Generic `runInline` remains the advanced escape hatch while text, stream, and JSON helpers remain the primary documented inline interfaces.
- The Vercel and TanStack demos use genuine public adapters, actual protected-content inspection, independent private conversations, coordinated cleanup, and browser-local generation.
- The complete import/build matrix passes.
- Automated request interception plus supplementary human browser inspection prove static delivery, explicit artifact behavior, cancellation, restoration safety, and the absence of an inference endpoint.
