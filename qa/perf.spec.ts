/**
 * Loading performance, measured in the browser the judge will use.
 *
 * The pages are static and self-contained apart from two font requests, so there is
 * no excuse for a slow paint. These are Core Web Vitals thresholds, not aspirations:
 * LCP under 2.5 s is Google's "good", and the DOM should be interactive well before.
 *
 * The weight budget is two numbers since the framework landed — see the comment on it.
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

  /* Two budgets, because the page is two things now.
   *
   * It shipped 37 KB before Next.js and ships about 505 KB after it, and only one of those
   * numbers is a decision this project made. The document, the stylesheets and the modules
   * that read the chain are ours, they were under 100 KB and they still are. React and the
   * App Router runtime are the price of the framework: 447 KB, identical on every page,
   * unmovable without leaving the framework.
   *
   * Merging them would have meant raising one number to 600 KB and quietly losing the
   * standard inside it. Kept apart, both stay measured: ours cannot creep, and the
   * framework's cannot grow without somebody deciding it may. */
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

    // The framework's own JavaScript. Its stylesheets are under the same path and are ours
    // — `recorder.css` and the page's own — so the split is on the extension, not the folder.
    const isFramework = (u: string) => /^\/_next\/static\/chunks\/.*\.js$/.test(u);
    const ours = Object.entries(sizes).filter(([u]) => !isFramework(u)).reduce((a, [, n]) => a + n, 0);
    const framework = Object.entries(sizes).filter(([u]) => isFramework(u)).reduce((a, [, n]) => a + n, 0);
    const report = `ours ${Math.round(ours / 1024)} KB, framework ${Math.round(framework / 1024)} KB — ${JSON.stringify(sizes)}`;

    // Unchanged since before the framework: document, CSS, our modules, SVG.
    expect(ours, report).toBeLessThan(100 * 1024);
    // 447 KB today on every page. A cap, so it cannot drift without a decision.
    expect(framework, report).toBeLessThan(480 * 1024);
  });
}
