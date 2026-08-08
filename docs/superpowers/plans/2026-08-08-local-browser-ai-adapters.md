# Local Browser AI Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship framework-neutral inline and TanStack AI PII adapters plus a real, static, browser-only Fumadocs playground with Vercel AI SDK and TanStack AI chats powered by Gemini Nano or an opt-in Gemma 3 270M fallback.

**Architecture:** `local-pii/inline` owns protect-call-restore ordering for complete, JSON, and streamed in-process calls. `local-pii/tanstack` wraps any client `ConnectConnectionAdapter`, protects only semantic message content, and restores AG-UI output with per-run buffers. The static docs app owns a narrow `LanguageModel` runtime boundary: native Chrome Prompt API first, then a user-activated Transformers.js runtime configured for Gemma 3 270M; Vercel and TanStack examples consume that boundary independently.

**Tech Stack:** TypeScript 5, Vitest 3, fast-check, Rslib, Bun workspaces, Next.js 16 static export, React 19, Vercel AI SDK 7, TanStack AI, Chrome Prompt API, `@browser-ai/core`, `@huggingface/transformers`, ONNX, shadcn/ui, AI Elements, Testing Library.

---

## File map

### Library

- `packages/local-pii/src/inline.ts`: public inline options, session ownership, complete text, JSON, generic execution, and streamed text helpers.
- `packages/local-pii/src/inline.test.ts`: black-box inline behavior, cleanup, error, abort, non-mutation, and streaming boundary coverage.
- `packages/local-pii/src/tanstack-content.ts`: immutable semantic-field protection for TanStack model/UI messages.
- `packages/local-pii/src/tanstack-stream.ts`: immutable AG-UI chunk restoration with per-message and per-tool buffers.
- `packages/local-pii/src/tanstack.ts`: public `piiConnection` wrapper and TanStack lifecycle forwarding.
- `packages/local-pii/src/tanstack.test.ts`: black-box fake-connection coverage for text, tools, abort, early return, and concurrency.
- `packages/local-pii/package.json`: public subpath exports and optional TanStack peer metadata.
- `packages/local-pii/rslib.config.ts`: Rslib entry points for inline and TanStack adapters.

### Browser playground

- `apps/docs/components/playground/model/types.ts`: playground-owned `LanguageModel` factory and runtime status types.
- `apps/docs/components/playground/model/prompt-runtime.ts`: native capability detection, explicit native session creation, and opt-in Gemma activation.
- `apps/docs/components/playground/model/gemma-runtime.ts`: direct Transformers.js Prompt-compatible runtime with real generation cancellation.
- `apps/docs/components/playground/model/ephemeral-browser-ai.ts`: one Browser AI provider session per Vercel generation.
- `apps/docs/components/playground/model/prompt-runtime.test.ts`: fake-global state-machine tests.
- `apps/docs/components/playground/model/tanstack-connection.ts`: direct Prompt API to AG-UI connection adapter.
- `apps/docs/components/playground/model/tanstack-connection.test.ts`: lifecycle, history, streaming, abort, and session-destroy tests.
- `apps/docs/components/playground/runtime-provider.tsx`: hydrated runtime controller shared by the two tab views.
- `apps/docs/components/playground/chat-shell.tsx`: shared accessible AI Elements/shadcn presentation.
- `apps/docs/components/playground/privacy-inspector.tsx`: runtime identity, local status, PII counts, and protected model-facing prompt.
- `apps/docs/components/playground/vercel-chat.tsx`: Vercel `useChat` with `DirectChatTransport`, `ToolLoopAgent`, browser provider, and existing `withPii` middleware.
- `apps/docs/components/playground/tanstack-chat.tsx`: TanStack `useChat` with direct Prompt connection and `piiConnection`.
- `apps/docs/components/playground.tsx`: small tabbed orchestrator replacing the current echo demonstration.
- `apps/docs/components/ai-elements/conversation.tsx`: registry-owned conversation/scroller primitives.
- `apps/docs/components/ai-elements/message.tsx`: registry-owned message and response primitives.
- `apps/docs/components/ai-elements/prompt-input.tsx`: registry-owned composer primitives.
- `apps/docs/components/ui/alert.tsx`: shadcn capability and error alerts.
- `apps/docs/components/ui/progress.tsx`: shadcn model download progress.
- `apps/docs/components/ui/tabs.tsx`: shadcn Vercel/TanStack switcher.
- `apps/docs/vitest.config.ts`: jsdom and path-alias test configuration.
- `apps/docs/test/setup.ts`: DOM matchers and test cleanup.
- `apps/docs/package.json`: pinned browser AI, TanStack, AI SDK React, Prompt API type, and test dependencies.
- `apps/docs/content/docs/playground.mdx`: English runtime and privacy explanation.
- `apps/docs/content/docs/playground.pt.mdx`: Portuguese runtime and privacy explanation.
- `apps/docs/content/docs/playground.de.mdx`: German runtime and privacy explanation.
- `apps/docs/content/docs/adapters.mdx`: English inline and TanStack usage.
- `apps/docs/content/docs/adapters.pt.mdx`: Portuguese inline and TanStack usage.
- `apps/docs/content/docs/adapters.de.mdx`: German inline and TanStack usage.
- `bun.lock`: resolved dependency graph.

### Workflow artifacts

- `docs/specs/2026-08-08-local-browser-ai-adapters.md`: approved product and architecture specification.
- `docs/superpowers/plans/2026-08-08-local-browser-ai-adapters.md`: this executable plan.
- `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`, and `AGENTS.md`: already-approved Matt Pocock workflow setup; preserve them.

---

### Task 1: Complete and JSON inline execution

**Files:**
- Create: `packages/local-pii/src/inline.ts`
- Create: `packages/local-pii/src/inline.test.ts`
- Modify: `packages/local-pii/package.json`
- Modify: `packages/local-pii/rslib.config.ts`

- [x] **Step 1: Write failing public-behavior tests**

Add tests that import `runInline`, `runInlineJson`, and `runInlineText` from `./inline`. Capture callback inputs and assert that `ana@acme.com` is absent from model-facing text/JSON while the returned value contains it again. Use a supplied session in one test and an internally created anonymizer in another. The core assertions are:

```ts
const wire: string[] = []
const output = await runInlineText({
  input: "Email ana@acme.com",
  call: async (protectedText) => {
    wire.push(protectedText)
    return `Confirmed ${protectedText}`
  },
})

expect(wire[0]).not.toContain("ana@acme.com")
expect(output).toContain("ana@acme.com")
```

Add JSON coverage with nested arrays, object keys, empty strings, numbers, and a quoted PII value. Freeze the input and assert that it remains unchanged.

- [x] **Step 2: Run the inline tests and verify the red state**

Run: `bun --filter local-pii test -- inline.test.ts`

Expected: FAIL because `./inline` does not exist.

- [x] **Step 3: Implement session resolution and the generic executor**

Define the public types and generic executor in `inline.ts`:

```ts
export interface InlineContext {
  readonly signal?: AbortSignal
}

export interface InlineTransformContext extends InlineContext {
  readonly session: PiiSession
}

export interface RunInlineOptions<Input, Protected, Output, Restored> {
  input: Input
  session?: PiiSession
  signal?: AbortSignal
  protect: (input: Input, context: InlineTransformContext) => Promise<Protected>
  call: (input: Protected, context: InlineContext) => Promise<Output>
  restore: (output: Output, context: InlineTransformContext) => Promise<Restored> | Restored
}
```

`runInline` must prefer the supplied session, otherwise create an anonymizer with opaque `token()` placeholders, create a session, check `signal.throwIfAborted()` before and after protection, run the callback with a context that cannot expose the session vault, restore the result, and clear only the internally owned session in `finally`.

- [x] **Step 4: Implement complete text and JSON helpers**

`runInlineText` uses `session.anonymize(input).redactedText` and `session.rehydrate(output, { lenient: true })`. `runInlineJson` uses `session.anonymizeJson(input)` and casts the pure `session.rehydrateJson(output, { lenient: true })` result back to the declared output type. Both helpers delegate lifecycle to `runInline` rather than duplicating ownership logic.

- [x] **Step 5: Export the inline subpath**

Add an `inline` source entry to Rslib and an `./inline` package export with ESM, CJS, and declaration targets matching the existing `./ai-sdk` shape.

- [x] **Step 6: Run focused and package checks**

Run: `bun --filter local-pii test -- inline.test.ts`

Expected: PASS.

Run: `bun --filter local-pii typecheck`

Expected: exit 0.

Run: `bun --filter local-pii build`

Expected: `dist/inline.js`, `dist/inline.cjs`, and `dist/inline.d.ts` exist.

- [x] **Step 7: Commit the inline complete-call API**

```bash
git add packages/local-pii/src/inline.ts packages/local-pii/src/inline.test.ts packages/local-pii/package.json packages/local-pii/rslib.config.ts
git commit -m "feat(local-pii): add inline execution adapter"
```

---

### Task 2: Streaming and cancellation for inline execution

**Files:**
- Modify: `packages/local-pii/src/inline.ts`
- Modify: `packages/local-pii/src/inline.test.ts`

- [x] **Step 1: Write failing split-token and early-return tests**

Create a session, anonymize a known email to obtain its opaque token, and make the callback yield that token at every possible split point. Concatenate `runInlineTextStream` output and assert the exact restored response. Add a generator with a `finally` flag, consume one item, call `iterator.return()`, and assert upstream cleanup ran.

- [x] **Step 2: Write failing abort and error-tail tests**

Abort during iteration and assert the same abort reason reaches the consumer. Make a stream throw after yielding a prefix of a placeholder and assert that no incomplete placeholder tail is emitted after the failure.

- [x] **Step 3: Run the streaming tests and verify the red state**

Run: `bun --filter local-pii test -- inline.test.ts -t "stream"`

Expected: FAIL because `runInlineTextStream` is not exported.

- [x] **Step 4: Implement the lazy streaming helper**

Return an `AsyncIterable<string>` whose iterator creates or borrows the session only when iteration begins, protects the input, invokes the upstream iterable, and pushes every chunk through `createStreamingRehydrator(() => session.mapping)`. Flush only after normal upstream completion. The iterator `finally` block calls upstream `return()` when present and clears only an owned session.

Use this public shape:

```ts
export interface RunInlineTextStreamOptions {
  input: string
  session?: PiiSession
  signal?: AbortSignal
  call: (input: string, context: InlineContext) => AsyncIterable<string>
}

export function runInlineTextStream(
  options: RunInlineTextStreamOptions,
): AsyncIterable<string>
```

- [x] **Step 5: Add property coverage for chunk partitions**

Use `fast-check` to generate non-empty arrays of chunk lengths, partition a response containing two placeholders, and assert that the concatenated stream always equals the complete rehydrated response.

- [x] **Step 6: Run focused and full library tests**

Run: `bun --filter local-pii test -- inline.test.ts`

Expected: PASS.

Run: `bun --filter local-pii test`

Expected: all existing and inline test files pass.

- [x] **Step 7: Commit streaming support**

```bash
git add packages/local-pii/src/inline.ts packages/local-pii/src/inline.test.ts
git commit -m "feat(local-pii): stream inline responses safely"
```

---

### Task 3: TanStack AI text connection adapter

**Files:**
- Create: `packages/local-pii/src/tanstack-content.ts`
- Create: `packages/local-pii/src/tanstack-stream.ts`
- Create: `packages/local-pii/src/tanstack.ts`
- Create: `packages/local-pii/src/tanstack.test.ts`
- Modify: `packages/local-pii/package.json`
- Modify: `packages/local-pii/rslib.config.ts`
- Modify: `bun.lock`

- [x] **Step 1: Pin the supported TanStack contracts**

Add `@tanstack/ai-client@0.23.1` and `@tanstack/ai@0.43.1` as exact development dependencies and exact optional peers of `local-pii`.

Run: `bun install`

Expected: the two exact versions are recorded in `bun.lock`.

- [x] **Step 2: Write failing message-protection tests**

Wrap a fake `ConnectConnectionAdapter` that records `messages`, `data`, `signal`, and `runContext`. Pass both `UIMessage` parts and `ModelMessage` content. Assert that email/phone strings are protected while role, IDs, dates, metadata, file URLs, `data`, and `runContext` remain deeply equal. Freeze the source messages to prove immutability.

- [x] **Step 3: Write failing text-stream restoration tests**

Have the fake connection yield `RUN_STARTED`, `TEXT_MESSAGE_START`, a placeholder split over several `TEXT_MESSAGE_CONTENT` chunks, `TEXT_MESSAGE_END`, and `RUN_FINISHED`. Assert event order and identity are preserved while concatenated deltas contain the restored email.

- [x] **Step 4: Run focused tests and verify the red state**

Run: `bun --filter local-pii test -- tanstack.test.ts`

Expected: FAIL because `piiConnection` does not exist.

- [x] **Step 5: Implement immutable semantic message protection**

In `tanstack-content.ts`, clone only the branches being changed. Protect:

- string `ModelMessage.content`;
- text `ContentPart.text` values;
- `UIMessage` parts with `type: "text"` through `content`;

Tool-call and tool-result protection is deliberately added together with tool-stream restoration in Task 4, so the text-first milestone cannot create an asymmetric adapter that protects values without restoring them before client execution.

Preserve every other property verbatim. Export one internal `protectTanStackMessages(session, messages)` function.

- [x] **Step 6: Implement per-message text restoration**

In `tanstack-stream.ts`, create a transformer local to one `connect()` call. Allocate a streaming rehydrator per `messageId`. On `TEXT_MESSAGE_CONTENT`, normalize a cumulative-only provider `content` value into the corresponding protected incremental delta, rehydrate that delta, and omit the optional cumulative field from the emitted chunk so TanStack cannot bypass a buffered empty delta by consuming protected content. On `TEXT_MESSAGE_END`, emit a final delta before the end event when the rehydrator has a tail. Flush normally before `RUN_FINISHED`; discard tails on `RUN_ERROR`, thrown errors, and abort.

- [x] **Step 7: Implement the public connection wrapper**

Expose:

```ts
export interface PiiConnectionOptions {
  session: PiiSession
}

export function piiConnection<T extends ConnectConnectionAdapter>(
  inner: T,
  options: PiiConnectionOptions,
): ConnectConnectionAdapter
```

Forward `hydrate` and `joinRun` when present. Implement `connect` with `Parameters<T["connect"]>`-compatible arguments, protect messages, call the inner connection with unchanged `data`, `AbortSignal`, and `runContext`, then yield restored chunks. Do not clear the supplied session.

- [x] **Step 8: Export and build the TanStack subpath**

Add a `tanstack` Rslib source entry and `./tanstack` package export. Build and verify the generated declaration references the pinned TanStack public types rather than private paths.

- [x] **Step 9: Run library validation**

Run: `bun --filter local-pii test -- tanstack.test.ts`

Expected: PASS.

Run: `bun --filter local-pii typecheck`

Expected: exit 0.

Run: `bun --filter local-pii build`

Expected: TanStack ESM, CJS, and declaration artifacts exist.

- [x] **Step 10: Commit the text-first TanStack adapter**

```bash
git add packages/local-pii/src/tanstack-content.ts packages/local-pii/src/tanstack-stream.ts packages/local-pii/src/tanstack.ts packages/local-pii/src/tanstack.test.ts packages/local-pii/package.json packages/local-pii/rslib.config.ts bun.lock
git commit -m "feat(local-pii): add TanStack AI connection adapter"
```

---

### Task 4: TanStack tools, lifecycle, and concurrency hardening

**Files:**
- Modify: `packages/local-pii/src/tanstack-content.ts`
- Modify: `packages/local-pii/src/tanstack-stream.ts`
- Modify: `packages/local-pii/src/tanstack.test.ts`

- [x] **Step 1: Write failing tool protocol tests**

Stream two interleaved tool calls with distinct `toolCallId` values. Split each `TOOL_CALL_ARGS.delta` across placeholder boundaries, finish them with `TOOL_CALL_END`, and emit `TOOL_CALL_RESULT`. Assert restored inputs/results and unchanged tool names, IDs, metadata, schemas, and event discriminants.

- [x] **Step 2: Write failing overlap tests**

Start two `connect()` calls against the same wrapped connection and shared session. Interleave two message IDs and two tool-call IDs. Assert that no output from run A appears in run B and that the inner connection received stable placeholders for values reused across conversation turns.

- [x] **Step 3: Write failing abnormal-termination tests**

Cover `RUN_ERROR`, an exception, abort, and iterable completion without a terminal event. Assert that normal bare completion may flush valid text, while error/abort paths never emit an incomplete token. Assert that breaking the consumer loop triggers the inner iterator's `return()`.

- [x] **Step 4: Run the new tests and verify they fail**

Run: `bun --filter local-pii test -- tanstack.test.ts -t "tool|concurrent|abort|terminal"`

Expected: at least the tool and overlap cases fail.

- [x] **Step 5: Add symmetric outbound protection and per-tool streaming restoration**

Extend message protection for `tool-call.arguments`, parsed `tool-call.input`, `tool-call.output`, `tool-result.content`, and `ModelMessage.toolCalls`. In the same milestone, maintain a `Map<toolCallId, StreamingRehydrator>` local to the transformer. Restore `TOOL_CALL_ARGS.delta`, then deep-restore `TOOL_CALL_END.input`, `.output`, and parsed textual `.result`. Restore `TOOL_CALL_RESULT.content` without changing message or tool identifiers.

- [x] **Step 6: Finalize termination semantics**

Track whether the run ended normally. Flush complete text/tool tails before successful terminal events and on normal iterable exhaustion. On abort, `RUN_ERROR`, or exception, clear maps without flushing. Keep all maps inside the generator invocation.

- [x] **Step 7: Run full adapter and package validation**

Run: `bun --filter local-pii test -- tanstack.test.ts`

Expected: PASS.

Run: `bun --filter local-pii test`

Expected: all package tests pass, including overlapping runs.

- [x] **Step 8: Commit protocol hardening**

```bash
git add packages/local-pii/src/tanstack-content.ts packages/local-pii/src/tanstack-stream.ts packages/local-pii/src/tanstack.test.ts
git commit -m "feat(local-pii): protect TanStack tool streams"
```

---

### Task 5: Browser Prompt runtime and Gemma fallback

**Files:**
- Create: `apps/docs/components/playground/model/types.ts`
- Create: `apps/docs/components/playground/model/prompt-runtime.ts`
- Create: `apps/docs/components/playground/model/prompt-runtime.test.ts`
- Create: `apps/docs/vitest.config.ts`
- Create: `apps/docs/test/setup.ts`
- Modify: `apps/docs/package.json`
- Modify: `bun.lock`

- [x] **Step 1: Pin browser runtime and test dependencies**

Add exact runtime dependencies `ai@7.0.57`, `@ai-sdk/react@4.0.61`, `@browser-ai/core@3.0.0`, `@huggingface/transformers@4.2.0`, `@tanstack/ai@0.43.1`, `@tanstack/ai-client@0.23.1`, and `@tanstack/ai-react@0.19.1`. Add exact development dependencies `@types/dom-chromium-ai@0.0.17`, `vitest@3.2.7`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, and `@testing-library/jest-dom` at the versions resolved by Bun.

Run: `bun install`

Expected: installation succeeds without changing the existing Next 16 or React 19 versions.

- [x] **Step 2: Add the docs test harness**

Configure Vitest with jsdom, the `@` alias pointing at `apps/docs`, and `test/setup.ts`. The setup imports `@testing-library/jest-dom/vitest` and runs Testing Library cleanup after each test. Add `test` and `typecheck` scripts to the docs package.

- [x] **Step 3: Define the runtime boundary**

Use this playground-owned contract:

```ts
export type LocalRuntimeKind = "gemini-nano" | "gemma-3-270m"
export type LocalRuntimeStatus =
  | "checking"
  | "native-ready"
  | "fallback-available"
  | "downloading"
  | "ready"
  | "error"

export interface BrowserModelRuntime {
  kind: LocalRuntimeKind
  create(options?: LanguageModelCreateOptions): Promise<LanguageModel>
}
```

Expose a factory dependency so tests can inject a fake global rather than patching implementation modules.

- [x] **Step 4: Write failing state-machine tests**

Test native unavailable, downloadable, downloading, available, explicit fallback activation, progress updates, activation failure, and retry. Assert that importing the module or checking capability never imports Transformers.js and never starts a model download.

- [x] **Step 5: Run runtime tests and verify the red state**

Run: `bun --filter docs test -- prompt-runtime.test.ts`

Expected: FAIL because the runtime controller does not exist.

- [x] **Step 6: Implement native capability detection**

Call `LanguageModel.availability()` only after hydration. Pass the same text `expectedInputs` and `expectedOutputs` options later used by `create()`. Map browser availability into the documented UI states and retain the browser's own download monitor for explicit native activation.

- [x] **Step 7: Implement explicit Gemma activation**

Only from the activation method, assign:

```ts
window.TRANSFORMERS_CONFIG = {
  apiKey: "dummy",
  device: "webgpu",
  dtype: "q4f16",
  modelName: "onnx-community/gemma-3-270m-it-ONNX",
}
```

Dynamically import the playground-owned Gemma runtime and Transformers.js, then create a session with a download monitor. Use `InterruptableStoppingCriteria` so abort stops generation. Report source, quantization, and approximate 426 MB artifact size through runtime metadata. Do not define any cloud provider configuration.

- [x] **Step 8: Run runtime and static checks**

Run: `bun --filter docs test -- prompt-runtime.test.ts`

Expected: PASS.

Run: `bun --filter docs typecheck`

Expected: exit 0 with Prompt API globals typed.

- [x] **Step 9: Commit the runtime boundary**

```bash
git add apps/docs/components/playground/model/types.ts apps/docs/components/playground/model/prompt-runtime.ts apps/docs/components/playground/model/prompt-runtime.test.ts apps/docs/vitest.config.ts apps/docs/test/setup.ts apps/docs/package.json bun.lock
git commit -m "feat(docs): add local browser model runtime"
```

---

### Task 6: Direct TanStack Prompt API connection

**Files:**
- Create: `apps/docs/components/playground/model/tanstack-connection.ts`
- Create: `apps/docs/components/playground/model/tanstack-connection.test.ts`

- [x] **Step 1: Write failing AG-UI lifecycle tests**

Inject a fake runtime whose session records `initialPrompts`, prompt text, signal, and `destroy()`. Supply a multi-turn TanStack history and assert the connection yields, in order, `RUN_STARTED`, `TEXT_MESSAGE_START`, streamed `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, and `RUN_FINISHED` with the `threadId` and `runId` from `runContext`.

- [x] **Step 2: Write failing history and cleanup tests**

Assert that all messages except the latest user message become Prompt API `initialPrompts`, the latest user text is sent once to `promptStreaming`, abort is forwarded, and `destroy()` runs on success, error, and abort.

- [x] **Step 3: Run the tests and verify the red state**

Run: `bun --filter docs test -- tanstack-connection.test.ts`

Expected: FAIL because `createPromptConnection` does not exist.

- [x] **Step 4: Implement message flattening**

Convert only textual UI/Model message content into Prompt API history. Preserve user/assistant roles as `user`/`assistant`, skip unsupported non-text parts with a typed error, and require the final message to be a non-empty user prompt.

- [x] **Step 5: Implement the connection generator**

Create one Prompt API session per `connect()` call to avoid duplicating TanStack history inside a stateful browser session. Generate stable fallback IDs when `runContext` is absent, stream deltas as AG-UI events, and destroy the session in `finally`. On a thrown model error, emit `RUN_ERROR` only when the stream has already started; otherwise rethrow so the TanStack client owns error synthesis.

- [x] **Step 6: Run focused checks**

Run: `bun --filter docs test -- tanstack-connection.test.ts`

Expected: PASS.

Run: `bun --filter docs typecheck`

Expected: exit 0.

- [x] **Step 7: Commit the direct connection**

```bash
git add apps/docs/components/playground/model/tanstack-connection.ts apps/docs/components/playground/model/tanstack-connection.test.ts
git commit -m "feat(docs): connect TanStack AI to Prompt API"
```

---

### Task 7: shadcn/AI Elements shell and Vercel AI SDK chat

**Files:**
- Create: `apps/docs/components/ai-elements/conversation.tsx`
- Create: `apps/docs/components/ai-elements/message.tsx`
- Create: `apps/docs/components/ai-elements/prompt-input.tsx`
- Create: `apps/docs/components/ui/alert.tsx`
- Create: `apps/docs/components/ui/progress.tsx`
- Create: `apps/docs/components/ui/tabs.tsx`
- Create: `apps/docs/components/playground/runtime-provider.tsx`
- Create: `apps/docs/components/playground/chat-shell.tsx`
- Create: `apps/docs/components/playground/privacy-inspector.tsx`
- Create: `apps/docs/components/playground/vercel-chat.tsx`
- Create: `apps/docs/components/playground/vercel-chat.test.tsx`

- [x] **Step 1: Install registry-owned components**

From `apps/docs`, run the installed shadcn CLI to add `alert`, `progress`, and `tabs`, then add the AI Elements `conversation`, `message`, and `prompt-input` components from the official registry. Inspect generated imports and keep the existing new-york style and path aliases.

- [x] **Step 2: Write the failing Vercel end-to-end component test**

Render the chat with a fake browser model. Enter `Email ana@acme.com`, submit, and assert the fake model-facing prompt contains an opaque token but not the email. Stream a response containing that token and assert the rendered AI Elements message contains the restored email. Add stop and new-chat assertions.

- [x] **Step 3: Run the component test and verify the red state**

Run: `bun --filter docs test -- vercel-chat.test.tsx`

Expected: FAIL because the Vercel chat and shell do not exist.

- [x] **Step 4: Implement the runtime provider**

Own capability detection and activation in one context provider. Expose runtime status, metadata, progress, error, `activateNative`, `activateFallback`, and a runtime factory. Ensure no browser global is touched during server rendering.

- [x] **Step 5: Implement the shared chat shell**

Compose registry-owned `Conversation`, `Message`, `MessageResponse`, and `PromptInput` with shadcn status, alert, button, progress, and tabs primitives. Expose framework-neutral props for messages, submission, loading, stop, new chat, and privacy inspector data. Use live regions for download/error/generation state and labels for icon-only controls.

- [x] **Step 6: Implement the privacy inspector**

Display runtime name, “on device” status, protected prompt, and PII type counts sourced from the active `PiiSession.mapping`/anonymization result. Keep inspector state in memory, clear it with new chat, and never call logging or persistence APIs with original content.

- [x] **Step 7: Implement the Vercel AI SDK pipeline**

Create one `PiiSession` per mounted Vercel chat. Build `browserAI("text")`, wrap it with `withPii(model, { session })`, construct a text-only `ToolLoopAgent`, and give `useChat` a `DirectChatTransport({ agent })`. Recreate the transport only when the runtime changes. Call `stop()` on user request and clear both `useChat` messages and the session for new chat.

- [x] **Step 8: Run component and accessibility checks**

Run: `bun --filter docs test -- vercel-chat.test.tsx`

Expected: PASS.

Run: `bun --filter docs typecheck`

Expected: exit 0.

- [x] **Step 9: Commit the shared shell and Vercel chat**

```bash
git add apps/docs/components/ai-elements apps/docs/components/ui/alert.tsx apps/docs/components/ui/progress.tsx apps/docs/components/ui/tabs.tsx apps/docs/components/playground/runtime-provider.tsx apps/docs/components/playground/chat-shell.tsx apps/docs/components/playground/privacy-inspector.tsx apps/docs/components/playground/vercel-chat.tsx apps/docs/components/playground/vercel-chat.test.tsx
git commit -m "feat(docs): add browser-only Vercel AI chat"
```

---

### Task 8: TanStack chat tab and playground orchestration

**Files:**
- Create: `apps/docs/components/playground/tanstack-chat.tsx`
- Create: `apps/docs/components/playground/tanstack-chat.test.tsx`
- Modify: `apps/docs/components/playground.tsx`

- [x] **Step 1: Write the failing TanStack component test**

Render the TanStack tab with the fake Prompt runtime. Submit a PII-bearing message and assert the fake session sees only placeholders, while the rendered response restores the original value. Assert stop aborts, new chat clears messages and the PII session, and switching tabs does not share histories.

- [x] **Step 2: Run the component test and verify the red state**

Run: `bun --filter docs test -- tanstack-chat.test.tsx`

Expected: FAIL because the component does not exist.

- [x] **Step 3: Implement the TanStack chat pipeline**

Create one `PiiSession` per mounted TanStack chat. Compose `createPromptConnection(runtime)` with `piiConnection(inner, { session })`, pass it to TanStack `useChat`, map textual message parts into the shared shell, and wire `sendMessage`, `stop`, `clear`, and session cleanup.

- [x] **Step 4: Replace the current echo playground**

Make the root `Playground` a client-side orchestrator containing the runtime status/activation area and shadcn tabs for Vercel AI SDK and TanStack AI. Mount both chats through the shared runtime provider, retain independent state, and remove the handwritten echo bubbles and old Rampart toggle from this component.

- [x] **Step 5: Run both chat tests and type checking**

Run: `bun --filter docs test -- vercel-chat.test.tsx tanstack-chat.test.tsx`

Expected: PASS.

Run: `bun --filter docs typecheck`

Expected: exit 0.

- [x] **Step 6: Commit the TanStack tab and orchestrator**

```bash
git add apps/docs/components/playground/tanstack-chat.tsx apps/docs/components/playground/tanstack-chat.test.tsx apps/docs/components/playground.tsx
git commit -m "feat(docs): add TanStack AI browser chat"
```

---

### Task 9: Localized documentation, build, and smoke audit

**Files:**
- Modify: `apps/docs/content/docs/playground.mdx`
- Modify: `apps/docs/content/docs/playground.pt.mdx`
- Modify: `apps/docs/content/docs/playground.de.mdx`
- Modify: `apps/docs/content/docs/adapters.mdx`
- Modify: `apps/docs/content/docs/adapters.pt.mdx`
- Modify: `apps/docs/content/docs/adapters.de.mdx`
- Modify: `docs/specs/2026-08-08-local-browser-ai-adapters.md` only if implementation evidence requires a factual correction

- [x] **Step 1: Document both public adapters**

Add concise complete-text, JSON, stream, and TanStack connection examples in all three locales. State session ownership, one-session-per-conversation, abort behavior, tool support, and supported version ranges. Do not add or describe a gateway.

- [x] **Step 2: Document browser runtime truth**

Explain Gemini Nano versus Gemma 3 270M, explicit fallback download, approximate artifact size, WebGPU preference, local artifact hosting requests, absence of inference endpoints, current desktop limitations, and model-language quality caveats in English, Portuguese, and German.

- [x] **Step 3: Run formatting and static checks**

Run: `bunx prettier --check packages/local-pii/src apps/docs/components apps/docs/content/docs docs/specs docs/superpowers/plans`

Expected: all matched files are formatted.

Run: `git diff --check`

Expected: no whitespace errors.

- [x] **Step 4: Run the complete automated suite**

Run: `bun test`

Expected: all workspace tests pass.

Run: `bun run typecheck`

Expected: all workspace type checks pass.

Run: `bun run build`

Expected: the library artifacts and Fumadocs static `out` export are produced successfully.

- [x] **Step 5: Run React diagnostics**

Run the repository's `react-doctor` skill against `apps/docs`, fix actionable errors introduced by this feature, and rerun until no feature-owned error remains.

- [ ] **Step 6: Run browser smoke tests**

Serve the static docs export, open the localized playground in desktop Chrome, and verify:

1. opening the page downloads no LLM;
2. native availability and explicit activation states render correctly;
3. a PII-bearing prompt reaches the native model only as placeholders;
4. streamed output restores values;
5. stop and new chat work in both tabs;
6. fallback activation discloses Gemma source/size and reports progress;
7. fallback generation works after download;
8. Network shows model artifacts only and no inference endpoint;
9. English, Portuguese, and German routes render without hydration errors.

Fallback smoke evidence (2026-08-08): explicit Gemma activation downloaded the
q4f16 artifacts, both framework tabs protected and restored email addresses,
Stop and new chat worked, cached activation reused the artifacts without new
Hugging Face requests, and no inference fetch/XHR was observed. The native
Gemini Nano portion remains open because `LanguageModel.availability()` did not
resolve in the available Chrome 151 environment.

- [x] **Step 7: Perform final code review**

Use the `code-review` skill against all changes since the first feature commit. Resolve high and medium findings, rerun focused tests for every fix, then rerun the complete automated suite.

- [x] **Step 8: Commit documentation and verification fixes**

```bash
git add apps/docs/content/docs/playground.mdx apps/docs/content/docs/playground.pt.mdx apps/docs/content/docs/playground.de.mdx apps/docs/content/docs/adapters.mdx apps/docs/content/docs/adapters.pt.mdx apps/docs/content/docs/adapters.de.mdx
git commit -m "docs: explain local browser AI adapters"
```

---

## Self-review

- Spec coverage: every approved public API, session rule, no-backend constraint, native/fallback runtime state, shadcn/AI Elements requirement, localized documentation requirement, test seam, and manual smoke requirement maps to Tasks 1–9.
- Placeholder scan: the plan contains no deferred decision markers, unspecified error-handling step, or unnamed test command. Tool UI remains explicitly out of scope; protocol tool handling is implemented in Task 4.
- Type consistency: `PiiSession` ownership is borrowed for supplied inline sessions and mandatory/borrowed for TanStack; `piiConnection` always wraps `ConnectConnectionAdapter`; the playground runtime always returns Prompt API `LanguageModel` sessions; both chat examples own separate sessions.
- Worktree safety: every commit command stages exact feature files so the user's unrelated localized routing changes are never staged accidentally.
