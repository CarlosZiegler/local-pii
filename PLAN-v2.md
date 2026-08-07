# expo-pii — PLAN v2: Browser, Adapters, Tool Calls, Test Battery, Docs

Milestone goal (user's brief): Fumadocs docs site with get-started examples; browser support beyond Expo; adapters for TanStack AI / Vercel AI SDK / OpenAI / Grok; hash-style opaque tokens for the cases that need them (as `better-privacy` had); a robust test battery that verifies what works and characterizes limitations; and **solve the tool-calls challenge**. "Our lib must be the best for PII."

This plan is written for autonomous execution (Opus). Every open decision has a chosen default — follow the defaults, note deviations in commit messages. It builds on the shipped v1 (see `PLAN.md`): the pure-TS pipeline, `sequential()`/`hashed()` strategies, WordPiece tokenizer, `createRampartNer` (ORT-injected, Node-tested), `expo-pii/rampart` RN glue, `expo-pii/metro`.

> **Codex merge point:** `/Users/zietec/work/expo-pii/research/better-privacy-findings.md` did **not exist** when this plan was written (the `research/` dir is empty). A parallel Codex agent is documenting `better-privacy`'s TOOL-CALLS problem and its Crockford-base32 mangling-tolerant tokens. When that file lands: (1) cross-check §3/§4 token design against its exact token format and observed mangling modes, (2) evaluate its `datasets/` for the corpus harness in §6.3. Nothing in this plan blocks on it — the designs below are independently derived from `PLAN.md` §2's better-privacy summary (tokens `[[PERSON_9G8H2K…]]`, Crockford base32, ~100 bits, opaque sessions, OpenAI-compatible gateway).

Current-version facts checked against npm on 2026-08-07: `ai` 7.0.57 · `openai` 7.4.0 · `@tanstack/ai` 0.43.1 · `@tanstack/ai-react` 0.19.1 · `onnxruntime-web` 1.27.0 (matches the `onnxruntime-node` ^1.27 devDep already in the repo) · `fast-check` 4.9.0 · `fumadocs-ui`/`fumadocs-core` 16.14.2 · `fumadocs-mdx` 15.2.2.

---

## 0. Architecture invariant that drives everything below

**One rule:** *everything that crosses the trust boundary toward the provider is anonymized; everything handed back to application code is rehydrated; a `PiiSession` spans the whole exchange so re-anonymizing a rehydrated value reproduces the identical placeholder.*

Two deployment shapes, same code:

- **On-device (RN / browser):** the app calls the provider directly; adapters run in the app; the mapping never leaves the device. This is expo-pii's home turf.
- **Server-side (Next.js route, gateway):** AI SDK middleware / TanStack server middleware run on *your* server; the mapping stays on your server and protects against the *provider* (better-privacy's model). Document both explicitly in the docs site ("Trust boundaries" section) — this is a feature, not a compromise.

---

## 1. Browser support — `expo-pii/web`

### Facts

- The main `expo-pii` entry already imports zero native modules ("works in React Native, Node and the browser" — `src/index.ts`). Detectors, strategies, rehydrate, tokenizer: nothing to do.
- `createRampartNer` is runtime-agnostic via the injected `OrtModule` (`src/ner/rampart.ts`). `onnxruntime-web` implements the same `onnxruntime-common` surface (`InferenceSession.create`, `Tensor`) as `onnxruntime-node`/`-react-native`, so the web backend is *pure wiring*, exactly like `expo-pii/rampart` is for RN.
- **The Q4 model demonstrably runs on onnxruntime-web.** Rampart's own model card reports in-browser p50 3.9 ms (WebGPU) / 12.6 ms (WASM) via transformers.js — which executes on onnxruntime-web (https://huggingface.co/nationaldesignstudio/rampart). ORT-web's WebGPU EP supports 4-bit `MatMulNBits` (https://dev.to/hector_lxm/bringing-2-bit-quantization-to-onnx-runtimes-webgpu-backend-33cj), and the WASM EP is the universal fallback. Default EPs: `['webgpu', 'wasm']` — ORT falls through automatically when WebGPU is unavailable/unsupported. If a WebGPU op gap surfaces for Q4, wasm alone is proven-good (12.6 ms p50 is fine).
- `InferenceSession.create` accepts a **URL string or a `Uint8Array`** in onnxruntime-web (https://onnxruntime.ai/docs/get-started/with-javascript/web.html; API: https://onnxruntime.ai/docs/api/js/). Node supports the single-threaded wasm EP — so the *web* wiring is testable in vitest by passing model bytes.

### Design

New entry `packages/expo-pii/src/web.ts`, exported as `expo-pii/web`:

```ts
import { rampartWeb } from "expo-pii/web"

const pii = createAnonymizer({ ner: rampartWeb() })            // zero-config: HF CDN
// or self-hosted (recommended for production; CSP + availability):
const pii = createAnonymizer({
  ner: rampartWeb({ modelUrl: "/models/rampart-q4.onnx", vocab, labels }),
})
```

```ts
export interface RampartWebOptions {
  /** URL or preloaded bytes. Default: the HF resolve URL for model_q4.onnx. */
  modelUrl?: string | Uint8Array
  /** Inline arrays (e.g. from `@expo-pii/model-rampart`) — skip the fetches. */
  vocab?: readonly string[]
  labels?: readonly string[]
  /** Fetched + parsed when inline arrays are absent. Defaults: HF raw vocab.txt / config.json. */
  vocabUrl?: string
  labelsUrl?: string
  executionProviders?: Array<"webgpu" | "wasm">   // default ["webgpu", "wasm"]
  /** Forwarded to ort.env.wasm.wasmPaths before session creation (self-hosted .wasm assets). */
  wasmPaths?: string
  numThreads?: number
  ort?: OrtModule                                  // injection for tests / custom builds
  maxTokens?: number
}
export function rampartWeb(options?: RampartWebOptions): NerBackend
```

Implementation notes:

- Same lazy shape as `rampart()` in `src/rampart.ts`: `load()` resolves assets, sets `ort.env.wasm.*` if provided, then delegates to `createRampartNer`. `import * as ort from "onnxruntime-web"` (default bundle includes WebGPU in current ORT; keep `ort` injectable so a user can pass the `onnxruntime-web/wasm`-only bundle for size). `onnxruntime-web` becomes an **optional peer dep** — only the `./web` subpath touches it, mirroring how `./rampart` isolates `onnxruntime-react-native`.
- **Core change (small):** widen `RampartNerConfig.modelPath: string` → `model: string | Uint8Array` and `OrtModule.InferenceSession.create(path: string | Uint8Array, …)`. Backward-compatible for RN/Node (string paths still work); enables buffer loading on web and in tests. Rename field to `model` with a deprecated `modelPath` alias, or just do the breaking rename now (pre-1.0 — **rename, no alias**).
- Vocab/labels default fetch: `vocab.txt` → split lines; `config.json` → `id2label` in index order (the fetch-model script already does this conversion — extract the two pure functions into `src/ner/assets.ts` so script and web share them).
- Default HF URLs are a *convenience with a documented caveat*: the model download itself contains no user data, but production apps should self-host (docs show copying from `@expo-pii/model-rampart/assets/` into `public/`).
- **`apps/web` playground (small, optional last step):** one page in the existing Next.js app importing `expo-pii` + `rampartWeb` — live demo of anonymize→rehydrate in the browser. Keeps the "untouched template" clause of PLAN v1 loosened deliberately; it becomes the SDK's showcase.

### Tests (Node, no browser needed)

`src/web.test.ts` + extend `src/ner/rampart.golden.test.ts`:
- `rampartWeb({ modelUrl: bytes, vocab, labels, ort: onnxruntimeWebModule })` with bytes read from `@expo-pii/model-rampart` assets, wasm EP, `describe.skipIf(!modelPresent)` — asserts the same golden entities as the `onnxruntime-node` run (proves the ORT-web wasm EP executes Q4 and that web wiring is correct).
- Asset-parsing unit tests: `vocab.txt` → array; `config.json` → labels (fixtures, no network).
- URL loading + `wasmPaths` side effects: mock `ort` module asserting `env.wasm.wasmPaths` set before `create`, fetch mocked via `vi.stubGlobal("fetch", …)`.

---

## 2. Adapters for LLM libraries

### Package shape — decision

**Subpaths on the existing `expo-pii` package** (`expo-pii/ai-sdk`, `expo-pii/openai`, `expo-pii/tanstack`), not a separate `@expo-pii/adapters` package. Rationale: the package already uses exactly this pattern for optional integrations (`./rampart`, `./metro`) with optional peer deps + `peerDependenciesMeta`; each subpath is its own Rslib entry so nothing leaks into `.`; one install, one version to keep in sync; all adapters are pure JS with **zero native deps**. A separate package buys only npm-name aesthetics and costs a second release pipeline. (If the SDK is ever split for web-only branding, the subpaths lift out cleanly — they only import public core API.)

Shared internal engine (not a public subpath): `src/adapters/shared.ts` —
- `anonymizeJson(session, value)` / `rehydrateJson(value, mapping, opts)`: deep-map every **string leaf** of any JSON value (object/array recursion; keys untouched; non-strings untouched). This is the workhorse for message arrays, tool-call args and tool results. Also exported from core (see §3.4).
- `createStreamingRehydrator(mapping | session, opts)` (see §4.2).

### 2.1 Vercel AI SDK — `expo-pii/ai-sdk`

Current API (verified): AI SDK 7 (`ai@7.0.57`); middleware is `LanguageModelV4Middleware` with the same three hooks the pattern has had since V1 — `transformParams({ params })`, `wrapGenerate({ doGenerate, params })`, `wrapStream({ doStream, params })` — applied via `wrapLanguageModel({ model, middleware })`, both exported from `ai` (https://ai-sdk.dev/docs/ai-sdk-core/middleware, https://ai-sdk.dev/docs/reference/ai-sdk-core/wrap-language-model). Stream parts: `text-start` / `text-delta` (`{ id, delta }`) / `text-end`, `tool-input-start` / `tool-input-delta` / `tool-call` (`{ toolCallId, toolName, input }`, `input` = JSON string), `finish`, etc. **Implementer: verify exact part/field names against the installed `@ai-sdk/provider` types on day one** — the hook *shape* is stable across V2→V3→V4, the part names have drifted before. Peer range: `ai >= 6 < 8`, optional. Import only *types* from `ai`; all runtime logic is ours (keeps us tolerant of minor drift).

```ts
import { streamText, wrapLanguageModel } from "ai"
import { piiMiddleware, withPii } from "expo-pii/ai-sdk"

const session = anonymizer.createSession()
const model = withPii(openai("gpt-5.2"), { session })   // sugar over wrapLanguageModel
// or: wrapLanguageModel({ model, middleware: piiMiddleware({ session }) })
const result = streamText({ model, tools, prompt: userText })
```

Behavior (the invariant from §0, mechanically):

- **`transformParams`** — deep-anonymize the outgoing `params.prompt`: system string; user `text` parts; assistant `text` parts **and `tool-call` `input` JSON** (history); tool-message `tool-result` `output` values. Uses `session.anonymize` for free text and `anonymizeJson` for tool payloads. Because the SDK's agent loop calls `doGenerate`/`doStream` repeatedly with app-space (real-data) history, transformParams re-anonymizes each step — the session vault guarantees identical placeholders each time (§3.3).
- **`wrapGenerate`** — call `doGenerate()`, then rehydrate the result content: text parts via `rehydrate(text, session.mapping, { lenient: true })`; `tool-call` parts via parse-input-JSON → `rehydrateJson` → re-stringify (fallback path in §3.2). **Net effect: the SDK executes the app's tools with REAL argument values — no tool wrapper needed** — and appends real tool results, which transformParams re-anonymizes on the next step. The tool loop is solved entirely inside the middleware.
- **`wrapStream`** — pipe through a `TransformStream`: `text-delta` deltas through a per-`id` `createStreamingRehydrator` (flush on `text-end`/`finish`); `tool-input-delta` passed through **unmodified** (placeholders visible in streaming arg previews — documented; they're display-only), and the final `tool-call` part's `input` rehydrated exactly as in wrapGenerate, so execution always sees real values.

### 2.2 OpenAI SDK & Grok/xAI — `expo-pii/openai`

`openai@7.x`: `client.chat.completions.create()` (and the Responses API). Grok is OpenAI-compatible — same adapter with `new OpenAI({ baseURL: "https://api.x.ai/v1", apiKey: XAI_API_KEY })` (https://docs.x.ai/docs/tutorial). **No runtime or type dependency on the `openai` package**: the adapter wraps a client *instance* structurally (`{ chat: { completions: { create } } }`), so it also covers Groq/Ollama/OpenRouter/any compatible server — this *is* the Grok story, one adapter, documented three times.

```ts
import { withPiiOpenAI } from "expo-pii/openai"

const client = withPiiOpenAI(new OpenAI({ baseURL: "https://api.x.ai/v1", apiKey }), { session })
const res = await client.chat.completions.create({ model: "grok-4", messages, tools })
```

Behavior: a Proxy over the client intercepting `chat.completions.create` (and `responses.create` when present):
- Request: `messages` deep-anonymized (`content` strings and content-part arrays; `tool` role message `content`; assistant `tool_calls[].function.arguments` parsed→anonymized→re-stringified). `tools` schemas untouched (no PII by construction; documented).
- Non-stream response: rehydrate `choices[].message.content` (lenient) and each `tool_calls[].function.arguments` via parse→`rehydrateJson`→stringify, with the §3.2 fallback.
- Stream (`stream: true`, AsyncIterable of chunks): wrap the iterable; `delta.content` through a streaming rehydrator; `delta.tool_calls[].function.arguments` fragments passed through raw (placeholders) + rehydrated snapshot available via an exported helper `rehydrateToolArgs(argsJson, session)` for use at execution time. The docs' tool-loop example calls it right before executing the tool, then `session.anonymize` on the stringified tool result before pushing the `role:"tool"` message.
- Unlike the AI SDK, the user drives the tool loop manually here — the docs page shows the full loop (this is the primary "Tool Calls" doc example, because every wire detail is visible).

### 2.3 TanStack AI — `expo-pii/tanstack` (experimental)

What it is (verified): TanStack AI (beta) — provider-agnostic AI toolkit; server `chat()` from `@tanstack/ai` streams AG-UI-protocol `StreamChunk`s produced by per-provider adapters (`@tanstack/ai-openai` etc.); client `useChat`/`ChatClient` from `@tanstack/ai-react` connects via **connection adapters** (`fetchServerSentEvents(url, { fetchClient })`, or custom `ConnectConnectionAdapter` with `connect(messages, data, signal, ctx): AsyncIterable<StreamChunk>`); server-side `ChatMiddleware` exposes `onChunk` (transform chunks before emission) plus lifecycle hooks (https://tanstack.com/ai/latest/docs/api/ai, https://tanstack.com/ai/latest/docs/chat/connection-adapters, https://tanstack.com/blog/tanstack-ai-beta).

Two integration points, matching the two trust models:

- **Client-side (device-trust, the expo-pii headline):** `piiConnection(inner, { session })` — wraps any `ConnectConnectionAdapter`: deep-anonymize the outgoing `messages` (all part text, client-tool results) before delegating to `inner.connect(...)`; rehydrate the yielded chunks (text-delta content via streaming rehydrator; tool-call input JSON on completed tool-call chunks so **client tools** execute with real values). Works with `fetchServerSentEvents`/`xhrServerSentEvents` (the RN one) as the inner adapter — so this same adapter serves Expo and browser apps.
- **Server-side (gateway-trust):** `piiChatMiddleware({ session })` — a `ChatMiddleware` whose `onChunk` rehydrates nothing (chunks go to the *client*, which holds no mapping in this model — instead it anonymizes the messages heading to the provider adapter). NOTE: verify during implementation whether `ChatMiddleware` can transform the outgoing model input or only chunks; if input transformation isn't exposed, wrap the *model adapter* instead (`piiAdapter(openaiText("gpt-5.2"), { session })` decorating its send/stream methods). Choose whichever hook the installed version actually provides; the shared engine makes both trivial.

TanStack AI is 0.x and explicitly beta — pin exact minors, mark the subpath `@experimental` in TSDoc and docs, and keep its tests against a **fake in-process connection adapter** (`stream()`-style) so upstream churn can't break CI.

---

## 3. THE TOOL-CALLS CHALLENGE (critical)

### 3.1 Why tool calls break naive anonymize→call→rehydrate

The multi-step loop has **four boundary crossings per step**, not one:

```
user text ──anonymize──▶ provider
provider ──tool_call{args JSON with placeholders}──▶ app   ← must REHYDRATE args (tool needs real data)
app tool result (REAL data) ──anonymize──▶ provider        ← fresh PII enters mid-conversation
provider ──final text──▶ app                               ← rehydrate (possibly streamed)
```

Failure modes (each becomes a test in §6.4):

1. **Placeholders inside argument JSON.** The model must copy `[EMAIL_1]` byte-for-byte into a JSON string it generates. Models mangle bracketed tokens: case changes (`[Email_1]`), translation of the type word (`[NOME_1]` in a Portuguese chat), spacing (`[EMAIL 1]`), bracket loss (`EMAIL_1`), markdown collision (`[EMAIL_1](mailto:…)` — brackets are link syntax), and — worst — **treating the bracket token as a template slot to fill with an invented value**. Bracketed tokens *look like* fill-in placeholders to an instruction-tuned model.
2. **JSON validity.** If the model emits a placeholder where a *number* is expected (`"zip": [ZIP_CODE_1]` unquoted), the argument JSON no longer parses. String-level replacement over serialized JSON is also unsafe in the other direction: rehydrating a value containing `"` `\` or newlines into a JSON string without escaping corrupts it. **Rule: always parse → deep-map parsed string values → re-serialize; never string-substitute inside serialized JSON** (fallback below).
3. **Streaming splits.** `tool-input-delta` / `delta.content` chunks split placeholders arbitrarily (`"[EMA"`+`"IL_1]"`). Naive per-chunk regex replacement misses them.
4. **Session drift across steps.** If step N+1 re-anonymizes history and produces *different* placeholders than step N (new numbering, NER detecting different spans on re-read), the provider sees two names for one entity and cross-references break.

### 3.2 Design: exact behaviors

**(a) Rehydrate-parsed-JSON with lenient fallback.** `rehydrateToolArgs(argsJson: string, mapping, opts)`:
1. `JSON.parse` → `rehydrateJson` (deep string-leaf rehydrate, `lenient: true`) → `JSON.stringify`. 
2. If parse fails (mangled/truncated JSON): fall back to token-level replacement on the raw string, where each substituted value is JSON-string-escaped iff the match position is inside a JSON string literal (cheap heuristic: count unescaped `"` before match). Return `{ args, clean: boolean }` so adapters can surface a warning.
3. Placeholders that match the strategy pattern but are **not in the mapping** (model-invented) are left untouched and reported via an optional `onUnknownPlaceholder` callback — never guess.

**(b) Anonymize tool results as JSON.** `session.anonymizeJson(value)` — deep map string leaves through the session pipeline (deterministic + dictionary + vault-dictionary always; NER per leaf ≥ a min length, default 4 chars, to bound model calls). Object *keys* are never anonymized (schema, not data). Adapters use this for `tool-result` outputs / `role:"tool"` messages.

**(c) Session-stable re-anonymization (fixes drift).** Two new core behaviors, both in `Vault`/pipeline:
- **Vault-dictionary:** every raw value already in the session vault acts as an implicit dictionary entry (priority above NER, below user dictionary) on subsequent `anonymize` calls. Once "João Silva" is `[GIVEN_NAME_1] [SURNAME_1]`… actually per-entity: each vault entry (value → placeholder) is matched exactly (canonicalized, whole-word) and mapped to its existing placeholder — NER volatility can no longer renumber a known entity.
- **Placeholder passthrough (idempotence):** spans matching `strategy.pattern()` AND present in the vault are protected regions — no detector runs inside them, and they are emitted unchanged. `anonymize(anonymize(x).redactedText)` is a no-op. This is what makes "re-anonymize the whole history every step" safe and cheap.

**(d) When `[TYPE_N]` is fine vs when `token()` is required.**
- `sequential()` stays the **default**: best LLM reasoning, human-debuggable, zero leakage. Fine for plain chat, and *usually* fine for tool calls (models copy short IDs well).
- The **opaque `token()` strategy (§4.1) is the recommended setting whenever `tools` are in play or outputs are machine-parsed** (JSON mode, structured output): no brackets → no markdown/JSON/template-slot collisions; Crockford base32 → survives case-folding and 0/O 1/I/L confusions via lenient decode; looks like an opaque ID, which models are strongly trained to preserve verbatim. This is better-privacy's proven answer imported into expo-pii (merge exact observed-mangling list from the Codex report when it lands).
- Adapters accept the session as-is; docs (Tool Calls page) state the recommendation, and adapters emit a one-time `console.warn` in dev when tools are detected with the `sequential` strategy (suppressed via `{ warnings: false }`).

**(e) Stream-aware rehydration** — §4.2; used by every adapter's stream path.

### 3.3 Where the loop state lives

One `PiiSession` per conversation. AI SDK: `withPii(model, { session })` — create per request/conversation in the route handler (document; a module-level session would leak mappings across users server-side). OpenAI adapter: `withPiiOpenAI(client, { session })` same rule. TanStack client adapter: session lives in the component/ChatClient scope — device-local, one per thread. `session.mapping` remains the exportable snapshot; persisting it across app restarts stays the app's choice (secure-store note already in v1 docs).

### 3.4 New public API (core)

```ts
// expo-pii (root)
export function anonymizeJsonWith(session: PiiSession, value: unknown): Promise<unknown>  // or session.anonymizeJson
export function rehydrateJson(value: unknown, mapping: Mapping, opts?: RehydrateOptions): unknown
export function rehydrateToolArgs(argsJson: string, mapping: Mapping, opts?: RehydrateOptions):
  { args: string; clean: boolean }
export function createStreamingRehydrator(mapping: Mapping | (() => Mapping), opts?: RehydrateOptions):
  { push(chunk: string): string; flush(): string }
export function token(opts?: TokenStrategyOptions): PlaceholderStrategy    // §4.1
// PiiSession additions
interface PiiSession {
  anonymizeJson(value: unknown): Promise<unknown>
  rehydrateJson(value: unknown, opts?: RehydrateOptions): unknown
  // existing: anonymize, rehydrate, mapping, clear
}
```

(`mapping` as `() => Mapping` lets the streaming rehydrator see entries added mid-loop.)

---

## 4. Placeholder strategies revisited

### 4.1 New: `token()` — opaque, mangling-tolerant (Crockford base32)

```ts
export interface TokenStrategyOptions {
  /** HMAC key for cross-session-stable tokens. Omitted → CSPRNG-random per value. */
  secret?: Uint8Array | string
  /** Token payload bits, default 80 (16 Crockford chars). */
  bits?: number
  /** Leading tag, default "PII". Must be A–Z0–9, ≥2 chars. */
  prefix?: string
}
export function token(opts?: TokenStrategyOptions): PlaceholderStrategy
```

- Format: `PII` + Crockford-base32 payload, e.g. `PIIQ2X9K7M3TZ8R4EJ0V` — **no brackets, no underscores, letters+digits only**, matched with `/\bPII[0-9A-HJKMNP-TV-Z]+\b/g` (Crockford alphabet excludes I, L, O, U — https://www.crockford.com/base32.html). No type name in the token (opaque = no type leakage either; the `entities` array still carries types for the app/UI).
- Default **random** payload (via `crypto.getRandomValues`, feature-detected with a `Math.random`-free fallback error): the `Vault` already calls `placeholderFor` only on first sight of a `(type, value)` key, so randomness is safe and needs no strategy-side cache. With `secret`: payload = HMAC-SHA256(secret, `type\0canonicalValue`) truncated — stable across sessions/devices sharing the secret, same keyed-hash security analysis as `hashed()` (PLAN v1 §4 applies verbatim; unkeyed value-hashing remains forbidden).
- **Lenient decode** (rehydrate + streaming): normalize candidates before lookup — uppercase, `O→0`, `I→1`, `L→1`, strip `-` and internal spaces — and index the mapping by normalized key. This is the mangling tolerance that made better-privacy's tokens survive LLM round-trips.

Strategy interface: unchanged (`placeholderFor(type, value, index)` + `pattern()`), plus one **optional** member so lenient matching stops being sequential-specific:

```ts
interface PlaceholderStrategy {
  // …existing…
  /** Optional: map a possibly-mangled candidate to canonical form ("" = not mine). */
  normalizeMatch?(candidate: string): string
  /** Optional: regex matching mangled variants, used when lenient (defaults to pattern()). */
  lenientPattern?(): RegExp
}
```

`rehydrate(text, mapping, { lenient: true, strategy })` uses these when present; current bracket-variant behavior remains the default (back-compat). `sequential()` gains `lenientPattern` covering `[[X]]`, missing brackets, and case-insensitive type words — the existing hand-rolled variants move behind the interface.

### 4.2 Streaming rehydration (strategy-agnostic)

`createStreamingRehydrator(mapping, opts)` — pure incremental transformer:

- Keeps an internal carry buffer. On `push(chunk)`: append; rehydrate the buffer; **emit everything except the longest trailing suffix that could still be a placeholder prefix** (computed against the *mapping keys* + lenient normalizations, not the strategy — capped at `maxKeyLen + slack(8)` so the holdback is bounded and mapping-driven, working identically for `[GIVEN_NAME_1]`, `[TYPE_hash]`, and `PIIQ2X9…`).
- `flush()` releases the carry (rehydrating any complete match formed at the end).
- Property (tested exhaustively in §6.5): for every split of every text, `concat(push(parts)…, flush()) === rehydrate(whole)`.
- Thin wrappers: `toTransformStream(rehydrator)` for AI SDK `wrapStream`; async-generator wrapper for the OpenAI/TanStack iterables.

Strategy interaction summary (docs table): `sequential` = default, chat-optimal; `hashed` = cross-session stable, readable-ish; `token` = tool/JSON-proof, opaque; all three work with sessions, streaming, and lenient rehydrate; only `token({secret})`/`hashed` are cross-session stable.

---

## 5. Fumadocs docs site — `apps/docs`

Stack (verified current): `fumadocs-ui` + `fumadocs-core` 16.14.2, `fumadocs-mdx` 15.2.2, Next.js App Router (Pages Router unsupported) — https://fumadocs.dev/docs, https://www.fumadocs.dev/docs/manual-installation/next. Scaffold with `bun create fumadocs-app` (choose Next.js), then move into `apps/docs` and wire the workspace (fastest path; keep its Tailwind v4 setup). Lives alongside `apps/web` (which stays the marketing/template app + browser playground). Turbo: `build` already covers it via `.next/**` outputs; `dev` runs on port 3001 (`next dev -p 3001`).

Minimal file set:

```
apps/docs/
├── package.json            # next, react, fumadocs-ui, fumadocs-core, fumadocs-mdx,
│                           # expo-pii: workspace:* (live examples typecheck against the real SDK)
├── next.config.ts          # createMDX from "fumadocs-mdx/next"
├── source.config.ts        # defineDocs({ dir: "content/docs" }) + defineConfig()
├── lib/source.ts           # loader({ source: docs.toFumadocsSource(), baseUrl: "/docs" })
├── mdx-components.tsx      # defaultMdxComponents from "fumadocs-ui/mdx"
├── app/
│   ├── layout.tsx          # RootProvider
│   ├── (home)/page.tsx     # landing → /docs
│   ├── docs/layout.tsx     # DocsLayout with source.pageTree
│   ├── docs/[[...slug]]/page.tsx
│   └── api/search/route.ts # createFromSource(source)
└── content/docs/           # the pages + meta.json files below
```

Page tree (`content/docs/`, `meta.json` per folder for order):

```
index.mdx                     Get Started (install, 10-line happy path, Expo + browser tabs)
concepts.mdx                  Core Concepts (pipeline, Session, Vault, Mapping, trust boundaries diagram)
detectors.mdx                 Detectors (built-ins table, dictionary, custom Detector)
strategies.mdx                Placeholder Strategies (sequential / hashed / token — decision table, security notes)
expo.mdx                      On-device Model (Expo): rampart(), metro helper, prebuild, model asset
browser.mdx                   Browser: rampartWeb(), self-hosting model + wasm assets, WebGPU/WASM
adapters/
  meta.json
  ai-sdk.mdx                  Vercel AI SDK (withPii + streamText + tools, server & client examples)
  tanstack.mdx                TanStack AI (piiConnection client, server note; experimental banner)
  openai.mdx                  OpenAI & Grok/xAI (withPiiOpenAI; baseURL https://api.x.ai/v1; manual tool loop)
tool-calls.mdx                Tool Calls (the §3 loop diagram, failure modes, token() recommendation)
security.mdx                  Security & Hashing (HMAC analysis, what leaks with each strategy, mapping handling)
limitations.mdx               Limitations (Rampart's own numbers; non-Latin ~13.7% recall; indirect identifiers;
                              gov IDs ~67.6%; "PII removal ≠ anonymization" — driven by §6.7 characterization results)
api.mdx                       API Reference (generated-ish: curated per-export reference; full typedoc later)
```

Content rules: every code block is lifted from a compiling example file under `apps/docs/examples/` (typechecked by `turbo typecheck` since `expo-pii` is a workspace dep) — docs that can't rot. The Limitations page cites the §6.7 suite's committed results table.

---

## 6. Robust test battery

All Node-runnable under the existing `turbo test` / vitest setup. New deps (dev): `fast-check@^4`, `onnxruntime-web@^1.27`, `ai@^7` (+ `zod`), `@tanstack/ai` (exact pin). Extend `packages/expo-pii/vitest.config.ts` include to `["src/**/*.test.ts", "test/**/*.test.ts"]` — unit tests stay colocated in `src/` (repo convention); the cross-cutting battery lives in `packages/expo-pii/test/`.

```
packages/expo-pii/test/
├── arbitraries.ts               # fast-check generators: PII values per type, carrier templates,
│                                #   unicode noise (emoji, ZWJ, RTL, combining marks), chunk splitters
├── roundtrip.property.test.ts   # §6.1
├── idempotence.property.test.ts # §6.2 (also numbering stability)
├── corpus/                      # §6.3 labeled fixtures (JSONL per language)
│   ├── en.jsonl  pt.jsonl  de.jsonl  es.jsonl  fr.jsonl  …
├── precision-recall.test.ts     # §6.3 harness
├── tool-loop.test.ts            # §6.4
├── streaming.property.test.ts   # §6.5
├── adapters/{ai-sdk,openai,tanstack}.test.ts   # §6.6 (mock models/clients)
└── limitations.test.ts          # §6.7 (+ committed results snapshot)
```

**6.1 Property-based round-trip (fast-check).** Generate `(template, plantedEntities)` — templates embed generated PII values (emails, phones, IBANs, names) into multilingual carrier text salted with unicode noise. Planted values are ALSO registered as dictionary entries, so detection is *guaranteed* and the invariant is exact: `rehydrate(anonymize(x).redactedText, mapping) === x` for all three strategies × lenient on/off. Companion invariants: `redactedText` contains no planted raw value; every mapping value was planted; placeholders survive `JSON.stringify`/`parse`. (Detector *recall* is deliberately excluded from this invariant — that's §6.3's job; keep the two concerns separate or the property flakes.)

**6.2 Idempotence & numbering stability.** `anonymize(redactedText)` changes nothing (§3.2c); session turn-2 with shuffled/repeated entities reuses turn-1 placeholders; vault-dictionary guarantees re-anonymization of rehydrated text reproduces identical placeholders even with a *disabled* NER backend standing in for "NER volatility".

**6.3 Detector precision/recall harness.** JSONL fixtures `{ text, entities: [{start, end, type}] }`, ~100 lines/language to start, EN/PT/DE/ES/FR. Harness computes per-type P/R/F1 for the deterministic layer (always) and for deterministic+Rampart (`describe.skipIf(!modelPresent)`, model via `bun run fetch-model` like the existing golden test). Assert **floors**, not exact values (e.g. EMAIL P ≥ 0.95 / R ≥ 0.9; PHONE-international R ≥ 0.85; with-NER GIVEN_NAME R ≥ 0.9 on EN) so improvements never break CI. Emit a markdown summary artifact consumed by the Limitations docs page. **Merge point: better-privacy's `datasets/` (per the Codex report) should seed/extend these fixtures if license-compatible; convert with a one-off script under `scripts/`.**

**6.4 Tool-call round-trip.** Scripted mock provider (no network): step 1 returns a `tool-call` whose args embed placeholders (also mangled variants: case-folded token, bracket-stripped, `O`→`0` swap); the harness runs the AI SDK loop via `generateText` + `withPii` + a real `tool()` whose execute records its received input. Assert: (a) *every* provider-visible payload (captured params at each step) contains zero raw PII — sweep with a "leak detector" that searches all planted values; (b) the tool executed with fully-real values; (c) tool result PII got fresh placeholders reused in step-2 params; (d) final rehydrated answer matches expected. Repeat matrix: `sequential` vs `token()`; `token` must additionally pass the *mangled* variants that `sequential` is allowed to fail (those `sequential` failures are recorded as characterization, not errors — they justify the recommendation).

**6.5 Streaming rehydration.** fast-check: arbitrary chunkings (`splitAt` generator incl. every boundary, 1-char chunks, empty chunks) of texts containing placeholders/mangled placeholders → `StreamingRehydrator` output equals whole-string `rehydrate`. Plus AI SDK `wrapStream` integration using stream-simulation utilities from `ai` (mock model + simulated `text-delta` parts split mid-placeholder).

**6.6 Adapter tests (mock models).** AI SDK: mock language model from `ai`'s test utilities (v5 shipped `MockLanguageModelV2` under `ai/test` — use the current V4 equivalent; verify the exported name on install) for generate + stream + tools. OpenAI: hand-rolled fake client object (structural — this also proves the no-dependency claim) covering non-stream, stream, tool_calls, `arguments`-invalid-JSON fallback. TanStack: fake in-process `ConnectConnectionAdapter` yielding scripted `StreamChunk`s; assert anonymized outbound messages + rehydrated inbound chunks + client-tool arg rehydration.

**6.7 Limitations characterization.** A suite that *asserts current misses* so the Limitations page is evidence, not vibes: Cyrillic/CJK/Arabic names NOT detected (Rampart non-Latin ~13.7% recall — model card), Brazilian CPF / German Steuer-ID misses without dictionary entries, indirect identifiers ("my neighbor the mayor of Springfield") passing through untouched, zero-width-joiner adversarial evasion of deterministic detectors. Each test's expectation IS the documented limitation; when a future improvement flips one, the test fails → update docs. Committed `test/limitations-results.md` snapshot regenerated by the suite feeds `limitations.mdx`.

---

## 7. Monorepo & build impact

- **`packages/expo-pii`** — new Rslib entries in `rslib.config.ts`: `web`, `ai-sdk`, `openai`, `tanstack` (adapters implemented under `src/adapters/`, entry files `src/ai-sdk.ts` etc. re-exporting them — matches the existing flat-entry pattern; extensionless imports; no new barrels beyond the entry files themselves). `exports` map gains `./web`, `./ai-sdk`, `./openai`, `./tanstack` (same `types/import/require` triple as `./rampart`). New optional peers: `onnxruntime-web` (web), `ai >=6 <8` (ai-sdk types), `@tanstack/ai` (exact-pinned range) — all with `peerDependenciesMeta.optional: true`; the OpenAI adapter needs **no** peer. New devDeps: `fast-check`, `onnxruntime-web`, `ai`, `zod`, `@tanstack/ai`.
- **New app `apps/docs`** — §5 deps; joins Turbo `build`/`dev`/`lint`/`typecheck` automatically via workspace glob. No new packages otherwise — **no `@expo-pii/adapters`** (§2 decision).
- **`packages/model-rampart`** — unchanged, plus the docs note that web users copy `assets/` to their public dir; optionally add `exports` subpath `"./assets/*": "./assets/*"` if bundlers complain about deep imports (only if needed).
- **Core source changes**: `types.ts` (strategy optional members, session additions), `pipeline/vault.ts` (vault-dictionary iteration, normalized token index), `anonymizer.ts` (placeholder-protection premask, vault-dictionary detector wiring), `rehydrate.ts` (strategy-aware lenient), new `src/placeholder/token.ts`, `src/json.ts` (anonymizeJson/rehydrateJson/rehydrateToolArgs), `src/stream.ts` (StreamingRehydrator), `src/ner/assets.ts` (vocab/labels parsing shared with fetch script), `src/web.ts`.
- Root: `research/` stays untracked scratch; `scripts/import-bp-corpus.mjs` (only if §6.3 merge point pans out).

---

## 8. Phased implementation plan (for Opus) 

TDD throughout (repo convention: colocated `*.test.ts` first). Each phase is independently shippable and fully Node-verifiable **today**; nothing below needs a device or a browser.

**Phase 1 — Core primitives (foundation for everything).**
Files: `src/placeholder/token.ts`(+test), `src/stream.ts`(+test), `src/json.ts`(+test), edits to `types.ts`, `rehydrate.ts`(+tests: strategy-aware lenient, normalized token lookup), `pipeline/vault.ts`, `anonymizer.ts`, `session.ts` (+tests: vault-dictionary, idempotence, `anonymizeJson`).
Key tests: Crockford alphabet/lenient-decode table (`O/I/L` mapping, case, hyphens); random vs HMAC token determinism; streaming rehydrator split-at-every-boundary; `rehydrateToolArgs` parse-path, escape-safety (value with `"` and `\n`), invalid-JSON fallback, unknown-placeholder untouched; `anonymize∘anonymize` no-op; re-anonymize-rehydrated-text placeholder equality.
Exit: `bun run test` green; no public-API breaks besides the `RampartNerConfig.modelPath→model` rename.

**Phase 2 — Adapters + the tool-calls solution.**
Files: `src/adapters/shared.ts`, `src/adapters/ai-sdk.ts` → entry `src/ai-sdk.ts`, `src/adapters/openai.ts` → `src/openai.ts`, `src/adapters/tanstack.ts` → `src/tanstack.ts` (+ colocated unit tests), `rslib.config.ts` + `package.json` exports/peers, `test/tool-loop.test.ts`, `test/adapters/*`.
Key tests: §6.4 full loop with leak-sweep; §6.6 mock-model matrix; stream text-delta rehydration through `wrapStream`; OpenAI `arguments` fallback path. First task: `bun add -d ai zod @tanstack/ai` and pin the real exported type names (`LanguageModelV4Middleware` etc.) — adjust this plan's names to what's installed, keep hooks/behavior as specified.

**Phase 3 — Browser backend.**
Files: `src/web.ts`(+test), `src/ner/assets.ts`(+test), widen `src/ner/rampart.ts` model input, extend `src/ner/rampart.golden.test.ts` with the `onnxruntime-web` wasm run, `scripts/fetch-model.mjs` refactor to reuse `ner/assets.ts`. Optional: `apps/web` playground page.
Key tests: golden parity node-EP vs web-wasm-EP on the same sentences; asset parsing; wasmPaths/EP option plumbing with a mock `ort`.

**Phase 4 — Test battery build-out.**
Files: everything under `test/` from §6 not yet created (`arbitraries.ts`, property suites, `corpus/*.jsonl`, `precision-recall.test.ts`, `limitations.test.ts` + results snapshot), vitest include update.
Key tests: are the deliverable. Gate: property suites ≥ 1000 runs locally, 200 in CI (fast-check `numRuns` via env); P/R floors green; limitations snapshot committed.

**Phase 5 — Docs site.**
Files: `apps/docs/*` per §5, `apps/docs/examples/*` (compiling snippets), README cross-links.
Exit: `turbo build` builds docs; every example file typechecks; Limitations page embeds §6.7 results; Get Started reproduces the 10-line happy path on Expo AND browser tabs.

**Phase 6 — Merge & polish.**
Read `research/better-privacy-findings.md` (should exist by then): fold observed tool-call failure modes into §6.4 mangling matrix + `tool-calls.mdx`; import datasets into `test/corpus/` if suitable; reconcile token format details. Update root README (packages table + new subpaths). Optional: `apps/example` gains a tools demo screen.

### Risks & open decisions (defaults chosen)

| # | Risk / decision | Default (do this) |
|---|---|---|
| 1 | AI SDK major-version churn (V2→V3→V4 middleware in 14 months) | Structural behavior in our code, type-only import from `ai`, optional peer `>=6 <8`, verify names at install. Hooks (`transformParams`/`wrapGenerate`/`wrapStream`) are the stable contract. |
| 2 | TanStack AI is beta (0.x) | Ship `expo-pii/tanstack` marked `@experimental`, exact-pin peer, fake-adapter tests only. Re-evaluate at their 1.0. |
| 3 | Adapter package shape | Subpaths on `expo-pii` (decision, §2). No separate package. |
| 4 | Tool-call arg rehydration when JSON is mangled | Parse-first; string-level escaped fallback with `clean:false` flag; never guess unknown placeholders (§3.2a). |
| 5 | Default strategy with tools | Keep `sequential` default; recommend + dev-warn toward `token()` when tools detected; `token()` random by default, HMAC with `secret`. |
| 6 | Streaming tool-arg deltas | Pass through with placeholders (display-only); rehydrate the final tool-call/at-execution via `rehydrateToolArgs`. |
| 7 | WebGPU Q4 op coverage uncertainty | Default `['webgpu','wasm']` EP fallthrough; wasm is proven by Rampart's own browser numbers. If webgpu misbehaves, ship default `['wasm']` and note it. |
| 8 | Zero-config web model from HF CDN | Allowed as default with a documented self-hosting recommendation (no user data in the download). |
| 9 | NER re-detection drift across the tool loop | Vault-dictionary + placeholder-passthrough idempotence (§3.2c) make session placeholders sticky regardless of NER behavior. |
| 10 | `modelPath` rename breaks v1 API | Do the rename (`model: string \| Uint8Array`) now, pre-1.0, one line in the changelog. |
| 11 | Fumadocs majors move fast (ui/core 16, mdx 15) | Scaffold with `bun create fumadocs-app`, pin what it generates; docs app is isolated from SDK builds. |
| 12 | better-privacy findings absent at planning time | Plan proceeds; Phase 6 is the merge point (token format, mangling matrix, datasets). |
| 13 | Property tests flaking on detector recall | Round-trip invariant plants values via dictionary (guaranteed detection); recall lives only in the P/R harness with floor assertions (§6.1 vs §6.3 separation). |
| 14 | Sessions shared across users server-side | Docs + TSDoc: one `PiiSession` per conversation/request; examples always show per-request creation. |

---

## Appendix: research URLs

- AI SDK middleware: https://ai-sdk.dev/docs/ai-sdk-core/middleware · https://ai-sdk.dev/docs/reference/ai-sdk-core/wrap-language-model · v6 middleware (LanguageModelV3): https://v6.ai-sdk.dev/docs/ai-sdk-core/middleware · AI SDK 6 announcement: https://vercel.com/blog/ai-sdk-6
- TanStack AI: https://tanstack.com/ai/latest · API: https://tanstack.com/ai/latest/docs/api/ai · connection adapters: https://tanstack.com/ai/latest/docs/chat/connection-adapters · OpenAI-compatible adapter: https://tanstack.com/ai/latest/docs/adapters/openai-compatible · beta post: https://tanstack.com/blog/tanstack-ai-beta
- xAI/Grok OpenAI compatibility (`https://api.x.ai/v1`): https://docs.x.ai/docs/tutorial · https://docs.x.ai/docs/api-reference
- onnxruntime-web: https://onnxruntime.ai/docs/get-started/with-javascript/web.html · JS API: https://onnxruntime.ai/docs/api/js/ · 4-bit MatMulNBits on WebGPU EP background: https://dev.to/hector_lxm/bringing-2-bit-quantization-to-onnx-runtimes-webgpu-backend-33cj
- Rampart browser perf (Q4 via transformers.js → onnxruntime-web): https://huggingface.co/nationaldesignstudio/rampart
- Fumadocs: https://fumadocs.dev/docs · manual install: https://www.fumadocs.dev/docs/manual-installation/next
- fast-check: https://fast-check.dev/
- Crockford base32: https://www.crockford.com/base32.html
- Prior art (user's): https://github.com/CarlosZiegler/better-privacy
