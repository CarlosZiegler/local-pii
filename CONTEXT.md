# Better Privacy

Better Privacy protects personal information while applications process text with language models. It supports both protected exchanges with external models and browser-local inference where user content stays in the browser.

## Language

**User content**:
The prompts, responses, and personal information handled for a user interaction.
_Avoid_: Payload, raw data

**Protected content**:
User content whose personal information has been replaced by placeholders and whose private mapping remains inside the caller-controlled runtime.
_Avoid_: Safe content, anonymized data

**Private mapping**:
The relationship between placeholders and the original personal information, retained only inside the caller's trust boundary; this is the device for browser/Expo use and the application server for server-side use.
_Avoid_: Lookup table, PII map

**Browser-local inference**:
Language-model inference performed inside the user's browser without transmitting user content to a backend or cloud model.
_Avoid_: Local AI, client-side AI, on-device AI

**Artifact download**:
A network transfer of code, model weights, or other static resources required to prepare browser-local inference; it contains no user content.
_Avoid_: Model request, inference request

**Detection model**:
A small model that finds and classifies personal information so it can be replaced in protected content; Rampart is the reference detection model.
_Avoid_: Local LLM, generation model, anonymization service

**Generation model**:
A language model that produces an application response from protected content; it may run externally or through browser-local inference.
_Avoid_: Detection model, PII model

**Protection flow**:
The reversible progression from user content to protected content, through a generation model, and back to restored content while the private mapping remains inside the caller's trust boundary.
_Avoid_: Anonymization service, inference pipeline

**Private conversation**:
A sequence of related user interactions that shares one privacy session and may contain multiple generation runs.
_Avoid_: Chat session, model session, thread

**Privacy session**:
The conversation-scoped lifetime of a private mapping; it is isolated from every other private conversation.
_Avoid_: PII session, vault, model session

**Generation run**:
One attempt to produce a model response within a private conversation, with an independent completion, failure, or cancellation outcome.
_Avoid_: Request, completion, inference session

**Browser runtime**:
The browser-local model capability and its reusable resources, independent from private conversations and their privacy sessions.
_Avoid_: Model session, chat runtime, provider
