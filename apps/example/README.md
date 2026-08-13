# local-pii example

A one-screen Expo app demonstrating the full flow: **anonymize on device →
(mock) LLM → rehydrate**, with a live view of the detected entities and the
redacted text that would be sent.

## Run

```sh
# from the repo root
bun install
bun run fetch-model          # download the Rampart model (needed for on-device AI)

cd apps/example
bunx expo prebuild           # onnxruntime-react-native is native → needs a dev client
bun run ios                  # or: bun run android
```

- The **deterministic** pipeline (emails, phones, cards, IBAN, SSN, IP, URLs)
  works immediately — even in Expo Go. Leave **Detection model (Rampart)** off
  for this deterministic-only mode.
- Toggle **Detection model (Rampart)** to add names/addresses via the local
  model. This needs the dev client build above. When Detection is on, the
  example is **fail-closed**: a load or inference failure is shown and the mock
  Generation call is not made (nothing is sent with incomplete protection).
- Toggle **Private mode** to prove nothing is sent: it anonymizes and stops.

The mock "LLM" (`src/llm.ts`) echoes the placeholders back so you can watch
rehydration restore the originals. Swap it for a real OpenAI/Claude call — only
the redacted text ever leaves the device.
