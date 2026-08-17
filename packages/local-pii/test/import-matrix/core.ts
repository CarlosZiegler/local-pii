import {
  createAnonymizer,
  type DetectionModel,
  type NerBackend,
} from "@local-pii/core"

declare const detection: DetectionModel
const legacy: NerBackend = detection

export const currentSession = createAnonymizer({ detection }).createSession()
export const legacySession = createAnonymizer({ ner: legacy }).createSession()
