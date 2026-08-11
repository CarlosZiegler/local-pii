"use client"

import { useChat } from "@tanstack/ai-react"
import { createAnonymizer, token, type PiiSession } from "local-pii"
import { piiConnection } from "local-pii/tanstack"
import type { ChatStatus } from "ai"
import { useMemo, useState } from "react"
import { ChatShell, type ChatShellMessage } from "./chat-shell"
import { createBrowserConnection } from "./model/tanstack-connection"
import type { BrowserGenerationRuntime } from "./model/types"
import type { PrivacyInspection } from "./privacy-inspector"

export interface TanStackChatProps {
  runtime: BrowserGenerationRuntime
  runtimeName: string
}

function createSession(): PiiSession {
  return createAnonymizer({ placeholders: token() }).createSession()
}

export function TanStackChat({ runtime, runtimeName }: TanStackChatProps) {
  const [session] = useState(createSession)
  const [inspection, setInspection] = useState<PrivacyInspection>()
  const connection = useMemo(
    () => piiConnection(createBrowserConnection(runtime), { session }),
    [runtime, session]
  )
  const { clear, error, isLoading, messages, sendMessage, stop } = useChat({
    connection,
  })

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
            .map((part) => part.content)
            .join(""),
        })),
    [messages]
  )
  const status: ChatStatus = error ? "error" : isLoading ? "streaming" : "ready"

  return (
    <ChatShell
      error={error}
      framework="TanStack AI"
      inspection={inspection}
      messages={shellMessages}
      onNewChat={() => {
        stop()
        clear()
        session.clear()
        setInspection(undefined)
      }}
      onStop={stop}
      onSubmit={async (text) => {
        const result = await session.anonymize(text)
        const counts: Record<string, number> = {}
        for (const entity of result.entities) {
          counts[entity.type] = (counts[entity.type] ?? 0) + 1
        }
        setInspection({ counts, protectedPrompt: result.redactedText })
        await sendMessage(text)
      }}
      runtimeName={runtimeName}
      status={status}
    />
  )
}
