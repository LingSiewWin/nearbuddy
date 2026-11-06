// Smoke tests against a prebuilt app (`bun run build` first). Set BASE_URL to test a server you already run.
import { defineConfig } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:3013";

export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  use: { baseURL, viewport: { width: 1440, height: 1100 } },
  webServer: process.env.BASE_URL ? undefined : { command: "bun run start -p 3013", url: baseURL, reuseExistingServer: true, timeout: 60_000 },
});
