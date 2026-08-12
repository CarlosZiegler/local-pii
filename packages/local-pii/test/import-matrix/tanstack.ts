import type { ConnectConnectionAdapter } from "@tanstack/ai-client"
import { createAnonymizer } from "local-pii"
import {
  piiConnection,
  UnsupportedTanStackSemanticContentError,
} from "local-pii/tanstack"

const session = createAnonymizer().createSession()
declare const connection: ConnectConnectionAdapter

export const protectedConnection = piiConnection(connection, { session })
export const unsupportedError = UnsupportedTanStackSemanticContentError
