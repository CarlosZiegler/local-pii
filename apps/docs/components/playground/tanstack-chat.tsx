import { useChat } from "@tanstack/ai-react"
import {
  createAnonymizer,
  token,
  type NerBackend,
  type PiiSession,
  type PiiType,
} from "@local-pii/core"
import type { ChatStatus } from "ai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChatShell,
  OTHER_CONVERSATION_BUSY_REASON,
  type ChatShellMessage,
} from "./chat-shell"
import {
  createGenerationRunRegistry,
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
import { serializeDetectionKeep } from "../playground"

export interface TanStackChatProps {
  runtime: BrowserGenerationRuntime
  runtimeName: string
  detection?: NerBackend
  /**
   * Model Detection categories retained in protected text (anonymizer `keep`).
   * Always pass an explicit list from the playground policy; `[]` means redact
   * every listed model category.
   */
  keep?: readonly PiiType[]
}

function createSession(
  detection: NerBackend | undefined,
  keep: readonly PiiType[]
): PiiSession {
  return createAnonymizer({
    detection,
    placeholders: token(),
    keep: [...keep],
    // Fail closed when model-backed Detection is configured but unavailable.
    // A degraded playground must never forward selected categories unchanged.
    strict: true,
  }).createSession()
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export function TanStackChat({
  runtime,
  runtimeName,
  detection,
  keep = [],
}: TanStackChatProps) {
  const [conversationKey, setConversationKey] = useState(0)

  return (
    <TanStackPrivateConversation
      key={conversationKey}
      onConversationReset={() => setConversationKey((key) => key + 1)}
      detection={detection}
      keep={keep}
      runtime={runtime}
      runtimeName={runtimeName}
    />
  )
}

interface TanStackPrivateConversationProps extends Omit<
  TanStackChatProps,
  "keep"
> {
  onConversationReset(): void
  keep: readonly PiiType[]
}

function TanStackPrivateConversation({
  onConversationReset,
  runtime,
  runtimeName,
  detection,
  keep,
}: TanStackPrivateConversationProps) {
  const localRuntime = useOptionalLocalRuntime()
  const gate = localRuntime?.gate
  const gateSnapshot = localRuntime?.gateSnapshot
  const [session] = useState(() => createSession(detection, keep))
  const [inspection, setInspection] = useState<PrivacyInspection>()
  const [controlError, setControlError] = useState<Error>()
  const [resetting, setResetting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const runs = useRef<GenerationRunRegistry>(createGenerationRunRegistry())
  const activeRun = useRef<GenerationRun | null>(null)
  const keepKey = serializeDetectionKeep(keep)
  const policyMounted = useRef(false)
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

  const handleNewChatRef = useRef(handleNewChat)
  handleNewChatRef.current = handleNewChat

  useEffect(() => {
    if (!policyMounted.current) {
      policyMounted.current = true
      return
    }
    void handleNewChatRef.current()
  }, [keepKey])

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
