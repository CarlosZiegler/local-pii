import { expect, test, type Page } from "@playwright/test"

const BASE_ORIGIN = "http://127.0.0.1:4173"
const TEST_EMAIL = "ana@acme.com"

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
    const apiPath = url.pathname === "/api" || url.pathname.startsWith("/api/")
    const backendLikePath =
      /(^|\/)(api|graphql|inference|rpc|server-action|telemetry)(\/|$)/i.test(
        url.pathname
      )

    if (!sameOrigin) externalRequests.push(request.url())
    if (
      serverAction ||
      mutating ||
      apiPath ||
      (sameOrigin && backendLikePath) ||
      (!sameOrigin && !artifactOrigin)
    ) {
      violations.push(`${request.method()} ${request.url()}`)
      await route.abort("blockedbyclient")
      return
    }
    await route.continue()
  })
  await installFakeChromePromptApi(page)

  ;(page as Page & { __matrix?: unknown }).__matrix = {
    consoleErrors,
    externalRequests,
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
        pageErrors: string[]
        violations: string[]
      }
    }
  ).__matrix
  expect(matrix?.violations).toEqual([])
  expect(matrix?.externalRequests).toEqual([])
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

test("renders localized static playground pages", async ({ page }) => {
  await page.goto("/pt/docs/playground")
  await expect(
    page.getByText("Tudo abaixo usa Geração local no navegador")
  ).toBeVisible()
  await page.goto("/de/docs/playground")
  await expect(
    page.getByText("Alles unten nutzt browserlokale Generierung")
  ).toBeVisible()
})
