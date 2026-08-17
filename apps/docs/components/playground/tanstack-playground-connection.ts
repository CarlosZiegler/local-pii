import type { ConnectConnectionAdapter } from "@tanstack/ai-client"
import { piiConnection } from "@local-pii/core/tanstack"
import { withPlaygroundGate, type GenerationGate } from "./generation-gate"
import { createBrowserConnection } from "./model/tanstack-connection"
import type { BrowserGenerationRuntime } from "./model/types"
import {
  recordGenerationRunFailures,
  type GenerationRun,
} from "./private-conversation"
import {
  observeBrowserRuntime,
  type ProtectionObserver,
} from "./protection-observer"

interface TanStackPlaygroundConnectionOptions {
  readonly gate?: GenerationGate
  readonly getRun: () => GenerationRun | null
  readonly observer: ProtectionObserver
  readonly runtime: BrowserGenerationRuntime
}

/** Compose the exact public adapter path used by the TanStack playground. */
export function createTanStackPlaygroundConnection({
  gate,
  getRun,
  observer,
  runtime,
}: TanStackPlaygroundConnectionOptions): ConnectConnectionAdapter {
  const gated = gate ? withPlaygroundGate(runtime, gate, "tanstack") : runtime
  const tracked = recordGenerationRunFailures(gated, getRun)
  const observed = observeBrowserRuntime(tracked, observer)
  return piiConnection(createBrowserConnection(observed), {
    session: observer.session,
  })
}
