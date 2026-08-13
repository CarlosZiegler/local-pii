"use client"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { NerBackend, PiiType } from "local-pii"
import {
  rampartAssets,
  rampartWeb,
  type RampartWebOptions,
} from "local-pii/web"
import {
  ChevronsUpDownIcon,
  CpuIcon,
  DownloadIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RuntimeOption } from "./playground/model/types"
import { RuntimeProvider, useLocalRuntime } from "./playground/runtime-provider"
import { runtimeChoiceAriaLabel } from "./playground/runtime-choice"
import { TanStackChat } from "./playground/tanstack-chat"
import { VercelChat } from "./playground/vercel-chat"

/** Model-backed Detection categories exposed by the playground multi-select. */
export const DETECTION_CATEGORY_GROUPS = [
  {
    id: "identity",
    label: "Identity",
    types: ["GIVEN_NAME", "SURNAME", "PERSON", "ORGANIZATION"],
  },
  {
    id: "contact",
    label: "Contact",
    types: ["EMAIL", "PHONE", "URL"],
  },
  {
    id: "address",
    label: "Address",
    types: [
      "BUILDING_NUMBER",
      "STREET_NAME",
      "SECONDARY_ADDRESS",
      "CITY",
      "STATE",
      "ZIP_CODE",
    ],
  },
  {
    id: "documents",
    label: "Documents",
    types: ["TAX_ID", "GOVERNMENT_ID", "PASSPORT", "DRIVERS_LICENSE"],
  },
  {
    id: "financial-network",
    label: "Financial / network",
    types: [
      "BANK_ACCOUNT",
      "ROUTING_NUMBER",
      "CREDIT_CARD",
      "IBAN",
      "IP_ADDRESS",
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  types: readonly PiiType[]
}>

export const ALL_DETECTION_CATEGORIES: readonly PiiType[] =
  DETECTION_CATEGORY_GROUPS.flatMap((group) => [...group.types])

/** Unselected by default so local-pii keeps CITY/STATE/ZIP_CODE (library default). */
export const DEFAULT_UNSELECTED_DETECTION_CATEGORIES: readonly PiiType[] = [
  "CITY",
  "STATE",
  "ZIP_CODE",
]

export function createDefaultSelectedDetectionCategories(): Set<PiiType> {
  const unselected = new Set<PiiType>(DEFAULT_UNSELECTED_DETECTION_CATEGORIES)
  return new Set(
    ALL_DETECTION_CATEGORIES.filter((type) => !unselected.has(type))
  )
}

/**
 * Unselected model Detection categories become anonymizer `keep` entries so
 * they are retained; selected categories are redacted by the Detection model.
 * Deterministic built-in detectors are unaffected by this list.
 */
export function detectionKeepFromSelected(
  selected: ReadonlySet<PiiType>
): PiiType[] {
  return ALL_DETECTION_CATEGORIES.filter((type) => !selected.has(type))
}

export function serializeDetectionKeep(keep: readonly PiiType[]): string {
  return [...keep].sort().join("\0")
}

function createPlaygroundDetection(): NerBackend {
  let inner: NerBackend | undefined
  let loadPromise: Promise<void> | undefined
  let disposed = false

  return {
    name: "rampart-web-wasm",
    async load() {
      if (disposed) {
        throw new DOMException("Detection runtime disposed", "AbortError")
      }
      loadPromise ??= (async () => {
        // The default ONNX Runtime browser bundle selects its JSEP artifact
        // even for a WASM-only session. Cloudflare Pages cannot publish that
        // artifact because it exceeds the per-file limit, so load the actual
        // WASM-only entry point at the browser boundary.
        const ortWasm = await import("onnxruntime-web/wasm")
        const detection = rampartWeb({
          ort: ortWasm as unknown as NonNullable<RampartWebOptions["ort"]>,
          model: "/models/rampart-q4.onnx",
          vocab: rampartAssets.vocab,
          labels: rampartAssets.labels,
          executionProviders: ["wasm"],
          wasmPaths:
            process.env.NODE_ENV === "production" ? "/ort/" : undefined,
        })
        await detection.load()
        if (disposed) {
          await detection.dispose()
          throw new DOMException("Detection runtime disposed", "AbortError")
        }
        inner = detection
      })().catch((error) => {
        loadPromise = undefined
        throw error
      })
      await loadPromise
    },
    async detect(text) {
      return inner?.detect(text) ?? []
    },
    async dispose() {
      disposed = true
      const pendingLoad = loadPromise
      if (pendingLoad) {
        try {
          await pendingLoad
        } catch {
          // Loading already reports its own primary failure to the generation.
        }
      }
      const detection = inner
      inner = undefined
      loadPromise = undefined
      await detection?.dispose()
    },
  }
}

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

function RuntimeChoice({
  option,
  onClear,
}: {
  option: RuntimeOption
  onClear?: () => void
}) {
  const runtime = useLocalRuntime()
  const unavailable = option.availability === "unavailable"
  const cached = option.availability === "ready"

  return (
    <li className="flex flex-col gap-4 rounded-lg border bg-background p-4 sm:flex-row sm:items-start sm:justify-between">
      <RuntimeDisclosure option={option} />
      <div className="flex flex-wrap gap-2">
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
        {onClear ? (
          <Button onClick={onClear} type="button" variant="outline">
            Clear cached model
          </Button>
        ) : null}
      </div>
    </li>
  )
}

function DetectionCategorySelector({
  selected,
  onChange,
}: {
  selected: ReadonlySet<PiiType>
  onChange: (next: Set<PiiType>) => void
}) {
  const selectedCount = selected.size
  const total = ALL_DETECTION_CATEGORIES.length
  const selectedList = ALL_DETECTION_CATEGORIES.filter((type) =>
    selected.has(type)
  )

  const toggle = useCallback(
    (type: PiiType, nextChecked: boolean) => {
      const next = new Set(selected)
      if (nextChecked) next.add(type)
      else next.delete(type)
      onChange(next)
    },
    [onChange, selected]
  )

  const remove = useCallback(
    (type: PiiType) => {
      const next = new Set(selected)
      next.delete(type)
      onChange(next)
    },
    [onChange, selected]
  )

  return (
    <section
      aria-labelledby="detection-categories-heading"
      className="space-y-3 rounded-xl border bg-card p-4 shadow-sm"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h3
            className="text-sm font-semibold"
            id="detection-categories-heading"
          >
            Protect these Detection categories
          </h3>
          <p className="text-xs text-muted-foreground">
            Shared by Vercel AI SDK and TanStack AI. Selected model categories
            are redacted; unselected ones stay in the protected request via the
            anonymizer keep list.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Protect these Detection categories, ${selectedCount} of ${total} selected`}
              className="justify-between sm:min-w-[16rem]"
              type="button"
              variant="outline"
            >
              <span>
                {selectedCount === 0
                  ? "No model categories"
                  : `${selectedCount} of ${total} categories`}
              </span>
              <ChevronsUpDownIcon className="size-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="max-h-80 w-72 overflow-y-auto"
          >
            {DETECTION_CATEGORY_GROUPS.map((group, index) => (
              <div key={group.id}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                {group.types.map((type) => (
                  <DropdownMenuCheckboxItem
                    checked={selected.has(type)}
                    key={type}
                    onCheckedChange={(checked) =>
                      toggle(type, checked === true)
                    }
                    onSelect={(event) => event.preventDefault()}
                  >
                    {type}
                  </DropdownMenuCheckboxItem>
                ))}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {selectedCount === 0 ? (
        <p className="text-xs text-muted-foreground" role="status">
          No model Detection categories selected. Deterministic built-in
          detectors (email, URL, IP, SSN, card, IBAN, and phone) remain active.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected categories">
          {selectedList.map((type) => (
            <li key={type}>
              <Badge className="gap-1 pr-1" variant="secondary">
                <span>{type}</span>
                <button
                  aria-label={`Remove ${type}`}
                  className="rounded-full p-0.5 hover:bg-muted"
                  onClick={() => remove(type)}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Deterministic built-in detectors (email, URL, IP, SSN, card, IBAN, and
        phone) stay always-on in this playground: the public anonymizer contract
        cannot disable them individually. Deselecting a model category such as
        EMAIL does not turn off the deterministic email detector.
      </p>
    </section>
  )
}

export function RuntimePlayground() {
  const runtime = useLocalRuntime()
  const detection = useMemo(createPlaygroundDetection, [])
  // React Strict Mode remounts effects once in development (mount → cleanup →
  // remount). Dispose must wait a microtask so a replayed effect can claim the
  // same Detection backend; a genuine final teardown still disposes it.
  const detectionEffectGeneration = useRef(0)
  useEffect(() => {
    const generation = ++detectionEffectGeneration.current
    return () => {
      queueMicrotask(() => {
        if (detectionEffectGeneration.current !== generation) {
          return
        }
        // Component teardown has no UI channel for a cleanup failure.
        void detection.dispose().catch(() => undefined)
      })
    }
  }, [detection])
  const [selectedCategories, setSelectedCategories] = useState(
    createDefaultSelectedDetectionCategories
  )
  const [policyAnnouncement, setPolicyAnnouncement] = useState("")
  const keep = useMemo(
    () => detectionKeepFromSelected(selectedCategories),
    [selectedCategories]
  )
  const ready = runtime.status === "ready" && runtime.runtime

  const handleCategoriesChange = useCallback((next: Set<PiiType>) => {
    setSelectedCategories(next)
    setPolicyAnnouncement(
      "Privacy policy changed; private conversations were restarted."
    )
  }, [])

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
              <RuntimeChoice
                key={option.kind}
                onClear={
                  option.kind === "gemma-3-270m" &&
                  option.availability === "ready"
                    ? () => void runtime.clearGemmaCache()
                    : undefined
                }
                option={option}
              />
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
        <>
          <DetectionCategorySelector
            onChange={handleCategoriesChange}
            selected={selectedCategories}
          />
          <p aria-live="polite" className="sr-only">
            {policyAnnouncement}
          </p>
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
                detection={detection}
                keep={keep}
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
                detection={detection}
                keep={keep}
                runtime={ready}
                runtimeName={runtime.disclosure.label}
              />
            </TabsContent>
          </Tabs>
        </>
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
