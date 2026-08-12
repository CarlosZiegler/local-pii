import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "bun run build && bunx http-server out -p 4173 -c-1",
    url: "http://127.0.0.1:4173/en/docs/playground.html",
    reuseExistingServer: true,
    timeout: 180_000,
  },
})
