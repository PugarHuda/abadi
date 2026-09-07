import { defineConfig, devices } from "@playwright/test";

/* The target. `scripts/qa.mjs` sets BASE in a real process before Playwright starts, which
 * is the only place it can be set and be seen by the worker processes that run the specs —
 * setting it from inside this file looked like it worked and quietly tested production
 * instead. Unset means production, which is what a bare `npx playwright test` should mean. */
const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";

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
        // Serve only. `npm run qa` builds first; this command must not, because the build
        // it used to run was the pre-framework one, which writes `dist/` and leaves `out/`
        // — the directory this server reads — untouched or half-written. That mismatch
        // failed seventy-one tests against a page that was fine when served by hand.
        command: "node qa/serve.mjs",
        url: BASE,
        reuseExistingServer: true,
        timeout: 60_000,
      }
    : undefined,
});
