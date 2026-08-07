# Better Privacy findings for `local-pii`

## Executive finding

The server gateway found a real architectural fault line: reversible PII tokens work well for ordinary prompt/response text, but tool calling is not an ordinary text round trip. A token copied by a model into JSON tool arguments can survive serialization perfectly and still make the tool call useless, because the tool receives the opaque token instead of the email, customer name, or account number it needs. Restoring it automatically is unsafe because a tool is a separate disclosure destination, possibly a third party. In the OpenAI-compatible gateway, the mapping is also request-scoped and is destroyed before the usual client-side tool round trip returns on a later HTTP request.

Better Privacy's later security research recognizes all three concerns—structured serialization, destination-specific authorization, and session lifetime—but the shipped integrations do not solve them end to end. The gateway deliberately leaves model-emitted tool arguments tokenized; the Vercel and TanStack adapters likewise do not restore argument JSON. Tool results receive partial protection on the next model iteration, with framework-specific gaps. This is the most important design constraint for `local-pii`.

All paths below are relative to `/Users/zietec/work/better-privacy` unless shown otherwise. The repository was inspected read-only.

## 1. Architecture and public API

### Packages and integration boundary

The repository separates the privacy mechanism from model/framework integration:

- `packages/core/` is published as `better-privacy`. Its public surface exports `createGuard`, `definePolicy`, all five actions, policy packs, the deterministic regex detector, checksum validators, `RestorationSession`, token helpers, span/normalization helpers, and report types (`packages/core/src/index.ts:26-78`).
- `packages/detector-presidio/`, `packages/detector-gliner/`, and `packages/detector-openmed/` adapt model-based sidecars to the core `DetectorAdapter` contract.
- `packages/adapter-vercel/` exports `privacy()` as Vercel AI SDK middleware (`packages/adapter-vercel/src/index.ts`).
- `packages/adapter-tanstack/` exports `privacy()` as TanStack AI middleware and keeps an exchange across an agent run (`packages/adapter-tanstack/src/index.ts`).
- `packages/gateway/` exports `createGateway()` for an authenticated OpenAI-compatible `/v1` proxy (`packages/gateway/src/index.ts`). It intentionally exposes no plaintext restoration endpoint.
- `apps/example/` is both a scenario demo and a documentation-check harness. Its rule editor surfaces which detector can actually express each policy type (`apps/example/src/contract.ts`, `apps/example/README.md`). `apps/docs/` is the documentation site.

The intended flow is:

```text
input text
  -> NFC normalization
  -> detectors
  -> validate/merge overlapping spans
  -> policy action per entity type
  -> protected text + request/run-scoped session
  -> model
  -> exact token recognition + session-authorized restoration
  -> caller-visible output
```

See `README.md:18-45`, `packages/core/src/guard.ts:167-352`, and `packages/core/src/session.ts:4-21`.

### Guard, policy, protect, restore, and session

A caller builds a policy with an ID/version, detector list, action map, locale, score threshold, and failure/streaming/provider-retention behavior, then creates a guard:

```ts
const policy = definePolicy({
  id: "notes",
  version: "1.0.0",
  detectors: [regex()],
  actions: { EMAIL: tokenize(), BR_CPF: redact() },
})

const guard = createGuard({ policy })
const { text, session, entities, degraded } = await guard.protect(input)
const providerOutput = await model(text)
const output = guard.restore(providerOutput, session)
session.close()
```

This API is shown in `README.md:18-41` and defined in `packages/core/src/guard.ts:49-67`. `protect()` returns transformed text, safe evidence about applied entities, a degradation flag, and the capability-like session. `restore()` recognizes well-formed tokens but only replaces a token if that exact identifier exists in the supplied live session. Invented tokens, tokens from another request, one-way tokens, and corrupted tokens remain visible (`packages/core/src/guard.ts:331-352`; `packages/core/src/session.ts`). Closing clears the mapping and makes later restoration fail.

Sessions are deliberately not a durable authorization system. The host process that receives a session is already trusted. Multi-turn, asynchronous, stateless, or cross-process restoration would require a durable mapping plus authenticated disclosure scope, which is explicitly not implemented (`packages/core/src/session.ts:4-21`; `README.md:247-285`). Within one `protect()` call, the same `{type, original}` is assigned the same token for model coherence; a later call gets a different token to reduce provider-side correlation (`packages/core/src/guard.ts:245-310`).

### Detection, overlap resolution, and actions

Every detector implements `analyze(text, options)` and returns `{ type, start, end, score, detector }`. Entity types are open upper-snake-case strings, not a closed runtime enum. Offsets are UTF-16 code units into NFC-normalized text (`packages/core/src/detectors/types.ts`; `packages/core/src/text.ts`).

The guard runs detectors, validates their spans and score thresholds, then deterministically resolves overlap. More privacy-preserving actions win (`block > redact > tokenize > mask > allow`); detector order and score break later ties. Suppressed candidates remain in the safe report for diagnostics (`packages/core/src/guard.ts:69-153`). Existing well-formed tokens are excluded from re-tokenization to prevent nested delimiters and broken restoration in multi-turn/double-protect paths (`packages/core/src/guard.ts:221-237`).

The actions are (`README.md:216-227`; `packages/core/src/policy.ts`):

- `tokenize()` — mint a reversible random token and record it in the session.
- `tokenize({ oneWay: true })` — mint a token but never record a restorable mapping; it is domain-separated from reversible tokens.
- `redact()` — replace with a fixed label, defaulting to `[redacted]`; irreversible.
- `mask()` — retain a configured suffix (default last four) and mask the prefix; irreversible.
- `block()` — throw `PolicyBlockError`, stopping the provider call.
- `allow()` — leave the span unchanged.

`encrypt()` was considered and removed: a decryptable durable value would add risk while providing no useful model behavior over an opaque token (`packages/core/src/policy.ts:1-8`). The built-in `notesPolicy()` and `crmBasicPolicy()` are opinionated starting points, not guarantees. Their own source warns that tokenizing everything forces models to reason about placeholders and can reduce usefulness (`packages/core/src/policies.ts:1-14`).

## 2. The tool-call/function-calling challenge

### The exact failure

Consider a protected user message containing `ana@example.com`:

1. `protect()` sends the model `[[EMAIL_<21-character-id>]]` and retains the original only in a local session.
2. The model emits a function call such as `sendReceipt({"email":"[[EMAIL_...]]"})`.
3. The JSON is syntactically valid and the token may be byte-for-byte intact.
4. If passed through unchanged, the tool receives a meaningless placeholder, so lookup, sending, routing, database keys, dates, IDs, and names do not work.
5. If middleware restores every token automatically, it may disclose PII to an external API that was never authorized to receive it.
6. The tool returns another payload that may contain fresh PII. That result is new input on the next model call and must be protected before it reaches the provider.
7. In a client-executed OpenAI tool loop, steps 2 and 6 normally occur across separate HTTP requests. A request-local gateway session has already been closed, so the next request does not possess the old token mapping.

The repository states the functional problem directly: `lookupCustomer({ name: token })` receives garbage unless arguments are rehydrated (`docs/research/middleware-hooks-comparison.md:373-387`). Unauthorized restoration through tool arguments and cross-session mapping bleed are security vulnerabilities, not merely quality defects (`SECURITY.md:8-18`).

### The PRD's promise was too symmetric

The PRD says tool arguments and results are in scope and should pass through “the same pipeline” (`AI_Privacy_Gateway_PRD_v3_EN.md:136-141`, `:249-275`, `:392-397`, `:438-452`). It also places streaming tool-call sanitization in the gateway MVP.

The later threat-model work corrects that model:

- arguments are a model-to-tool disclosure;
- results are tool-to-model input;
- the model provider, host application, local tool, remote SaaS API, and audit/log sink are different principals;
- restoration therefore needs a grant tied to the concrete tool/destination, entity class, and preferably schema field/path;
- argument JSON should be parsed and schema-validated, approved string leaves restored, and the object validated again;
- serialized JSON must never be edited as undifferentiated prose; and
- tool results must be treated as untrusted and protected before the next provider call.

See `docs/research/threat-model-review.md:107-113` and `docs/research/restoration-authorization-review.md:99-125`. The latter also concludes that hand-written allowlists for every field are probably unusable, proposing destination plus data-class grants with optional path constraints. It never became a shipped authorization model.

### Why serialized JSON needs a separate path

Tool arguments are often transported as a JSON string. Running ordinary span replacement over the serialized representation can invalidate it when escaping, quotes, backslashes, or boundaries are involved, and a detector can accidentally match across structural syntax. Better Privacy's gateway instead parses the JSON, walks only string leaves, protects each leaf, preserves numbers/booleans/null and keys, and serializes the tree again (`packages/gateway/src/tools.ts:1-35`, `:182-334`). It enforces default limits of 64 KiB, depth 32, and 1,000 nodes and blocks unparseable/oversized input by default (`packages/gateway/src/tools.ts:43-88`, `:130-295`). The tests cover nested objects/arrays, preserved scalar types and keys, parseability, and limit behavior (`packages/gateway/test/tools.test.ts`).

That solves structural protection on the way *to the model*. It does not authorize or perform restoration on the way *to a tool*. `packages/gateway/src/tools.ts:17-26` explicitly omits `restoreToolCalls()` because a tool is a different principal.

Streaming makes this harder. Tool argument JSON arrives in partial `tool-input-delta`/tool-call fragments; an individual fragment is not a parseable object and cannot safely be walked. It must be buffered and reassembled by tool-call ID, then parsed, authorized, selectively restored, and revalidated immediately before execution. The framework investigation identifies this work for Vercel but the shipped streaming restorer only handles text deltas (`docs/research/middleware-hooks-comparison.md:101-115`, `:345-391`; `packages/adapter-vercel/src/stream.ts`).

### What the gateway actually does

The gateway protects string leaves in tool-call arguments found in inbound conversation history before forwarding them to the provider. It does **not** restore model-emitted tool calls in completions. Ordinary assistant text can restore while the same token in `tool_calls[].function.arguments` remains a token, in both buffered and streaming responses (`packages/gateway/src/messages.ts:154-167`, `:202-245`; `packages/gateway/src/stream.ts`; `packages/gateway/test/tools.test.ts:369-456`). This is an intentional default-deny privacy decision, but it means tools that require the original value do not work.

The larger lifecycle problem remains: a gateway exchange and its sessions are request-scoped (`packages/gateway/src/chat.ts:60-165`; `packages/gateway/src/exchange.ts:39-70`, `:98-129`, `:182-207`). A normal tool round trip is:

```text
HTTP request 1 -> model emits tool call -> gateway closes request session
client executes tool
HTTP request 2 -> client sends tool result and prior tool call -> new session
```

The second request cannot redeem request 1's token. The core deliberately skips existing valid tokens during another `protect()`, so they remain opaque rather than being nested or adopted by the new session. Redis/multi-turn storage and restoration authorization beyond a request are listed as unsolved (`README.md:247-285`).

### What the adapters actually do

Vercel (`packages/adapter-vercel/`):

- `prompt.ts:1-52` protects ordinary text and textual/error-text tool results, but deliberately leaves tool-call inputs and JSON tool outputs untouched.
- `middleware.ts:157-191` restores generated text parts only; tool-call parts are passed through.
- `stream.ts` restores text deltas only; partial tool-input events are not reassembled or rehydrated.
- Its per-call protected rewrite is not persisted into application history, so raw tool results reappear and must be protected again on every subsequent call.

TanStack (`packages/adapter-tanstack/`):

- one exchange lives across an agent run, which is better for stable token identity and restoration lifetime;
- textual tool results appended to messages are protected on the next model iteration;
- `messages.ts:18-35` and its middleware tests explicitly leave `toolCalls[].arguments` unchanged;
- the adapter does not use TanStack's available `onBeforeToolCall` hook for destination-authorized rehydration; and
- structured result objects are not restored because restoration only operates on the text chunk stream (`packages/adapter-tanstack/src/index.ts`; `packages/adapter-tanstack/test/middleware.test.ts:136-145`, `:190-306`).

The hook review also found an ordering hazard: TanStack's `onBeforeToolCall` is first-win, so earlier middleware can bypass a privacy transform and silently pass a token to the tool (`docs/research/middleware-hooks-comparison.md:193-236`, `:345-369`).

### What the tool-result spike proves—and does not prove

The recorded spike used Vercel AI SDK 7.0.42 and TanStack AI 0.42. Both frameworks expose tool results to middleware on the *next* model iteration, and both can mutate the result before the provider sees it. TanStack persists the rewritten history; Vercel does not, although Vercel application code still sees the raw result in either case (`benchmarks/spikes/results/tool-results-report.md:1-25`, `:27-170`).

The spike is useful evidence for result interception, but it did not test placeholders in LLM-emitted argument JSON or a complete argument → execution → result round trip. It therefore does not solve the central rehydration problem.

### Required design for `local-pii`

The on-device SDK is in a better position than a stateless gateway because it can own the vault and tool loop locally. It should nevertheless make disclosure explicit:

1. Keep a stable session for the entire agent/tool run, not one string or model HTTP call. Close it at an explicit run boundary and isolate concurrent runs.
2. Model tool arguments and tool results as two separate APIs/directions.
3. Reassemble streamed arguments by call ID; never rewrite incomplete serialized JSON.
4. Parse and schema-validate arguments, restore only approved string leaves immediately before an authorized tool executes, then validate again.
5. Scope approval to a concrete tool/destination plus entity types and optionally field paths. Default-deny remote tools, arbitrary URLs, headers, query parameters, request bodies, and webhooks.
6. If a tool needs protected data but lacks a grant, fail loudly with a privacy diagnostic; do not silently invoke it with garbage.
7. Protect every tool result before the next model call, including JSON objects/arrays, not only text result variants.
8. Test non-streaming/streaming × arguments/results × text/structured values, repeated turns, session closure, concurrent runs, middleware ordering, and token mangling.

## 3. Token and placeholder design

### Format and security properties

The shipped shape is:

```text
[[PERSON_9G8H2K4M6P0R3T5V7X9Z4]]
           20 data characters + 1 check character
```

The 20 data characters contain 100 random bits (20 × 5) from Crockford base32. The full ID is 21 characters, and the type plus delimiters are outside it (`packages/core/src/token.ts:1-52`). This replaced the PRD's illustrative short `PER_a8f2`, whose roughly 65,000 values are enumerable. The type is deliberately readable so the model can reason coherently, at the cost of revealing the PII category to the provider (`packages/core/src/token.ts:81-86`).

Crockford base32 excludes `I`, `L`, `O`, and `U`; recognition folds case and maps common confusions (`I`/`L` → `1`, `O` → `0`). Because minted IDs never use the ambiguous letters, normalization is injective over issued tokens. A custom alphanumeric mod-31 weighted check character validates before vault lookup. The project rejected Crockford's standard mod-37 suffix because its `*`, `~`, `$`, `=`, and `U` characters are likely to be altered by models or Markdown/renderers (`packages/core/src/token.ts:12-68`; `README.md:333-352`).

This is “mangling tolerance,” not fuzzy restoration. The scanner tolerates case/confusable changes and missing `[[...]]` delimiters, then requires a valid checksum and an exact live-session lookup. There is no edit-distance, prefix, or partial matching, avoiding both wrong restoration and a token-existence oracle (`packages/core/src/token.ts:20-28`, `:93-188`). Although `canonicalizeId()` can remove Crockford visual hyphens, the current scan regex does not accept hyphens inside the fixed-width ID, so that helper's tolerance is not fully exposed by `scanTokens()`.

One-way tokens use a separate domain and are not deduplicated against reversible tokens, preventing a value seen in reversible content from making a hidden occurrence redeemable (`packages/core/src/token.ts:41-46`; `packages/core/src/guard.ts`). Entropy only prevents blind guessing; a model that has seen a token can echo it, so session authorization remains essential.

### Evidence from the mangling spike

The spike ran 840 model calls and recorded 4,200 token observations across five token formats, seven prompt shapes, and two model arms. For the shipped format, 739 tokens were echoed; 96.5% of those were intact, 3.5% mutated, and 99.9% were recoverable after tolerant recognition. Optional delimiters mattered because JSON/table rewriting often dropped brackets. The punctuation-bearing mod-37 variant recovered less reliably. Thirty-six invented identifier-shaped strings were observed and none passed checksum validation (`benchmarks/spikes/results/token-mangling-report.md`).

The results support the shipped Crockford/checksum/delimiter strategy. They do **not** directly compare it with simple readable `[TYPE_N]` counters in real tool execution, and they do not solve authorization: a token surviving JSON only ensures that the tool receives the same unusable token.

Readable counters such as `[PERSON_1]` are shorter, but are easy to invent, collide across runs, reveal repetition, and lack cryptographic unguessability/check validation. For `local-pii`, retain random checked identifiers unless a rigorous per-session alternative meets the same collision, guessing, and isolation properties. A category-opaque token could reduce length and category leakage, but would reduce model coherence; make that an explicit policy trade-off.

### Streaming restoration

Tokens may be split across arbitrary text chunks. The Vercel, TanStack, and gateway restorers keep a dynamic tail at least as long as the longest token issued in the active exchange. If a possible token straddles the proposed cut, they move the cut back to the token start; only complete tokens are scanned/restored, and the remaining buffer is flushed at end (`packages/adapter-vercel/src/stream.ts`, `packages/adapter-tanstack/src/stream.ts`, `packages/gateway/src/stream.ts`). The gateway also handles SSE and multibyte byte boundaries.

This mechanism is sound for ordinary text tokens. It does not parse or reassemble streamed tool argument JSON. Also, the default `deterministic` streaming mode scans for known tokens but does not detect newly generated provider-side PII; `buffered` mode can scan the whole response but adds full-response latency. Sliding-window output detection was explicitly not implemented because detectors do not declare a right-context contract (`packages/core/src/policy.ts:139-181`; `README.md:267-309`).

## 4. Detectors and entity types

### Canonical taxonomy

There is no closed canonical TypeScript enum; detector output and policy keys are strings. The product policies, demo contract, and benchmark mapping nevertheless converge on these names (`apps/example/src/contract.ts`; `packages/core/src/policies.ts`; `docs/research/label-mapping-matrix.md`):

Contextual/product types:

- `PERSON`
- `ADDRESS`
- `LOCATION`
- `ORGANIZATION`
- `DATE_OF_BIRTH`
- `RELATIONSHIP`

Deterministic structured types:

- `EMAIL`
- `PHONE_NUMBER`
- `IBAN`
- `CREDIT_CARD`
- `BR_CPF`
- `BR_CNPJ`
- `DE_TAX_ID`
- `IP_ADDRESS`
- `API_KEY_OR_SECRET`

The annotation manual adds zero-weight `MEDICAL_CONDITION` and `PATIENT_ID` labels for corpus completeness. Only five contextual types—everything above except `RELATIONSHIP`—are scored in detector comparisons (`datasets/annotation-manual.v1.md`; `docs/research/label-mapping-matrix.md`). `RELATIONSHIP` appears in policies but no shipped detector can honestly emit it, a capability mismatch called out in `README.md:267-285` and the example contract. `MEDICAL_FACT` appears in PRD prose but is not the runtime taxonomy.

`local-pii` should define a central closed union/registry for its supported taxonomy while still allowing namespaced custom types. A policy should be validated against detector-declared capabilities so an action for an undetectable type cannot silently imply coverage.

### Deterministic detector

`regex()` always runs locally and emits the nine structured types above (`packages/core/src/detectors/regex.ts`). Validation details are:

- CPF and CNPJ: Brazilian check digits, with invalid repeated-digit forms rejected.
- IBAN: rearrangement and mod-97 validation.
- credit card: Luhn validation.
- German tax ID: structural repetition constraints plus its arithmetic check.
- email and IP: bounded syntax checks, no external identity validation.
- secrets: only known prefixes (`sk-`, GitHub, AWS, Slack, Google, etc.); unknown formats are intentionally missed rather than guessed by entropy.
- phone: a conservative syntactic candidate only, scored lower because no checksum can prove it is a phone number.

Checksum implementations are exported from `packages/core/src/detectors/checksums.ts`; confidence scores and rule order are in `packages/core/src/detectors/regex.ts`. Earlier regex matches win overlap so a CPF/card candidate does not also become a phone number.

### Model-based sidecars

- Presidio uses its recognizers plus configured NLP models. Its native vocabulary maps `PERSON` reasonably but location is lossy, organization was configured out by default, and address/date-of-birth are vocabulary gaps. Stock sidecar NER is effectively English-first (`packages/detector-presidio/`; `docs/research/label-mapping-matrix.md`).
- GLiNER is zero-shot and is prompted with `person`, `organization`, `location`, `full address`, and `date of birth` in all three benchmark languages. Label wording and ordering materially change accuracy. Attempts to elicit relationship/kinship tended to return the related person's name and suppress correct `PERSON` spans (`packages/detector-gliner/`; `docs/research/label-mapping-matrix.md`).
- OpenMed provides medical NER. Its separate first/middle/last-name components map to multiple `PERSON` spans rather than one person, its location types collapse many-to-one, and its emitted `STREET_ADDRESS` was missing a map to canonical `ADDRESS`. German/Portuguese model licensing was also unsuitable for a clean shipped default (`packages/detector-openmed/`; `docs/research/label-mapping-matrix.md`).

The benchmark's provisional conclusion is that regex + GLiNER leads or ties 12 of 15 scored type/language cells, but all contextual results are synthetic and sidecar latency/size are server-oriented (`README.md:311-322`; `benchmarks/README.md`). On device, reuse deterministic/checksum logic first; contextual NER should be an optional local model with explicit capability, language, download-size, memory, battery, and license constraints.

## 5. Datasets and benchmarks

### Reusable corpus

`datasets/smoke/v1/` contains 1,126 synthetic JSONL documents with 4,426 annotated instances in English (`en`), German (`de`), and Brazilian Portuguese (`pt-BR`) (`datasets/README.md`):

| Set/language | en | de | pt-BR | Total |
|---|---:|---:|---:|---:|
| balanced documents | 315 | 271 | 270 | 856 |
| prevalence documents | 90 | 90 | 90 | 270 |
| all documents | 405 | 361 | 360 | 1,126 |

Gold instance counts across both sets:

| Type | en | de | pt-BR |
|---|---:|---:|---:|
| `PERSON` | 379 | 337 | 364 |
| `ADDRESS` | 155 | 195 | 162 |
| `LOCATION` | 254 | 199 | 156 |
| `ORGANIZATION` | 234 | 204 | 177 |
| `DATE_OF_BIRTH` | 155 | 150 | 155 |

`balanced.jsonl` is a diagnostic/challenge set with four to seven entities per document. `prevalence.jsonl` is intended for false-positive behavior; 120 of its 270 documents contain no annotated entity. Ninety balanced documents are hand-written adversarial cases. The generator also produces checksum-valid structured identifiers and invalid near-miss cases, although the five contextual types are the detector-ranking target (`datasets/README.md`; `datasets/annotation-manual.v1.md`).

Each line is independently loadable with `JSON.parse`:

```ts
type Record = {
  id: string
  lang: "en" | "de" | "pt-BR"
  set: "balanced" | "prevalence"
  domain: string
  template: string
  adversarial: boolean
  text: string
  entities: Array<{
    type: string
    start: number
    end: number
    distractor: boolean
  }>
}
```

The source files are `datasets/smoke/v1/balanced.jsonl` and `datasets/smoke/v1/prevalence.jsonl`; `manifest.json` summarizes counts and `LOCK.json` pins hashes. Text is NFC and spans are half-open UTF-16 code-unit offsets, so JavaScript's `text.slice(start, end)` is the correct verifier. Ten documents contain astral characters. The adjudication script once used Python code-point indices and shifted all following spans, a directly reusable regression case for React Native/Hermes (`datasets/README.md`; `datasets/adjudication.v1.md`).

The corpus is deterministic and regenerable from `datasets/spec.v1.json`, language templates, lexicons, and `datasets/generate.ts`. The frozen annotation contract is `datasets/annotation-manual.v1.md`. If copied into `local-pii`, preserve its license/provenance and `LOCK.json`, and add a loader that rejects hash, NFC, out-of-range, overlapping, or slice-mismatch errors.

### Benchmark protocol

`benchmarks/` includes frozen detector composition configs and hashes, committed raw native detector outputs, a TypeScript scoring harness using the shipped adapters/UTF-16 offset mapping, latency tests, and two focused spikes (`benchmarks/README.md`). Accuracy reports per language, scored type, and detector combination:

- TP, FP, and FN;
- precision, recall, and F1;
- strict span matching and overlap matching; and
- Wilson recall intervals.

It intentionally does not publish one overall F1: entity mix would make that number easy to distort. Latency reports p50/p95 from 300 serial requests plus concurrency runs. The README's representative p95 figures are roughly 10 ms for Presidio and 267 ms for GLiNER on the measured workstation, with no cold-start claim (`README.md:311-322`; `benchmarks/README.md`; `benchmarks/results/`).

The benchmark is good for regression and eliminating badly failing designs, not for public performance claims. It is synthetic, common-name-heavy, demographically incomplete, label-cued, sometimes semantically incoherent, and soft on address boundaries. A second annotation pass covered only 48/1,126 documents and used the same model family, not independent human annotators (`datasets/README.md`; `datasets/adjudication.v1.md`). Differences below roughly ten points are not reliably resolvable.

For `local-pii`, reuse it as a versioned test corpus, then add mobile-specific cases: realistic chat history, contacts/clipboard/free-form notes, rare and demographically broader names, additional target languages, JSON tool arguments/results, tokens split across stream chunks, Hermes Unicode behavior, and device latency/memory/energy measurements.

## 6. Limitations and lessons for an on-device SDK

### Explicitly documented limitations

The repository is unusually candid in `README.md:267-309`, `SECURITY.md`, and the detector/dataset research:

An exact repository-wide search for `TODO`, `FIXME`, and `KNOWN ISSUE(S)` found no substantive implementation backlog markers; the meaningful gaps are documented in API comments, tests, README limitations, and research reviews instead.

- Detection is never complete; false negatives are quality failures even when not security vulnerabilities under the narrow disclosure model.
- Tokenization is pseudonymization, not anonymization. It preserves linkable structure and may expose the entity category.
- Restoration authority is delegated to the trusted host process; durable/multi-turn authorization is unsolved.
- Session checks stop cross-request/invented-token restoration but do not decide whether a downstream tool is allowed to receive PII.
- The product names `RELATIONSHIP` although no shipped detector emits it.
- Default streaming only restores known tokens; it does not scan model output for new PII. Buffered scanning incurs full-response latency, while sliding-window scanning lacks a detector context contract.
- Images, audio, video, document/file parts, and several structured framework outputs are unscanned.
- Provider-retained state such as `store`/`previous_response_id` can outlive the local mapping and is blocked/stripped by policy rather than made safe.
- Sidecars see raw PII and enlarge the trusted computing base; large model downloads, language coverage, and licensing are real deployment constraints.
- Safe reports avoid original values, but detector exceptions and upstream logs/traces can still quote PII if not sanitized.
- All comparative accuracy evidence is synthetic; there is no compliance certification or guarantee.

### Adopt in `local-pii`

- NFC normalization and UTF-16 offsets end to end, with astral-character fixtures.
- Small deterministic detectors with checksum validation and conservative scores.
- Exact random token lookup with checksum validation; no fuzzy restoration.
- Explicit session isolation, closure, concurrency tests, and stable identity within one agent run.
- Existing-token suppression to avoid nested re-tokenization.
- Deterministic overlap arbitration and safe evidence that records suppressed spans and degraded detectors without originals.
- Detector capability declarations and policy validation against them.
- Structured tree walkers for JSON-like inputs, with size/depth/node limits.
- Tool-specific authorization and lifecycle APIs as first-class core design, not adapter glue.
- Fail-loud modes for unscannable or unauthorized disclosure paths, with a deliberately chosen pass/report/block policy.

### Avoid or change

- Do not copy the request-scoped gateway session model into an agent SDK. A tool run is the minimum useful restoration lifetime.
- Do not claim tool coverage merely because placeholders are JSON-safe or tool results can be intercepted on the next turn.
- Do not blindly restore tokens into every tool argument, URL, header, or webhook.
- Do not run detectors across serialized JSON and hope replacements preserve syntax.
- Do not make server sidecars the on-device baseline. Keep contextual NER optional and honestly declare its language/model constraints.
- Do not expose policy entity names that no installed detector can emit.
- Do not use one aggregate F1 or challenge-set precision as a product-quality claim.
- Do not log plaintext mappings or error objects that may embed the original input.

### Why the design feels “too verbose”

The repository does not use that exact phrase, so this is an inference from its API and implementation rather than a quoted postmortem.

There are two kinds of verbosity:

1. **Wire/prompt verbosity.** A full token is the entity type plus 26 fixed wrapper/ID characters. Typical examples are 31–43 characters (`EMAIL` through `API_KEY_OR_SECRET`), so a short name, date, or ID can expand substantially. Recursive protection can place one such token in every string leaf and repeat them through agent history. The explicit type helps model coherence and debugging but leaks category and consumes tokens.
2. **Integration/cognitive verbosity.** The promised one-line middleware expands into policies, five actions, detector capabilities, normalization and offset rules, overlap arbitration, reports, failure modes, provider-retention rules, per-string/per-call/per-run sessions, framework-specific message walkers, streaming holdback, and `finally`/abort cleanup. Tool calls add destination authorization, schemas, partial-JSON assembly, and cross-turn lifetime. The Vercel, TanStack, and gateway integrations consequently have different coverage and semantics.

The source itself warns that tokenizing everything makes the model reason about placeholders and reduces usefulness (`packages/core/src/policies.ts:1-14`). `local-pii` should keep the safe internals but present a smaller default surface: a compact standard taxonomy/policy, deterministic local detection, one explicit run-scoped vault, and separate `protectModelInput`, `prepareToolCall`, `protectToolResult`, and `restoreModelOutput` operations (names illustrative). Advanced detector/policy/report controls can remain opt-in.

## Bottom line

Better Privacy successfully demonstrates reversible, high-entropy, model-tolerant placeholders; careful Unicode/span handling; useful deterministic detectors; and a reusable multilingual synthetic corpus. Its hardest failure is also its best lesson: an intact placeholder in a function call is not success. Correct tool support requires a live mapping for the whole agent run, parsed structured arguments, explicit authorization for the concrete tool destination, selective just-in-time restoration, and immediate re-protection of tool results. The shipped server gateway and adapters stop short of that end-to-end contract. `local-pii` should make that contract foundational while keeping the public API substantially smaller.
