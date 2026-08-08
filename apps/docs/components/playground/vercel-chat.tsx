"use client"

import { useChat } from "@ai-sdk/react"
import { browserAI } from "@browser-ai/core"
import { createAnonymizer, token, type PiiSession } from "local-pii"
import { withPii } from "local-pii/ai-sdk"
import {
  DirectChatTransport,
  ToolLoopAgent,
  type ChatStatus,
  type LanguageModel,
} from "ai"
import { useMemo, useState } from "react"
import { ChatShell, type ChatShellMessage } from "./chat-shell"
import type { PrivacyInspection } from "./privacy-inspector"

export interface VercelChatProps {
  model?: LanguageModel
  runtimeName: string
}

function createSession(): PiiSession {
  return createAnonymizer({ placeholders: token() }).createSession()
}

function inspectionFrom(
  protectedPrompt: string,
  entities: ReadonlyArray<{ type: string }>
): PrivacyInspection {
  const counts: Record<string, number> = {}
  for (const entity of entities)
    counts[entity.type] = (counts[entity.type] ?? 0) + 1
  return { counts, protectedPrompt }
}

export function VercelChat({ model, runtimeName }: VercelChatProps) {
  const [session] = useState(createSession)
  const [inspection, setInspection] = useState<PrivacyInspection>()
  const protectedModel = useMemo(
    () => withPii(model ?? browserAI("text"), { session }),
    [model, session]
  )
  const transport = useMemo(
    () =>
      new DirectChatTransport({
        agent: new ToolLoopAgent({ model: protectedModel }),
      }),
    [protectedModel]
  )
  const {
    clearError,
    error,
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
  } = useChat({ transport })

  const shellMessages = useMemo<Array<ChatShellMessage>>(
    () =>
      messages
        .filter(
          (
            message
          ): message is typeof message & { role: "user" | "assistant" } =>
            message.role === "user" || message.role === "assistant"
        )
        .map((message) => ({
          id: message.id,
          role: message.role,
          text: message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        })),
    [messages]
  )

  return (
    <ChatShell
      error={error}
      framework="Vercel AI SDK"
      inspection={inspection}
      messages={shellMessages}
      onNewChat={() => {
        stop()
        setMessages([])
        clearError()
        session.clear()
        setInspection(undefined)
      }}
      onStop={stop}
      onSubmit={async (text) => {
        const result = await session.anonymize(text)
        setInspection(inspectionFrom(result.redactedText, result.entities))
        await sendMessage({ text })
      }}
      runtimeName={runtimeName}
      status={status as ChatStatus}
    />
  )
}
