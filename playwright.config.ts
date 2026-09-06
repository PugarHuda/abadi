import { defineConfig, devices } from "@playwright/test";

/* `npm run qa` means the local mirror; a bare `npx playwright test` still means production.
 *
 * The script used to carry `BASE=http://localhost:4321` as a POSIX env prefix, which npm on
 * Windows hands to cmd.exe, where it is not a command. It worked in CI and on nobody's
 * laptop. `npm_lifecycle_event` is set by npm itself on every platform, so the default lives
 * here instead and an explicit BASE still wins over both. */
const BASE =
  process.env.BASE ??
  (process.env.npm_lifecycle_event === "qa"
    ? "http://localhost:4321"
    : "https://abadi-wheat.vercel.app");

// The specs read the variable, not this file, and the config is evaluated before they load.
process.env.BASE = BASE;

export default defineConfig({
  testDir: "qa",
  fullyParallel: true,
  reporter: [["list"]],
  use: { trace: "off", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  /* Let Playwright own the QA server when the target is local.
   *
   * `npm run qa` used to background the server with a bare `&` and nothing ever killed it,
   * so every local run left a listener on 4321. The next run then quietly graded a build
   * from a previous session — which happened here on 2026-09-06: a stale server answered
   * without the security headers that had just been added, and the tests for them read as
   * failures of the change rather than of the server. Playwright starts and stops it now.
   *
   * `reuseExistingServer` so CI, which starts its own, is left alone. Nothing starts when
   * the target is production. */
  webServer: BASE.includes("localhost")
    ? {
        command: "node scripts/build-site.mjs && node qa/serve.mjs",
        url: BASE,
        reuseExistingServer: true,
        timeout: 60_000,
      }
    : undefined,
});
