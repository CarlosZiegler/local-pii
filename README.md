# local-pii

**On-device PII anonymization for Expo / React Native.** Redact personal data
locally, send only placeholders to any LLM, and rehydrate the reply on device —
the `placeholder → original` mapping never leaves the phone.

This is the monorepo. The SDK lives in [`packages/local-pii`](packages/local-pii)
— **[read its README for the full docs](packages/local-pii/README.md)**.

```ts
import { createAnonymizer, rehydrate } from "local-pii"

const pii = createAnonymizer()
const { redactedText, mapping } = await pii.anonymize(
  "Ontem encontrei João Silva. Meu telefone é +49 151 12345678.",
)
// redactedText → "Ontem encontrei João Silva. Meu telefone é [PHONE_1]."   (names need the model)
const answer = rehydrate(await callYourLlm(redactedText), mapping)
```

With the on-device [Rampart](https://huggingface.co/nationaldesignstudio/rampart)
model enabled, names and addresses go too:
`"[GIVEN_NAME_1] [SURNAME_1] … [STREET_NAME_1] [BUILDING_NUMBER_1]"`.

## Packages

| Package | Description |
| --- | --- |
| [`packages/local-pii`](packages/local-pii) | The SDK. Pure-TS core (`local-pii`) + subpaths `local-pii/expo` (Expo NER), `local-pii/web` (browser NER), `local-pii/ai-sdk` (Vercel AI SDK), `local-pii/openai` (OpenAI/Grok), `local-pii/metro`. |
| [`packages/model-rampart`](packages/model-rampart) | `@local-pii/model-rampart` — the Rampart Q4 ONNX model + tokenizer assets (CC BY 4.0, fetched on demand). |
| [`apps/docs`](apps/docs) | Fumadocs documentation site (`bun --filter docs dev` → :3001). |
| [`apps/example`](apps/example) | Expo app demoing anonymize → mock LLM → rehydrate. |
| `apps/web`, `packages/ui`, … | The original Next.js/shadcn template. |

Subpaths, all pure-JS with optional peer deps: **`local-pii`** (core, no native
deps) · **`/rampart`** (Expo) · **`/web`** (browser) · **`/ai-sdk`** · **`/openai`**
(OpenAI + Grok/xAI) · **`/metro`**. Placeholder strategies: `sequential` (default),
`hashed` (keyed), `token` (opaque, for tool calls). Full tool-call support with a
leak-swept test proving no PII reaches the provider.

## Develop

```sh
bun install
bun run fetch-model     # download the Rampart model (sha256-pinned) for NER tests + the demo
bun run test            # run the SDK test suite (incl. a real-model golden test)
bun run build           # build the SDK (ESM + CJS + types via Rslib)
```

Tooling: **Bun** workspaces + **Turborepo**, **Rslib** (Rspack) builds,
**Vitest** tests. The SDK core is dependency-free and TypeScript-strict.

## How it works

```
note ─▶ deterministic detectors (email, phone, card+Luhn, IBAN, SSN, IP, URL)
     ─▶ dictionary (your terms)
     ─▶ Rampart NER (names, addresses, IDs) — 14.7 MB ONNX, on device
     ─▶ resolve overlaps ─▶ placeholder engine ─▶ redacted text ─▶ LLM
                                                        │
                       reply ─▶ rehydrate(reply, mapping) ─▶ restored text
```

The mapping is plain in-memory data that the SDK never serializes off-device.

## Credits

- Rampart PII model by **National Design Studio** (CC BY 4.0).
- Architecture planned with the help of the repo's [`PLAN.md`](PLAN.md).
- SDK code licensed **MIT**.
