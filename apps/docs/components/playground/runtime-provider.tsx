"use client"

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react"
import {
  createBrowserPromptRuntime,
  type PromptRuntimeController,
} from "./model/prompt-runtime"
import type { LocalRuntimeSnapshot } from "./model/types"

interface RuntimeContextValue extends LocalRuntimeSnapshot {
  activateFallback(): Promise<void>
  activateNative(): Promise<void>
  check(): Promise<void>
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null)
const SERVER_SNAPSHOT: LocalRuntimeSnapshot = { status: "checking" }

export interface RuntimeProviderProps {
  children: ReactNode
  controller?: PromptRuntimeController
}

export function RuntimeProvider({
  children,
  controller: suppliedController,
}: RuntimeProviderProps) {
  const controller = useMemo(
    () => suppliedController ?? createBrowserPromptRuntime(),
    [suppliedController]
  )
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => SERVER_SNAPSHOT
  )

  useEffect(() => {
    void controller.check()
  }, [controller])

  const value = useMemo<RuntimeContextValue>(
    () => ({
      ...snapshot,
      activateFallback: controller.activateFallback,
      activateNative: controller.activateNative,
      check: controller.check,
    }),
    [controller, snapshot]
  )

  return (
    <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
  )
}

export function useLocalRuntime(): RuntimeContextValue {
  const value = useContext(RuntimeContext)
  if (!value)
    throw new Error("useLocalRuntime must be used within RuntimeProvider")
  return value
}
