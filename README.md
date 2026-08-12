# local-pii

**Adapter-first privacy for Expo, React Native, the browser, and Node.** Detect
personal information locally, replace it with placeholders, call the selected
generation model, and restore the response while the private mapping stays on
the device.

This is the monorepo. The SDK lives in [`packages/local-pii`](packages/local-pii)
— **[read its README for the full docs](packages/local-pii/README.md)**.

The canonical flow has four stages: a Detection adapter feeds the anonymizer,
one privacy session owns a private conversation, and a native Generation
adapter or inline callback calls the caller-selected Generation model.

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

Rampart Q4 is a **Detection model**. Gemini Nano, Gemma, and provider models
are **Generation models**; they receive protected content, never the private
mapping. `ner:` remains supported as compatibility spelling for `detection:`,
but new code should use `detection:`.

## Packages

| Package                                            | Description                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`packages/local-pii`](packages/local-pii)         | The SDK: pure-TS core plus `/expo`, `/web`, `/inline`, `/ai-sdk`, `/openai`, `/tanstack`, and `/metro`. |
| [`packages/model-rampart`](packages/model-rampart) | `@local-pii/model-rampart` — Rampart Q4 Detection assets (CC BY 4.0, fetched on demand).                |
| [`apps/docs`](apps/docs)                           | Fumadocs documentation site (`bun --filter docs dev` → :3001).                                          |
| [`apps/example`](apps/example)                     | Expo app demonstrating protect → model → restore.                                                       |

## Develop

```sh
bun install
bun run fetch-model
bun run test
bun run build
```

## How it works

```text
user content ─▶ Detection adapter ─▶ anonymizer ─▶ private session
              ─▶ protected content ─▶ Generation model
              ◀─ restored response ◀─ private mapping stays on device
```

The core deterministic detectors cover email, phone, card, IBAN, SSN, IP, and
URL. Rampart adds names, addresses, and IDs. Keep one privacy session per
private conversation; supplied sessions are borrowed and are never cleared by
an adapter.

## Credits

- Rampart Detection model by **National Design Studio** (CC BY 4.0).
- SDK code licensed **MIT**.
