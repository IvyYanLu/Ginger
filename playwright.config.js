import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.spec.js",
  use: { baseURL: "http://localhost:8790", ...devices["iPhone 13"], browserName: "chromium" },
  webServer: { command: "node test/e2e/serve.mjs", url: "http://localhost:8790", reuseExistingServer: true },
});
