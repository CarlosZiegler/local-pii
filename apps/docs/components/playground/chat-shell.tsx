import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { RotateCcwIcon, ShieldCheckIcon } from "lucide-react"
import type { ChatStatus } from "ai"
import { useId } from "react"
import type { PrivacyInspection } from "./privacy-inspector"
import { PrivacyInspector } from "./privacy-inspector"

export const OTHER_CONVERSATION_BUSY_REASON =
  "Another private conversation is running browser-local inference."

export interface ChatShellMessage {
  id: string
  role: "user" | "assistant"
  text: string
}

export interface ChatShellProps {
  disabled?: boolean
  disabledReason?: string
  error?: Error
  framework: string
  inspection?: PrivacyInspection
  messages: ChatShellMessage[]
  onNewChat(): Promise<void>
  onStop(): Promise<void>
  onSubmit(text: string): Promise<void>
  resetting?: boolean
  runtimeName: string
  status: ChatStatus
  stopping?: boolean
}

export function ChatShell({
  disabled,
  disabledReason,
  error,
  framework,
  inspection,
  messages,
  onNewChat,
  onStop,
  onSubmit,
  resetting = false,
  runtimeName,
  status,
  stopping = false,
}: ChatShellProps) {
  const disabledReasonId = useId()
  const busy = status === "submitted" || status === "streaming"
  const controlsDisabled = disabled || busy || resetting || stopping

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(16rem,0.85fr)]">
      <Card className="min-h-[34rem] overflow-hidden">
        <CardHeader className="flex-row items-center justify-between border-b p-4">
          <div className="space-y-1">
            <CardTitle className="text-base">{framework}</CardTitle>
            <p className="text-xs text-muted-foreground">
              Direct browser inference · no gateway or API route
            </p>
          </div>
          <Button
            aria-label="Start a new chat"
            disabled={controlsDisabled}
            onClick={() => void onNewChat()}
            size="sm"
            type="button"
            variant="outline"
          >
            <RotateCcwIcon /> New chat
          </Button>
        </CardHeader>
        <CardContent className="flex h-[29rem] flex-col gap-3 p-3">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Generation failed</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}
          <Conversation className="min-h-0 rounded-lg border bg-background">
            <ConversationContent aria-live="polite">
              {messages.length === 0 ? (
                <ConversationEmptyState
                  description="Try: Email ana@acme.com and ask the model to repeat it."
                  icon={<ShieldCheckIcon className="size-6" />}
                  title="Private local chat"
                />
              ) : (
                messages.map((message) => (
                  <Message from={message.role} key={message.id}>
                    <MessageContent>
                      {message.role === "assistant" ? (
                        <MessageResponse>{message.text}</MessageResponse>
                      ) : (
                        message.text
                      )}
                    </MessageContent>
                  </Message>
                ))
              )}
            </ConversationContent>
            <ConversationScrollButton aria-label="Scroll to latest message" />
          </Conversation>
          <PromptInput
            onSubmit={async ({ text }) => {
              const value = text.trim()
              if (value && !controlsDisabled) await onSubmit(value)
            }}
          >
            <PromptInputBody>
              <PromptInputTextarea
                aria-describedby={
                  disabled && disabledReason ? disabledReasonId : undefined
                }
                aria-label="Message"
                disabled={controlsDisabled}
                placeholder="Write a message containing test PII…"
              />
            </PromptInputBody>
            <PromptInputFooter>
              <span
                aria-live="polite"
                className="text-xs text-muted-foreground"
                id={disabledReasonId}
              >
                {disabled && disabledReason
                  ? disabledReason
                  : resetting
                    ? "Resetting private conversation…"
                    : stopping
                      ? "Stopping generation run…"
                      : busy
                        ? "Running browser-local inference…"
                        : "Enter to send · Shift+Enter for newline"}
              </span>
              <PromptInputSubmit
                disabled={disabled || resetting || stopping}
                onStop={() => void onStop()}
                status={status}
              />
            </PromptInputFooter>
          </PromptInput>
        </CardContent>
      </Card>
      <PrivacyInspector inspection={inspection} runtimeName={runtimeName} />
    </div>
  )
}
