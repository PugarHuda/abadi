/**
 * Loading performance, measured in the browser the judge will use.
 *
 * The pages are static and self-contained apart from two font requests, so there is
 * no excuse for a slow paint. These are Core Web Vitals thresholds, not aspirations:
 * LCP under 2.5 s is Google's "good", and the DOM should be interactive well before.
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";

/** The dashboard is not idle until the explorer's log API answers for every vault, and that
 *  API stalls past 30 seconds often enough to fail a build on nothing. The thresholds below
 *  are unchanged — this only stops the wait itself from being the thing that fails. */
const slowIfDashboard = (path: string) => { if (path === "/dashboard") test.slow(); };

for (const path of ["/", "/dashboard", "/deck", "/app"]) {
  test(`${path} paints its largest content within 2.5s`, async ({ page }) => {
    slowIfDashboard(path);
    await page.goto(BASE + path, { waitUntil: "load" });
    const lcp = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let last = 0;
          const po = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) last = e.startTime;
          });
          po.observe({ type: "largest-contentful-paint", buffered: true });
          // LCP is final once the page settles; give it a beat, then read what we have.
          setTimeout(() => { po.disconnect(); resolve(last); }, 1500);
        }),
    );
    expect(lcp, `LCP ${Math.round(lcp)}ms`).toBeGreaterThan(0);
    expect(lcp, `LCP ${Math.round(lcp)}ms is over the 2.5s "good" threshold`).toBeLessThan(2500);
  });

  test(`${path} ships no more than it needs`, async ({ page }) => {
    slowIfDashboard(path);
    const sizes: Record<string, number> = {};
    page.on("response", async (r) => {
      const url = r.url();
      if (!url.startsWith(BASE)) return;
      const len = Number(r.headers()["content-length"] ?? 0);
      if (len) sizes[url.replace(BASE, "")] = len;
    });
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    // The whole page — document, script, SVG — under 100 KB transferred from our origin.
    expect(total, `${Math.round(total / 1024)} KB from our origin: ${JSON.stringify(sizes)}`).toBeLessThan(100 * 1024);
  });
}
