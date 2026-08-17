import { createAnonymizer } from "@local-pii/core"
import { piiMiddleware, withPii } from "@local-pii/core/ai-sdk"

const session = createAnonymizer().createSession()
declare const model: Parameters<typeof withPii>[0]

export const implicitMiddleware = piiMiddleware()
export const explicitMiddleware = piiMiddleware({ session })
export const implicitModel = withPii(model)
export const explicitModel = withPii(model, { session })
