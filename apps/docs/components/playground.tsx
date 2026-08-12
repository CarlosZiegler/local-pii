"use client"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CpuIcon, DownloadIcon, ShieldCheckIcon, XIcon } from "lucide-react"
import type { RuntimeOption } from "./playground/model/types"
import { RuntimeProvider, useLocalRuntime } from "./playground/runtime-provider"
import { runtimeChoiceAriaLabel } from "./playground/runtime-choice"
import { TanStackChat } from "./playground/tanstack-chat"
import { VercelChat } from "./playground/vercel-chat"

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `~${(bytes / 1_000_000_000).toFixed(1)} GB`
  return `~${Math.round(bytes / 1_000_000)} MB`
}

function RuntimeDisclosure({ option }: { option: RuntimeOption }) {
  const { disclosure } = option
  return (
    <div className="space-y-1 text-sm">
      <h4 className="font-medium">{disclosure.label}</h4>
      <p className="text-muted-foreground">
        Model: <span className="text-foreground">{disclosure.model}</span>
      </p>
      <p className="text-muted-foreground">
        Source: <span className="text-foreground">{disclosure.source}</span>
      </p>
      {disclosure.artifacts.kind === "explicit-download" ? (
        <>
          <p className="text-muted-foreground">
            Artifact download:{" "}
            {formatBytes(disclosure.artifacts.approximateBytes)}
          </p>
          <p className="text-muted-foreground">
            Origins: {disclosure.artifacts.origins.join(", ")}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">Artifacts: browser-managed</p>
      )}
    </div>
  )
}

function RuntimeChoice({ option }: { option: RuntimeOption }) {
  const runtime = useLocalRuntime()
  const unavailable = option.availability === "unavailable"
  const cached = option.availability === "ready"

  return (
    <li className="flex flex-col gap-4 rounded-lg border bg-background p-4 sm:flex-row sm:items-start sm:justify-between">
      <RuntimeDisclosure option={option} />
      <Button
        aria-label={runtimeChoiceAriaLabel(option)}
        disabled={unavailable}
        onClick={() => {
          void runtime.activate(option.kind)
        }}
        type="button"
      >
        {cached ? <CpuIcon /> : <DownloadIcon />}
        {unavailable
          ? "Unavailable"
          : cached
            ? "Use cached runtime"
            : "Activate runtime"}
      </Button>
    </li>
  )
}

function RuntimePlayground() {
  const runtime = useLocalRuntime()
  const ready = runtime.status === "ready" && runtime.runtime

  return (
    <div className="not-prose my-8 space-y-4">
      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>Browser-only inference</AlertTitle>
        <AlertDescription>
          Prompts stay in this browser. There is no gateway, API route, server
          action, or API key. Explicit artifact downloads contain only static
          model resources and no user content.
        </AlertDescription>
      </Alert>

      {runtime.status === "checking" ? (
        <div
          className="rounded-xl border bg-card p-5 shadow-sm"
          aria-live="polite"
        >
          <h3 className="font-semibold">Checking browser capabilities…</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            No model artifacts are downloaded during this check.
          </p>
        </div>
      ) : null}

      {runtime.status === "choice-required" ? (
        <section
          aria-live="polite"
          className="rounded-xl border bg-card p-5 shadow-sm"
        >
          <div className="space-y-1">
            <h3 className="flex items-center gap-2 font-semibold">
              <CpuIcon className="size-4" /> Choose a local runtime
            </h3>
            <p className="text-sm text-muted-foreground">
              Review each runtime before explicitly activating it. Nothing is
              downloaded until you choose one.
            </p>
          </div>
          <ul className="mt-4 space-y-3">
            {runtime.options.map((option) => (
              <RuntimeChoice key={option.kind} option={option} />
            ))}
          </ul>
        </section>
      ) : null}

      {runtime.status === "activating" ? (
        <section
          aria-live="polite"
          className="rounded-xl border bg-card p-5 shadow-sm"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h3 className="font-semibold">
                Activating {runtime.disclosure.label}
              </h3>
              <p className="text-sm text-muted-foreground">
                Model: {runtime.disclosure.model}; source:{" "}
                {runtime.disclosure.source}
              </p>
              {runtime.disclosure.artifacts.kind === "explicit-download" ? (
                <p className="text-sm text-muted-foreground">
                  Download:{" "}
                  {formatBytes(runtime.disclosure.artifacts.approximateBytes)}
                  {" · "}origins:{" "}
                  {runtime.disclosure.artifacts.origins.join(", ")}
                </p>
              ) : null}
            </div>
            <Button onClick={runtime.abort} type="button" variant="outline">
              <XIcon /> Cancel
            </Button>
          </div>
          <div className="mt-4 space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Preparing runtime</span>
              <span>{Math.round((runtime.progress ?? 0) * 100)}%</span>
            </div>
            <Progress
              aria-label="Runtime activation progress"
              value={(runtime.progress ?? 0) * 100}
            />
          </div>
        </section>
      ) : null}

      {runtime.actionError ? (
        <Alert aria-live="polite" variant="destructive">
          <AlertTitle>Runtime action failed</AlertTitle>
          <AlertDescription>{runtime.actionError.message}</AlertDescription>
        </Alert>
      ) : null}

      {runtime.status === "error" ? (
        <Alert aria-live="polite" variant="destructive">
          <AlertTitle>Runtime activation failed</AlertTitle>
          <AlertDescription>
            <p>{runtime.error.message}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {runtime.recovery.includes("retry-activation") && runtime.kind ? (
                <Button
                  onClick={() => {
                    void runtime.activate(runtime.kind!)
                  }}
                  type="button"
                  variant="outline"
                >
                  Retry activation
                </Button>
              ) : null}
              {runtime.recovery.includes("check-again") ? (
                <Button
                  onClick={() => void runtime.check()}
                  type="button"
                  variant="outline"
                >
                  Check again
                </Button>
              ) : null}
              {runtime.recovery.includes("choose-runtime") ? (
                <Button
                  onClick={() => void runtime.check()}
                  type="button"
                  variant="outline"
                >
                  Choose another runtime
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {ready ? (
        <Tabs defaultValue="vercel">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <TabsList aria-label="AI framework example">
              <TabsTrigger value="vercel">Vercel AI SDK</TabsTrigger>
              <TabsTrigger value="tanstack">TanStack AI</TabsTrigger>
            </TabsList>
            <span className="text-xs text-muted-foreground">
              Active runtime:{" "}
              <strong className="text-foreground">
                {runtime.disclosure.label}
              </strong>
            </span>
          </div>
          <TabsContent
            className="mt-3 data-[state=inactive]:hidden"
            forceMount
            value="vercel"
          >
            <VercelChat
              runtime={ready}
              runtimeName={runtime.disclosure.label}
            />
          </TabsContent>
          <TabsContent
            className="mt-3 data-[state=inactive]:hidden"
            forceMount
            value="tanstack"
          >
            <TanStackChat
              runtime={ready}
              runtimeName={runtime.disclosure.label}
            />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  )
}

export function Playground() {
  return (
    <RuntimeProvider>
      <RuntimePlayground />
    </RuntimeProvider>
  )
}
