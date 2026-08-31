/**
 * The dashboard's live ledger: real logs, decoded in the browser, drawn as one chart.
 * The chart is checked the way the spec describes it — one series, no legend, an end
 * label, a crosshair tooltip that enhances and never gates (the table beneath carries
 * every value) — and the heartbeat line must be a real duration, not a placeholder.
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";

/** The result column, added up. Each row prints to the cent, so the sum of the printed
 *  rows may sit up to half a cent per row away from a total summed at full precision. */
function rowSum(results: string[]) {
  const sum = results.reduce((a, t) => { const m = t.match(/^([+-]\d+\.\d{2}) \(/); return m ? a + Number(m[1]) : a; }, 0);
  return { sum, tol: 0.005 * results.length + 1e-9 };
}

test.describe("live ledger", () => {
  // The pages under here read the chain on load, and the public explorer's log API is
  // rate-limited: it stalls past 30s often enough to fail roughly two runs in five on an
  // untouched checkout. `networkidle` then never settles and the test times out on the
  // venue's availability rather than on anything this repo did. More budget, not a weaker
  // wait — every assertion below is unchanged, so a real regression still fails.
  test.beforeEach(() => test.slow());

  test("renders episodes from the explorer, with totals that add up", async ({ page }) => {
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
    const ledger = page.locator("#ledger");
    await expect.poll(async () => ledger.getAttribute("data-state"), { timeout: 30000 }).toMatch(/^(live|unreachable)$/);
    test.skip((await ledger.getAttribute("data-state")) === "unreachable", "explorer unreachable from this runner");

    const rows = ledger.locator("tbody tr");
    const episodes = Number(await ledger.locator("[data-ledger=episodes]").textContent());
    expect(episodes, "the summary counts the rows").toBe(await rows.count());
    expect(episodes).toBeGreaterThan(0);

    // Every closed episode in the table sums to the realised figure shown — losers included.
    const results = await rows.locator("td:nth-child(8)").allTextContents();
    const { sum, tol } = rowSum(results);
    const shown = (await ledger.locator("[data-ledger=pnl]").textContent()) ?? "";
    const total = Number(shown.match(/^([+-]?\d+\.\d{2})/)![1]);
    expect(Math.abs(total - sum), "realised total equals the sum of the rows").toBeLessThanOrEqual(tol);

    // Nothing may be dropped: every row is priced, or says in the open why it is not.
    for (const t of results) {
      expect(t, "every row carries a figure or an explicit reason").toMatch(
        /^([+-]\d+\.\d{2} \(|0\.00 · no fill|open$|\? · not determinable)/,
      );
    }

    // The honest headline. Per share is what a depositor's claim is worth; it must be on
    // the page next to the basis-relative figure, not left to a strip further up.
    await expect(ledger.locator("[data-ledger=share]")).toHaveText(/^\d\.\d{6}$/);
    await expect(ledger.locator("[data-ledger=depositors]")).toHaveText(/^[+-]\d+\.\d{2} \([+-]?\d+\.\d{2}%\)$/);

    await expect(ledger.locator("[data-ledger=last]")).toHaveText(/last activity (under a minute|\d+ min|\d+ h) ago/);
  });

  // The defect this file exists to catch: the series used to filter out every episode that
  // lost money, so the curve could only rise. Run over a fixture rather than the live vault,
  // which is not obliged to lose money while the suite happens to be running.
  test("the series prices losers and can fall", async ({ page }) => {
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
    await page.waitForFunction(() => (window as any).ABADI_LEDGER, null, { timeout: 30000 });

    const out = await page.evaluate(() => {
      const M = 1000000n;
      // basis = size*bid + size*(1 - ask); 100 contracts a side at 0.400 / 0.500.
      const base = (over: Record<string, unknown>) => Object.assign({
        vault: "0x0000000000000000000000000000000000000000", slot: 0,
        marketId: "0x" + "0".repeat(60) + "abcd", at: "2026-01-01T00:00:00.000000Z",
        closedAt: "2026-01-01T00:00:00.000000Z", bid: 400000n, ask: 500000n, size: 100n * M,
        basis: 90n * M, merged: 0n, returned: 0n, redeemed: 0n, refunded: 0n,
        cancelled: false, closedBy: "settle", pool: "0xpool", quoteOrd: 1, tx: "0x0",
      }, over);

      const eps = [
        // both legs filled and merged: the spread, +10.00
        base({ at: "2026-01-01T01:00:00.000000Z", closedAt: "2026-01-01T01:00:00.000000Z",
               closedBy: "flatten", merged: 100n * M, returned: 100n * M }),
        // only the YES leg filled, at 40.00, and YES lost. The NO leg's 50.00 came back.
        base({ at: "2026-01-01T02:00:00.000000Z", closedAt: "2026-01-01T02:00:00.000000Z",
               refunded: 50n * M }),
        // neither leg filled: the whole basis came back. Not a loss, and not adverse.
        base({ at: "2026-01-01T03:00:00.000000Z", closedAt: "2026-01-01T03:00:00.000000Z",
               refunded: 90n * M }),
      ];
      const L = (window as any).ABADI_LEDGER;
      return { states: eps.map((e) => L.value(e).state), pts: L.series(eps).map((p: any) => [p.y, p.d]) };
    });

    expect(out.states, "a full refund is no fill, a partial one is a priced loss")
      .toEqual(["complete", "one-sided", "no fill"]);
    // +10.00, then −40.00, then flat: the curve rises, falls through zero, and holds.
    expect(out.pts).toEqual([[10, 10], [-30, -40], [-30, 0]]);
  });

  test("the chart is one turmeric line with an end label and a crosshair tooltip", async ({ page }) => {
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
    const fig = page.locator("#pnlChart");
    await expect.poll(async () => fig.getAttribute("data-state"), { timeout: 30000 }).toBe("live");
    // Two closes are needed before there is a line to draw; the shape of it is checked
    // against a fixture in the test above, which does not depend on the live vault.
    test.skip((await fig.locator("svg path.line").count()) === 0, "fewer than two closed episodes on chain");
    await expect(fig.locator("svg path.line")).toHaveCount(1);
    await expect(fig.locator("svg .endlabel")).toHaveText(/^[+-]\d+\.\d{2}$/);
    // A horizontal hairline has no box height, so "visible" is the wrong question; count it.
    expect(await fig.locator("svg .grid").count()).toBeGreaterThan(0);
    // No legend for a single series: the caption names what is plotted.
    await expect(fig.locator("figcaption")).toContainText(/realised, cumulative, every closed episode/i);
    expect(await fig.locator(".legend").count()).toBe(0);

    // The end label agrees with the table beneath it. Two different passes over the same
    // episodes — `render` writes the rows, `series` walks them in close order — so this
    // catches the two disagreeing, which the old check could not: it compared the chart
    // against a total the same filter had produced.
    const endLabel = (await fig.locator("svg .endlabel").textContent()) ?? "";
    const { sum, tol } = rowSum(await page.locator("#ledger tbody tr td:nth-child(8)").allTextContents());
    expect(Math.abs(Number(endLabel) - sum), "the curve ends where the rows add up to").toBeLessThanOrEqual(tol);

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
