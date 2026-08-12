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
type RuntimeActionError = {
  readonly error: Error
  readonly generation: number
}

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
  const mounted = useRef(false)
  const effectGeneration = useRef(0)
  const effectController = useRef<RuntimeController | undefined>(undefined)
  const [actionError, setActionError] = useState<RuntimeActionError>()

  useEffect(() => {
    const generation = ++effectGeneration.current
    effectController.current = controller
    mounted.current = true
    setActionError(undefined)
    void controller.check().catch(() => {
      // The controller publishes check failures in its snapshot. Observe the
      // rejection here so an unmounted or replaced provider cannot leak it.
    })
    return () => {
      mounted.current = false
      const abort = activeAbort.current
      activeAbort.current = null
      abort?.abort(
        new DOMException("The runtime provider was unmounted", "AbortError")
      )
      queueMicrotask(() => {
        if (
          effectController.current === controller &&
          effectGeneration.current !== generation
        ) {
          return
        }
        let disposal: Promise<void>
        try {
          disposal = controller.dispose()
        } catch {
          return
        }
        void disposal.catch(() => {
          // Disposal is best-effort during unmount; observe failures so they
          // cannot become unhandled rejections after the provider is gone.
        })
      })
    }
  }, [controller])

  const activate = useCallback(
    (kind: RuntimeKind) => {
      if (!mounted.current) return Promise.resolve()
      const generation = effectGeneration.current
      const abort = new AbortController()
      setActionError(undefined)
      if (activeAbort.current === null) activeAbort.current = abort
      return controller
        .activate(kind, abort.signal)
        .catch((cause) => {
          if (!mounted.current || effectController.current !== controller) {
            return
          }
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
          setActionError({ error, generation })
        })
        .then(() => {
          if (
            mounted.current &&
            effectController.current === controller &&
            effectGeneration.current === generation &&
            controller.getSnapshot().status === "ready"
          ) {
            setActionError(undefined)
          }
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

  const visibleActionError =
    actionError !== undefined &&
    actionError.generation === effectGeneration.current &&
    effectController.current === controller &&
    snapshot.status !== "ready"
      ? actionError.error
      : undefined

  const value = useMemo<RuntimeContextValue>(() => {
    const runtime = controller.getRuntime()
    return {
      ...snapshot,
      ...(runtime === undefined ? {} : { runtime }),
      ...(visibleActionError === undefined
        ? {}
        : { actionError: visibleActionError }),
      activate,
      abort,
      check: () => {
        if (!mounted.current) return Promise.resolve()
        setActionError(undefined)
        return controller.check().catch(() => undefined)
      },
    }
  }, [abort, activate, controller, snapshot, visibleActionError])

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
