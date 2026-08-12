"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { PrivacyInspection as CommittedPrivacyInspection } from "./protection-observer"

/** Compatibility for the pre-observer chat seams during the Task 10 migration. */
interface LegacyPrivacyInspection {
  readonly counts: Readonly<Record<string, number>>
  readonly protectedPrompt: string
}

export type PrivacyInspection =
  CommittedPrivacyInspection | LegacyPrivacyInspection

export interface PrivacyInspectorProps {
  inspection?: PrivacyInspection
  runtimeName: string
}

export function PrivacyInspector({
  inspection,
  runtimeName,
}: PrivacyInspectorProps) {
  const committed =
    inspection && "generationRunId" in inspection ? inspection : undefined
  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-center justify-between gap-3 p-4">
        <CardTitle className="text-sm">Privacy inspector</CardTitle>
        <Badge variant="outline">On device · {runtimeName}</Badge>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {committed ? (
          <p className="text-xs text-muted-foreground">
            Generation run:{" "}
            <span className="font-mono">{committed.generationRunId}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {committed && Object.keys(committed.counts).length > 0 ? (
            Object.entries(committed.counts).map(([type, count]) => (
              <Badge key={type} variant="secondary">
                {type}: {count}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">
              {committed
                ? "No personal information was detected in this generation run."
                : "No generation run has been committed yet."}
            </span>
          )}
        </div>
        {committed ? (
          <>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Protected history
              </p>
              {committed.protectedHistory.length > 0 ? (
                <ol
                  aria-label="Protected conversation history"
                  className="max-h-36 space-y-1 overflow-auto rounded-md border bg-muted/40 p-3 text-xs"
                  tabIndex={0}
                >
                  {committed.protectedHistory.map((turn, index) => (
                    <li key={`${turn.role}-${index}`}>
                      <span className="font-medium">{turn.role}:</span>{" "}
                      <span className="break-words whitespace-pre-wrap">
                        {turn.protectedContent}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-muted-foreground">No prior turns.</p>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                What the model receives
              </p>
              <pre
                aria-label="Current protected content"
                className="max-h-36 overflow-auto rounded-md border bg-muted/40 p-3 text-xs break-words whitespace-pre-wrap"
                tabIndex={0}
              >
                {committed.protectedContent}
              </pre>
            </div>
          </>
        ) : (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              What the model receives
            </p>
            <p className="text-xs text-muted-foreground">No prompt sent yet.</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
