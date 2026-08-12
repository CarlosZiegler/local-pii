"use client"

import { useMemo, type ReactNode } from "react"
import { createRuntimeController } from "./model/runtime-controller"
import { RuntimeProviderCore } from "./runtime-provider-core"

export interface RuntimeProviderProps {
  children: ReactNode
}

export function RuntimeProvider({ children }: RuntimeProviderProps) {
  const controller = useMemo(() => createRuntimeController(), [])
  return (
    <RuntimeProviderCore controller={controller}>
      {children}
    </RuntimeProviderCore>
  )
}

export { useLocalRuntime } from "./runtime-provider-core"
