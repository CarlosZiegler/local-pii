"use client"

import { useMemo, type ReactNode } from "react"
import { createGenerationGate } from "./generation-gate"
import { createRuntimeController } from "./model/runtime-controller"
import { RuntimeProviderCore } from "./runtime-provider-core"

export interface RuntimeProviderProps {
  children: ReactNode
}

export function RuntimeProvider({ children }: RuntimeProviderProps) {
  const controller = useMemo(() => createRuntimeController(), [])
  const gate = useMemo(() => createGenerationGate(), [])
  return (
    <RuntimeProviderCore controller={controller} gate={gate}>
      {children}
    </RuntimeProviderCore>
  )
}

export {
  useLocalRuntime,
  useOptionalLocalRuntime,
} from "./runtime-provider-core"
