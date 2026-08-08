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

  if (part.type === "tool-call") {
    const next: UnknownRecord = { ...part }
    if (typeof part.arguments === "string") {
      next.arguments = await protectText(session, part.arguments)
    }
    if (part.input !== undefined) {
      next.input = await session.anonymizeJson(part.input)
    }
    if (part.output !== undefined) {
      next.output = await session.anonymizeJson(part.output)
    }
    return next
  }

  if (part.type === "tool-result") {
    if (typeof part.content === "string") {
      return { ...part, content: await protectText(session, part.content) }
    }
    if (Array.isArray(part.content)) {
      return {
        ...part,
        content: await Promise.all(
          part.content.map((child) => protectContentPart(session, child))
        ),
      }
    }
  }

  return part
}

async function protectToolCall(
  session: PiiSession,
  toolCall: unknown
): Promise<unknown> {
  if (!isRecord(toolCall) || !isRecord(toolCall.function)) return toolCall
  if (typeof toolCall.function.arguments !== "string") return toolCall

  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: await protectText(session, toolCall.function.arguments),
    },
  }
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

  if (Array.isArray(source.toolCalls)) {
    next.toolCalls = await Promise.all(
      source.toolCalls.map((toolCall) => protectToolCall(session, toolCall))
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
