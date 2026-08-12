# local-pii

**Adapter-first privacy for Expo, React Native, the browser, and Node.**

The protection flow is Detection adapter → anonymizer → one privacy session per
private conversation → native Generation adapter or inline callback → caller-
selected Generation model. Protected content contains placeholders; the private
mapping stays inside the caller's trust boundary.

## Quickstart: the canonical flow

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
  input: "Email me at ana@acme.com",
  call: (protectedContent, { signal }) =>
    generationModel.generate(protectedContent, { signal }),
})
```

Rampart Q4 is a Detection model. Gemini Nano, Gemma, and provider models are
Generation models. Keep the private mapping in memory; never log it, send it,
or put it in analytics/crash reports. `ner:` remains supported for compatibility
but new code should use `detection:`.

## Install

```sh
bun add local-pii onnxruntime-web @local-pii/model-rampart
```

The quickstart uses browser Rampart, whose optional peers are
`onnxruntime-web` and `@local-pii/model-rampart`. The deterministic pipeline
works with only `local-pii` in React Native, Node, and the browser.

## Detection on Expo and the browser (Rampart)

The [Rampart](https://huggingface.co/nationaldesignstudio/rampart) Detection
model adds names, addresses, and IDs to deterministic detection.

```sh
bun add onnxruntime-react-native expo-asset expo-file-system @local-pii/model-rampart
```

Configure Metro with the actual helper name:

```js
const { getDefaultConfig } = require("expo/metro-config")
const { withLocalPiiMetro } = require("local-pii/metro")
module.exports = withLocalPiiMetro(getDefaultConfig(__dirname))
```

Then configure the Detection adapter:

```ts
import { createAnonymizer } from "local-pii"
import { rampart } from "local-pii/expo"

const privacy = createAnonymizer({
  detection: rampart({
    model: require("@local-pii/model-rampart/assets/rampart-q4.onnx"),
  }),
})
```

This requires a dev client / prebuild, not Expo Go. If the model cannot load,
the default is deterministic-only degradation; `strict: true` throws instead.
The browser equivalent is `detection: rampartWeb()` from `local-pii/web`.

## Adapters and ownership

`runInlineText`, `runInlineTextStream`, and `runInlineJson` protect input,
forward the same `AbortSignal`, call the model, and restore output. Inline
resolution is `session`, then `anonymizer`, then the adapter default. An
adapter-created session is cleaned up; a supplied session is borrowed and
remains the caller's responsibility.

`withPii` wraps an AI SDK model; `withPiiOpenAI` wraps an OpenAI-compatible
client; and `piiConnection` wraps a TanStack `ConnectConnectionAdapter`. Use
one privacy session and one adapter wrapper per private conversation. The
OpenAI and AI SDK adapters can create an implicit wrapper-scoped session that
is reused across that wrapper's calls, while TanStack requires a caller-owned
session. Create a fresh wrapper for a fresh private conversation when you do
not pass `{ session }`.

## TanStack lifecycle limits

TanStack protects text, supported structured content, tool inputs/results, and
stream boundaries without mutating caller messages. Hydration is passed
through, and `joinRun` is supported only for the same live privacy session.
Persistence, full-reload restoration, cross-tab restoration, and joining with a
new session are unsupported. Since 0.1.0,
`UnsupportedTanStackSemanticContentError` rejects unsupported semantic parts;
migrate those messages to text or a supported structured value.

## Placeholder strategies

```ts
import { hashed, sequential, token } from "local-pii"

sequential() // [EMAIL_1], readable and stable within one session
hashed({ secret }) // keyed equality without exposing the value
token() // opaque and robust in JSON/tool output
```

Use `token()` for tools and machine-parsed output. Never use an unkeyed hash:
personal information is low entropy and a guessed value could be verified
offline.

## Limitations

Detection is defense in depth, not a guarantee. Indirect identifiers can pass
through, and Rampart has lower recall for non-Latin scripts. Keep user content
and the private mapping out of logs, analytics, and crash reports.
