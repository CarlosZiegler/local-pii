import type { ModelMessage, UIMessage } from "@tanstack/ai/client"
import type { PiiSession } from "./session"

type TanStackMessages = Array<UIMessage> | Array<ModelMessage>
type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object"
}

async function protectText(session: PiiSession, text: string): Promise<string> {
  if (text.length === 0) return text
  return (await session.anonymize(text)).redactedText
}

async function protectContentPart(
  session: PiiSession,
  part: unknown
): Promise<unknown> {
  if (!isRecord(part)) return part

  if (part.type === "text" && typeof part.content === "string") {
    return { ...part, content: await protectText(session, part.content) }
  }

  if (
    part.type === "structured-output" &&
    part.status === "complete" &&
    typeof part.raw === "string"
  ) {
    return { ...part, raw: await protectText(session, part.raw) }
  }

  return part
}

async function protectMessage(
  session: PiiSession,
  message: UIMessage | ModelMessage
): Promise<UIMessage | ModelMessage> {
  const source = message as unknown as UnknownRecord
  const next: UnknownRecord = { ...source }

  if (Array.isArray(source.parts)) {
    next.parts = await Promise.all(
      source.parts.map((part) => protectContentPart(session, part))
    )
  }

  if (typeof source.content === "string") {
    next.content = await protectText(session, source.content)
  } else if (Array.isArray(source.content)) {
    next.content = await Promise.all(
      source.content.map((part) => protectContentPart(session, part))
    )
  }

  return next as unknown as UIMessage | ModelMessage
}

/** Protect only model-semantic fields and retain protocol/control values. */
export async function protectTanStackMessages(
  session: PiiSession,
  messages: TanStackMessages
): Promise<TanStackMessages> {
  const protectedMessages: Array<UIMessage | ModelMessage> = []
  for (const message of messages) {
    protectedMessages.push(await protectMessage(session, message))
  }
  return protectedMessages as TanStackMessages
}
