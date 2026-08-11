# Adapter-First Privacy Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `local-pii` an adapter-first, cross-platform protection library with an inline escape hatch and a static, backend-free Fumadocs playground that runs protected Vercel AI SDK and TanStack AI chats against caller-selected browser Generation models.

**Architecture:** Keep `createAnonymizer()` and one conversation-scoped privacy session as the center of the public API, with independent Detection adapters before protection and framework-native Generation adapters after it. Deepen the OpenAI, AI SDK, TanStack, and inline modules at their real protocol seams; keep browser Generation runtime selection, run observation, and cross-chat arbitration private to `apps/docs`. Rampart Q4 remains only a Detection model, while browser-managed Gemini Nano and opt-in Gemma 3 270M are Generation models; no Gateway, server route, model registry, or universal Generation-model interface is introduced.

**Tech Stack:** TypeScript 5, Bun 1.3 workspaces, Vitest 3, fast-check, Rslib/Rspack, Next.js 16.2.6 static export, React 19, Vercel AI SDK 7, TanStack AI 0.43.1/0.23.1, Chrome Prompt API, Transformers.js 4, WebGPU, shadcn/ui, AI Elements, Testing Library, Playwright.

---

## Delivery order and dependency graph

Implement blockers first. Tasks 1 and 2 establish the public vocabulary and inline contract. Tasks 3 and 4 can then be implemented independently. Tasks 5 and 6 form the TanStack sequence. Tasks 7 and 8 establish the browser seam and controller. Task 9 supplies the shared observer/gate used by Tasks 10 and 11. Task 12 documents only behavior already green. Task 13 verifies the complete package/platform matrix. Task 14 is the final review and release gate.

```text
Task 1 -> Task 2
Task 1 -> Task 3
Task 1 -> Task 4
Task 1 -> Task 5 -> Task 6
Task 4 -> Task 7 -> Task 8
Task 5 -> Task 7
Task 7 -> Task 9 -> Task 10
Task 6 -> Task 9 -> Task 11
Tasks 2-11 -> Task 12 -> Task 13 -> Task 14
```

The approved spec spans package API, three framework protocols, and one documentation application, but these are not independent products: each later slice exercises the same protection flow and the migration sequence requires a continuously working public path. One coordinated plan therefore wins over separate plans, while the dependency graph keeps every commit independently testable.

## File map

### Public package and compatibility

- `packages/local-pii/src/types.ts`: add the additive `DetectionModel` vocabulary alias.
- `packages/local-pii/src/anonymizer.ts`: resolve `detection`/`ner` aliases and reject ambiguous configuration synchronously.
- `packages/local-pii/src/index.ts`: export the new type without removing `NerBackend`.
- `packages/local-pii/src/anonymizer.test.ts`: runtime alias, conflict, degradation, and no-load regression tests.
- `packages/local-pii/src/inline.ts`: add caller-supplied anonymizer resolution while preserving session ownership.
- `packages/local-pii/src/inline.test.ts`: inline precedence and cleanup tests.
- `packages/local-pii/src/openai-content.ts`: immutable OpenAI semantic input/output traversal.
- `packages/local-pii/src/openai-stream.ts`: run-local OpenAI text/tool streaming restoration and cleanup.
- `packages/local-pii/src/openai.ts`: retain the public OpenAI facade and delegate protocol policy to focused modules.
- `packages/local-pii/src/openai.test.ts`: pinned OpenAI field matrix, lifecycle, split-token, and concurrency tests.
- `packages/local-pii/src/ai-sdk-content.ts`: pinned AI SDK v4 semantic prompt/result traversal.
- `packages/local-pii/src/ai-sdk-stream.ts`: run-local AI SDK text/tool-input restoration and terminal semantics.
- `packages/local-pii/src/ai-sdk.ts`: retain `piiMiddleware`/`withPii` and delegate protocol policy.
- `packages/local-pii/src/ai-sdk.test.ts`: pinned AI SDK field matrix and lifecycle tests.
- `packages/local-pii/src/tanstack-content.ts`: fail-closed TanStack semantic policy and immutable cloning.
- `packages/local-pii/src/tanstack-stream.ts`: per-run, per-message, and per-tool restoration.
- `packages/local-pii/src/tanstack.ts`: public error export plus connection/hydration/join lifecycle.
- `packages/local-pii/src/tanstack.test.ts`: field matrix, error redaction, hydration, live-session join, and abnormal termination.
- `packages/local-pii/src/tanstack.exports.test.ts`: public error/declaration compatibility.
- `packages/local-pii/package.json`: `0.1.0` release metadata and matrix-verification scripts/dependencies.
- `packages/local-pii/rslib.config.ts`: preserve all existing isolated entry points.

### Browser-only documentation application

- `apps/docs/components/playground/model/types.ts`: exact browser runtime disclosures, protected request, state-machine, and recovery types.
- `apps/docs/components/playground/model/protected-request.ts`: private request-minting guard that rejects an unprotected request before model acquisition.
- `apps/docs/components/playground/model/browser-generation-runtime.ts`: reusable iterator cleanup/disposal primitives.
- `apps/docs/components/playground/model/fake-runtime.ts`: deterministic runtime for component and browser tests.
- `apps/docs/components/playground/model/chrome-runtime.ts`: browser-managed Gemini Nano runtime.
- `apps/docs/components/playground/model/gemma-runtime.ts`: opt-in Transformers.js/Gemma runtime without Prompt-global emulation.
- `apps/docs/components/playground/model/vercel-model.ts`: direct AI SDK v4 model over `BrowserGenerationRuntime`, with no `globalThis.LanguageModel` mutation.
- `apps/docs/components/playground/model/tanstack-connection.ts`: direct TanStack connection over the same runtime seam.
- `apps/docs/components/playground/model/runtime-controller.ts`: capability discovery, explicit activation, operation identity, progress, retry, and disposal.
- `apps/docs/components/playground/model/*.test.ts`: fake-driven runtime, cancellation, stale-operation, and direct-adapter tests.
- `apps/docs/components/playground/protection-observer.ts`: run-scoped observed privacy session and exact model-facing inspection.
- `apps/docs/components/playground/generation-gate.ts`: non-queuing, same-page cross-chat lease.
- `apps/docs/components/playground/private-conversation.ts`: shared run identity and strict stop/new-conversation ordering.
- `apps/docs/components/playground/runtime-provider.tsx`: hydrated controller and gate provider.
- `apps/docs/components/playground/vercel-chat.tsx`: Vercel chat with one private conversation and real public `withPii` adapter.
- `apps/docs/components/playground/tanstack-chat.tsx`: TanStack chat with one private conversation and real public `piiConnection` adapter.
- `apps/docs/components/playground/chat-shell.tsx`: shared accessible shadcn/AI Elements controls with async stop/reset.
- `apps/docs/components/playground/privacy-inspector.tsx`: committed run inspection only.
- `apps/docs/components/playground.tsx`: runtime choice/recovery UI and force-mounted independent chats.
- `apps/docs/components/playground/*.test.tsx`: run identity, inspector, reset ordering, cancellation, and gate component tests.
- `apps/docs/next.config.mjs`: preserve `output: "export"`; no route or server feature.
- `apps/docs/playwright.config.ts`: static-output browser test server.
- `apps/docs/e2e/playground.spec.ts`: keyboard/accessibility smoke and network allowlist interception.
- `apps/docs/package.json`: browser-test script and Playwright development dependency.

### Documentation and build matrix

- `packages/local-pii/README.md`: canonical cross-platform flow, public matrices, lifecycle, and corrected Metro helper.
- `README.md`: concise Detection/Generation vocabulary and package orientation.
- `apps/docs/content/docs/{index,adapters,browser,expo,concepts,security,limitations,playground}.{mdx,pt.mdx,de.mdx}`: localized vocabulary, matrices, browser consent, lifecycle, and limitations.
- `packages/local-pii/test/import-matrix/*.ts`: declaration-only consumer fixtures.
- `packages/local-pii/scripts/verify-import-matrix.mjs`: ESM/CJS loading and browser/core/Expo bundle-isolation assertions.
- `apps/example/App.tsx`: canonical Expo consumer using `detection` while legacy `ner` remains covered by fixtures.
- `apps/example/metro.config.js`: existing `withLocalPiiMetro` consumer remains the Metro build fixture.
- `bun.lock`: exact Playwright and bundle-fixture tooling resolution.

---

### Task 1: Add Detection-model vocabulary without breaking `ner`

**Files:**

- Modify: `packages/local-pii/src/types.ts:79-90`
- Modify: `packages/local-pii/src/anonymizer.ts:20-25,66-82`
- Modify: `packages/local-pii/src/index.ts:54-67`
- Modify: `packages/local-pii/src/anonymizer.test.ts`

- [ ] **Step 1: Write compile-time and runtime alias tests**

Add `DetectionModel` to the type import and use `expectTypeOf` to prove exact bidirectional assignability. Reuse the existing mock backend pattern and capture `load`/`detect` calls:

```ts
import { expectTypeOf } from "vitest"
import type { DetectionModel, NerBackend } from "./types"

expectTypeOf<DetectionModel>().toEqualTypeOf<NerBackend>()

it.each(["detection", "ner"] as const)(
  "uses the %s compatibility name for the same model seam",
  async (key) => {
    const model = mockNer(() => [emailEntity("ana@acme.com")])
    const result = await createAnonymizer({ [key]: model }).anonymize(
      "ana@acme.com"
    )
    expect(result.redactedText).not.toContain("ana@acme.com")
    expect(model.load).toHaveBeenCalledOnce()
    expect(model.detect).toHaveBeenCalledOnce()
  }
)
```

Add a legacy `ner` assertion to the existing declaration/build test so source compatibility is checked, not inferred.

- [ ] **Step 2: Write the complete conflict truth table**

Use a model whose lifecycle functions throw if called. Assert that both supplied aliases fail synchronously, including `false`, while omitted and explicit `undefined` do not conflict:

```ts
expect(() => createAnonymizer({ detection: false, ner: false })).toThrow(
  TypeError
)
expect(() =>
  createAnonymizer({ detection: model, ner: undefined })
).not.toThrow()
expect(() =>
  createAnonymizer({ detection: undefined, ner: model })
).not.toThrow()
expect(() => createAnonymizer({ detection: model, ner: false })).toThrow()
expect(model.load).not.toHaveBeenCalled()
```

- [ ] **Step 3: Run the focused tests and verify red**

Run: `bun --filter local-pii test -- anonymizer.test.ts`

Expected: FAIL because `DetectionModel` and `AnonymizerOptions.detection` do not exist and no ambiguity check runs.

- [ ] **Step 4: Implement the alias and synchronous resolution**

Add the alias immediately after `NerBackend`:

```ts
export type DetectionModel = NerBackend
```

Extend the options and resolve once, before detector/model setup can cause side effects:

```ts
export interface AnonymizerOptions {
  detection?: DetectionModel | false
  ner?: NerBackend | false
}

const detectionSupplied = options.detection !== undefined
const nerSupplied = options.ner !== undefined
if (detectionSupplied && nerSupplied) {
  throw new TypeError(
    '"detection" and "ner" configure the same Detection model; supply only one'
  )
}
const configuredDetection = detectionSupplied ? options.detection : options.ner
const ner: NerBackend | null =
  configuredDetection === false || configuredDetection == null
    ? null
    : configuredDetection
```

Export `DetectionModel` from `index.ts`; retain `NerBackend` and all existing exports.

- [ ] **Step 5: Prove strict/degraded behavior is unchanged**

Run: `bun --filter local-pii test -- anonymizer.test.ts session.test.ts`

Expected: PASS, including existing lazy loading, strict rejection, `onDegraded`, dispose, and legacy `ner` cases.

Run: `bun --filter local-pii typecheck && bun --filter local-pii build`

Expected: exit 0 and `dist/index.d.ts` contains both `type DetectionModel = NerBackend` and `NerBackend`.

- [ ] **Step 6: Commit the vocabulary slice**

```bash
git add packages/local-pii/src/types.ts packages/local-pii/src/anonymizer.ts packages/local-pii/src/index.ts packages/local-pii/src/anonymizer.test.ts
git commit -m "feat(local-pii): add detection model vocabulary"
```

---

### Task 2: Let inline helpers derive temporary sessions from an anonymizer

**Files:**

- Modify: `packages/local-pii/src/inline.ts:1-46`
- Modify: `packages/local-pii/src/inline.test.ts`
- Modify: `packages/local-pii/src/inline.exports.test.ts:48-56`

- [ ] **Step 1: Write failing anonymizer resolution tests**

Create an anonymizer configured with a mock Detection model that recognizes `João`. Pass it to each primary inline helper and assert the Generation callback sees a placeholder and the restored result contains `João`:

```ts
const anonymizer = createAnonymizer({
  detection: mockNer((text) => entityFor(text, "João", "GIVEN_NAME")),
  placeholders: token(),
})
const output = await runInlineText({
  anonymizer,
  input: "Olá João",
  call: async (protectedText) => {
    expect(protectedText).not.toContain("João")
    return protectedText
  },
})
expect(output).toBe("Olá João")
```

Repeat the ownership assertion for successful complete, failure, abort, streamed completion, and streamed early `return()` paths by spying on the session returned by `anonymizer.createSession()`.

- [ ] **Step 2: Write precedence and borrowed-session tests**

Supply both a session and an anonymizer. Assert the session wins, `anonymizer.createSession` is never called, and the borrowed session is not cleared:

```ts
await runInlineText({
  session,
  anonymizer,
  input: "ana@acme.com",
  call: async (value) => value,
})
expect(createFromAnonymizer).not.toHaveBeenCalled()
expect(clearBorrowedSession).not.toHaveBeenCalled()
```

- [ ] **Step 3: Run focused tests and verify red**

Run: `bun --filter local-pii test -- inline.test.ts inline.exports.test.ts`

Expected: FAIL because `InlineSessionOptions` rejects `anonymizer` and `resolveSession` always creates the default token anonymizer.

- [ ] **Step 4: Implement the established three-way resolution**

Import `type Anonymizer`, add the option, and keep ownership explicit:

```ts
export interface InlineSessionOptions {
  session?: PiiSession
  anonymizer?: Anonymizer
  signal?: AbortSignal
}

function resolveSession(options: InlineSessionOptions): ResolvedSession {
  if (options.session) return { session: options.session, owned: false }
  const anonymizer =
    options.anonymizer ?? createAnonymizer({ placeholders: token() })
  return { session: anonymizer.createSession(), owned: true }
}
```

Do not add `createPrivacy`, a registry, or new inline policy callbacks. Keep generic `runInline` advanced and keep text/stream/JSON helpers as the documented defaults.

- [ ] **Step 5: Verify cleanup and declarations**

Run: `bun --filter local-pii test -- inline.test.ts inline.exports.test.ts`

Expected: PASS; owned mappings are empty after every terminal path and borrowed mappings survive.

Run: `bun --filter local-pii build && rg "anonymizer.*Anonymizer" packages/local-pii/dist/inline.d.ts`

Expected: build exits 0 and the declaration search finds `InlineSessionOptions.anonymizer`.

- [ ] **Step 6: Commit inline composition**

```bash
git add packages/local-pii/src/inline.ts packages/local-pii/src/inline.test.ts packages/local-pii/src/inline.exports.test.ts
git commit -m "feat(local-pii): accept anonymizers in inline adapters"
```

---

### Task 3: Publish and enforce the OpenAI field/lifecycle matrix

**Files:**

- Create: `packages/local-pii/src/openai-content.ts`
- Create: `packages/local-pii/src/openai-stream.ts`
- Modify: `packages/local-pii/src/openai.ts`
- Modify: `packages/local-pii/src/openai.test.ts`

- [ ] **Step 1: Write the pinned OpenAI input matrix test**

Freeze messages and record the exact value passed to `chat.completions.create`. Assert this matrix:

```ts
const messages = deepFreeze([
  {
    role: "assistant",
    content: "Email ana@acme.com",
    name: "ana@acme.com",
    tool_calls: [
      {
        id: "call-ana@acme.com",
        type: "function",
        function: {
          name: "lookup_ana@acme.com",
          arguments: JSON.stringify({ email: "ana@acme.com" }),
        },
      },
    ],
    metadata: { audit: "ana@acme.com" },
  },
])

expect(JSON.stringify(wire[0].content)).not.toContain("ana@acme.com")
expect(
  JSON.stringify(wire[0].tool_calls?.[0]?.function.arguments)
).not.toContain("ana@acme.com")
expect(wire[0].name).toBe("ana@acme.com")
expect(wire[0].tool_calls?.[0]?.id).toBe("call-ana@acme.com")
expect(wire[0].metadata).toEqual({ audit: "ana@acme.com" })
expect(messages).toEqual(snapshot)
```

The protected locations are message `content` strings and `function.arguments`; roles, identifiers, names, tools/schemas, metadata, request options, and unknown keys are preserved and documented as caller responsibility.

- [ ] **Step 2: Write complete-output and streamed tool-call tests**

For complete output, return content plus tool-call argument JSON and assert both restore without mutating control fields. For streaming, interleave two choices and two tool calls; split each token at every boundary and assert channel isolation by `choice.index` plus `tool_calls[].index`:

```ts
yield {
  choices: [{
    index: 0,
    delta: {
      tool_calls: [{ index: 1, function: { arguments: protectedArgs.slice(0, cut) } }],
    },
  }],
}
yield {
  choices: [{
    index: 0,
    delta: {
      tool_calls: [{ index: 1, function: { arguments: protectedArgs.slice(cut) } }],
    },
  }],
}
```

Assert emitted argument fragments concatenate into valid JSON containing the restored email, while `id`, `type`, function name, finish reason, usage, and unknown keys survive unchanged.

- [ ] **Step 3: Write lifecycle and concurrency tests**

Cover pre-aborted signal, abort after protection/before provider call, provider throw, stream throw with an incomplete token, consumer early return, upstream `return()` failure, and two overlapping calls on one wrapped client. Assert:

```ts
await expect(preAbortedCall).rejects.toBe(abortReason)
expect(providerCreate).not.toHaveBeenCalled()
expect(incompleteOutput).not.toContain("PII")
expect(upstreamReturn).toHaveBeenCalledOnce()
await expect(primaryFailure).rejects.toBe(providerFailure)
await expect(successWithCleanupFailure).rejects.toBe(cleanupFailure)
expect(runAOutput).toBe("ana@acme.com")
expect(runBOutput).toBe("bob@example.net")
```

- [ ] **Step 4: Run focused tests and verify red**

Run: `bun --filter local-pii test -- openai.test.ts`

Expected: FAIL in streamed tool arguments and cancellation/cleanup assertions; current code restores only streamed text and has no explicit run-terminal policy.

- [ ] **Step 5: Extract immutable semantic traversal**

Move message protection and complete message restoration behind focused functions:

```ts
export async function protectOpenAIMessages(
  session: PiiSession,
  messages: readonly ChatMessage[]
): Promise<ChatMessage[]>

export function restoreOpenAIMessage(
  session: PiiSession,
  message: ChatMessage
): ChatMessage
```

Clone only changed paths. Parse JSON arguments for deep restoration when valid and fall back to text restoration when invalid. Never traverse schemas, metadata, identifiers, names, URLs, or arbitrary unknown keys.

- [ ] **Step 6: Implement run-local streaming restoration**

Use one state object per wrapped `create` call:

```ts
interface OpenAIStreamState {
  readonly text: Map<number, StreamingRehydrator>
  readonly tools: Map<string, StreamingRehydrator>
}

const toolChannel = (choiceIndex: number, toolIndex: number) =>
  `${choiceIndex}:${toolIndex}`
```

Push `delta.content` through the choice rehydrator. Push `delta.tool_calls[].function.arguments` through the tool channel, preserving every sibling field. Flush only after successful source completion; clear without flushing on abort, throw, or consumer return. In `finally`, call upstream `return()` when the source did not complete. Track the primary error so cleanup failure replaces only an otherwise successful outcome.

- [ ] **Step 7: Keep the public facade source-compatible**

Leave `createPiiChat`, `withPiiOpenAI`, `PiiChatOptions`, `ChatMessage`, and `ChatToolCall` public. Widen structural message/index signatures only where needed to preserve unknown control keys. Before and after protection call the request's `signal` when it is an `AbortSignal`, then invoke the original client method with the same model/options and protected messages.

- [ ] **Step 8: Verify OpenAI behavior**

Run: `bun --filter local-pii test -- openai.test.ts`

Expected: PASS for matrix, complete text/tool JSON, all split points, abort, early return, failure precedence, and overlap.

Run: `bun --filter local-pii typecheck && bun --filter local-pii build`

Expected: exit 0 with unchanged `local-pii/openai` import/require paths.

- [ ] **Step 9: Commit the OpenAI audit**

```bash
git add packages/local-pii/src/openai.ts packages/local-pii/src/openai-content.ts packages/local-pii/src/openai-stream.ts packages/local-pii/src/openai.test.ts
git commit -m "feat(local-pii): harden OpenAI semantic lifecycle"
```

---

### Task 4: Publish and enforce the AI SDK v4 field/lifecycle matrix

**Files:**

- Create: `packages/local-pii/src/ai-sdk-content.ts`
- Create: `packages/local-pii/src/ai-sdk-stream.ts`
- Modify: `packages/local-pii/src/ai-sdk.ts`
- Modify: `packages/local-pii/src/ai-sdk.test.ts`

- [ ] **Step 1: Write a typed AI SDK v4 prompt matrix test**

Build a fake `LanguageModelV4` and capture `LanguageModelV4CallOptions`. Assert protection of system strings, `text` parts, tool-call `input`, and textual/JSON tool-result output. Assert preservation of reasoning, file data/URLs, approval reasons, roles, tool schemas/examples, provider options, headers, response schema, and identifiers:

```ts
expect(findText(wire.prompt)).not.toContain("ana@acme.com")
expect(JSON.stringify(findToolInput(wire.prompt))).not.toContain("ana@acme.com")
expect(findFileUrl(wire.prompt)).toBe("https://files.test/ana@acme.com")
expect(findReasoning(wire.prompt)).toBe("ana@acme.com")
expect(wire.tools).toBe(originalOptions.tools)
expect(wire.providerOptions).toBe(originalOptions.providerOptions)
expect(originalOptions).toEqual(snapshot)
```

- [ ] **Step 2: Write complete and stream restoration tests**

For `doGenerate`, cover `text`, `tool-call.input`, and `tool-result.result`; preserve reasoning, sources, files, custom data, approval events, metadata, usage, and raw response. For `doStream`, cover interleaved `text-delta` channels and buffered `tool-input-delta` channels at every placeholder split. Emit a final restored tool-input delta immediately before `tool-input-end` only after valid complete JSON.

- [ ] **Step 3: Write cancellation, error, and cleanup tests**

Use a fake `ReadableStream` with observable `cancel`. Assert pre-aborted calls never reach the model, stream cancellation propagates, provider error parts discard incomplete tails, thrown stream errors preserve identity, successful close flushes safe tails, and concurrent calls do not share restoration buffers.

- [ ] **Step 4: Run focused tests and verify red**

Run: `bun --filter local-pii test -- ai-sdk.test.ts`

Expected: FAIL because the current adapter protects arbitrary `input`/`output` keys regardless of discriminant, omits streamed tool-input restoration, and flushes all tails without distinguishing an error part.

- [ ] **Step 5: Implement discriminant-specific AI SDK traversal**

Use the pinned v4 contract rather than `"input" in part`:

```ts
switch (part.type) {
  case "text":
    return { ...part, text: await protectText(session, part.text) }
  case "tool-call":
    return { ...part, input: await session.anonymizeJson(part.input) }
  case "tool-result":
    return { ...part, output: await protectToolOutput(session, part.output) }
  default:
    return part
}
```

Implement the symmetric result switch for `text`, `tool-call`, and `tool-result`. Keep reasoning, files, sources, custom/provider values, approvals, schemas, and control data untouched.

- [ ] **Step 6: Implement AI SDK stream terminal semantics**

Keep `Map<textId, StreamingRehydrator>` and `Map<toolInputId, string>` inside each `wrapStream` call. Normalize text deltas, buffer tool JSON until `tool-input-end`, and restore complete `tool-call`/`tool-result` chunks. On `{ type: "error" }`, `ReadableStream` error, abort, or cancel, discard all tails. On normal close, flush text tails and valid complete tool JSON. Rely on stream cancellation propagation and add an explicit transformer `cancel`/source wrapper if the test proves `pipeThrough` does not forward the original reason in the pinned runtime.

- [ ] **Step 7: Verify AI SDK behavior and build**

Run: `bun --filter local-pii test -- ai-sdk.test.ts`

Expected: PASS for the complete pinned matrix and all terminal paths.

Run: `bun --filter local-pii typecheck && bun --filter local-pii build`

Expected: exit 0 and the existing `local-pii/ai-sdk` ESM/CJS/declaration export remains loadable.

- [ ] **Step 8: Commit the AI SDK audit**

```bash
git add packages/local-pii/src/ai-sdk.ts packages/local-pii/src/ai-sdk-content.ts packages/local-pii/src/ai-sdk-stream.ts packages/local-pii/src/ai-sdk.test.ts
git commit -m "feat(local-pii): harden AI SDK semantic lifecycle"
```

---

### Task 5: Make TanStack semantic content fail closed

**Files:**

- Modify: `packages/local-pii/src/tanstack-content.ts`
- Modify: `packages/local-pii/src/tanstack.ts`
- Modify: `packages/local-pii/src/tanstack.test.ts`
- Modify: `packages/local-pii/src/tanstack.exports.test.ts`

- [ ] **Step 1: Encode the full pinned input matrix as tests**

Use UI and Model messages containing every known discriminant. Assert:

| Location                                                   | Expected behavior                          |
| ---------------------------------------------------------- | ------------------------------------------ |
| `content` string and `text.content`                        | protected                                  |
| complete `structured-output.raw`                           | parsed/deep protected, valid JSON retained |
| tool arguments/input/output/result/text error              | protected                                  |
| image/audio/video/document/thinking/ui-resource            | preserved unchanged                        |
| role/id/name/schema/metadata/source URL/reasoning/run data | preserved unchanged                        |
| unknown key on message or known part                       | preserved unchanged                        |

Freeze the original graph and assert exact non-mutation after `connect`.

- [ ] **Step 2: Write fail-closed unknown-discriminant tests**

Inject `{ type: "future-secret-part", content: "ana@acme.com" }` into both `parts` and array `content`. Assert rejection happens before `inner.connect`, the public error exposes only path/discriminant, and its message does not contain sibling content:

```ts
await expect(collect(wrapped.connect(messages))).rejects.toMatchObject({
  name: "UnsupportedTanStackSemanticContentError",
  path: [0, "parts", 1],
  discriminant: "future-secret-part",
})
expect(inner.connect).not.toHaveBeenCalled()
expect(String(caught)).not.toContain("ana@acme.com")
```

Also assert an unknown key on a known `text` part is preserved rather than rejected.

- [ ] **Step 3: Run focused tests and verify red**

Run: `bun --filter local-pii test -- tanstack.test.ts tanstack.exports.test.ts`

Expected: FAIL because unknown parts currently pass through and the public error does not exist.

- [ ] **Step 4: Implement the public structural error**

Define and export from `tanstack.ts`:

```ts
export class UnsupportedTanStackSemanticContentError extends Error {
  override readonly name = "UnsupportedTanStackSemanticContentError"

  constructor(
    readonly path: readonly (string | number)[],
    readonly discriminant: string
  ) {
    super(
      `Unsupported TanStack semantic content at ${formatPath(path)}: ${discriminant}`
    )
  }
}
```

The constructor receives only the structural path and the `type` string. Never attach the part object, original message, or `cause`.

- [ ] **Step 5: Implement exhaustive known-part traversal**

Thread `path` through `protectMessage`, `protectParts`, and `protectContentPart`. Handle `text`, `structured-output`, `tool-call`, and `tool-result` exactly as protected. Explicitly return `image`, `audio`, `video`, `document`, `thinking`, and `ui-resource` unchanged. Throw the exported error for every other discriminant before the inner connection is acquired. Preserve unknown sibling keys through object spread.

- [ ] **Step 6: Prove the export and declaration**

Extend the public subpath test:

```ts
expect(esm.UnsupportedTanStackSemanticContentError).toBeTypeOf("function")
expect(cjs.UnsupportedTanStackSemanticContentError).toBeTypeOf("function")
expect(declarations).toContain("UnsupportedTanStackSemanticContentError")
```

Run: `bun --filter local-pii test -- tanstack.test.ts tanstack.exports.test.ts`

Expected: PASS for the entire matrix, error privacy, ESM, CJS, and declarations.

- [ ] **Step 7: Commit TanStack semantic hardening**

```bash
git add packages/local-pii/src/tanstack-content.ts packages/local-pii/src/tanstack.ts packages/local-pii/src/tanstack.test.ts packages/local-pii/src/tanstack.exports.test.ts
git commit -m "feat(local-pii): fail closed on unknown TanStack content"
```

---

### Task 6: Prove TanStack restoration and ephemeral lifecycle boundaries

**Files:**

- Modify: `packages/local-pii/src/tanstack-stream.ts`
- Modify: `packages/local-pii/src/tanstack.ts`
- Modify: `packages/local-pii/src/tanstack.test.ts`

- [ ] **Step 1: Add symmetric stream-matrix tests**

Extend the existing AG-UI fake stream to cover complete structured JSON, tool arguments, parsed input/output/result, and textual tool errors. Interleave message and tool identifiers, then assert restored values and preserved control data:

```ts
expect(restoredTextByMessage.get("message-a")).toBe("ana@acme.com")
expect(JSON.parse(restoredArgsByTool.get("tool-b")!)).toEqual({
  email: "bob@example.net",
})
expect(toolEnd.input).toEqual({ email: "ana@acme.com" })
expect(toolEnd.output).toEqual({ owner: "bob@example.net" })
expect(toolEnd.id).toBe(originalToolEnd.id)
expect(toolEnd.metadata).toBe(originalToolEnd.metadata)
```

Add property coverage that partitions text placeholders and escaped JSON placeholders at every boundary.

- [ ] **Step 2: Add explicit hydration and live-session join tests**

Use sentinel snapshot objects and spies:

```ts
await expect(wrapped.hydrate?.("thread-1")).resolves.toBe(chatSnapshot)
await expect(wrapped.hydrateGeneration?.("thread-1")).resolves.toBe(
  generationSnapshot
)
expect(inner.hydrate).toHaveBeenCalledWith("thread-1")
expect(inner.hydrateGeneration).toHaveBeenCalledWith("thread-1")
```

Create a placeholder in the live session, emit it through `joinRun`, and assert restoration. Wrap the same inner connection with a new empty session and assert the old placeholder remains protected/unresolved; this is the executable boundary proving that reload/new-session resume is unsupported rather than falsely claimed safe.

- [ ] **Step 3: Complete the abnormal-terminal table**

For `connect` and `joinRun`, cover normal exhaustion, `RUN_FINISHED`, `RUN_ERROR`, thrown error, pre-abort, mid-stream abort, early iterator return, cleanup throw after success, and cleanup throw after a primary failure. Assert only normal completion flushes valid tails, and the original failure wins over cleanup failure.

- [ ] **Step 4: Run focused tests and verify red**

Run: `bun --filter local-pii test -- tanstack.test.ts`

Expected: at least `hydrateGeneration` pass-through and new-session join-boundary assertions fail or are absent from the current behavior coverage.

- [ ] **Step 5: Forward lifecycle methods without claiming snapshot protection**

Keep identity pass-through for hydration and restoration only around live streams:

```ts
if (inner.hydrate) wrapped.hydrate = (...args) => inner.hydrate!(...args)
if (inner.hydrateGeneration) {
  wrapped.hydrateGeneration = (...args) => inner.hydrateGeneration!(...args)
}
if (inner.joinRun) {
  wrapped.joinRun = (runId, signal) =>
    restoreTanStackStream(
      options.session,
      inner.joinRun!(runId, signal),
      signal
    )
}
```

Do not transform hydration snapshots, persist the private mapping, or synthesize resumability.

- [ ] **Step 6: Align stream terminal/error precedence**

Keep restoration maps local to each iterator. Track `primaryError`, `upstreamDone`, and normal terminal status. Discard maps on `RUN_ERROR`, abort, throw, or early return. In `finally`, await upstream `return()` if necessary; throw its error only when no primary error exists. Retain source-order flushing on successful bare exhaustion and before successful terminal events.

- [ ] **Step 7: Verify lifecycle and concurrency**

Run: `bun --filter local-pii test -- tanstack.test.ts`

Expected: PASS for field matrix, chunk fuzzing, hydrate/hydrateGeneration identity, same-live-session join, new-session limitation, two concurrent generation runs, and every terminal path.

Run: `bun --filter local-pii typecheck && bun --filter local-pii build`

Expected: exit 0 with the unchanged `piiConnection(inner, { session })` call form.

- [ ] **Step 8: Commit TanStack lifecycle guarantees**

```bash
git add packages/local-pii/src/tanstack.ts packages/local-pii/src/tanstack-stream.ts packages/local-pii/src/tanstack.test.ts
git commit -m "feat(local-pii): define TanStack ephemeral lifecycle"
```

---

### Task 7: Replace Prompt-global emulation with the docs-internal browser Generation seam

**Files:**

- Modify: `apps/docs/components/playground/model/types.ts`
- Create: `apps/docs/components/playground/model/protected-request.ts`
- Create: `apps/docs/components/playground/model/browser-generation-runtime.ts`
- Create: `apps/docs/components/playground/model/browser-generation-runtime.test.ts`
- Create: `apps/docs/components/playground/model/fake-runtime.ts`
- Create: `apps/docs/components/playground/model/chrome-runtime.ts`
- Create: `apps/docs/components/playground/model/chrome-runtime.test.ts`
- Modify: `apps/docs/components/playground/model/gemma-runtime.ts`
- Modify: `apps/docs/components/playground/model/gemma-runtime.test.ts`
- Create: `apps/docs/components/playground/model/vercel-model.ts`
- Create: `apps/docs/components/playground/model/vercel-model.test.ts`
- Modify: `apps/docs/components/playground/model/tanstack-connection.ts`
- Modify: `apps/docs/components/playground/model/tanstack-connection.test.ts`
- Delete: `apps/docs/components/playground/model/ephemeral-browser-ai.ts`
- Delete: `apps/docs/components/playground/model/ephemeral-browser-ai.test.ts`

- [ ] **Step 1: Re-read the installed Next.js guides before client/runtime edits**

Run:

```bash
NEXT_DOCS=$(find node_modules/.bun -path '*/node_modules/next/dist/docs' -type d | head -n 1)
sed -n '1,220p' "$NEXT_DOCS/01-app/01-getting-started/05-server-and-client-components.md"
cat "$NEXT_DOCS/01-app/02-guides/lazy-loading.md"
cat "$NEXT_DOCS/01-app/02-guides/static-exports.md"
cat "$NEXT_DOCS/01-app/03-api-reference/01-directives/use-client.md"
```

Expected: the installed 16.2.6 docs confirm browser APIs belong behind a hydrated Client Component/effect, external libraries can use dynamic `import()`, and `output: "export"` supports client-side execution but not server actions, request-dependent routes, or other server features.

- [ ] **Step 2: Write the runtime contract and protected-request guard tests**

Define the exact approved public-to-docs boundary in `types.ts`:

```ts
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

export interface BrowserGenerationRuntime {
  readonly id: string
  readonly disclosure: RuntimeDisclosure
  generate(input: {
    protectedHistory: readonly ProtectedBrowserTurn[]
    protectedContent: string
    signal?: AbortSignal
  }): AsyncIterable<string>
  dispose(): Promise<void>
}
```

Because a structural string cannot prove that it crossed a public adapter, keep a private `WeakSet<object>` in `protected-request.ts`. Only `createProtectedBrowserRequest(...)` marks a request; `assertProtectedBrowserRequest(...)` rejects a hand-built/unprotected object before a runtime factory/session is called. Validate roles while minting, allow at most one leading `system` turn, and never expose this guard from `local-pii`.

- [ ] **Step 3: Write the shared iterator lifecycle tests**

Against the deterministic fake, cover abort before acquisition, abort after acquisition, upstream throw, consumer `return()`, normal completion, cleanup throw, and `dispose()` while active. Assert one acquire/release per generation and that `dispose()` resolves only after active iterators settle.

- [ ] **Step 4: Write direct Vercel and TanStack adapter tests**

For Vercel, invoke the v4 model through `withPii(createBrowserLanguageModel(fake), { session })`. Assert the fake receives protected history/current turn exactly once, source messages are not mutated, streamed content restores, cancellation calls iterator `return`, and this invariant holds around every call:

```ts
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "LanguageModel")
await consumeModelStream()
expect(Object.getOwnPropertyDescriptor(globalThis, "LanguageModel")).toEqual(
  descriptor
)
```

For TanStack, wrap `createBrowserConnection(fake)` with `piiConnection`; assert the same protected request shape and AG-UI lifecycle.

- [ ] **Step 5: Run runtime/adapter tests and verify red**

Run: `bun --filter docs test -- browser-generation-runtime.test.ts chrome-runtime.test.ts gemma-runtime.test.ts vercel-model.test.ts tanstack-connection.test.ts`

Expected: FAIL because the common runtime and direct Vercel model do not exist and the fallback still depends on temporary `globalThis.LanguageModel` installation.

- [ ] **Step 6: Implement the shared generation iterator helper**

Provide one internal wrapper used by native, Gemma, and fake adapters:

```ts
export function managedGeneration(
  open: () => Promise<AsyncIterator<string>>,
  signal?: AbortSignal,
  onSettled?: () => Promise<void> | void
): AsyncIterable<string>
```

Its generator checks abort before/after `open`, forwards every `next`, flushes nothing of its own, calls iterator `return(signal.reason)` on abort/early return/error, awaits `onSettled`, and preserves a primary generation error over cleanup. Track active settlement promises so runtime `dispose()` waits and then releases only reusable resources.

- [ ] **Step 7: Implement Chrome and Gemma adapters**

`createChromeBrowserRuntime(factory)` maps protected history to `initialPrompts`, creates one Prompt API session per generation, calls `promptStreaming` for the current protected turn, and destroys that session on every terminal path. Browser-managed disclosure contains no explicit artifact origins.

Refactor Gemma to `createGemmaBrowserRuntime()`: lazy-import Transformers.js only after explicit controller activation, cache the q4f16 generator across runs, format supplied protected history/current turn directly with `apply_chat_template`, create one interrupt criterion per run, and interrupt it on abort/return. Its disclosure is:

```ts
artifacts: {
  kind: "explicit-download",
  approximateBytes: 293_284_073,
  origins: ["https://huggingface.co", "https://*.cdn.hf.co"],
}
```

Keep `onnx-community/gemma-3-270m-it-ONNX` pinned to revision `2dbbfdb1b59bd034eb959428c6a7da9dd7ea27f0`, WebGPU, `q4f16`, deterministic sampling, and 512 output tokens. Validate its one-leading-system and alternating user/assistant template rules before model acquisition. The byte estimate covers the six files resolved by Transformers.js 4.2.0 at that revision; Hugging Face may redirect large artifacts to regional `*.cdn.hf.co` hosts. Do not call Gemma or Gemini a Detection model. See `docs/research/2026-08-11-browser-generation-primary-sources.md` for the primary-source evidence.

- [ ] **Step 8: Implement the direct AI SDK v4 model**

`createBrowserLanguageModel(runtime)` accepts only system/user/assistant text from the already-transformed v4 prompt. Reject files, tools, reasoning, and unsupported roles before calling runtime generation. Split prior turns from the final non-empty user turn, mint a protected request, and map output to `text-start`, `text-delta`, `text-end`, and `finish` stream parts. `doGenerate` collects the same iterator. Its stream `cancel(reason)` calls upstream `return(reason)` and awaits model-session cleanup.

- [ ] **Step 9: Convert the TanStack connection to the same seam**

Replace Prompt API factories with `BrowserGenerationRuntime`. Preserve validation before acquisition, translate protected prior messages/current turn into `createProtectedBrowserRequest`, and keep AG-UI run/message IDs. In `finally`, return the generation iterator; do not own runtime disposal or privacy state.

- [ ] **Step 10: Remove global mutation and verify both adapters**

Delete `ephemeral-browser-ai.ts` and its mutation/lock tests only after the direct-model tests are green.

Run: `bun --filter docs test -- browser-generation-runtime.test.ts chrome-runtime.test.ts gemma-runtime.test.ts vercel-model.test.ts tanstack-connection.test.ts`

Expected: PASS; grep finds no write/delete/define of the Prompt global:

```bash
rg 'defineProperty\(.*LanguageModel|deleteProperty\(.*LanguageModel|LanguageModel\s*=' apps/docs/components/playground
```

Expected: no matches. Read-only Chrome discovery (`window.LanguageModel`) remains allowed.

- [ ] **Step 11: Commit the internal browser seam**

```bash
git add apps/docs/components/playground/model
git commit -m "refactor(docs): add direct browser generation runtime"
```

---

### Task 8: Implement explicit browser-runtime state and recovery

**Files:**

- Modify: `apps/docs/components/playground/model/types.ts`
- Create: `apps/docs/components/playground/model/runtime-controller.ts`
- Create: `apps/docs/components/playground/model/runtime-controller.test.ts`
- Delete: `apps/docs/components/playground/model/prompt-runtime.ts`
- Delete: `apps/docs/components/playground/model/prompt-runtime.test.ts`
- Modify: `apps/docs/components/playground/runtime-provider.tsx`
- Modify: `apps/docs/components/playground.tsx`

- [ ] **Step 1: Write the exact state-machine types**

Replace shallow optional state with the approved discriminated union:

```ts
export type RuntimeKind = "gemini-nano" | "gemma-3-270m"
export type RuntimeRecovery =
  "check-again" | "retry-activation" | "choose-runtime"

export type RuntimeSnapshot =
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
```

Expose `check`, `activate(kind, signal?)`, `getSnapshot`, `getRuntime`, `subscribe`, and `dispose` on the docs-internal controller.

- [ ] **Step 2: Write transition tests before implementation**

Cover these exact traces:

```text
checking -> ready(native already available)
checking -> choice-required(native requires activation + Gemma choice)
checking -> choice-required(native unavailable + Gemma choice)
choice-required -> activating -> ready
choice-required -> activating -> error -> activating -> ready
error -> checking -> choice-required
```

Assert `check()` calls coalesce, inspection never calls fallback `load`, a second activation throws `RuntimeActivationBusyError`, and activation never silently switches kind.

- [ ] **Step 3: Write stale-operation, progress, abort, and disposal tests**

Control deferred promises. Complete an old check/activation after a newer `operationId` and assert no stale publication. Send monotonic progress and assert it belongs only to the current activation. Abort activation and assert the abort reason remains observable with recovery choices. Assert replacing/disposal waits for runtime active iterators.

- [ ] **Step 4: Run controller tests and verify red**

Run: `bun --filter docs test -- runtime-controller.test.ts`

Expected: FAIL because the current shallow controller exposes separate activation methods, queues no explicit busy error, and has no operation identity.

- [ ] **Step 5: Implement coalesced discovery and explicit activation**

Maintain `nextOperationId`, `currentCheck`, `currentActivation`, and a single snapshot. `check()` reuses `currentCheck`, inspects native availability and cache metadata only, and never imports Transformers.js. If Chrome says `available`, construct its reusable runtime wrapper without acquiring a model session and publish `ready`; otherwise publish all choices with `ready`, `requires-activation`, or `unavailable` availability.

`activate(kind)` accepts only `choice-required` or recoverable `error`. Publish `activating` with disclosure before any download. Compare operation identity before every progress/success/error publication. Preserve the selected kind on failure and expose only valid recovery actions.

- [ ] **Step 6: Update the provider and accessible choice UI**

Keep `RuntimeProvider` as a narrow Client Component using `useSyncExternalStore`; call `check()` from `useEffect`, consistent with the installed Next static-export guide. Expose one `activate(kind)` action. Render every option with its model/source/artifact disclosure, an explicit activation button, `Progress`, `Alert`, and recovery buttons. Use `aria-live="polite"`; disable activation while active. Do not auto-download or auto-fallback.

- [ ] **Step 7: Verify state and static-client boundaries**

Run: `bun --filter docs test -- runtime-controller.test.ts`

Expected: PASS for all traces, stale completions, busy activation, progress, retry, and no-load check.

Run: `bun --filter docs typecheck`

Expected: exit 0 with no browser global accessed during module evaluation outside Client Component/runtime call paths.

- [ ] **Step 8: Commit explicit runtime control**

```bash
git add apps/docs/components/playground/model/types.ts apps/docs/components/playground/model/runtime-controller.ts apps/docs/components/playground/model/runtime-controller.test.ts apps/docs/components/playground/runtime-provider.tsx apps/docs/components/playground.tsx
git rm apps/docs/components/playground/model/prompt-runtime.ts apps/docs/components/playground/model/prompt-runtime.test.ts
git commit -m "feat(docs): model explicit browser runtime activation"
```

---

### Task 9: Add run-scoped observation and a non-queuing cross-chat gate

**Files:**

- Create: `apps/docs/components/playground/protection-observer.ts`
- Create: `apps/docs/components/playground/protection-observer.test.ts`
- Create: `apps/docs/components/playground/generation-gate.ts`
- Create: `apps/docs/components/playground/generation-gate.test.ts`
- Modify: `apps/docs/components/playground/privacy-inspector.tsx`

- [ ] **Step 1: Write observed-session tests**

Wrap a real `PiiSession`, begin `run-a`, and protect text plus nested JSON through the wrapper. Commit the exact request at the runtime seam. Assert entity counts aggregate, protected history/current content match the committed request byte-for-byte, the base mapping remains authoritative, and no second inspection anonymization occurs.

Begin `run-b` before a late `run-a` record/commit and assert the late operation is ignored. Assert failure/cancel before the seam calls `discard()` and publishes no inspection.

- [ ] **Step 2: Define inspection and observation contracts**

Use the spec vocabulary:

```ts
export interface PrivacyInspection {
  readonly generationRunId: string
  readonly counts: Readonly<Record<string, number>>
  readonly protectedHistory: readonly ProtectedBrowserTurn[]
  readonly protectedContent: string
}

export interface ProtectionObservation {
  record(path: readonly (string | number)[], result: AnonymizeResult): void
  commit(request: ProtectedBrowserRequest): PrivacyInspection | undefined
  discard(): void
}
```

Expose a docs-internal `createProtectionObserver(session, publish)` that provides an observed `PiiSession` and `begin(generationRunId)`. Implement observed `anonymizeJson` through the observed `anonymize` function so nested semantic leaves are attributed, instead of delegating to the base session's invisible JSON traversal.

- [ ] **Step 3: Write gate race and cleanup tests**

Acquire for `vercel`, race `tanstack`, and assert immediate `PlaygroundBusyError` rather than a queued promise. Abort/return the first runtime iterator and keep the gate busy until its deferred cleanup settles. Then prove TanStack can acquire. Also prove histories and sessions are absent from the gate object.

- [ ] **Step 4: Run focused tests and verify red**

Run: `bun --filter docs test -- protection-observer.test.ts generation-gate.test.ts`

Expected: FAIL because neither shared primitive exists and current chats perform an extra `session.anonymize(text)` inspection pass.

- [ ] **Step 5: Implement observation as delegation, not a second pass**

The observed session delegates `rehydrate`, mapping, and clear directly. Each `anonymize` calls the base once, records only into the currently active run, and returns the original result. `commit` derives counts from recorded entities and freezes a normalized copy of the exact protected request. `discard` erases only run-local observation, never the privacy mapping.

- [ ] **Step 6: Implement the gate and runtime decorator**

Define:

```ts
export class PlaygroundBusyError extends Error {
  override readonly name = "PlaygroundBusyError"
}

export interface GenerationLease {
  readonly owner: "vercel" | "tanstack"
  release(): void
}
```

`tryAcquire(owner)` either returns a lease synchronously or throws. `withPlaygroundGate(runtime, gate, owner)` acquires lazily when generation starts and releases in the outermost iterator `finally`, after upstream `return()` and session cleanup complete. Add `subscribe/getSnapshot` so force-mounted chat controls disable before the usual race, while preserving the exception as the race-safe backstop.

- [ ] **Step 7: Render committed inspection only**

Update `PrivacyInspector` to show generation-run identity, aggregated counts, protected prior turns, and current protected content. Preserve shadcn `Card`/`Badge`, keyboard-scrolling behavior, and readable empty state. Never render private mapping or user content from observation internals.

- [ ] **Step 8: Verify and commit shared conversation primitives**

Run: `bun --filter docs test -- protection-observer.test.ts generation-gate.test.ts`

Expected: PASS for exact-pass inspection, late-run suppression, discard, racing acquisition, and cleanup-delayed release.

```bash
git add apps/docs/components/playground/protection-observer.ts apps/docs/components/playground/protection-observer.test.ts apps/docs/components/playground/generation-gate.ts apps/docs/components/playground/generation-gate.test.ts apps/docs/components/playground/privacy-inspector.tsx
git commit -m "feat(docs): observe and arbitrate protected runs"
```

---

### Task 10: Apply strict private-conversation lifecycle to the Vercel chat

**Files:**

- Create: `apps/docs/components/playground/private-conversation.ts`
- Create: `apps/docs/components/playground/private-conversation.test.ts`
- Modify: `apps/docs/components/playground/runtime-provider.tsx`
- Modify: `apps/docs/components/playground/chat-shell.tsx`
- Modify: `apps/docs/components/playground/vercel-chat.tsx`
- Modify: `apps/docs/components/playground/vercel-chat.test.tsx`
- Delete: `apps/docs/components/playground/model/normalize-chat-transport-abort.ts`
- Delete: `apps/docs/components/playground/model/normalize-chat-transport-abort.test.ts`
- Modify: `apps/docs/components/playground/model/settle-chat-stop.ts`
- Modify: `apps/docs/components/playground/model/settle-chat-stop.test.ts`

- [ ] **Step 1: Write the framework-neutral ordering tests**

Use deferred promises and an event log to assert this exact reset sequence:

```ts
expect(events).toEqual([
  "block-submissions",
  "abort-active-run",
  "stop-framework",
  "run-settled",
  "runtime-cleanup-settled",
  "clear-framework-history",
  "clear-framework-error",
  "clear-old-session",
  "clear-inspection",
  "create-new-session",
  "enable-submissions",
])
```

Assert user abort returns ready with no error, while a non-abort stop/cleanup error is returned for display. Begin run B while a delayed run-A callback exists and prove `isCurrent("run-a")` is false.

- [ ] **Step 2: Define the small shared lifecycle module**

Keep framework differences as callbacks:

```ts
export interface PrivateConversationReset {
  blockSubmissions(blocked: boolean): void
  abortActiveRun(): void
  stopFramework(): Promise<Error | undefined>
  awaitRunSettlement(): Promise<void>
  awaitRuntimeCleanup(): Promise<void>
  clearFramework(): void
  clearFrameworkError(): void
  clearOldSession(): void
  clearInspection(): void
  createNewSession(): void
}

export async function resetPrivateConversation(
  actions: PrivateConversationReset
): Promise<Error | undefined>
```

Add a `GenerationRunRegistry` that allocates monotonic opaque IDs, stores only the active run's settlement promise, ignores late completion by identity, and exposes `begin`, `settle`, `abort`, `isCurrent`, and `waitForActive`. It owns no mapping/history/runtime.

- [ ] **Step 3: Write Vercel component tests for the real adapter pass**

Render with the deterministic `BrowserGenerationRuntime`; do not inject a pre-protected model that bypasses `withPii`. Submit `Email ana@acme.com`, assert the runtime request and inspector show the same protected string, visible assistant output is restored, and the private mapping remains conversation-local.

Add deferred-stream tests for stop and new conversation. Assert history/session/inspection are not cleared before upstream iterator cleanup resolves, then are cleared and a new session is used. Assert a late old delta cannot reappear. Spy on the Prompt global descriptor to retain the no-mutation proof at component level.

- [ ] **Step 4: Run focused tests and verify red**

Run: `bun --filter docs test -- private-conversation.test.ts vercel-chat.test.tsx settle-chat-stop.test.ts`

Expected: FAIL because current `onNewChat` starts stop without awaiting it, immediately clears the old session, and inspection comes from a duplicate anonymization pass.

- [ ] **Step 5: Provide the gate through the hydrated provider**

Create one `GenerationGate` beside the runtime controller in `RuntimeProvider`; expose its snapshot and instance through context. The runtime remains reusable across private conversations, while the gate owns only an active lease. Dispose the controller/runtime in the provider effect cleanup after active generation settles.

- [ ] **Step 6: Compose Vercel generation in the required order**

For the current privacy session, create an observer and then compose:

```ts
const model = withPii(
  createBrowserLanguageModel(
    observeBrowserRuntime(withPlaygroundGate(runtime, gate, "vercel"), observer)
  ),
  { session: observer.session }
)
```

Begin a generation-run observation immediately before `sendMessage`; attach its promise to the run registry. If the run never commits at the browser seam, discard its observation. Do not invoke `session.anonymize` from `onSubmit`.

- [ ] **Step 7: Make stop and reset awaitable in the shared shell**

Change `ChatShellProps.onStop` and `onNewChat` to return `Promise<void>`. Disable composer/new-conversation controls while submitted, streaming, stopping, resetting, or another chat owns the gate. Preserve the AI Elements `PromptInputSubmit` behavior by adapting its synchronous callback with `void onStop()`, while the chat retains the actual settlement promise.

Normalize only expected `AbortError`/known Stop cancellation in `settleChatStop`; return every other error. Remove `normalize-chat-transport-abort` if the direct model's cancellation now preserves the AI SDK's expected contract and its replacement tests prove that behavior.

- [ ] **Step 8: Verify Vercel lifecycle**

Run: `bun --filter docs test -- private-conversation.test.ts vercel-chat.test.tsx settle-chat-stop.test.ts generation-gate.test.ts protection-observer.test.ts`

Expected: PASS for exact-pass observation, restored output, stop, reset ordering, late-run suppression, gate disabling, and cleanup error visibility.

- [ ] **Step 9: Commit the Vercel private conversation**

```bash
git add apps/docs/components/playground/private-conversation.ts apps/docs/components/playground/private-conversation.test.ts apps/docs/components/playground/runtime-provider.tsx apps/docs/components/playground/chat-shell.tsx apps/docs/components/playground/vercel-chat.tsx apps/docs/components/playground/vercel-chat.test.tsx apps/docs/components/playground/model/settle-chat-stop.ts apps/docs/components/playground/model/settle-chat-stop.test.ts
git rm apps/docs/components/playground/model/normalize-chat-transport-abort.ts apps/docs/components/playground/model/normalize-chat-transport-abort.test.ts
git commit -m "feat(docs): isolate Vercel private conversations"
```

---

### Task 11: Apply the same lifecycle to TanStack and prove cross-chat isolation

**Files:**

- Modify: `apps/docs/components/playground/tanstack-chat.tsx`
- Modify: `apps/docs/components/playground/tanstack-chat.test.tsx`
- Modify: `apps/docs/components/playground.tsx`
- Create: `apps/docs/components/playground/playground.test.tsx`

- [ ] **Step 1: Write TanStack real-adapter and reset tests**

Render with the deterministic browser runtime and allow `TanStackChat` itself to construct `piiConnection`. Submit a message with email/phone, assert the runtime sees only protected history/current content, inspection matches that request exactly, and visible content restores. Freeze the chat input objects to retain non-mutation coverage through the component.

Defer stream cleanup. Click Stop and New conversation and assert the same strict event order from Task 10. Prove a new `PiiSession` replaces the old one only after cleanup and that late AG-UI events from the previous run are ignored.

- [ ] **Step 2: Write a force-mounted cross-chat race test**

Render `Playground` with one fake runtime whose Vercel iterator remains open. Start Vercel generation, switch tabs, assert TanStack submit controls are disabled, then trigger the race backstop directly and expect `PlaygroundBusyError`. Confirm both visible histories and both mappings remain independent. Release Vercel cleanup, assert TanStack becomes enabled, and complete a TanStack generation.

- [ ] **Step 3: Run component tests and verify red**

Run: `bun --filter docs test -- tanstack-chat.test.tsx playground.test.tsx`

Expected: FAIL because current TanStack reset calls `stop`, `clear`, and `session.clear` synchronously and no cross-chat gate is wired into both force-mounted tabs.

- [ ] **Step 4: Compose TanStack over observer and gate**

For each current privacy session, construct:

```ts
const connection = piiConnection(
  createBrowserConnection(
    observeBrowserRuntime(
      withPlaygroundGate(runtime, gate, "tanstack"),
      observer
    )
  ),
  { session: observer.session }
)
```

Begin/settle/discard observation around `sendMessage`, use the shared run registry, and adapt TanStack's stop/clear functions to `resetPrivateConversation`. Do not enable TanStack persistence, hydration, or reload resume in the playground.

- [ ] **Step 5: Wire shared gate state into both tabs**

Keep both `TabsContent` nodes force-mounted, pass the current gate owner/busy state into both chats, and disable only new generation/reset actions that would violate cleanup ordering. Stop remains available to the owning chat. Never merge message arrays, sessions, observers, or run registries.

- [ ] **Step 6: Verify both functional chats**

Run: `bun --filter docs test -- tanstack-chat.test.tsx vercel-chat.test.tsx playground.test.tsx`

Expected: PASS; both chats use genuine public adapters, independent sessions/history/inspection, one shared runtime/gate, and no extra protection pass.

Run: `bun --filter docs typecheck`

Expected: exit 0 with pinned TanStack and AI SDK client contracts.

- [ ] **Step 7: Commit the complete playground lifecycle**

```bash
git add apps/docs/components/playground/tanstack-chat.tsx apps/docs/components/playground/tanstack-chat.test.tsx apps/docs/components/playground.tsx apps/docs/components/playground/playground.test.tsx
git commit -m "feat(docs): isolate and coordinate browser chats"
```

---

### Task 12: Document the canonical flow, pinned matrices, and limitations

**Files:**

- Modify: `README.md`
- Modify: `packages/local-pii/README.md`
- Modify: `apps/docs/content/docs/index.mdx`
- Modify: `apps/docs/content/docs/index.pt.mdx`
- Modify: `apps/docs/content/docs/index.de.mdx`
- Modify: `apps/docs/content/docs/adapters.mdx`
- Modify: `apps/docs/content/docs/adapters.pt.mdx`
- Modify: `apps/docs/content/docs/adapters.de.mdx`
- Modify: `apps/docs/content/docs/browser.mdx`
- Modify: `apps/docs/content/docs/browser.pt.mdx`
- Modify: `apps/docs/content/docs/browser.de.mdx`
- Modify: `apps/docs/content/docs/expo.mdx`
- Modify: `apps/docs/content/docs/expo.pt.mdx`
- Modify: `apps/docs/content/docs/expo.de.mdx`
- Modify: `apps/docs/content/docs/concepts.mdx`
- Modify: `apps/docs/content/docs/concepts.pt.mdx`
- Modify: `apps/docs/content/docs/concepts.de.mdx`
- Modify: `apps/docs/content/docs/security.mdx`
- Modify: `apps/docs/content/docs/security.pt.mdx`
- Modify: `apps/docs/content/docs/security.de.mdx`
- Modify: `apps/docs/content/docs/limitations.mdx`
- Modify: `apps/docs/content/docs/limitations.pt.mdx`
- Modify: `apps/docs/content/docs/limitations.de.mdx`
- Modify: `apps/docs/content/docs/playground.mdx`
- Modify: `apps/docs/content/docs/playground.pt.mdx`
- Modify: `apps/docs/content/docs/playground.de.mdx`

- [ ] **Step 1: Write the canonical cross-platform example first**

Use the same four-stage vocabulary in package and localized primary docs:

```ts
import { createAnonymizer, token } from "local-pii"
import { rampartWeb } from "local-pii/web"
import { runInlineText } from "local-pii/inline"

const privacy = createAnonymizer({
  detection: rampartWeb(),
  placeholders: token(),
})
const conversation = privacy.createSession()

const answer = await runInlineText({
  session: conversation,
  input: "Email ana@acme.com",
  call: (protectedContent, { signal }) =>
    generationModel.generate(protectedContent, { signal }),
})
```

Explain: Detection adapter -> `createAnonymizer` -> one privacy session per private conversation -> native Generation adapter/inline -> caller-selected Generation model. State that Rampart Q4 is a Detection model; Gemini Nano, Gemma, and provider models are Generation models.

- [ ] **Step 2: Publish all three adapter matrices**

In each localized adapters page, add tables for OpenAI, AI SDK, and TanStack with four rows/categories: protected semantic values, restored semantic values, known preserved control/opaque values, and unsupported variants/error behavior. Use only behavior proven in Tasks 3-6. Explain that preserved fields containing personal information remain caller responsibility and that generic inline/caller Detection models are trusted caller code.

- [ ] **Step 3: Document session and lifecycle ownership**

State that explicit sessions are recommended for multi-turn use; OpenAI/AI SDK implicit sessions remain compatible; TanStack requires a caller session; supplied sessions are borrowed and never cleared. Document inline resolution priority and cleanup. Document TanStack hydration pass-through, same-live-session `joinRun`, and unsupported persistence/full reload/cross-tab/new-session restoration. Include the `UnsupportedTanStackSemanticContentError` 0.1.0 migration note.

- [ ] **Step 4: Correct Detection-model and Metro documentation**

Migrate canonical Expo/browser examples from `ner:` to `detection:` while explicitly showing legacy `ner` as supported compatibility syntax. Replace stale `withExpoPiiMetro` with the real `withLocalPiiMetro`. Preserve strict/degraded behavior, lazy Rampart loading, local-only original content, and separate artifact-download disclosure.

- [ ] **Step 5: Document the backend-free playground precisely**

State that both chats use public adapters and browser-local Generation inference with no Gateway, route, server action, key, or inference endpoint. Explain explicit Chrome/Gemma selection, Gemma q4f16 approximate size/origins/license, no automatic downloads/switching, one private conversation per tab, cross-chat busy behavior, stop/new ordering, and the inspector's actual model-facing request. Do not describe the docs-internal runtime as a `local-pii` public API.

- [ ] **Step 6: Run documentation consistency tests**

Run: `bun --filter docs test -- localized-links.test.ts`

Expected: PASS for English, Portuguese, and German internal links.

Run:

```bash
rg 'withExpoPiiMetro|Rampart.*(generation|Generation model|local LLM)' README.md packages/local-pii/README.md apps/docs/content/docs
```

Expected: no matches.

Run:

```bash
for locale in '' '.pt' '.de'; do
  test -f "apps/docs/content/docs/adapters${locale}.mdx"
  test -f "apps/docs/content/docs/playground${locale}.mdx"
done
```

Expected: exit 0.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md packages/local-pii/README.md apps/docs/content/docs
git commit -m "docs: explain adapter-first privacy flow"
```

---

### Task 13: Automate the import/build, static-export, accessibility, and network matrix

**Files:**

- Create: `packages/local-pii/test/import-matrix/core.ts`
- Create: `packages/local-pii/test/import-matrix/inline.ts`
- Create: `packages/local-pii/test/import-matrix/openai.ts`
- Create: `packages/local-pii/test/import-matrix/ai-sdk.ts`
- Create: `packages/local-pii/test/import-matrix/tanstack.ts`
- Create: `packages/local-pii/test/import-matrix/expo.ts`
- Create: `packages/local-pii/test/import-matrix/web.ts`
- Create: `packages/local-pii/test/import-matrix/metro.cts`
- Create: `packages/local-pii/test/import-matrix/tsconfig.node.json`
- Create: `packages/local-pii/test/import-matrix/tsconfig.bundler.json`
- Create: `packages/local-pii/scripts/verify-import-matrix.mjs`
- Modify: `packages/local-pii/package.json`
- Modify: `packages/local-pii/rslib.config.ts`
- Modify: `packages/local-pii/src/inline.exports.test.ts`
- Modify: `packages/local-pii/src/tanstack.exports.test.ts`
- Modify: `apps/example/App.tsx`
- Modify: `apps/docs/package.json`
- Create: `apps/docs/playwright.config.ts`
- Create: `apps/docs/e2e/playground.spec.ts`
- Modify: `bun.lock`

- [ ] **Step 1: Write declaration-only consumers for every subpath**

Each fixture imports and minimally calls its advertised API. Include legacy/new Detection configuration and session ownership:

```ts
import {
  createAnonymizer,
  type DetectionModel,
  type NerBackend,
} from "local-pii"

declare const model: DetectionModel
const legacy: NerBackend = model
createAnonymizer({ detection: model }).createSession()
createAnonymizer({ ner: legacy }).createSession()
```

The inline fixture uses both `{ anonymizer }` and `{ session }`; OpenAI and AI SDK fixtures use explicit and implicit options; TanStack imports the error and connection; Expo/web/Metro fixtures import only their platform subpaths. Compile NodeNext and Bundler resolution separately with `noEmit`, `strict`, and `skipLibCheck: false` for the fixture graph.

- [ ] **Step 2: Write the runtime/bundle isolation verifier**

After `rslib build`, the Node script must:

1. load every advertised `import` target;
2. load every advertised `require` target;
3. bundle core, inline, OpenAI, AI SDK, TanStack, and web fixtures for browser;
4. bundle core, inline, OpenAI, AI SDK, TanStack, and Metro fixtures for Node;
5. inspect esbuild metafiles and reject `expo-*`, `react-native`, or `onnxruntime-react-native` from core/browser bundles;
6. reject `onnxruntime-web` from core/Expo inputs;
7. assert declaration files exist for every subpath.

Use `esbuild` programmatically with `write: false`, `bundle: true`, and optional peers external only where the matrix permits them. Exit non-zero with the subpath and forbidden module in the error.

- [ ] **Step 3: Add package scripts and release metadata**

Set `packages/local-pii/package.json` version to `0.1.0`; do not change root/app private versions. Add exact development `esbuild` and scripts:

```json
{
  "scripts": {
    "test:matrix": "bun run build && node scripts/verify-import-matrix.mjs && tsc -p test/import-matrix/tsconfig.node.json && tsc -p test/import-matrix/tsconfig.bundler.json"
  }
}
```

Run `bun install` and commit the lockfile only with this task.

- [ ] **Step 4: Prove the Expo/Metro consumer separately**

Update `apps/example/App.tsx` to use `detection: rampart(...)`; leave a declaration fixture on legacy `ner`. Preserve `apps/example/metro.config.js` with `withLocalPiiMetro`. Run:

```bash
EXPO_MATRIX_DIR=$(mktemp -d /tmp/local-pii-expo-matrix.XXXXXX)
bun --cwd apps/example x expo export --platform android --output-dir "$EXPO_MATRIX_DIR"
```

Expected: Expo export succeeds, the bundle resolves `local-pii/expo` and the `.onnx` asset, and no `onnxruntime-web` module appears in the export log/metafile. After inspection, delete only the directory printed in `$EXPO_MATRIX_DIR`.

- [ ] **Step 5: Run the package matrix and verify red/green deliberately**

Before implementing the verifier, run: `bun --filter local-pii test:matrix`

Expected: FAIL because the script/fixtures do not exist.

After implementation, run: `bun --filter local-pii test:matrix`

Expected: PASS for every required subpath, ESM/CJS, browser/Node bundle, and declaration consumer.

- [ ] **Step 6: Add static-output Playwright configuration**

Add exact dev dependencies `@playwright/test` and `http-server`, plus:

```json
{
  "scripts": {
    "test:e2e": "playwright test"
  }
}
```

Configure `webServer.command` as `bun run build && bunx http-server out -p 4173 -c-1`, `baseURL` as `http://127.0.0.1:4173`, one Chromium worker, and trace on first retry. The static server serves only `apps/docs/out`; add no API route.

- [ ] **Step 7: Implement fake-native browser injection and request interception**

In `playground.spec.ts`, use `page.addInitScript` to install a deterministic browser-managed `window.LanguageModel` whose availability is `available`, whose `promptStreaming` echoes its protected input in split chunks, and whose `destroy` is observable. Capture every request and allow only:

```ts
const sameOrigin = new URL(page.url()).origin
const allowedArtifactOrigin = (url: URL) =>
  url.origin === "https://huggingface.co" ||
  (url.protocol === "https:" && url.hostname.endsWith(".cdn.hf.co"))
```

External requests must be `GET` and match `sameOrigin` or the disclosed Hugging Face artifact/CDN family; fail on `/api`, server-action headers, POST/PUT/PATCH/DELETE, or any undisclosed origin. In the injected native path, expect no external request at all.

- [ ] **Step 8: Exercise both chats, keyboard, and status UI in the static build**

Navigate to `/en/docs/playground`, wait for browser runtime ready, submit PII through Vercel, and assert visible restored text plus protected inspector content. Switch to TanStack and repeat. Use keyboard Tab/Enter to reach tabs/composer/stop/new conversation, assert live status text, and assert no console hydration/accessibility errors. Visit `/pt/docs/playground` and `/de/docs/playground` and assert localized headings render.

- [ ] **Step 9: Run complete automated verification**

Run:

```bash
bun --filter local-pii test
bun --filter local-pii test:matrix
bun --filter docs test
bun --filter docs typecheck
bun --filter docs build
bun --filter docs test:e2e
bun run lint
bun run typecheck
```

Expected: local-pii remains at least the fresh 140-test baseline plus new tests, docs remains at least the fresh 60-test baseline plus new tests, every command exits 0, `apps/docs/out` exists, and Playwright records no inference/backend request.

- [ ] **Step 10: Commit matrix and browser verification**

```bash
git add packages/local-pii/test packages/local-pii/scripts packages/local-pii/package.json packages/local-pii/rslib.config.ts packages/local-pii/src/inline.exports.test.ts packages/local-pii/src/tanstack.exports.test.ts apps/example/App.tsx apps/docs/package.json apps/docs/playwright.config.ts apps/docs/e2e/playground.spec.ts bun.lock
git commit -m "test: verify adapter platform matrix"
```

---

### Task 14: Review against the spec and collect real-browser evidence

**Files:**

- Create: `docs/verification/2026-08-11-adapter-first-privacy.md`
- Modify: only files required by confirmed review findings

- [ ] **Step 1: Run the `code-review` skill from the feature base**

Review all changes since `1b0609a` with emphasis on semantic leaks, private mapping/session ownership, cleanup/error precedence, unknown TanStack parts, stale runtime operations, cross-chat races, global mutation, package export isolation, and static-only Next constraints. Record severity, exact file/line, and evidence. Fix every high/medium finding with a new failing regression test before implementation.

- [ ] **Step 2: Re-run focused tests for each review fix**

For every changed module, run its exact Vitest file first. Expected: the new regression fails before the fix and passes after it. Commit review fixes by concern, for example:

```bash
git add packages/local-pii/src/tanstack-stream.ts packages/local-pii/src/tanstack.test.ts
git commit -m "fix(local-pii): preserve primary TanStack stream errors"
```

Do not combine unrelated review fixes in one commit.

- [ ] **Step 3: Perform installed Chrome/Gemini Nano smoke**

Serve the fresh static export, open the English playground in installed Google Chrome, and verify capability discovery causes no artifact request. If Gemini Nano is `available`, run both framework chats, Stop, and New conversation; inspect DevTools Network for no inference request, restored visible text, protected inspector content, and model-session cleanup. If the browser reports unavailable, record the exact Chrome version/status rather than claiming native success.

- [ ] **Step 4: Perform explicit Gemma fallback smoke**

Choose Gemma explicitly, confirm the ~426 MB disclosure before activation, and inspect that only disclosed Hugging Face artifact GETs occur. After activation, run both chats, Stop, New conversation, and a cached second activation. Confirm no prompt/mapping appears in request URLs, bodies, console, storage, or inference endpoint. Record hardware/browser, artifact origins, cache behavior, and any unavailable WebGPU limitation.

- [ ] **Step 5: Write an evidence-only verification record**

Create `docs/verification/2026-08-11-adapter-first-privacy.md` with:

```markdown
# Adapter-first privacy verification — 2026-08-11

## Automated commands

| Command | Result | Test/build count or artifact |
| ------- | ------ | ---------------------------- |

## Browser matrix

| Runtime | Browser/device | Activation | Vercel | TanStack | Network | Cleanup |
| ------- | -------------- | ---------- | ------ | -------- | ------- | ------- |

## Remaining environmental uncertainty
```

Enter only observed outputs. An unavailable native model or WebGPU is an environmental limitation, not permission to fabricate a pass; the fake-runtime automated proof remains distinct from real-runtime evidence.

- [ ] **Step 6: Run `verification-before-completion` from a clean feature worktree**

Run fresh, not from cached prose:

```bash
git status --short
bun run test
bun run typecheck
bun run lint
bun run build
bun --filter local-pii test:matrix
bun --filter docs test:e2e
git diff --check 1b0609a..HEAD
```

Expected: only the intended verification record is uncommitted before its commit; all commands exit 0; no whitespace errors.

- [ ] **Step 7: Recheck every prohibited architecture outcome**

Run:

```bash
rg 'createPrivacy|privacy\.attach|/api/|"use server"|globalThis\.LanguageModel\s*=|defineProperty\(.*LanguageModel' packages/local-pii/src apps/docs/components apps/docs/app
find apps/docs/app -type d -name api -print
```

Expected: neither command reports an implementation of a second façade, backend endpoint, server action, or Prompt-global mutation. Review the dependency manifests separately to confirm no Gateway package was added; user-facing prose saying “no Gateway” remains valid.

Run:

```bash
rg 'Rampart.*(Generation model|local LLM)|Gemma.*Detection model|Gemini.*Detection model' README.md packages/local-pii/README.md apps/docs/content CONTEXT.md
```

Expected: no vocabulary inversions.

- [ ] **Step 8: Commit verification evidence**

```bash
git add docs/verification/2026-08-11-adapter-first-privacy.md
git commit -m "docs: record adapter privacy verification"
```

- [ ] **Step 9: Hand off for branch completion**

Use the `finishing-a-development-branch` skill. Present the verified feature branch and exact commit range. Because the user already requested merge to `main`, merge only after the final SOL review reports no high/medium findings and the fresh verification commands above pass on the merge result; preserve the user's unrelated untracked `.agents/`, `.claude/`, and `skills-lock.json` files.

---

## Self-review

- Spec coverage: Task 1 covers `DetectionModel`/`detection`, compatibility, `false`, `undefined`, synchronous conflict, and unchanged strict/degraded lifecycle. Task 2 covers inline anonymizer precedence and temporary/borrowed cleanup. Tasks 3-4 cover OpenAI and AI SDK pinned semantic matrices plus complete/JSON/tool/stream/abort/early-return/error/concurrency behavior. Tasks 5-6 cover TanStack's fail-closed error, complete matrix, hydration pass-through, same-live-session join, unsupported resumability, and lifecycle. Tasks 7-8 remove Prompt-global mutation and implement the private browser seam, small Generation models, explicit activation/state/recovery, lazy artifacts, and cleanup. Tasks 9-11 cover exact-pass inspection, run identity, private conversations, strict reset ordering, and cross-chat arbitration. Tasks 12-14 cover localized docs, 0.1.0 migration, imports/builds, static output, accessibility, network interception, real-browser evidence, review, verification, and merge handoff.
- Architecture exclusions: no Task adds a Gateway, route, server action, remote Detection fallback, `createPrivacy`, public browser runtime, universal Generation interface, model registry, automatic download, runtime queue, silent fallback, persistence, or private mapping storage. Rampart is Detection-only; Gemini Nano/Gemma are docs-owned Generation runtimes.
- Placeholder scan: every behavioral change has a named test, a red command, a concrete contract/algorithm, a green command, and an exact commit scope; no deferred implementation markers or generic error-handling instructions remain.
- Type consistency: `DetectionModel` remains an alias of `NerBackend`; `AnonymizerOptions.detection` and `.ner` share one resolver; `InlineSessionOptions.anonymizer` never overrides a supplied session; `PiiSession` remains the sole privacy-session type; `piiConnection` keeps its call form; `BrowserGenerationRuntime` never owns a privacy session; runtime state uses `RuntimeKind`; observation is keyed by generation-run ID; the gate owns only a lease.
- Field consistency: OpenAI, AI SDK, and TanStack each own a separate pinned semantic matrix. Protected/restored values are symmetric, preserved fields remain caller responsibility, unknown TanStack semantic discriminants reject before `connect`, and other protocols do not inherit that TanStack-only policy.
- Lifecycle consistency: every streaming adapter uses run-local buffers; normal success may flush; failure, abort, error event, and early return discard; upstream cleanup is awaited; a primary generation error wins over cleanup; library adapters retain concurrent runs while only the playground has a non-queuing expensive-generation gate.
- Next.js consistency: Task 7 mandates reading the installed 16.2.6 guides before edits. Browser APIs stay behind Client Components/call paths, Transformers.js is dynamically imported only after explicit activation, and the only deployment output is static `out` with no backend feature.
- Verification strength: baseline evidence is 140 `local-pii` tests plus 60 docs tests passing before feature work. The plan requires focused red/green cycles, full suites, declarations, ESM/CJS loads, browser/Node/Expo isolation, static build, Playwright request interception, accessibility/keyboard smoke, SOL review, and distinct real Chrome/Gemma evidence.
