import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    serviceWorkers: "block",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "bun run build && node e2e/static-server.mjs",
    url: "http://127.0.0.1:4173/en/docs/playground",
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
