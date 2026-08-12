"use client"

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  readonly actionError?: Error
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
  const [actionError, setActionError] = useState<Error>()

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
      const abort = new AbortController()
      setActionError(undefined)
      if (activeAbort.current === null) activeAbort.current = abort
      return controller
        .activate(kind, abort.signal)
        .catch((cause) => {
          const error =
            cause instanceof Error ? cause : new Error(String(cause))
          const current = controller.getSnapshot()
          if (
            current.status === "error" &&
            (current.error === error || current.error.message === error.message)
          ) {
            setActionError(undefined)
            return
          }
          setActionError(error)
        })
        .finally(() => {
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
      ...(actionError === undefined ? {} : { actionError }),
      activate,
      abort,
      check: () => {
        setActionError(undefined)
        return controller.check()
      },
    }
  }, [abort, actionError, activate, controller, snapshot])

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
