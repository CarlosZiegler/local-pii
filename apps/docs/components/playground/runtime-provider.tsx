"use client"

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react"
import {
  createRuntimeController,
  type RuntimeController,
} from "./model/runtime-controller"
import type {
  BrowserGenerationRuntime,
  RuntimeKind,
  RuntimeSnapshot,
} from "./model/types"

type RuntimeContextValue = RuntimeSnapshot & {
  readonly runtime?: BrowserGenerationRuntime
  activate(kind: RuntimeKind): Promise<void>
  abort(): void
  check(): Promise<void>
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null)
const SERVER_SNAPSHOT: RuntimeSnapshot = { status: "checking", operationId: 0 }

export interface RuntimeProviderProps {
  children: ReactNode
  controller?: RuntimeController
}

export function RuntimeProvider({
  children,
  controller: suppliedController,
}: RuntimeProviderProps) {
  const controller = useMemo(
    () => suppliedController ?? createRuntimeController(),
    [suppliedController]
  )
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => SERVER_SNAPSHOT
  )
  const activeAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    void controller.check()
    return () => {
      activeAbort.current?.abort(
        new DOMException("The runtime provider was unmounted", "AbortError")
      )
      void controller.dispose()
    }
  }, [controller])

  const activate = useCallback(
    (kind: RuntimeKind) => {
      activeAbort.current?.abort(
        new DOMException(
          "A newer runtime activation was requested",
          "AbortError"
        )
      )
      const abort = new AbortController()
      activeAbort.current = abort
      return controller.activate(kind, abort.signal).finally(() => {
        if (activeAbort.current === abort) activeAbort.current = null
      })
    },
    [controller]
  )

  const abort = useCallback(() => {
    activeAbort.current?.abort(
      new DOMException("Runtime activation cancelled", "AbortError")
    )
  }, [])

  const value = useMemo<RuntimeContextValue>(() => {
    const runtime = controller.getRuntime()
    return {
      ...snapshot,
      ...(runtime === undefined ? {} : { runtime }),
      activate,
      abort,
      check: controller.check,
    }
  }, [abort, activate, controller, snapshot])

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
