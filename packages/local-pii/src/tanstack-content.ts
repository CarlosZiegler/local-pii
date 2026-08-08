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

async function protectJsonText(
  session: PiiSession,
  text: string
): Promise<string> {
  try {
    return JSON.stringify(await session.anonymizeJson(JSON.parse(text)))
  } catch {
    return protectText(session, text)
  }
}

async function protectParts(
  session: PiiSession,
  parts: Array<unknown>
): Promise<Array<unknown>> {
  const output: Array<unknown> = []
  for (const part of parts) output.push(await protectContentPart(session, part))
  return output
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

  if (part.type === "tool-call") {
    const next: UnknownRecord = { ...part }
    if (typeof part.arguments === "string") {
      next.arguments = await protectJsonText(session, part.arguments)
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
    const next: UnknownRecord = { ...part }
    if (typeof part.content === "string") {
      next.content = await protectJsonText(session, part.content)
    } else if (Array.isArray(part.content)) {
      next.content = await protectParts(session, part.content)
    }
    if (typeof part.error === "string") {
      next.error = await protectText(session, part.error)
    }
    return next
  }

  return part
}

async function protectModelToolCall(
  session: PiiSession,
  toolCall: unknown
): Promise<unknown> {
  if (!isRecord(toolCall) || !isRecord(toolCall.function)) return toolCall
  if (typeof toolCall.function.arguments !== "string") return toolCall

  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: await protectJsonText(session, toolCall.function.arguments),
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
    next.parts = await protectParts(session, source.parts)
  }

  if (typeof source.content === "string") {
    next.content = await protectText(session, source.content)
  } else if (Array.isArray(source.content)) {
    next.content = await protectParts(session, source.content)
  }

  if (Array.isArray(source.toolCalls)) {
    const toolCalls: Array<unknown> = []
    for (const toolCall of source.toolCalls) {
      toolCalls.push(await protectModelToolCall(session, toolCall))
    }
    next.toolCalls = toolCalls
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
