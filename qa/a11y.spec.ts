/**
 * Accessibility, measured rather than asserted. axe-core runs the WCAG 2.1 A/AA rule set
 * against each deployed page; anything serious or critical fails the build.
 *
 * Runs against BASE (default: production), same as site.spec.ts.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";

for (const path of ["/", "/dashboard", "/deck", "/app"]) {
  test(`${path} has no serious or critical accessibility violations`, async ({ page }) => {
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    const report = bad
      .map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n  ")}`)
      .join("\n");
    expect(bad, report).toEqual([]);
  });
}

test("the price control is a real slider to assistive tech", async ({ page }) => {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const track = page.getByRole("slider", { name: /probability/i });
  await expect(track).toBeVisible();
  await expect(track).toHaveAttribute("aria-valuemin", "0.01");
  await expect(track).toHaveAttribute("aria-valuemax", "0.99");
  await track.focus();
  await page.keyboard.press("ArrowRight");
  const now = await track.getAttribute("aria-valuenow");
  const text = await track.getAttribute("aria-valuetext");
  expect(now, "value announced to screen readers must follow the control").toBe(text);
});

test("reduced motion is respected on the control", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const transition = await page.evaluate(() => getComputedStyle(document.querySelector("#knob")!).transitionDuration);
  expect(transition, "knob must not animate under prefers-reduced-motion").toBe("0s");
  await ctx.close();
});
