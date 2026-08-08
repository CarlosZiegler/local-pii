"use client"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CpuIcon, DownloadIcon, ShieldCheckIcon } from "lucide-react"
import { RuntimeProvider, useLocalRuntime } from "./playground/runtime-provider"
import { TanStackChat } from "./playground/tanstack-chat"
import { VercelChat } from "./playground/vercel-chat"

function RuntimePlayground() {
  const runtime = useLocalRuntime()
  const ready = runtime.status === "ready" && runtime.runtime
  const runtimeName = runtime.metadata?.model ?? "Local model"

  return (
    <div className="not-prose my-8 space-y-4">
      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>Browser-only inference</AlertTitle>
        <AlertDescription>
          Prompts stay in this browser. There is no gateway, API route, server
          action, or API key. An explicit fallback download may fetch model
          artifacts, never inference requests.
        </AlertDescription>
      </Alert>

      {!ready ? (
        <div
          className="rounded-xl border bg-card p-5 shadow-sm"
          aria-live="polite"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <h3 className="flex items-center gap-2 font-semibold">
                <CpuIcon className="size-4" /> Choose a local runtime
              </h3>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Gemini Nano uses Chrome&apos;s built-in Prompt API. If it is not
                available, you can opt into Gemma 3 270M IT q4f16 (~426 MB) via
                WebGPU. Nothing downloads when this page opens.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {runtime.status === "native-ready" ||
              runtime.status === "native-downloadable" ? (
                <Button
                  onClick={() => void runtime.activateNative()}
                  type="button"
                >
                  {runtime.nativeAvailability === "available" ? (
                    <CpuIcon />
                  ) : (
                    <DownloadIcon />
                  )}
                  Use Gemini Nano
                </Button>
              ) : null}
              {runtime.status === "fallback-available" ||
              runtime.status === "error" ? (
                <Button
                  onClick={() => void runtime.activateFallback()}
                  type="button"
                >
                  <DownloadIcon /> Download local Gemma fallback
                </Button>
              ) : null}
              {runtime.status === "error" ? (
                <Button
                  onClick={() => void runtime.check()}
                  type="button"
                  variant="outline"
                >
                  Retry detection
                </Button>
              ) : null}
            </div>
          </div>

          {runtime.status === "checking" ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Checking browser capabilities…
            </p>
          ) : null}
          {runtime.status === "downloading" ? (
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Preparing {runtimeName}</span>
                <span>{Math.round((runtime.progress ?? 0) * 100)}%</span>
              </div>
              <Progress value={(runtime.progress ?? 0) * 100} />
            </div>
          ) : null}
          {runtime.error ? (
            <p className="mt-4 text-sm text-destructive">
              {runtime.error.message}
            </p>
          ) : null}
        </div>
      ) : (
        <Tabs defaultValue="vercel">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <TabsList aria-label="AI framework example">
              <TabsTrigger value="vercel">Vercel AI SDK</TabsTrigger>
              <TabsTrigger value="tanstack">TanStack AI</TabsTrigger>
            </TabsList>
            <span className="text-xs text-muted-foreground">
              Active runtime:{" "}
              <strong className="text-foreground">{runtimeName}</strong>
            </span>
          </div>
          <TabsContent
            className="mt-3 data-[state=inactive]:hidden"
            forceMount
            value="vercel"
          >
            <VercelChat runtimeName={runtimeName} />
          </TabsContent>
          <TabsContent
            className="mt-3 data-[state=inactive]:hidden"
            forceMount
            value="tanstack"
          >
            <TanStackChat runtime={ready} runtimeName={runtimeName} />
          </TabsContent>
        </Tabs>
      )}
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
