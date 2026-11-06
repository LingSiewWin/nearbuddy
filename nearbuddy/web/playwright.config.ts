// Smoke tests against a prebuilt app (`bun run build` first). Set BASE_URL to test a server you already run.
import { defineConfig } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:3013";

export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  // CI keeps the html report (uploaded on failure) next to the line log; never auto-open it there
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL, viewport: { width: 1440, height: 1100 }, trace: "retain-on-failure" },
  ...(process.env.BASE_URL
    ? {}
    : { webServer: { command: "bun run start -p 3013", url: baseURL, reuseExistingServer: true, timeout: 60_000 } }),
});
