import { createAnonymizer } from "local-pii"
import {
  createPiiChat,
  PiiOpenAIHelperError,
  withPiiOpenAI,
} from "local-pii/openai"

const session = createAnonymizer().createSession()
const client = {
  chat: {
    completions: {
      create: async (_params: Record<string, unknown>) => ({ choices: [] }),
    },
  },
}

export const implicit = withPiiOpenAI(client)
export const explicit = withPiiOpenAI(client, { session })
export const manual = createPiiChat({ session })
export const helperError = PiiOpenAIHelperError
