# expo-pii — Implementation Plan

On-device PII anonymization SDK for Expo/React Native. Text is anonymized locally (deterministic detectors + Rampart NER + user dictionary), only placeholder text goes to the cloud LLM, and the response is rehydrated locally. The placeholder→value mapping never leaves the device.

This plan is written for autonomous execution (Opus). Every open decision has a chosen default — do not pause to ask; follow the defaults and note deviations in commit messages.

---

## 1. Rampart model: confirmed facts vs. assumptions

The model is real and public. This is the single most important research finding: **`nationaldesignstudio/rampart` exists on HuggingFace with the exact Q4 ONNX artifact (14.7 MB), full tokenizer files, and a published 35-tag BIO label set.** We do not need a fallback model.

### Confirmed facts (verified against primary sources)

| Fact | Value | Source |
|---|---|---|
| HF repo | `nationaldesignstudio/rampart` | https://huggingface.co/nationaldesignstudio/rampart |
| ONNX artifact | `onnx/model_q4.onnx`, **14.7 MB**, 4-bit MatMul + INT8 embeddings (only file in `onnx/`) | HF file tree `/tree/main/onnx` |
| Architecture | `BertForTokenClassification`, fine-tune of `nreimers/MiniLM-L6-H384-uncased`: hidden 384, 6 layers, 12 heads, ~18.5M params | `config.json` (raw) |
| Vocab | 19,730 WordPieces (trimmed from BERT-uncased 30,522); `vocab.txt` (135 kB), `tokenizer.json` (442 kB), `tokenizer_config.json`, `special_tokens_map.json` all published | HF file tree + model card |
| Tokenizer | `BertTokenizer` (WordPiece), `do_lower_case: true`, `strip_accents: null` (→ strips accents because lowercasing, per BERT semantics: lowercase + NFD/NFKD decomposition + combining-mark removal), `do_basic_tokenize: true`, `tokenize_chinese_chars: true` | `tokenizer_config.json` (raw) |
| Max sequence | 512 tokens (`max_position_embeddings: 512`) | `config.json`, model card |
| Label set | 35 BIO tags = `O` + B/I for **17 types** (exact id2label below) | `config.json` (raw) |
| Deterministic layer (upstream design) | SSN (structural + reserved-area rejection), credit card (Luhn), email, URL, IP (v4/v6/MAC) are handled by regex and **premasked to sentinel tokens before the model runs** ("the model never learns to classify raw card/SSN/IP digits") | model card / README, GitHub `nationaldesignstudio/rampart` |
| Placeholders | Upstream uses `[ENTITY_TYPE_N]` format (`[GIVEN_NAME_1]`, `[SSN_1]`) with multi-turn stable placeholders + client rehydration | model card |
| Default keep-list | `CITY`, `STATE`, `ZIP_CODE` are tagged by the model but **kept** (not redacted) by default upstream | model card |
| Languages | EN, ES, FR, DE, IT, PT, NL (Latin-script). Per-language private-term recall: EN 98.85%, ES 98.84%, FR 98.41%, DE 97.94%, IT 97.83%, PT 97.73%, NL 97.21% | model card |
| Known limits | Non-Latin scripts ~13.7% recall; government-style IDs rely on model only (~67.6%); zero-width/adversarial injection not caught | model card |
| License | **CC BY 4.0** (model + training data OpenPII 1.5M) — redistribution allowed with attribution | model card, LICENSE |
| Upstream JS package | `@nationaldesignstudio/rampart` on npm (`createGuard()` / `protect()` / `reveal()`), peer-dep `@huggingface/transformers`, browser/Node — **not** RN-compatible | GitHub repo |
| Reference perf | p50 3.9 ms (WebGPU) / 12.6 ms (WASM) in browser | model card |
| rampart-mlx | The `OsaurusAI/rampart-mlx` FP16/MLX conversion was **not found** in current search of OsaurusAI's HF org. Irrelevant to us (we use ONNX); do not depend on it. | HF search |

Secondary sources: whitepaper https://inference.ndstudio.gov/rampart/whitepaper.pdf, announcement https://ndstudio.gov/posts/say-hello-to-rampart, integration writeup https://blog.arcjet.com/running-pii-detection-locally-with-the-rampart-ner-model/ (Arcjet chunk inputs at 480 chars with 64-char overlap and reconstruct offsets by stripping `##` prefixes — useful prior art).

### Exact id2label (from `config.json` — commit as `labels.json`)

```
0:O  1:B-GIVEN_NAME 2:I-GIVEN_NAME 3:B-SURNAME 4:I-SURNAME 5:B-EMAIL 6:I-EMAIL
7:B-PHONE 8:I-PHONE 9:B-URL 10:I-URL 11:B-TAX_ID 12:I-TAX_ID 13:B-BANK_ACCOUNT
14:I-BANK_ACCOUNT 15:B-ROUTING_NUMBER 16:I-ROUTING_NUMBER 17:B-GOVERNMENT_ID
18:I-GOVERNMENT_ID 19:B-PASSPORT 20:I-PASSPORT 21:B-DRIVERS_LICENSE 22:I-DRIVERS_LICENSE
23:B-BUILDING_NUMBER 24:I-BUILDING_NUMBER 25:B-STREET_NAME 26:I-STREET_NAME
27:B-SECONDARY_ADDRESS 28:I-SECONDARY_ADDRESS 29:B-CITY 30:I-CITY 31:B-STATE
32:I-STATE 33:B-ZIP_CODE 34:I-ZIP_CODE
```

### Assumptions (explicitly unverified — verify in Phase 2, cheap to correct)

| Assumption | Confidence | Mitigation |
|---|---|---|
| ONNX input tensors are `input_ids`, `attention_mask`, `token_type_ids` (int64, `[batch, seq]`); output `logits` (float32, `[batch, seq, 35]`) | High (standard HF BertForTokenClassification export; card says "runs via transformers.js") but **not documented** | Never hardcode blindly: read `session.inputNames` / `session.outputNames` at runtime; feed `token_type_ids` zeros only if present. Phase 2 has a Node test that asserts/prints the real names. |
| `model_q4.onnx` runs on onnxruntime CPU EP on mobile (Q4 MatMulNBits ops supported by ORT ≥1.17) | Medium-high | Phase 2 proves it in Node with `onnxruntime-node` first; if a mobile op is unsupported, fall back to requesting/int8-quantizing from upstream fp32 via `optimum` (documented in Risks). |
| npm name `expo-pii` is available | Unknown | Dev under workspace name; if taken at publish time use `@expo-pii/sdk` — no code change needed. |

---

## 2. Ecosystem research findings (drives the design below)

- **onnxruntime-react-native**: current npm `1.24.x` (https://www.npmjs.com/package/onnxruntime-react-native). Standard autolinked native module — works with **Expo prebuild / dev client, NOT Expo Go**. It does **NOT ship an Expo config plugin**; adding it to `app.json > plugins` fails with "does not contain a valid config plugin" (https://github.com/microsoft/onnxruntime-inference-examples/issues/548). Do not add it to `plugins`; plain install + prebuild is the path. Its JS API implements the shared `onnxruntime-common` interface (`InferenceSession.create(path)`, `ort.Tensor`), same as `onnxruntime-node` — this is what makes our NER core testable in Node.
- **Model asset loading in Expo**: add `onnx` to Metro `resolver.assetExts`, `require()` the model, resolve with `expo-asset` (`Asset.fromModule(...).downloadAsync()` → `localUri`). **Known bug**: in standalone iOS builds `InferenceSession.create()` fails on `file://` paths inside the app bundle — copy the file to `FileSystem.cacheDirectory` first (https://github.com/microsoft/onnxruntime/issues/26738, https://github.com/microsoft/onnxruntime/issues/27062). Our loader always copies to cache and strips the `file://` prefix.
- **int64 tensors on Hermes**: `input_ids` must be int64 (`BigInt64Array`). Hermes historically lacks `BigInt64Array` ("Can't find variable: BigInt64Array", https://github.com/microsoft/onnxruntime/issues/14770), though it has `BigInt`. Mitigation: feature-detect; fallback helper writes little-endian int64 pairs into an `ArrayBuffer` via two `Uint32Array` writes (all token ids < 2^31, no BigInt needed) and constructs the tensor from a typed-array view over that buffer.
- **Tokenizer**: `@huggingface/transformers` (transformers.js) is not RN-ready without shims (https://github.com/huggingface/transformers.js/issues/858; the shim package `@automatalabs/react-native-transformers` exists but drags heavy deps). The npm `tokenizers` package is native/Node-only; `bert-tokenizer` is stale and offset-less. **Decision: write our own ~250-line pure-TS BERT WordPiece tokenizer** with original-text offset tracking, golden-tested against transformers.js in Node (dev-only). Vocab is only 135 kB — ship it as JSON inside the model package.
- **Expo packaging**: no custom native code is needed, so **skip `create-expo-module` / `expo-modules-core` entirely**. `expo-pii` is a pure-TS package with peer deps on `onnxruntime-react-native`, `expo-asset`, `expo-file-system`. The only "native-ish" requirement is the Metro `assetExts` line — ship a `withExpoPiiMetro(config)` helper (config plugins cannot modify metro.config, so a documented helper is the honest mechanism).
- **Expo SDK (Aug 2026)**: SDK 54 (Sep 2025, last with legacy arch), SDK 55 (Feb 2026), SDK 56 current (https://expo.dev/changelog/sdk-56). Example app targets **latest stable via `create-expo-app` default**; library peer range supports SDK ≥52.
- **Monorepo**: this repo is already a Turborepo + **Bun workspaces** template (`packageManager: bun@1.3.14`, `bun.lock`, `apps/web` Next.js + shadcn, `packages/{ui,eslint-config,typescript-config}`). **Keep Bun** — its hoisted `node_modules` layout is Metro-friendly, Expo supports it, and switching to pnpm is churn with no benefit here. Keep Turborepo. `apps/web` stays untouched (future web playground for `@expo-pii/core`, out of scope).
- **Prior art — `better-privacy`** (the user's earlier backend attempt, https://github.com/CarlosZiegler/better-privacy, docs https://better-privacy-docs.carlos-ziegler-13d.workers.dev/): API is `createGuard({ policy: definePolicy({ id, version, detectors, actions }) })` → `guard.protect()` / `guard.restore(answer, session)` / `session.close()`, tokens like `[[PERSON_9G8H2K...]]` (Crockford base32, 100 bits), mapping hidden inside an opaque session, deployed as a self-hosted OpenAI-compatible gateway. **Lessons for expo-pii DX**: (1) the policy/actions/version ceremony is the verbosity the user complained about — default everything, make policy optional; (2) opaque sessions make sense server-side but on-device the mapping can and should be a plain inspectable object; (3) long random tokens are mangle-proof but unreadable and hurt LLM reasoning — default to short readable placeholders; (4) the `protect → call model → restore` triangle and the AI-SDK middleware idea are worth keeping.

---

## 3. Domain model / ubiquitous language

| Term | Definition |
|---|---|
| **Span** | Half-open range `[start, end)` in UTF-16 code units of the original text, plus the covered `text`. |
| **PiiType** | Canonical category of PII (string union below). |
| **Entity** | A detected Span with a `type`, `source` (`'deterministic' \| 'ner' \| 'dictionary'`), and `confidence` (0–1). |
| **Detector** | Anything that maps text → Entity[]. Deterministic detectors are sync/pure; the NER backend is async. |
| **NerBackend** | Pluggable async detector wrapping a model (Rampart/ONNX is the first implementation; a no-op backend is the default). |
| **Dictionary** | User-supplied exact terms (name, employer, family…) with a type; highest priority detector. |
| **Placeholder** | The token that replaces an entity in outgoing text, e.g. `[GIVEN_NAME_1]`. |
| **PlaceholderStrategy** | Pluggable policy that generates placeholders (`sequential`, `hashed`, custom). |
| **Vault** | In-memory bidirectional store: `(type, canonicalValue) → placeholder` and `placeholder → original raw value`. Never serialized off-device by the SDK. |
| **Mapping** | Plain serializable snapshot of the Vault's reverse index: `Record<placeholder, original>`. What `rehydrate` consumes. |
| **Anonymize** | text → pipeline → `{ redactedText, entities, mapping }`. |
| **Rehydrate** | Replace placeholders in LLM output with originals using a Mapping. Pure function. |
| **Session** | Stateful wrapper keeping one Vault across multiple turns so `João` is `[GIVEN_NAME_1]` in every message. |
| **Pipeline** | The ordered stages: deterministic → premask → NER → dictionary merge → span resolution → placeholder replacement. |
| **Premask** | Replacing deterministic entities with their placeholders *before* NER runs (matches Rampart's training distribution), with a segment map to translate NER offsets back. |

### Canonical PiiType

Rampart's 17 types + the deterministic-only types + escape hatch. Keep names identical to Rampart's labels (zero mapping needed):

```ts
export type PiiType =
  // NER (Rampart head)
  | 'GIVEN_NAME' | 'SURNAME' | 'EMAIL' | 'PHONE' | 'URL'
  | 'TAX_ID' | 'BANK_ACCOUNT' | 'ROUTING_NUMBER' | 'GOVERNMENT_ID'
  | 'PASSPORT' | 'DRIVERS_LICENSE'
  | 'BUILDING_NUMBER' | 'STREET_NAME' | 'SECONDARY_ADDRESS'
  | 'CITY' | 'STATE' | 'ZIP_CODE'
  // deterministic-only
  | 'SSN' | 'CREDIT_CARD' | 'IP_ADDRESS' | 'IBAN'
  // dictionary / custom
  | 'PERSON' | 'ORGANIZATION' | 'CUSTOM'
  | (string & {});  // user-defined types allowed
```

Default redaction policy mirrors upstream: redact everything **except** `CITY`, `STATE`, `ZIP_CODE` (configurable via `keep` / `redact` options).

---

## 4. Public SDK API

Design goals (AI-SDK-quality DX): zero-config happy path, sync creation with lazy model load, graceful degradation when the model isn't available, plain-data results, pure `rehydrate`, everything pluggable but nothing required.

### Happy path (~10 lines)

```ts
import { createAnonymizer, rehydrate } from 'expo-pii';
import { rampart } from 'expo-pii/rampart';

const anonymizer = createAnonymizer({ ner: rampart() });

const { redactedText, mapping } = await anonymizer.anonymize(
  'Ontem encontrei João Silva. Meu telefone é +49 151 12345678.'
);
// → "Ontem encontrei [GIVEN_NAME_1] [SURNAME_1]. Meu telefone é [PHONE_1]."
const reply = await callLlm(redactedText);      // only anonymized text leaves the device
const restored = rehydrate(reply, mapping);     // mapping never left the device
```

`rampart()` lives in the subpath `expo-pii/rampart` so importing the main entry never touches `onnxruntime-react-native` (regex-only users, web, Node all work without native modules).

### Core signatures (implemented in `@expo-pii/core`, re-exported by `expo-pii`)

```ts
// ── data types ─────────────────────────────────────────────────────────────
interface Span { start: number; end: number; text: string }
interface Entity extends Span {
  type: PiiType;
  source: 'deterministic' | 'ner' | 'dictionary';
  confidence: number;               // 1 for deterministic/dictionary
}
type Mapping = Record<string, string>;          // placeholder -> original
interface AnonymizeResult {
  redactedText: string;
  entities: Entity[];               // resolved, non-overlapping, sorted by start
  mapping: Mapping;                 // snapshot; safe to hold in memory only
}

// ── pluggable pieces ───────────────────────────────────────────────────────
interface Detector {
  name: string;
  type: PiiType;
  detect(text: string): Entity[];   // sync, pure
}
interface NerBackend {
  name: string;
  load(): Promise<void>;            // idempotent; called lazily
  detect(text: string): Promise<Entity[]>;
  dispose(): Promise<void>;
}
interface PlaceholderStrategy {
  /** Deterministic token for a (type, value); index = per-type 1-based first-occurrence counter. */
  placeholderFor(type: PiiType, value: string, index: number): string;
  /** Regex matching any placeholder this strategy emits (used by rehydrate + premask protection). */
  pattern(): RegExp;
}
interface DictionaryEntry {
  value: string; type?: PiiType;    // default 'CUSTOM'
  caseSensitive?: boolean;          // default false
  wholeWord?: boolean;              // default true
}

// ── construction ───────────────────────────────────────────────────────────
interface AnonymizerOptions {
  detectors?: Detector[] | 'default' | 'none';   // default: all built-ins
  ner?: NerBackend | false;                      // default: false (regex+dict only)
  dictionary?: DictionaryEntry[];
  placeholders?: PlaceholderStrategy;            // default: sequential()
  keep?: PiiType[];                              // default: ['CITY','STATE','ZIP_CODE']
  redact?: PiiType[];                            // overrides keep for listed types
  nerThreshold?: number;                         // default 0 (argmax; recall-first)
  strict?: boolean;   // default false: if NER fails to load, degrade to deterministic-only
  onDegraded?: (error: Error) => void;
}

function createAnonymizer(options?: AnonymizerOptions): Anonymizer;  // sync, cheap

interface Anonymizer {
  anonymize(text: string, opts?: { signal?: AbortSignal }): Promise<AnonymizeResult>;
  anonymizeSync(text: string): AnonymizeResult;  // deterministic + dictionary only
  warmup(): Promise<void>;                       // preload NER (optional)
  readonly status: 'idle' | 'loading' | 'ready' | 'degraded';
  addDictionaryEntries(entries: DictionaryEntry[]): void;
  createSession(): PiiSession;
  dispose(): Promise<void>;
}

// ── multi-turn ─────────────────────────────────────────────────────────────
interface PiiSession {
  anonymize(text: string): Promise<AnonymizeResult>;  // shared Vault: stable numbering
  rehydrate(text: string, opts?: RehydrateOptions): string;
  readonly mapping: Readonly<Mapping>;
  clear(): void;
}

// ── pure functions ─────────────────────────────────────────────────────────
interface RehydrateOptions { lenient?: boolean }  // also match bracket-mangled tokens
function rehydrate(text: string, mapping: Mapping, opts?: RehydrateOptions): string;

// built-in detectors (each individually importable/composable)
function emailDetector(): Detector;
function urlDetector(): Detector;
function ipAddressDetector(): Detector;          // v4 + v6
function ssnDetector(): Detector;                // structural + reserved-area rejection
function creditCardDetector(): Detector;         // 13–19 digits + Luhn
function ibanDetector(): Detector;               // per-country length + mod-97
function phoneDetector(): Detector;              // conservative: international formats only
function defaultDetectors(): Detector[];

// placeholder strategies
function sequential(): PlaceholderStrategy;                          // [GIVEN_NAME_1]
function hashed(opts: { secret: Uint8Array; length?: number }): PlaceholderStrategy; // [GIVEN_NAME_a3f2]
```

### `expo-pii/rampart` (RN-only subpath)

```ts
interface RampartOptions {
  /** default: asset from @expo-pii/model-rampart */
  model?: number | string;              // require() asset id or absolute file path
  executionProviders?: ('cpu' | 'xnnpack' | 'coreml' | 'nnapi')[];  // default: platform CPU
  maxTokens?: number;                   // default 512 (chunking handles longer text)
}
function rampart(options?: RampartOptions): NerBackend;

// metro helper (documented in README; config plugins can't touch metro.config)
// metro.config.js:  module.exports = withExpoPiiMetro(getDefaultConfig(__dirname));
function withExpoPiiMetro<T extends MetroConfig>(config: T): T;

// optional helper for the hashed strategy (expo-crypto + expo-secure-store)
function getOrCreateDeviceSecret(key?: string): Promise<Uint8Array>;
```

`@expo-pii/core` additionally exports `createRampartNer({ ort, modelPath, vocab, labels })` taking any `onnxruntime-common`-compatible module — this is how Node tests run the identical NER code with `onnxruntime-node`, and how `expo-pii/rampart` wires `onnxruntime-react-native`.

### Placeholder strategies (and the hashing security nuance)

Two built-ins behind `PlaceholderStrategy`:

1. **`sequential()` — DEFAULT.** `[TYPE_N]`, numbered per type by first occurrence. Leaks nothing (numbers carry zero information about the value), is human-readable, and short readable tokens are what LLMs reason about best ("call [GIVEN_NAME_1] tomorrow" survives paraphrase). Stable within a Session; resets across sessions.

2. **`hashed({ secret })` — opt-in.** `[TYPE_xxxx]` where `xxxx = hex(HMAC-SHA256(secret, type + '\0' + canonicalValue))` truncated to `length` (default 4) hex chars, with deterministic lengthening on collision (extend to 6, 8… until unique in the Vault). Gives **stable IDs across sessions and devices sharing the secret** and deduplication without a stored counter.

   **Security analysis (must be documented in the SDK README verbatim in spirit):**
   - A **plain hash of the raw value (e.g. `sha256(email)`) is a privacy leak, worse than sequential numbering.** Placeholders are sent to the LLM provider; PII values have low entropy (names, phones, emails are guessable/enumerable), so anyone holding the placeholder can confirm a guessed value offline by recomputing the hash — a classic rainbow/dictionary attack. Never offer an unkeyed hash mode.
   - The safe variant is a **keyed hash (HMAC) with a random ≥128-bit secret generated on device** (via `expo-crypto`, persisted in `expo-secure-store` through `getOrCreateDeviceSecret()`), which **never leaves the device**. Without the key, the placeholder is not verifiable even with a correct guess.
   - Residual leak to document: HMAC placeholders still reveal **equality** — the provider can see that two conversations mention the same entity. That linkability is exactly the feature (stable cross-session IDs), but it is more metadata than `sequential` leaks. Hence sequential stays the default.
   - Truncation to 4 hex chars is fine: collisions are a local correctness concern (handled by lengthening), not a security one — the attacker gains nothing from collisions.

Custom strategies just implement the interface; `pattern()` lets `rehydrate` and the premask stage recognize foreign placeholder shapes.

---

## 5. Monorepo & package structure

Keep the existing Bun + Turborepo skeleton; add three packages and one app. `@workspace/ui`, `apps/web`, eslint/ts-config packages remain untouched.

```
expo-pii/                              # repo root (bun@1.3.14 workspaces, turbo)
├── package.json                       # + "test": "turbo test"
├── turbo.json                         # + test task; build outputs dist/**
├── bun.lock
├── PLAN.md
├── scripts/
│   └── fetch-model.mjs                # downloads model_q4.onnx + tokenizer from HF, sha256-pinned
├── apps/
│   ├── web/                           # existing Next.js template — untouched
│   └── example/                       # NEW: Expo example app (Phase 4)
│       ├── app.json                   # newArchEnabled, bundle ids
│       ├── metro.config.js            # withExpoPiiMetro(getDefaultConfig(__dirname))
│       ├── package.json               # expo (latest stable), expo-dev-client, onnxruntime-react-native
│       ├── app/                       # expo-router: index.tsx (demo), settings.tsx
│       └── src/llm.ts                 # mock echo LLM + optional OpenAI-compatible call
└── packages/
    ├── core/                          # @expo-pii/core — pure TS, runs anywhere
    │   ├── package.json               # deps: @noble/hashes; devDeps: onnxruntime-node, vitest
    │   ├── tsconfig.json              # extends @workspace/typescript-config/base.json
    │   ├── tsdown.config.ts           # esm+cjs+dts
    │   ├── vitest.config.ts
    │   ├── src/
    │   │   ├── index.ts
    │   │   ├── types.ts               # PiiType, Span, Entity, Detector, Mapping, options
    │   │   ├── anonymizer.ts          # createAnonymizer + pipeline orchestration
    │   │   ├── session.ts             # PiiSession + Vault
    │   │   ├── rehydrate.ts
    │   │   ├── pipeline/
    │   │   │   ├── merge.ts           # overlap resolution (§6)
    │   │   │   └── replace.ts         # span replacement + segment offset map
    │   │   ├── placeholders/
    │   │   │   ├── strategy.ts
    │   │   │   ├── sequential.ts
    │   │   │   └── hashed.ts          # HMAC-SHA256 via @noble/hashes
    │   │   ├── detectors/
    │   │   │   ├── email.ts  url.ts  ip.ts  ssn.ts  credit-card.ts  iban.ts  phone.ts
    │   │   │   ├── dictionary.ts
    │   │   │   └── index.ts           # defaultDetectors()
    │   │   ├── tokenizer/
    │   │   │   ├── normalize.ts       # lowercase + NFD strip accents, with index map
    │   │   │   └── wordpiece.ts       # BertWordPiece with original-text offsets
    │   │   └── ner/
    │   │       ├── backend.ts         # NerBackend, NoopNer
    │   │       ├── rampart.ts         # createRampartNer({ ort, modelPath, vocab, labels })
    │   │       ├── bio.ts             # argmax/softmax + BIO aggregation
    │   │       └── chunk.ts           # 512-token windows, stride 384, overlap dedupe
    │   └── test/                      # *.test.ts per module + fixtures/
    │       └── fixtures/tokenizer-golden.json
    ├── model-rampart/                 # @expo-pii/model-rampart — assets only
    │   ├── package.json               # files: ["assets", "*.js", "*.d.ts"]; no deps
    │   ├── index.js                   # module.exports = { model: require('./assets/rampart-q4.onnx'), vocab, labels, ATTRIBUTION }
    │   ├── index.d.ts
    │   ├── assets/
    │   │   ├── rampart-q4.onnx        # 14.7 MB — GITIGNORED, fetched by script, INCLUDED in npm publish
    │   │   ├── vocab.json             # generated from vocab.txt (array of 19,730 strings)
    │   │   ├── tokenizer-config.json  # do_lower_case etc. (subset we need)
    │   │   └── labels.json            # id2label from config.json
    │   └── NOTICE.md                  # CC BY 4.0 attribution to National Design Studio
    └── expo-pii/                      # expo-pii — the SDK (pure TS, no native code)
        ├── package.json               # dep: @expo-pii/core; peerDeps: onnxruntime-react-native,
        │                              #   expo-asset, expo-file-system, react-native,
        │                              #   @expo-pii/model-rampart (optional), expo-crypto (optional),
        │                              #   expo-secure-store (optional)
        ├── tsdown.config.ts
        ├── src/
        │   ├── index.ts               # re-export all of @expo-pii/core (NO ort import here)
        │   ├── rampart.ts             # rampart(): wires onnxruntime-react-native + model asset
        │   ├── model-loader.ts        # Asset.fromModule → downloadAsync → copy to cacheDirectory
        │   ├── int64.ts               # BigInt64Array feature-detect + Uint32-pair fallback
        │   ├── secret.ts              # getOrCreateDeviceSecret()
        │   └── metro.ts               # withExpoPiiMetro (exported as "expo-pii/metro")
        └── test/                      # int64 encoding, metro helper (Node-testable parts)
```

Tooling decisions: **Bun** workspaces (keep), **Turborepo** (keep; add `test` task), **tsdown** builds for `core` and `expo-pii`, **Vitest** for tests (run under Node ≥20), existing **eslint + prettier** workspace configs (do not introduce Biome — the template is already wired). `create-expo-module` is intentionally not used (no native code).

`scripts/fetch-model.mjs`: downloads `https://huggingface.co/nationaldesignstudio/rampart/resolve/main/onnx/model_q4.onnx` (+ `vocab.txt`, `config.json`, `tokenizer_config.json`) into `packages/model-rampart/assets/`, converts `vocab.txt`→`vocab.json` and `config.json`→`labels.json`, verifies sha256 (record the actual hashes on first successful fetch and pin them in the script). Wire as root script `bun run fetch-model`; Phase 2+ tests skip gracefully with a clear message when assets are missing (CI caches them).

---

## 6. Layered architecture & the pipeline

```
                    @expo-pii/core (pure TS)
┌─────────────────────────────────────────────────────────────┐
│ input text                                                  │
│   │ 1. deterministic detectors (email, URL, IP, SSN,        │
│   │    credit card+Luhn, IBAN mod-97, intl phone)           │
│   │ 2. dictionary detector (user terms)                     │
│   ▼                                                         │
│ premask: resolve+replace det+dict spans with placeholders   │
│   │      keep SegmentMap: masked offsets ⇄ original offsets │
│   ▼                                                         │
│ 3. NER backend (pluggable; Rampart ONNX)                    │
│    tokenizer(offsets) → 512-tok chunks → logits → BIO       │
│    → spans in masked text → mapped back via SegmentMap;     │
│    spans touching a premasked segment are dropped           │
│   ▼                                                         │
│ 4. merge & overlap resolution (all sources, original text)  │
│   ▼                                                         │
│ 5. placeholder engine (strategy + Vault, stable numbering)  │
│   ▼                                                         │
│ redactedText + entities + mapping ──► cloud LLM             │
│                                                             │
│ LLM reply ──► rehydrate(reply, mapping) ──► restored text   │
└─────────────────────────────────────────────────────────────┘
   expo-pii (RN glue): asset loading, ORT session, int64, metro
```

Premasking before NER is not an optimization — Rampart was **trained** with deterministic classes masked to sentinels, so feeding raw SSNs/cards to the model is out-of-distribution. We premask with the *final* placeholders (they're stable anyway), so stage 5 only needs to place the remaining NER placeholders.

### Span merge / overlap resolution (precise)

Inputs: entities from all sources over the **original** text. Offsets are UTF-16 code units (JS string indexing; emoji-safe because all detectors and the tokenizer report code-unit offsets from the same string).

1. **NER post-processing** (before merging): (a) aggregate BIO — a `B-X` starts an entity; following `I-X` tokens extend it; tokens of the same type separated only by whitespace merge into one span (upstream behavior); an `I-X` without a preceding `B-X` starts a new entity (robustness); (b) trim leading/trailing whitespace and enclosing punctuation from each span; (c) drop entities of kept types (`keep` list) and entities below `nerThreshold`.
2. **Priority**: `dictionary = 3`, `deterministic = 2`, `ner = 1`. Rationale: explicit user intent always wins; checksum-validated patterns beat model guesses.
3. **Sort candidates** by `(priority desc, span length desc, confidence desc, start asc)`.
4. **Greedy interval selection**: walk the sorted list; accept an entity iff it does not overlap any already-accepted span (`a.start < b.end && b.start < a.end`). Identical spans from two sources: higher priority accepted first, duplicate rejected by the overlap test. This is deterministic and total.
5. **Output**: accepted entities sorted by `start` asc.

### Placeholder assignment & numbering (stable)

- Canonical key: `type + '\0' + canonicalize(value)` where `canonicalize` = NFC → trim → collapse inner whitespace → for name-like types (`GIVEN_NAME, SURNAME, PERSON, CITY, STATE, STREET_NAME, ORGANIZATION, CUSTOM`) case-fold; numeric/identifier types keep exact case but strip separators (spaces/dashes) for `CREDIT_CARD`/`IBAN`/`PHONE` so `+49 151…` and `+49151…` share one placeholder.
- Vault stores `key → placeholder` and `placeholder → first-seen raw value` (rehydration restores the first-seen original form).
- `sequential`: per-type counter incremented in order of first occurrence by ascending `start` across the Session's lifetime.
- Replacement is done in a single left-to-right pass building the output string from slices (never in-place), producing the SegmentMap `{origStart, origEnd, newStart, newEnd, placeholder?}[]` used to map NER offsets back through the premasked text.

### Rehydrate (reverse path)

Build one regex from mapping keys (longest key first, all escaped, global). Strict mode matches exact placeholders; `lenient: true` additionally matches keys with brackets stripped or doubled (`GIVEN_NAME_1`, `[[GIVEN_NAME_1]]`) — LLMs mangle brackets. Unknown/model-invented placeholders are left untouched (never guess). Pure function; also exposed on Session bound to its own mapping. Streaming rehydration (placeholder split across stream chunks) is out of scope for v1 — documented as a future `createRehydrateStream()` that buffers a trailing partial `[…` match.

---

## 7. Phased implementation plan (TDD order)

### Phase 1 — `@expo-pii/core` pure-JS pipeline (fully green in Node today)

Everything except tokenizer/NER. TDD: write the test file alongside each module.

Files: `types.ts`, `detectors/*` (7 detectors + dictionary + index), `pipeline/merge.ts`, `pipeline/replace.ts`, `placeholders/*`, `session.ts`, `rehydrate.ts`, `anonymizer.ts` (with `ner: false` path + `NoopNer`), plus root wiring (`turbo.json` test task, vitest configs, tsdown configs, package.jsons).

Key test cases:
- **Detectors**: Luhn accept/reject (4111 1111 1111 1111 ✓, off-by-one ✗; 13–19 digits; separators); SSN structural rules (rejects `000-xx-xxxx`, `666-…`, `9xx-…`, `xxx-00-xxxx`, `xxx-xx-0000`); IBAN mod-97 (`DE89 3704 0044 0532 0130 00` ✓, per-country length table, checksum fail ✗); IPv4 octet bounds (256 rejected), IPv6 compressed `::1`; email plus-addressing and subdomains; URL with/without scheme (`www.` accepted, bare `foo.bar` NOT — FP guard); phone international `+49 151 12345678`, `0049…`, requires ≥8 digits (national short forms are the model's job).
- **Merge**: NER `PHONE` overlapping deterministic `PHONE` → deterministic wins; dictionary over both; nested spans (surname inside full address) → longer wins within same priority; adjacent same-type NER spans merge across whitespace; identical duplicate spans dedupe; kept types (`CITY`) excluded.
- **Placeholders/Vault**: numbering by first occurrence; repeated value reuses placeholder; per-type counters independent; canonicalization (`João Silva` vs `joão silva` → same key; `+49 151…` vs `+49151…` → same PHONE key); sequential format `[TYPE_N]`.
- **hashed strategy**: HMAC determinism for same secret; different secrets → different tokens; truncation collision forced via fake hash → lengthens to uniqueness; output format `[TYPE_hex]`; property test: token never contains raw value.
- **Rehydrate**: round-trip `rehydrate(anonymize(x).redactedText, mapping) === x` (property-based over generated corpora); multiple occurrences; placeholders at string boundaries; lenient bracket-mangling; unknown placeholder untouched; overlapping key names (`[PHONE_1]` vs `[PHONE_10]` — longest-first).
- **Session**: turn 2 reuses turn 1 placeholders; `clear()`; mapping snapshot immutability.
- **Unicode**: emoji before an entity (offsets in code units stay consistent end-to-end); accented dictionary terms.

Exit criteria: `bun run test` green; `bun run build` produces dist for core; `anonymizeSync` usable.

### Phase 2 — tokenizer + Rampart ONNX NER (Node-verifiable)

Files: `tokenizer/normalize.ts`, `tokenizer/wordpiece.ts`, `ner/bio.ts`, `ner/chunk.ts`, `ner/rampart.ts`, `scripts/fetch-model.mjs`, `packages/model-rampart/*` (assets generated), golden fixture generator (dev script using `@huggingface/transformers` in Node only → commits `tokenizer-golden.json`).

Tokenizer spec: BERT basic tokenizer (whitespace/punctuation split, CJK char isolation) + WordPiece greedy longest-match with `##` continuations, `[UNK]` for >200-char tokens or no-match, `[CLS]`/`[SEP]` wrapping. **Normalization with index map**: lowercase + NFD + strip combining marks is done per-original-code-unit, recording for each normalized char its source index, so every token carries `[origStart, origEnd)` into the raw text. Test the expansion cases (`ß`, Turkish `İ` → `i̇`, `Müllerstraße` offsets land back on the umlauted original).

Key test cases:
- Tokenizer parity: for ~40 fixture sentences across the 7 languages (incl. accents, numbers, punctuation, emoji), token ids equal transformers.js output exactly (fixtures committed; regeneration script requires network, CI does not).
- Offsets: for every token, `text.slice(start, end)` normalizes to the token's surface form.
- `bio.ts` with synthetic logits: B/I aggregation, orphan `I-` handling, whitespace-merge, confidence = mean softmax.
- `chunk.ts`: >512-token text → windows of ≤510 content tokens, stride 384; entity in the overlap region reported once (prefer the window where it's farther from the edge).
- **Real-model golden test** (requires `bun run fetch-model`, `onnxruntime-node` devDep; `describe.skipIf(!modelPresent)`): (a) assert `session.inputNames`/`outputNames` — this **verifies the tensor-name assumption**; feed `token_type_ids` zeros only if listed; (b) e2e `createRampartNer` on EN/PT/DE sentences detects GIVEN_NAME/SURNAME/PHONE/STREET_NAME spans with correct offsets; (c) premask integration: text containing an SSN + a name → SSN premasked, name still found, offsets correct after SegmentMap round-trip.
- `int64.ts` (in expo-pii pkg but Node-testable): fallback encoder bytes equal `BigInt64Array` reference for ids 0, 1, 19729, 2^31−1.

Node-testable: everything above. Device-only: actual `onnxruntime-react-native` session creation, EP behavior, asset loading — deferred to Phase 3/4 manual verification.

### Phase 3 — Expo packaging

Files: `packages/expo-pii/src/{index,rampart,model-loader,int64,secret,metro}.ts`, `packages/model-rampart/index.js` + `.d.ts` + `NOTICE.md`, package `exports` maps (`.`, `./rampart`, `./metro`), README with install + metro + prebuild instructions and the CC BY 4.0 attribution.

Implementation notes (from research): no config plugin — README documents `bunx expo prebuild` + dev client requirement and states Expo Go is unsupported; `withExpoPiiMetro` pushes `'onnx'` into `resolver.assetExts`; `model-loader` does `Asset.fromModule(model).downloadAsync()` then **always copies to `FileSystem.cacheDirectory`** (iOS bundle bug #26738/#27062) and passes a `file://`-stripped path to `InferenceSession.create`; `rampart()` defaults `executionProviders` to CPU (ORT's own guidance for quantized models — measure CoreML/NNAPI later), exposes them as options; session creation failure with `strict: false` flips the anonymizer to `degraded` and fires `onDegraded`.

Tests: Node-side unit tests for `metro.ts` (assetExts contains onnx exactly once) and `int64.ts`; typecheck of `exports` resolution; the rest is validated via the example app.

### Phase 4 — example app (`apps/example`)

`bunx create-expo-app` (latest stable SDK, expo-router, new architecture), add `expo-dev-client`, `onnxruntime-react-native`, workspace deps. One main screen: multiline note input (pre-filled with the Portuguese sample from the original brief) → "Anonymize" shows `redactedText` with entities highlighted per type + detection latency + model status badge (`ready`/`degraded`) → "Send" calls a mock echo LLM (default) or a real OpenAI-compatible endpoint if the user pastes a key in settings → response shown side-by-side with rehydrated text. Settings screen: toggle each detector, toggle NER, sequential vs hashed strategy, private-mode switch (blocks the send button entirely). Verification: `bun run --cwd apps/example ios`/`android` on simulator (Android emulator NNAPI/CPU) and at least one physical iOS device; optional Maestro flow `flows/anonymize.yaml` asserting the sample note produces `[GIVEN_NAME_1]`.

Definition of done for v1: Phases 1–2 fully green in CI (`turbo test`); Phase 3 builds and typechecks; Phase 4 runs on both platforms with model inference under ~100 ms for a 300-char note on a modern device (indicative, not a gate).

---

## 8. Risks & open decisions (defaults chosen — proceed without asking)

| # | Risk / decision | Default (do this) |
|---|---|---|
| 1 | **Model binary in git?** 14.7 MB blob would bloat the repo forever | **No.** `scripts/fetch-model.mjs` with sha256 pins; assets gitignored; **included** in the published `@expo-pii/model-rampart` npm package (CC BY 4.0 permits redistribution; NOTICE.md carries attribution). |
| 2 | **Package manager** | **Keep Bun** (already configured; hoisted layout is Metro-friendly). Do not migrate to pnpm. |
| 3 | **Expo SDK target** | Example app: latest stable via `create-expo-app` (SDK 56 as of Aug 2026). Library peers: `expo >= 52`, RN ≥ 0.76. New Architecture on. |
| 4 | **ONNX tensor names unverified** | Introspect `session.inputNames`/`outputNames` at runtime; assume `input_ids`/`attention_mask`(/`token_type_ids`)→`logits`; Phase 2 golden test asserts reality and is the cheap correction point. |
| 5 | **Hermes lacks `BigInt64Array`** (ORT needs int64 feeds) | Feature-detect; fallback builds little-endian int64 buffers via `Uint32Array` pairs (ids < 2^31). Verify once on device in Phase 4. |
| 6 | **iOS standalone can't load model from app bundle** (ORT #26738/#27062) | Always copy asset to `FileSystem.cacheDirectory` before `InferenceSession.create`. |
| 7 | **Q4 ops unsupported on a mobile EP** | Default to CPU EP (ORT's own recommendation for quantized models); CoreML/NNAPI exposed but documented experimental. If CPU fails on-device, re-quantize from upstream weights with `optimum` to int8-QDQ as fallback artifact. |
| 8 | **Tokenizer drift vs upstream** | Own pure-TS WordPiece implementation + committed golden fixtures generated from `@huggingface/transformers` (dev-only). Reject transformers.js at runtime in RN (too heavy, needs shims). |
| 9 | **Placeholder strategy default** | `sequential()` (zero leakage, LLM-readable). `hashed()` is opt-in and **HMAC-keyed only** — plain value hashes are forbidden by design (offline-guess confirmation leak; see §4). |
| 10 | **NER unavailable (load failure, web, old device)** | `strict: false` default → degrade to deterministic + dictionary, surface `status: 'degraded'` + `onDegraded`. Privacy-critical apps set `strict: true`. |
| 11 | **Mapping persistence** | SDK keeps mapping in memory only and never writes it anywhere. `mapping` is plain data; if an app persists it, that's on the app — README documents `expo-secure-store` as the only sane target and warns against logging/analytics/crash reporters seeing raw text pre-anonymization. |
| 12 | **npm names** | `expo-pii`, `@expo-pii/core`, `@expo-pii/model-rampart`. If `expo-pii`/scope are taken at publish time, fall back to `@carlosziegler/expo-pii` — naming only, no code impact. Note: "expo-" prefix is conventional for community modules; not an official Expo package — say so in README. |
| 13 | **PII removal ≠ anonymization** (indirect identifiers, non-Latin scripts ~14% recall) | Document limitations prominently (quote Rampart's own numbers); dictionary feature + `strict` mode + example-app Private Mode are the mitigations. Never market "guaranteed anonymization". |
| 14 | **Licensing** | SDK code MIT; model + tokenizer assets CC BY 4.0 with attribution in `NOTICE.md` and README. Do not vendor upstream `@nationaldesignstudio/rampart` source; our regexes are independently implemented well-known patterns. |

---

## Appendix: key URLs

- Model: https://huggingface.co/nationaldesignstudio/rampart (files: `/tree/main`, config: `/raw/main/config.json`, model: `/resolve/main/onnx/model_q4.onnx`)
- Upstream system repo: https://github.com/nationaldesignstudio/rampart · whitepaper: https://inference.ndstudio.gov/rampart/whitepaper.pdf
- Arcjet integration notes: https://blog.arcjet.com/running-pii-detection-locally-with-the-rampart-ner-model/
- onnxruntime-react-native: https://www.npmjs.com/package/onnxruntime-react-native · RN docs: https://onnxruntime.ai/docs/get-started/with-javascript/react-native.html
- ORT/Expo issues: config-plugin https://github.com/microsoft/onnxruntime-inference-examples/issues/548 · iOS bundle load https://github.com/microsoft/onnxruntime/issues/26738 and https://github.com/microsoft/onnxruntime/issues/27062 · Hermes BigInt64Array https://github.com/microsoft/onnxruntime/issues/14770 · Expo discussion https://github.com/microsoft/onnxruntime/discussions/26536
- transformers.js RN status: https://github.com/huggingface/transformers.js/issues/858
- Expo SDK changelogs: https://expo.dev/changelog/sdk-56 · https://expo.dev/changelog/sdk-55 · https://expo.dev/changelog/sdk-54
- Prior art (user's): https://github.com/CarlosZiegler/better-privacy · https://better-privacy-docs.carlos-ziegler-13d.workers.dev/
