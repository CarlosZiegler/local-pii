import { useChat } from "@ai-sdk/react"
import { createAnonymizer, token, type PiiSession } from "local-pii"
import { withPii } from "local-pii/ai-sdk"
import { DirectChatTransport, ToolLoopAgent, type ChatStatus } from "ai"
import { useCallback, useMemo, useRef, useState } from "react"
import { ChatShell, type ChatShellMessage } from "./chat-shell"
import {
  createGenerationRunRegistry,
  recordGenerationRunFailures,
  resetPrivateConversation,
  type GenerationRunRegistry,
  type GenerationRun,
} from "./private-conversation"
import {
  createProtectionObserver,
  observeBrowserRuntime,
} from "./protection-observer"
import {
  isExpectedChatCancellation,
  settleChatStop,
} from "./model/settle-chat-stop"
import { createBrowserLanguageModel } from "./model/vercel-model"
import { withPlaygroundGate } from "./generation-gate"
import type { BrowserGenerationRuntime } from "./model/types"
import type { PrivacyInspection } from "./privacy-inspector"
import { useOptionalLocalRuntime } from "./runtime-provider"

export interface VercelChatProps {
  runtime?: BrowserGenerationRuntime
  runtimeName: string
}

function createSession(): PiiSession {
  return createAnonymizer({ placeholders: token() }).createSession()
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export function VercelChat({ runtime, runtimeName }: VercelChatProps) {
  const localRuntime = useOptionalLocalRuntime()
  const selectedRuntime = runtime ?? localRuntime?.runtime
  const gate = localRuntime?.gate
  const gateSnapshot = localRuntime?.gateSnapshot
  const [session, setSession] = useState(createSession)
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
  const protectedModel = useMemo(() => {
    if (!selectedRuntime)
      throw new Error("A browser generation runtime is required")
    const gated = gate
      ? withPlaygroundGate(selectedRuntime, gate, "vercel")
      : selectedRuntime
    return withPii(
      createBrowserLanguageModel(
        observeBrowserRuntime(
          recordGenerationRunFailures(gated, () => activeRun.current),
          observer
        )
      ),
      { session: observer.session }
    )
  }, [gate, observer, selectedRuntime])
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

  const handleStop = useCallback(async () => {
    setStopping(true)
    const settlement = runs.current.waitForActive()
    let failure = await settleChatStop(stop)
    try {
      await settlement
    } catch (cause) {
      failure ??= toError(cause)
    } finally {
      setStopping(false)
    }
    if (failure) setControlError(failure)
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
        return settleChatStop(stop)
      },
      awaitRunSettlement() {
        return runSettlement
      },
      awaitRuntimeCleanup() {
        return runSettlement
      },
      clearFramework() {
        setMessages([])
      },
      clearFrameworkError() {
        clearError()
      },
      clearOldSession() {
        oldSession.clear()
      },
      clearInspection() {
        setInspection(undefined)
      },
      createNewSession() {
        setSession(createSession())
      },
    })
    setControlError(failure)
  }, [clearError, session, setMessages, stop])

  const handleSubmit = useCallback(
    async (text: string) => {
      setControlError(undefined)
      const run = runs.current.begin()
      activeRun.current = run
      observer.begin(run.id)
      try {
        await sendMessage({ text })
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
            .map((part) => part.text)
            .join(""),
        })),
    [messages]
  )

  const otherChatBusy =
    gateSnapshot?.owner !== undefined &&
    gateSnapshot?.owner !== null &&
    gateSnapshot.owner !== "vercel"

  return (
    <ChatShell
      disabled={otherChatBusy}
      error={controlError ?? error}
      framework="Vercel AI SDK"
      inspection={inspection}
      messages={shellMessages}
      onNewChat={handleNewChat}
      onStop={handleStop}
      onSubmit={handleSubmit}
      resetting={resetting}
      runtimeName={runtimeName}
      status={status as ChatStatus}
      stopping={stopping}
    />
  )
}
