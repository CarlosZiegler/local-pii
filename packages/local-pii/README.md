# local-pii

**On-device PII anonymization for Expo / React Native.**

Redact names, emails, phones, cards and more **locally**, send only placeholders
to any LLM (OpenAI, Claude, Grok…), then rehydrate the reply on device. The
`placeholder → original` mapping never leaves the phone.

```
Ontem encontrei João Silva. Meu telefone é +49 151 12345678.
        │  anonymize on device
        ▼
Ontem encontrei [GIVEN_NAME_1] [SURNAME_1]. Meu telefone é [PHONE_1].   ← only this is sent
        │  ↕ your LLM
        ▼  rehydrate on device
João Silva / +49 151 12345678 come back — the mapping never left the device.
```

- 🔒 **Local by default** — deterministic detectors + optional 14.7 MB on-device NER model. No server.
- 🧱 **Defense in depth** — regex/checksum detectors **+** the Rampart NER model **+** your own dictionary.
- 🪶 **Zero-dependency core** — the pure-TS pipeline runs in React Native, Node and the browser.
- 🔁 **Reversible** — stable placeholders and a pure `rehydrate(text, mapping)`.
- 🧩 **Pluggable** — swap detectors, the NER backend, or the placeholder strategy.

> ⚠️ Community package, not an official Expo module. See [Limitations](#limitations).

## Install

```sh
bun add local-pii            # or npm / yarn / pnpm
```

The deterministic pipeline works with nothing else installed. For the on-device
AI model, also add the peer deps and the model asset package (see
[On-device AI](#on-device-ai-rampart)).

## Quickstart

Works today in React Native, Node and the browser — no native modules:

```ts
import { createAnonymizer, rehydrate } from "local-pii"

const pii = createAnonymizer()

const { redactedText, mapping } = await pii.anonymize(
  "Email me at ana@acme.com or call +49 151 12345678",
)
// redactedText → "Email me at [EMAIL_1] or call [PHONE_1]"

const reply = await callYourLlm(redactedText) // only placeholders leave the device
const answer = rehydrate(reply, mapping) // originals restored locally
```

`mapping` is plain data (`{ "[EMAIL_1]": "ana@acme.com", … }`). Keep it in
memory; never log it, send it, or put it in analytics/crash reports.

## On-device AI (Rampart)

Add the [Rampart](https://huggingface.co/nationaldesignstudio/rampart) NER model
(names, addresses, IDs) — a 14.7 MB quantized ONNX model that runs on device via
`onnxruntime-react-native`.

```sh
bun add onnxruntime-react-native expo-asset expo-file-system @local-pii/model-rampart
```

**1. Metro** — let Metro bundle the `.onnx` model as an asset:

```js
// metro.config.js
const { getDefaultConfig } = require("expo/metro-config")
const { withExpoPiiMetro } = require("local-pii/metro")

module.exports = withExpoPiiMetro(getDefaultConfig(__dirname))
```

**2. Use it** — pass `rampart()` as the NER backend:

```ts
import { createAnonymizer } from "local-pii"
import { rampart } from "local-pii/expo"

const pii = createAnonymizer({
  ner: rampart({ model: require("@local-pii/model-rampart/assets/rampart-q4.onnx") }),
})

const { redactedText } = await pii.anonymize(
  "Ontem encontrei João Silva na Müllerstraße 42.",
)
// → "Ontem encontrei [GIVEN_NAME_1] [SURNAME_1] na [STREET_NAME_1] [BUILDING_NUMBER_1]."
```

> **Requires a dev client / prebuild — not Expo Go** (`onnxruntime-react-native`
> is a native module). Run `bunx expo prebuild` then build a dev client. If the
> model can't load, the anonymizer **degrades to deterministic-only** and calls
> `onDegraded` (set `strict: true` to throw instead).
>
> The model isn't committed — run `bun run fetch-model` once to download it into
> `@local-pii/model-rampart` (verified by sha256).

## Browser

The same model runs in the browser via `onnxruntime-web` (WASM + WebGPU):

```ts
import { createAnonymizer } from "local-pii"
import { rampartWeb } from "local-pii/web"

const pii = createAnonymizer({ ner: rampartWeb() }) // fetches from the HF CDN; self-host for prod
```

## LLM adapters & tool calls

Wrap the whole anonymize → call → rehydrate cycle — **including tool calls** —
so your app barely changes. Both handle streaming and rehydrate tool-call
argument JSON so the agent loop runs your tools with real values.

```ts
// Vercel AI SDK
import { withPii } from "local-pii/ai-sdk"
const model = withPii(openai("gpt-5.2"))

// OpenAI SDK + Grok/xAI (zero-dep, OpenAI-compatible)
import { withPiiOpenAI } from "local-pii/openai"
const client = withPiiOpenAI(new OpenAI({ baseURL: "https://api.x.ai/v1", apiKey }))
```

Tool calls need the opaque `token()` strategy (below) — bracketed tokens get
mangled in JSON. `rehydrateToolArgs`, `createStreamingRehydrator` and a manual
`createPiiChat` loop are exported for hand-rolled integrations.

## Placeholder strategies

```ts
import { createAnonymizer, sequential, hashed, token } from "local-pii"

createAnonymizer({ placeholders: sequential() }) // default → [GIVEN_NAME_1]
createAnonymizer({ placeholders: hashed({ secret }) }) // → [GIVEN_NAME_a3f2c1d0]
createAnonymizer({ placeholders: token() }) // → PIIQ2X9K7M3TZ8R4EJ0V (tool/JSON-proof)
```

- **`sequential()` (default)** — `[TYPE_N]`. Leaks nothing (the number says
  nothing about the value) and reads well for the LLM. Stable within a session.
- **`hashed({ secret })`** — a **keyed HMAC** of the value, so the same value
  gets the same token across sessions/devices sharing the secret.
- **`token()`** — opaque Crockford base32 (`PII…`), no brackets, mangling-
  tolerant. Use it whenever tools or machine-parsed output are involved.

> **Why keyed?** A plain hash of the value (`sha256(email)`) is a **privacy leak**
> — placeholders reach the provider, and PII is low-entropy, so anyone can
> confirm a guessed value offline by recomputing the hash. `hashed()` is
> HMAC-keyed with a device-local secret (`getOrCreateDeviceSecret()` via
> `expo-secure-store`) that never leaves the device, so a correct guess isn't
> verifiable without the key. Unkeyed hashing is intentionally not offered.

## Multi-turn sessions

Keep placeholders stable across the messages of a conversation:

```ts
const session = pii.createSession()
await session.anonymize("First, about João…") // João → [GIVEN_NAME_1]
await session.anonymize("Tell João I said hi") // João → [GIVEN_NAME_1] again
session.rehydrate(assistantReply) // bound to this session's mapping
```

## Custom dictionary

Always redact your own terms (name, family, employer, project code-names):

```ts
createAnonymizer({
  dictionary: [
    { value: "Projeto Fênix", type: "ORGANIZATION" },
    { value: "Carlos Ziegler", type: "PERSON" },
  ],
})
```

Dictionary matches win over both the detectors and the model.

## Detectors

Deterministic, checksum-validated, and always on:

| Detector | Type | Validation |
| --- | --- | --- |
| `emailDetector` | `EMAIL` | structural |
| `phoneDetector` | `PHONE` | 7–15 digits, international formats |
| `creditCardDetector` | `CREDIT_CARD` | 13–19 digits + Luhn |
| `ibanDetector` | `IBAN` | ISO 7064 mod-97 |
| `ssnDetector` | `SSN` | structural + reserved-range rejection |
| `ipDetector` | `IP_ADDRESS` | IPv4 octet bounds, IPv6 |
| `urlDetector` | `URL` | scheme / `www.` |

The Rampart model adds `GIVEN_NAME`, `SURNAME`, `STREET_NAME`, `BUILDING_NUMBER`,
`CITY`, `STATE`, `ZIP_CODE`, `TAX_ID`, `BANK_ACCOUNT`, `ROUTING_NUMBER`,
`GOVERNMENT_ID`, `PASSPORT`, `DRIVERS_LICENSE`, `SECONDARY_ADDRESS`. `CITY`,
`STATE` and `ZIP_CODE` are kept by default (`keep`/`redact` to change).

## API

```ts
createAnonymizer(options?): Anonymizer
  .anonymize(text): Promise<{ redactedText, entities, mapping }>
  .anonymizeSync(text): { … }         // deterministic + dictionary only
  .warmup(): Promise<void>            // preload the model
  .createSession(): PiiSession
  .addDictionaryEntries(entries): void
  .status: "idle" | "loading" | "ready" | "degraded"
  .dispose(): Promise<void>

rehydrate(text, mapping, { lenient? }): string   // pure; lenient tolerates bracket-mangling

// strategies
sequential() · hashed({ secret, length? })

// backends
rampart(options)                      // local-pii/expo
createRampartNer({ ort, modelPath, vocab, labels })  // runtime-agnostic core
```

`AnonymizerOptions`: `detectors`, `ner`, `dictionary`, `placeholders`, `keep`,
`redact`, `nerThreshold`, `strict`, `onDegraded`.

## Limitations

- **PII removal ≠ perfect anonymization.** Indirect identifiers ("the only
  Brazilian engineer at company X in Kempten") can still identify someone. Use
  the dictionary, `strict` mode, and a "private mode" for sensitive notes.
- **Rampart** reports ~97–99% private-term recall on Latin-script EN/ES/FR/DE/
  IT/PT/NL; **non-Latin scripts are ~14%**. Government-style IDs rely on the
  model (~68%). Don't market "guaranteed anonymization".
- Keep raw text out of logs, analytics and crash reporters **before** anonymizing.

## Attribution & license

- SDK code: **MIT**.
- The Rampart model + tokenizer (`@local-pii/model-rampart`) are by
  **National Design Studio**, licensed **CC BY 4.0** — see its `NOTICE.md`.
