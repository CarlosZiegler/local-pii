import { createAnonymizer, token } from "@local-pii/core"
import {
  runInline,
  runInlineJson,
  runInlineText,
  runInlineTextStream,
} from "@local-pii/core/inline"

const anonymizer = createAnonymizer({ placeholders: token() })
const session = anonymizer.createSession()

export const withAnonymizer = runInlineText({
  anonymizer,
  input: "hello",
  call: async (input) => input,
})
export const withSession = runInlineText({
  session,
  input: "hello",
  call: async (input) => input,
})
export const stream = runInlineTextStream({
  session,
  input: "hello",
  async *call(input) {
    yield input
  },
})
export const json = runInlineJson({
  session,
  input: { value: "hello" },
  call: async (input) => input,
})
export const generic = runInline({
  session,
  input: "hello",
  protect: async (input) => input,
  call: async (input) => input,
  restore: (output) => output,
})
