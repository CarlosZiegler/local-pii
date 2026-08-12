# Adapter-first privacy verification — 2026-08-12

This record closes the evidence work in [issue #29](https://github.com/CarlosZiegler/local-pii/issues/29). It separates deterministic automation from observations made with installed browser runtimes.

## Automated commands

| Command                                                                     | Observed result | Coverage or artifact                                                                                                                                    |
| --------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`                                                              | Pass            | `local-pii` 380/380; docs 207/207                                                                                                                       |
| `bun run typecheck`                                                         | Pass            | Workspace TypeScript checks                                                                                                                             |
| `bun run lint`                                                              | Pass            | No errors; one pre-existing unused `Geist` warning in `apps/web`                                                                                        |
| `bun run build`                                                             | Pass            | Library ESM/CJS/declarations; docs static export with 38 pages                                                                                          |
| `bun run --cwd packages/local-pii test:matrix`                              | Pass            | 8 public subpaths; ESM/CJS targets; React Native target; 13 isolated bundles; NodeNext and Bundler declarations                                         |
| `npx -y node@20 packages/local-pii/scripts/verify-import-matrix.mjs`        | Pass            | Direct export-target and isolation matrix on the lowest declared Node major                                                                             |
| `bun run --cwd apps/example test:export`                                    | Pass            | Real Android Metro export; exact 14.7 MB Rampart ONNX provenance; native ONNX runtime present and web runtime absent                                    |
| `bun run --cwd apps/docs test:e2e`                                          | Pass            | 5 Playwright checks over a fresh static export: both chats, keyboard/status/inspection, PT/DE routes, `.mjs` MIME, WebSocket rejection, and HTTP policy |
| Issue-scoped `bunx prettier --check …` and `git diff --check 1b0609a..HEAD` | Pass            | Formatting of final verification changes and branch-wide whitespace                                                                                     |

The deterministic E2E installs a fake native Prompt API only as a browser-runtime seam. It is not counted as evidence that a real model exists or has a particular quality.

## Browser environment

| Item    | Observed value                                                             |
| ------- | -------------------------------------------------------------------------- |
| Browser | Installed Google Chrome `151.0.7922.110`                                   |
| OS      | macOS `26.5.1` (`25F80`)                                                   |
| Device  | MacBook Pro `Mac16,8`; Apple M4 Pro, 14 cores, 48 GB memory                |
| Page    | Fresh Fumadocs static export on `http://127.0.0.1:4173/en/docs/playground` |

## Real-browser matrix

| Runtime                         | Activation                                                                                                                                                                                     | Vercel AI SDK                                                                                                                                                                                                           | TanStack AI                                                                                                                    | Network                                                                                                                                                                                                 | Cleanup/cache                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome Prompt API / Gemini Nano | `window.LanguageModel` existed. A clean profile reported `downloadable`, then `downloading`, then `available`; a later session reported `available`. No experimental flag or API key was used. | The email-bearing request was protected before the native boundary; visible streamed output restored `ana@acme.com`; the inspector retained protected content.                                                          | Same protected-boundary and restored-output result.                                                                            | The HAR captured **zero requests** during generation and cancellation: no API route, inference endpoint, provider request, or prompt body.                                                              | Stop interrupted a long generation. New conversation reset the chat. Native sessions were destroyed after runs.                                          |
| Gemma 3 270M IT q4f16 / WebGPU  | Native `LanguageModel` was deliberately hidden for this smoke. Explicit activation loaded the pinned revision and reached ready in headed Chrome with WebGPU.                                  | Generation streamed through the Vercel adapter and the inspector showed protected input. This 270M run did not reliably repeat the requested email, so it did not independently demonstrate output restoration quality. | Generation repeated the protected token and the adapter restored the visible `ana@acme.com`; the inspector remained protected. | First-activation HAR: 17 GETs only—3 local, 9 `huggingface.co`, 3 regional Hugging Face CDN, 2 versioned JSDelivr ONNX Runtime resources. No request URL/body contained the email or a protected token. | Stop and New conversation worked. A reload/second activation offered the cached runtime; its HAR contained 31 local GETs and **zero external requests**. |

## Gemma artifact evidence

The first real activation resolved the six model files from immutable model revision `2dbbfdb1b59bd034eb959428c6a7da9dd7ea27f0`:

- `config.json`
- `generation_config.json`
- `tokenizer_config.json`
- `tokenizer.json`
- `onnx/model_q4f16.onnx`
- `onnx/model_q4f16.onnx_data`

Their repository sizes total **293,284,073 bytes**. Chrome also fetched two versioned ONNX Runtime Web support files from `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/`:

- `ort-wasm-simd-threaded.asyncify.mjs`: 47,389 uncompressed bytes
- `ort-wasm-simd-threaded.asyncify.wasm`: 23,567,050 uncompressed bytes

The disclosure therefore reports approximately **316,898,512 static artifact bytes (~317 MB before transfer compression)** and all three origin families: `https://huggingface.co`, `https://*.cdn.hf.co`, and `https://cdn.jsdelivr.net`. The captured responses used Brotli transfer compression, so observed wire bytes were lower. All external requests were GETs for these static model/runtime resources; there was no remote generation request.

A final installed-Chrome render check after this correction showed `Artifact download: ~317 MB` and the JSDelivr origin before activation, without starting another download.

The six model URLs remain the cache/prefetch manifest. The two ONNX Runtime support resources are versioned application-runtime dependencies, not model files, and are disclosed without being misclassified as Gemma artifacts.

## Privacy and cost boundary observed

- Neither runtime required a provider API key, Gateway, application backend, or server action.
- Native Gemini Nano generation caused no network request in the captured interval. The test exposed no metered provider or billing surface; this record does not make a general promise about future Chrome product terms.
- Gemma network traffic was limited to static artifacts during first activation. The prompt, restored value, private mapping, and inspection state were absent from captured request URLs and bodies.
- Protection and restoration happened through the real Vercel AI SDK and TanStack AI adapters, not through a playground-only privacy shortcut.

## Remaining environmental uncertainty

- Gemini Nano availability and its initial browser-managed download depend on Chrome version, device eligibility, free storage, policy, profile state, and Chrome's current distribution rules.
- The real-browser smoke covers one macOS/Apple Silicon machine. Android/iOS do not expose this Chrome Prompt API surface.
- Regional Hugging Face CDN hostnames can change even though the initiating model URLs and revision are pinned.
- The JSDelivr support-file version follows the built ONNX Runtime Web dependency. Artifact bytes and disclosure tests must be updated together when that dependency changes.
- Gemma 3 270M is intentionally small; instruction following, repetition, language quality, and reasoning are materially weaker than larger models. The TanStack run restored an exact email, while the Vercel run demonstrated the protected boundary but not reliable echo quality.
