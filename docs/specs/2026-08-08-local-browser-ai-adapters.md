# Local browser AI adapters and static playground

## Problem Statement

Developers using `local-pii` can already protect calls made through the OpenAI-style and Vercel AI SDK integrations, but they do not have a framework-neutral way to protect arbitrary in-process model calls or a TanStack AI client connection. The documentation playground also behaves like a redaction demo rather than a real local AI chat.

This makes it difficult to demonstrate the central privacy promise end to end: personal data should be replaced before a model sees it, the model should run locally when requested, and placeholders should be restored for the user without requiring a gateway, API route, server action, API key, or backend.

The project needs reusable inline and TanStack AI adapters plus a static Fumadocs playground that proves both Vercel AI SDK and TanStack AI integrations against an LLM running in the browser.

## Solution

Add a framework-neutral inline execution API and a TanStack AI `ConnectConnectionAdapter` wrapper to `local-pii`. Both adapters will use conversation-scoped `PiiSession` instances, protect semantic model content before it crosses the model boundary, restore streamed output safely, propagate cancellation, and define explicit session ownership.

Replace the current playground behavior with two real client-side chats that share a shadcn/AI Elements shell. One chat will use the existing Vercel AI SDK middleware; the other will use the new TanStack AI connection wrapper. The preferred runtime will be the Chrome Prompt API and its browser-managed Gemini Nano model. When that runtime is unavailable, the user may explicitly download and activate `onnx-community/gemma-3-270m-it-ONNX` as a local Transformers.js fallback. No model will be downloaded automatically.

The entire feature will remain compatible with the documentation application's static export. Model inference will not use an application backend or inference endpoint.

## User Stories

1. As a library consumer, I want to protect a plain-text model call without adopting an AI framework, so that I can use `local-pii` with any in-process model API.
2. As a library consumer, I want the inline adapter to return restored text, so that placeholder tokens never become part of my application UI.
3. As a library consumer, I want to protect and restore structured JSON values, so that I can use local PII protection with non-text model contracts.
4. As a library consumer, I want to consume restored output incrementally, so that local streaming remains responsive.
5. As a library consumer, I want cancellation to propagate to the underlying model call, so that stopping generation does not waste device resources.
6. As a library consumer, I want internally created sessions to be cleaned up, so that temporary PII mappings do not outlive their execution.
7. As a library consumer, I want a supplied session to remain under my ownership, so that a conversation can restore references across multiple turns.
8. As a library consumer, I want original model errors to remain observable, so that privacy wrapping does not make failures harder to diagnose.
9. As a library consumer, I want early termination of a stream to close the upstream iterator, so that local inference is released promptly.
10. As a TanStack AI user, I want to wrap any `ConnectConnectionAdapter`, so that PII protection is independent of the selected model provider or transport.
11. As a TanStack AI user, I want message content protected without changing roles, identifiers, metadata, or part discriminants, so that the protocol remains valid.
12. As a TanStack AI user, I want streamed text restored even when placeholders cross chunk boundaries, so that streaming does not leak internal tokens.
13. As a TanStack AI user, I want each conversation to own a distinct privacy session, so that mappings cannot cross threads or users.
14. As a TanStack AI user, I want overlapping runs to maintain isolated buffers, so that concurrent generation cannot mix responses.
15. As a TanStack AI user, I want tool arguments and results restored at the correct protocol boundary, so that client tools receive usable values.
16. As a documentation visitor, I want to try a real AI chat without entering an API key, so that I can understand the library immediately.
17. As a privacy-conscious visitor, I want model inference to remain on my device, so that my prompt is not sent to an application inference server.
18. As a Chrome user with the Prompt API available, I want the playground to use the browser-managed model, so that I avoid downloading a second model.
19. As a visitor without the Prompt API, I want an optional local fallback, so that I can still run the demonstration on supported hardware.
20. As a visitor considering the fallback, I want to see its source and approximate download size before activation, so that I can make an informed choice.
21. As a visitor, I want model download progress and failure states, so that a large local download never appears frozen.
22. As a visitor, I want the playground to avoid downloading model artifacts on page load, so that opening the documentation is lightweight.
23. As a visitor, I want to stop an active response, so that I remain in control of device work.
24. As a visitor, I want to start a new chat, so that prior messages and PII mappings can be cleared together.
25. As a visitor, I want to compare Vercel AI SDK and TanStack AI in the same interface, so that I can choose an integration based on working examples.
26. As a visitor, I want to see which local runtime is active, so that I understand whether Gemini Nano or Gemma is producing the response.
27. As a visitor, I want to see the protected prompt delivered to the model, so that the privacy transformation is demonstrable.
28. As a visitor, I want the restored response to remain readable, so that privacy protection does not degrade the chat experience.
29. As a visitor using assistive technology, I want accessible chat, progress, status, and cancellation controls, so that the demonstration is operable without relying on visual cues.
30. As a documentation maintainer, I want the chat interface built from shadcn and AI Elements primitives, so that it remains consistent and reusable.
31. As a documentation maintainer, I want automated tests to use a fake browser model, so that continuous integration does not download models or depend on special Chrome hardware.
32. As a documentation maintainer, I want the static export to remain green, so that the feature does not change the deployment architecture.
33. As a documentation maintainer, I want English, Portuguese, and German documentation to describe runtime limitations accurately, so that localized pages do not overpromise model support.
34. As a security reviewer, I want network inspection to show no inference endpoint, so that the no-backend claim is verifiable.
35. As a security reviewer, I want incomplete placeholder tails discarded on abort and error, so that internal token fragments are not exposed.
36. As a project maintainer, I want the existing OpenAI adapter left unchanged, so that this project does not duplicate an integration that already works.

## Implementation Decisions

- The delivery adds two public subpath integrations: `local-pii/inline` and `local-pii/tanstack`.
- The existing OpenAI-style adapter and Vercel AI SDK middleware remain the source of truth for their current integrations.
- The inline integration exposes opinionated helpers for complete text, streamed text, and JSON, plus a generic executor for custom protection and restoration functions.
- An inline callback receives only protected input and the relevant cancellation context. The adapter owns the protect-call-restore ordering.
- A session supplied to an inline helper is borrowed and is never cleared by the helper.
- When no inline session is supplied, the helper creates an opaque temporary session and clears it in a `finally` path.
- A temporary streaming session remains alive until normal completion, failure, cancellation, or early iterator return.
- Stream restoration reuses the library's established placeholder holdback behavior so that tokens split across arbitrary chunk boundaries are not emitted prematurely.
- JSON protection and restoration operate on structured values without mutating caller-owned input.
- The TanStack AI integration is a wrapper around any compatible client-side `ConnectConnectionAdapter`; it is not a server middleware and is not tied to Chrome.
- A `PiiSession` is mandatory for the TanStack wrapper because the connection contract does not provide a reliable adapter disposal hook.
- One wrapped TanStack connection represents one conversation. Separate threads or users require separate connection wrappers and sessions.
- The TanStack wrapper protects semantic text, textual message parts, and supported tool payloads while preserving protocol roles, identifiers, tool names, discriminants, schemas, metadata, files, URLs, reasoning data, transport data, and run context.
- The TanStack wrapper does not mutate incoming messages or auxiliary data.
- Each TanStack `connect` invocation owns independent restoration buffers. The shared conversation session may span turns, but run buffers never live in shared adapter state.
- The original `AbortSignal` is forwarded to the inner connection, and iterator cleanup is forwarded when a consumer stops early.
- Normal terminal events flush valid restoration tails. Error and abort paths discard incomplete tails rather than exposing partial placeholders.
- Text streaming is the first TanStack milestone. Tool arguments, tool results, lifecycle edge cases, and concurrency hardening are completed in a subsequent dependent milestone before the adapter is documented as supporting tools.
- The documentation application remains a static export. Browser globals are accessed only from a narrow hydrated client boundary and after capability detection.
- The playground runtime has explicit checking, native-ready, fallback-available, downloading, ready, and error states.
- The preferred runtime is the Chrome Prompt API through the browser's `LanguageModel` global and browser-managed Gemini Nano model.
- The fallback runtime is the instruction-tuned Gemma 3 270M ONNX model through Transformers.js. The preferred quantization is `q4f16`, subject to a runtime spike that verifies compatibility with the pinned browser stack.
- The Gemma fallback is opt-in, lazy-loaded, cached by the browser where supported, and presented with its source, license context, approximate 426 MB artifact size, and progress.
- Model artifacts may be fetched from their declared model host, but prompts, restored values, vault contents, and inference requests are not sent to an application server.
- The browser runtime implementation belongs to the playground and is not part of the generic `local-pii` public API.
- The Vercel AI SDK example uses the installed AI SDK generation path, the existing PII middleware, a direct in-browser chat transport, and a browser-compatible model provider. It does not call an API route.
- The TanStack AI example uses a browser connection adapter wrapped by `piiConnection` and consumed by the TanStack React chat client. It does not use the Vercel AI SDK as a hidden transport.
- Native and fallback runtimes are normalized behind a small playground-owned browser model boundary so that both examples exercise the same local model capability without sharing chat state.
- The two examples share a shadcn/AI Elements visual shell but maintain independent message history, generation state, and `PiiSession` ownership.
- Chat UI is composed from official or registry-provided shadcn and AI Elements primitives rather than maintaining custom chat bubbles.
- The interface includes accessible runtime status, explicit activation, progress, stop, new-chat, conversation scrolling, empty, loading, and error states.
- A privacy inspector displays runtime identity, local execution status, detected PII categories and counts, and the protected model-facing prompt. It does not persist or externally log original prompt text.
- New chat clears both the visible conversation and that chat's privacy session.
- The UI and documentation may be localized in English, Portuguese, and German, while model-language limitations are reported independently from the interface language.
- Dependencies that define adapter contracts are pinned during implementation, and compile-time contract tests guard against incompatible TanStack or AI SDK upgrades.
- All implementation follows the installed Next.js version documentation for client components, static exports, browser access, and lazy loading.

## Testing Decisions

- Tests assert externally observable behavior through public package exports and rendered playground behavior. They do not assert private helper structure or internal call counts unless those calls are themselves part of the public lifecycle contract.
- The primary inline test seam is the public inline API with a controlled model callback. The callback captures model-facing values and returns complete or streamed values selected by the test.
- Inline tests cover complete text, structured JSON, non-mutation, supplied and temporary session ownership, error identity, abort propagation, upstream iterator return, and arbitrary placeholder chunk boundaries.
- Property or fuzz-style chunking tests divide placeholders at every relevant boundary and assert that restoration matches the complete response.
- The primary TanStack test seam is the public connection wrapper around a fake `ConnectConnectionAdapter` that records input and yields controlled protocol chunks.
- TanStack tests cover semantic-field protection, control-field preservation, input non-mutation, text streaming, normal completion, missing terminal events, errors, abort, concurrent connects, interleaved message identifiers, and interleaved tool calls.
- Public subpath tests verify that runtime code, ESM output, CommonJS output where supported, and type declarations expose the intended adapters.
- The primary playground test seam is a single injectable browser model factory. Automated tests use a fake `LanguageModel` implementation and never download Gemini Nano or Gemma.
- Playground integration tests pass a PII-bearing message through each chat's real privacy adapter, assert that the fake model receives placeholders, and assert that the rendered response contains restored values.
- Playground tests cover capability states, explicit fallback activation, progress, failure and retry, cancellation, new-chat cleanup, keyboard operation, and accessible status announcements.
- Static export and type checking are required gates. The feature must not introduce an API route, server action, inference fetch, or other server-only requirement.
- Existing test style and the current package test runner remain the prior art for library coverage; existing documentation build commands remain the prior art for static delivery coverage.
- A human-in-the-loop smoke test uses a compatible desktop Chrome installation to verify native model availability or download, streaming, stop, new chat, and network behavior.
- A second human-in-the-loop smoke test verifies the Gemma fallback download disclosure, progress, local generation, cache reuse where available, and behavior in English, Portuguese, and German without promising equal quality across languages.
- Browser network inspection must show no application inference endpoint. Model artifact requests during explicit fallback download are expected and documented.
- The existing test and typecheck baseline must remain green in addition to all new coverage.

## Out of Scope

- A gateway, proxy, hosted inference endpoint, API route, server action, or application backend.
- A new OpenAI adapter or changes to the existing OpenAI-style adapter unless a regression is discovered during shared-core work.
- Automatic download of Gemini Nano, Gemma, or any other model when the documentation page loads.
- Mobile support for the Chrome Prompt API where the browser does not provide it.
- Claiming that Gemma 3 270M is suitable for complex reasoning or production-grade general conversation.
- Guaranteeing equal response quality across English, Portuguese, and German.
- Training, fine-tuning, converting, or hosting custom model weights as part of the first delivery.
- Persisting chat history or PII session vaults across reloads.
- Synchronizing a privacy session between the Vercel and TanStack demonstrations.
- A production tool-calling demonstration in the playground. Protocol-safe tool handling in the TanStack adapter is covered separately, but the first local chats remain text-first.
- Supporting every TanStack AI or Vercel AI SDK version. The implementation documents and tests the pinned compatible versions.
- Generalizing the playground-owned browser runtime into a new provider package before real reuse justifies that API.

## Further Notes

- The current documentation worktree contains unrelated localization and routing changes. Implementation must build on those changes and must not revert them.
- The documentation application already uses static export, and the current playground is a redaction/echo demonstration rather than a real LLM chat.
- The current library already contains the privacy session, JSON traversal, streaming restoration, OpenAI-style adapter, and Vercel AI SDK middleware needed as prior art.
- Chrome calls its built-in model Gemini Nano. There is no public downloadable model named Gemma Nano. Gemma 3n exists but is materially larger than the selected 270M fallback.
- The Gemma artifact size is large enough that download consent and progress are product requirements rather than implementation polish.
- Chrome model availability, supported languages, and hardware requirements can change independently of this project. Capability detection and documentation must prefer runtime truth over hard-coded assumptions.
- The feature should be delivered through small dependent tickets, with tests written before implementation and review after every ticket.
