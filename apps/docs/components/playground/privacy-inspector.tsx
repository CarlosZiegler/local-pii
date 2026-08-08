"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export interface PrivacyInspection {
  counts: Record<string, number>
  protectedPrompt: string
}

export interface PrivacyInspectorProps {
  inspection?: PrivacyInspection
  runtimeName: string
}

export function PrivacyInspector({
  inspection,
  runtimeName,
}: PrivacyInspectorProps) {
  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-center justify-between gap-3 p-4">
        <CardTitle className="text-sm">Privacy inspector</CardTitle>
        <Badge variant="outline">On device · {runtimeName}</Badge>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        <div className="flex flex-wrap gap-1.5">
          {inspection && Object.keys(inspection.counts).length > 0 ? (
            Object.entries(inspection.counts).map(([type, count]) => (
              <Badge key={type} variant="secondary">
                {type}: {count}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">
              Detected PII appears here after you send a message.
            </span>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            What the model receives
          </p>
          <pre className="max-h-36 overflow-auto rounded-md border bg-muted/40 p-3 text-xs break-words whitespace-pre-wrap">
            {inspection?.protectedPrompt ?? "No prompt sent yet."}
          </pre>
        </div>
      </CardContent>
    </Card>
  )
}
