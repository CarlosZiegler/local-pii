import { expect, test, type Page } from "@playwright/test"
import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { findStaticFile } from "./static-path.mjs"

const BASE_ORIGIN = "http://127.0.0.1:4173"
const TEST_EMAIL = "ana@acme.com"
const STATIC_ROOT = resolve(process.cwd(), "out")

async function installFakeChromePromptApi(page: Page) {
  await page.addInitScript(() => {
    const state = { createCalls: 0, destroyCalls: 0 }
    Object.defineProperty(window, "__localPiiPromptState", {
      configurable: true,
      value: state,
    })

    class FakeLanguageModel {
      static async availability() {
        return "available"
      }

      static async create() {
        state.createCalls += 1
        return {
          promptStreaming(input: string, options?: { signal?: AbortSignal }) {
            let timer: ReturnType<typeof setTimeout> | undefined
            let canceled = false
            return new ReadableStream<string>({
              start(controller) {
                const midpoint = Math.max(1, Math.floor(input.length / 2))
                controller.enqueue(input.slice(0, midpoint))
                timer = setTimeout(() => {
                  if (canceled) return
                  controller.enqueue(input.slice(midpoint))
                  controller.close()
                }, 120)
                options?.signal?.addEventListener(
                  "abort",
                  () => {
                    if (timer !== undefined) clearTimeout(timer)
                    controller.error(options.signal?.reason)
                  },
                  { once: true }
                )
              },
              cancel() {
                canceled = true
                if (timer !== undefined) clearTimeout(timer)
              },
            })
          },
          destroy() {
            state.destroyCalls += 1
          },
        }
      }
    }

    Object.defineProperty(window, "LanguageModel", {
      configurable: true,
      value: FakeLanguageModel,
    })
  })
}

async function tabTo(page: Page, accessibleName: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await page.keyboard.press("Tab")
    const name = await page.evaluate(() => {
      const element = document.activeElement
      if (!(element instanceof HTMLElement)) return ""
      return (
        element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""
      )
    })
    if (name === accessibleName) return
  }
  throw new Error(`Tab could not reach ${accessibleName}`)
}

test.beforeEach(async ({ page }) => {
  const violations: string[] = []
  const externalRequests: string[] = []
  const allowedRequestUrls: string[] = []
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const headers = request.headers()
    const sameOrigin = url.origin === BASE_ORIGIN
    const artifactOrigin =
      url.origin === "https://huggingface.co" ||
      url.origin === "https://cdn.jsdelivr.net" ||
      (url.protocol === "https:" && url.hostname.endsWith(".cdn.hf.co"))
    const serverAction = "next-action" in headers
    const mutating = !["GET", "HEAD"].includes(request.method())
    const eventSource = request.resourceType() === "eventsource"
    const rscToken = url.searchParams.get("_rsc")
    const allowedStaticQuery =
      url.searchParams.size === 1 &&
      url.searchParams.has("_rsc") &&
      Boolean(rscToken && /^[A-Za-z0-9_-]{16}$/.test(rscToken)) &&
      url.pathname.includes("/__next.")
    const allowedSameOrigin =
      sameOrigin &&
      (url.search === "" || allowedStaticQuery) &&
      !mutating &&
      Boolean(await findStaticFile(STATIC_ROOT, url.pathname))

    if (!sameOrigin) externalRequests.push(request.url())
    if (
      serverAction ||
      eventSource ||
      (sameOrigin && !allowedSameOrigin) ||
      (!sameOrigin && (!artifactOrigin || request.method() !== "GET"))
    ) {
      violations.push(
        eventSource
          ? `EVENTSOURCE ${request.url()}`
          : `${request.method()} ${request.url()}`
      )
      await route.abort("blockedbyclient")
      return
    }
    allowedRequestUrls.push(request.url())
    await route.continue()
  })
  await page.routeWebSocket("**/*", async (socket) => {
    violations.push(`WEBSOCKET ${socket.url()}`)
    await socket.close({ code: 1008, reason: "Backend-free playground" })
  })
  await installFakeChromePromptApi(page)

  ;(page as Page & { __matrix?: unknown }).__matrix = {
    consoleErrors,
    externalRequests,
    allowedRequestUrls,
    pageErrors,
    violations,
  }
})

test.afterEach(async ({ page }) => {
  const matrix = (
    page as Page & {
      __matrix?: {
        consoleErrors: string[]
        externalRequests: string[]
        allowedRequestUrls: string[]
        pageErrors: string[]
        violations: string[]
      }
    }
  ).__matrix
  expect(matrix?.violations).toEqual([])
  expect(matrix?.externalRequests).toEqual([])
  expect(
    matrix?.allowedRequestUrls.some((url) =>
      decodeURIComponent(url).includes(TEST_EMAIL)
    )
  ).toBe(false)
  expect(matrix?.consoleErrors).toEqual([])
  expect(matrix?.pageErrors).toEqual([])
})

test("runs both protected chats in a static backend-free build", async ({
  page,
}) => {
  await page.goto("/en/docs/playground")
  await expect(page.getByRole("heading", { name: "Playground" })).toBeVisible()
  await expect(page.getByText("Active runtime:")).toBeVisible()

  const vercelTab = page.getByRole("tab", { name: "Vercel AI SDK" })
  await expect(vercelTab).toHaveAttribute("aria-selected", "true")
  const vercelPanel = page.getByRole("tabpanel", { name: "Vercel AI SDK" })
  const vercelComposer = vercelPanel.getByRole("textbox", { name: "Message" })
  await tabTo(page, "Message")
  await expect(vercelComposer).toBeFocused()
  await page.keyboard.type(`Email ${TEST_EMAIL} and repeat it.`)
  await page.keyboard.press("Enter")
  await expect(
    vercelPanel.getByText("Running browser-local inference…")
  ).toBeVisible()
  await expect(vercelPanel.getByText(TEST_EMAIL)).toHaveCount(2)
  const vercelProtected = vercelPanel.getByLabel("Current protected content")
  await expect(vercelProtected).not.toContainText(TEST_EMAIL)
  await expect(vercelProtected).not.toHaveText("")

  await tabTo(page, "Vercel AI SDK")
  await page.keyboard.press("ArrowRight")
  const tanstackTab = page.getByRole("tab", { name: "TanStack AI" })
  await expect(tanstackTab).toHaveAttribute("aria-selected", "true")
  const tanstackPanel = page.getByRole("tabpanel", { name: "TanStack AI" })
  const tanstackComposer = tanstackPanel.getByRole("textbox", {
    name: "Message",
  })
  await tabTo(page, "Message")
  await expect(tanstackComposer).toBeFocused()
  await page.keyboard.type(`Email ${TEST_EMAIL} and repeat it.`)
  await page.keyboard.press("Enter")
  await expect(
    tanstackPanel.getByText("Running browser-local inference…")
  ).toBeVisible()
  await expect(tanstackPanel.getByText(TEST_EMAIL)).toHaveCount(2)
  const tanstackProtected = tanstackPanel.getByLabel(
    "Current protected content"
  )
  await expect(tanstackProtected).not.toContainText(TEST_EMAIL)
  await expect(tanstackProtected).not.toHaveText("")

  await tabTo(page, "Message")
  await expect(tanstackComposer).toBeFocused()
  await page.keyboard.type("Cancel this generation")
  await page.keyboard.press("Enter")
  await tabTo(page, "Stop")
  await page.keyboard.press("Enter")
  await expect(
    tanstackPanel.getByText("Enter to send · Shift+Enter for newline")
  ).toBeVisible()

  await tabTo(page, "Start a new chat")
  await page.keyboard.press("Enter")
  await expect(tanstackPanel.getByText("Private local chat")).toBeVisible()
  await expect(tanstackPanel.getByText("No prompt sent yet.")).toBeVisible()

  const promptState = await page.evaluate(
    () =>
      (
        window as unknown as {
          __localPiiPromptState: { createCalls: number; destroyCalls: number }
        }
      ).__localPiiPromptState
  )
  expect(promptState.createCalls).toBeGreaterThanOrEqual(3)
  expect(promptState.destroyCalls).toBe(promptState.createCalls)
})

test("protects selected model-backed names and street addresses before browser generation", async ({
  page,
}) => {
  await page.goto("/en/docs/playground")

  const vercelPanel = page.getByRole("tabpanel", { name: "Vercel AI SDK" })
  const composer = vercelPanel.getByRole("textbox", { name: "Message" })
  await composer.fill(
    "Carlos Rivera (carlos@example.com, +49 151 12345678) lives at 12 Oak Ave."
  )
  await composer.press("Enter")

  const protectedContent = vercelPanel.getByLabel("Current protected content")
  await expect(protectedContent).not.toContainText("Carlos Rivera")
  await expect(protectedContent).not.toContainText("12 Oak Ave")
  await expect(vercelPanel.getByText("GIVEN_NAME: 1")).toBeVisible()
  await expect(vercelPanel.getByText("SURNAME: 1")).toBeVisible()
  await expect(vercelPanel.getByText("BUILDING_NUMBER: 1")).toBeVisible()
  await expect(vercelPanel.getByText("STREET_NAME: 1")).toBeVisible()

  await page.getByRole("tab", { name: "TanStack AI" }).click()
  const tanstackPanel = page.getByRole("tabpanel", { name: "TanStack AI" })
  const tanstackComposer = tanstackPanel.getByRole("textbox", {
    name: "Message",
  })
  await tanstackComposer.fill(
    "Carlos Rivera (carlos@example.com, +49 151 12345678) lives at 12 Oak Ave."
  )
  await tanstackComposer.press("Enter")

  const tanstackProtected = tanstackPanel.getByLabel(
    "Current protected content"
  )
  await expect(tanstackProtected).not.toContainText("Carlos Rivera")
  await expect(tanstackProtected).not.toContainText("12 Oak Ave")
  await expect(tanstackPanel.getByText("GIVEN_NAME: 1")).toBeVisible()
  await expect(tanstackPanel.getByText("SURNAME: 1")).toBeVisible()
  await expect(tanstackPanel.getByText("BUILDING_NUMBER: 1")).toBeVisible()
  await expect(tanstackPanel.getByText("STREET_NAME: 1")).toBeVisible()
})

test("renders localized static playground pages", async ({ page }) => {
  await page.goto("/pt/docs/playground")
  await expect(page.getByRole("heading", { name: "Experimente" })).toBeVisible()
  await expect(
    page.getByText("Tudo abaixo usa Geração local no navegador")
  ).toBeVisible()
  await page.goto("/de/docs/playground")
  await expect(
    page.getByRole("heading", { name: "Ausprobieren" })
  ).toBeVisible()
  await expect(
    page.getByText("Alles unten nutzt browserlokale Generierung")
  ).toBeVisible()
})

test("serves emitted runtime modules as JavaScript", async ({ request }) => {
  const media = resolve(process.cwd(), "out/_next/static/media")
  const runtimeModule = (await readdir(media)).find(
    (file) => file.startsWith("ort.webgpu.bundle") && file.endsWith(".mjs")
  )
  expect(runtimeModule).toBeDefined()
  const response = await request.head(`/_next/static/media/${runtimeModule}`)
  expect(response.ok()).toBe(true)
  expect(response.headers()["content-type"]).toBe(
    "text/javascript; charset=utf-8"
  )
})

test("blocks WebSocket inference transports", async ({ page }) => {
  await page.goto("/en/docs/playground")
  await page.evaluate(
    () =>
      new Promise<void>((resolveAttempt) => {
        const socket = new WebSocket("ws://127.0.0.1:4173/inference")
        socket.addEventListener("close", () => resolveAttempt(), { once: true })
        socket.addEventListener("error", () => resolveAttempt(), { once: true })
      })
  )
  const matrix = (
    page as Page & {
      __matrix?: { violations: string[] }
    }
  ).__matrix
  expect(matrix?.violations).toEqual([
    "WEBSOCKET ws://127.0.0.1:4173/inference",
  ])
  matrix?.violations.splice(0)
})

test("blocks undisclosed same-origin inference endpoints", async ({ page }) => {
  await page.goto("/en/docs/playground")
  await page.evaluate(async (email) => {
    await Promise.allSettled([
      fetch("/v1/chat/completions?prompt=secret"),
      fetch("/generate?prompt=secret"),
      fetch(`/en/docs/playground?email=${encodeURIComponent(email)}`),
      fetch(`/en/docs/playground?_rsc=${encodeURIComponent(email)}`),
      new Promise<void>((resolveAttempt) => {
        const events = new EventSource("/en/docs/playground")
        events.addEventListener(
          "error",
          () => {
            events.close()
            resolveAttempt()
          },
          { once: true }
        )
      }),
    ])
  }, TEST_EMAIL)
  const matrix = (
    page as Page & {
      __matrix?: { consoleErrors: string[]; violations: string[] }
    }
  ).__matrix
  expect(matrix?.violations.toSorted()).toEqual(
    [
      "GET http://127.0.0.1:4173/v1/chat/completions?prompt=secret",
      "GET http://127.0.0.1:4173/generate?prompt=secret",
      "GET http://127.0.0.1:4173/en/docs/playground?email=ana%40acme.com",
      "GET http://127.0.0.1:4173/en/docs/playground?_rsc=ana%40acme.com",
      "EVENTSOURCE http://127.0.0.1:4173/en/docs/playground",
    ].toSorted()
  )
  expect(matrix?.consoleErrors.length).toBeGreaterThanOrEqual(2)
  for (const error of matrix?.consoleErrors ?? []) {
    expect(error).toContain("ERR_BLOCKED_BY_CLIENT")
  }
  matrix?.violations.splice(0)
  matrix?.consoleErrors.splice(0)
})
