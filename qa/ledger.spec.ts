/**
 * The dashboard's live ledger: real logs, decoded in the browser, drawn as one chart.
 * The chart is checked the way the spec describes it — one series, no legend, an end
 * label, a crosshair tooltip that enhances and never gates (the table beneath carries
 * every value) — and the heartbeat line must be a real duration, not a placeholder.
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";

test.describe("live ledger", () => {
  test("renders episodes from the explorer, with totals that add up", async ({ page }) => {
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
    const ledger = page.locator("#ledger");
    await expect.poll(async () => ledger.getAttribute("data-state"), { timeout: 30000 }).toMatch(/^(live|unreachable)$/);
    test.skip((await ledger.getAttribute("data-state")) === "unreachable", "explorer unreachable from this runner");

    const rows = ledger.locator("tbody tr");
    const episodes = Number(await ledger.locator("[data-ledger=episodes]").textContent());
    expect(episodes, "the summary counts the rows").toBe(await rows.count());
    expect(episodes).toBeGreaterThan(0);

    // Every closed complete set in the table sums to the realised figure shown.
    const results = await rows.locator("td:nth-child(8)").allTextContents();
    const sum = results.reduce((a, t) => { const m = t.match(/^([+-]\d+\.\d{2}) \(/); return m ? a + Number(m[1]) : a; }, 0);
    const shown = (await ledger.locator("[data-ledger=pnl]").textContent()) ?? "";
    expect(Number(shown.match(/^([+-]?\d+\.\d{2})/)![1]), "realised total equals the sum of the rows").toBeCloseTo(sum, 2);

    await expect(ledger.locator("[data-ledger=last]")).toHaveText(/last activity (under a minute|\d+ min|\d+ h) ago/);
  });

  test("the chart is one turmeric line with an end label and a crosshair tooltip", async ({ page }) => {
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
    const fig = page.locator("#pnlChart");
    await expect.poll(async () => fig.getAttribute("data-state"), { timeout: 30000 }).toBe("live");
    await expect(fig.locator("svg path.line")).toHaveCount(1);
    await expect(fig.locator("svg .endlabel")).toHaveText(/^[+-]\d+\.\d{2}$/);
    // A horizontal hairline has no box height, so "visible" is the wrong question; count it.
    expect(await fig.locator("svg .grid").count()).toBeGreaterThan(0);
    // No legend for a single series: the caption names what is plotted.
    await expect(fig.locator("figcaption")).toContainText(/realised spread, cumulative/i);
    expect(await fig.locator(".legend").count()).toBe(0);

    // The end label agrees with the ledger's realised total.
    const endLabel = (await fig.locator("svg .endlabel").textContent()) ?? "";
    const shown = (await page.locator("#ledger [data-ledger=pnl]").textContent()) ?? "";
    expect(Number(endLabel)).toBeCloseTo(Number(shown.match(/^([+-]?\d+\.\d{2})/)![1]), 2);

    // Hover: the crosshair appears and the tooltip leads with the value.
    // The chart sits below the first viewport; hover() scrolls it into view, mouse.move
    // to an off-screen coordinate would land on nothing.
    const plot = fig.locator(".chart-plot");
    await plot.hover({ position: { x: 400, y: 100 } });
    await expect(fig.locator(".xhair")).toBeVisible();
    await expect(fig.locator(".tip b")).toHaveText(/tUSDC cumulative/);
    await fig.locator("figcaption").hover();
    await expect(fig.locator(".tip")).toBeHidden();

    // Keyboard reaches the same readout.
    await plot.focus();
    await expect(fig.locator(".tip")).toBeVisible();
  });
});
