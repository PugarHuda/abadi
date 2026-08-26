import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "qa",
  fullyParallel: true,
  reporter: [["list"]],
  use: { trace: "off", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
