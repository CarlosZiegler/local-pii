import { useChat } from "@tanstack/ai-react"
import { createAnonymizer, token, type PiiSession } from "local-pii"
import type { ChatStatus } from "ai"
import { useCallback, useMemo, useRef, useState } from "react"
import {
  ChatShell,
  OTHER_CONVERSATION_BUSY_REASON,
  type ChatShellMessage,
} from "./chat-shell"
import {
  createGenerationRunRegistry,
  recordGenerationRunFailures,
  resetPrivateConversation,
  type GenerationRun,
  type GenerationRunRegistry,
} from "./private-conversation"
import {
  createProtectionObserver,
  type ProtectionObserver,
} from "./protection-observer"
import { isExpectedChatCancellation } from "./model/settle-chat-stop"
import type { BrowserGenerationRuntime } from "./model/types"
import type { PrivacyInspection } from "./privacy-inspector"
import { useOptionalLocalRuntime } from "./runtime-provider"
import { createTanStackPlaygroundConnection } from "./tanstack-playground-connection"

export interface TanStackChatProps {
  runtime: BrowserGenerationRuntime
  runtimeName: string
}

function createSession(): PiiSession {
  return createAnonymizer({ placeholders: token() }).createSession()
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export function TanStackChat({ runtime, runtimeName }: TanStackChatProps) {
  const [conversationKey, setConversationKey] = useState(0)

  return (
    <TanStackPrivateConversation
      key={conversationKey}
      onConversationReset={() => setConversationKey((key) => key + 1)}
      runtime={runtime}
      runtimeName={runtimeName}
    />
  )
}

interface TanStackPrivateConversationProps extends TanStackChatProps {
  onConversationReset(): void
}

function TanStackPrivateConversation({
  onConversationReset,
  runtime,
  runtimeName,
}: TanStackPrivateConversationProps) {
  const localRuntime = useOptionalLocalRuntime()
  const gate = localRuntime?.gate
  const gateSnapshot = localRuntime?.gateSnapshot
  const [session] = useState(createSession)
  const [inspection, setInspection] = useState<PrivacyInspection>()
  const [controlError, setControlError] = useState<Error>()
  const [resetting, setResetting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const runs = useRef<GenerationRunRegistry>(createGenerationRunRegistry())
  const activeRun = useRef<GenerationRun | null>(null)
  const observer = useMemo(
    () => createProtectionObserver(session, setInspection),
    [session]
  )
  const connection = useMemo(() => {
    return createTanStackPlaygroundConnection({
      gate,
      getRun: () => activeRun.current,
      observer,
      runtime,
    })
  }, [gate, observer, runtime])
  const { clear, error, isLoading, messages, sendMessage, stop } = useChat({
    connection,
  })

  const handleStop = useCallback(async () => {
    setStopping(true)
    try {
      stop()
      await runs.current.waitForActive()
    } catch (cause) {
      if (!isExpectedChatCancellation(cause)) {
        setControlError(toError(cause))
      }
    } finally {
      setStopping(false)
    }
  }, [stop])

  const handleNewChat = useCallback(async () => {
    const oldSession = session
    const runSettlement = runs.current.waitForActive()
    setResetting(true)
    const failure = await resetPrivateConversation({
      blockSubmissions(blocked) {
        setResetting(blocked)
      },
      abortActiveRun() {
        activeRun.current?.abort(
          new DOMException("Private conversation reset", "AbortError")
        )
      },
      stopFramework() {
        stop()
        return Promise.resolve(undefined)
      },
      awaitRunSettlement() {
        return runSettlement
      },
      awaitRuntimeCleanup() {
        return runSettlement
      },
      clearFramework() {
        clear()
      },
      clearFrameworkError() {
        // `clear` also clears the hook's error state.
      },
      clearOldSession() {
        oldSession.clear()
      },
      clearInspection() {
        setInspection(undefined)
      },
      createNewSession() {
        onConversationReset()
      },
    })
    setControlError(failure)
  }, [clear, onConversationReset, session, stop])

  const handleSubmit = useCallback(
    async (text: string) => {
      setControlError(undefined)
      const run = runs.current.begin()
      activeRun.current = run
      observer.begin(run.id)
      try {
        await sendMessage(text)
      } catch (cause) {
        observer.discard()
        if (!isExpectedChatCancellation(cause)) {
          if (runs.current.isCurrent(run.id)) setControlError(toError(cause))
          throw cause
        }
      } finally {
        run.settle()
        if (activeRun.current?.id === run.id) activeRun.current = null
      }
    },
    [observer, sendMessage]
  )

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
  const otherChatBusy =
    gateSnapshot?.owner !== undefined &&
    gateSnapshot?.owner !== null &&
    gateSnapshot.owner !== "tanstack"

  return (
    <ChatShell
      disabled={otherChatBusy}
      disabledReason={
        otherChatBusy ? OTHER_CONVERSATION_BUSY_REASON : undefined
      }
      error={controlError ?? error}
      framework="TanStack AI"
      inspection={inspection}
      messages={shellMessages}
      onNewChat={handleNewChat}
      onStop={handleStop}
      onSubmit={handleSubmit}
      resetting={resetting}
      runtimeName={runtimeName}
      status={status}
      stopping={stopping}
    />
  )
}
