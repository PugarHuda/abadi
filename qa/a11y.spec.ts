/**
 * Accessibility, measured rather than asserted. axe-core runs the WCAG 2.1 A/AA rule set
 * against each deployed page; anything serious or critical fails the build.
 *
 * Runs against BASE (default: production), same as site.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";

const PAGES = ["/", "/dashboard", "/deck", "/app"];
const PHONE = { width: 375, height: 812 };

/**
 * Markup, CSS and keyboard behaviour do not depend on what the chain says. The public RPC
 * and the explorer's log API rate-limit when several pages ask at once, so a test that
 * does not need them should not be queueing behind the ones that do — it costs the tests
 * that are actually measuring live data their answer. Fonts still load: the widths they
 * produce are what makes a code block overflow in the first place.
 */
async function withoutChainReads(page: Page) {
  await page.route(/somnia\.network/, (route) => route.abort());
}

/** One scan of the page as it stands. Anything serious or critical fails the build. */
async function scan(page: Page, where: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const report = `${where}\n` + bad
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n  ")}`)
    .join("\n");
  expect(bad, report).toEqual([]);
}

/**
 * Both widths, off one page load. playwright.config.ts defines a single desktop project,
 * so a pass that never resizes never sees what only goes wrong on a phone: a table or a
 * code block that starts scrolling sideways is a region no keyboard user can reach unless
 * it is focusable, and axe rates that serious. Resizing beats a second navigation — these
 * pages read the chain on load, and visiting each one twice only doubles that.
 */
for (const path of PAGES) {
  test(`${path} has no serious or critical accessibility violations`, async ({ page }) => {
    // The dashboard is not idle until the explorer's log API answers for every vault, and
    // that API stalls past 30 seconds often enough to fail a build on nothing. More budget,
    // not a weaker wait: the scan wants the episode table rendered, not skipped.
    if (path === "/dashboard") test.slow();
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    await scan(page, `${path} at desktop width`);
    await page.setViewportSize(PHONE);
    await scan(page, `${path} at ${PHONE.width}px`);
  });
}

// The deck shows one slide at a time, so a scan that lands on the cover never sees the
// slides carrying the wide code blocks or running taller than a phone. Two deep links put
// those under the same rules: #5 holds the widest pre, #9 the tallest slide. Nothing on
// this page reads the chain, so these cost a page load and no waiting.
for (const path of ["/deck#5", "/deck#9"]) {
  test(`${path} has no serious or critical accessibility violations at ${PHONE.width}px`, async ({ page }) => {
    await withoutChainReads(page);
    await page.setViewportSize(PHONE);
    await page.goto(BASE + path, { waitUntil: "load" });
    await scan(page, `${path} at ${PHONE.width}px`);
  });
}

/**
 * Non-text contrast, WCAG 2.1 AA 1.4.11. axe does not measure the boundary of a control,
 * so nothing caught that every button, field and link-button was outlined in #2A3B5E:
 * 1.45:1 on the ink ground and 1.28:1 on the raised panel, against a 3:1 requirement.
 * Measured in the browser off the computed border and the first opaque surface behind it.
 */
function luminance([r, g, b]: number[]) {
  const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

for (const [path, selector] of [
  ["/", ".out a, .track"],
  ["/app", "button, input[type=text]"],
  ["/deck", ".nav button"],
  ["/404", "main a"],
] as const) {
  test(`${path}: every control boundary clears 3:1 against the surface behind it`, async ({ page }) => {
    await withoutChainReads(page);
    // The controls and their colours are in the markup; none of this waits on the chain.
    await page.goto(BASE + path, { waitUntil: "load" });
    const controls = await page.$$eval(selector, (els) =>
      els.map((e) => {
        const cs = getComputedStyle(e);
        const side = cs.borderTopWidth !== "0px" ? "Top" : "Left";
        let n: HTMLElement | null = e.parentElement;
        let behind = "rgb(0, 0, 0)";
        while (n) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && !c.startsWith("rgba(0, 0, 0, 0")) { behind = c; break; }
          n = n.parentElement;
        }
        return {
          name: e.tagName.toLowerCase() + (e.id ? "#" + e.id : "." + e.className),
          width: cs[`border${side}Width` as "borderTopWidth"],
          border: cs[`border${side}Color` as "borderTopColor"],
          behind,
        };
      }),
    );
    expect(controls.length, "no controls matched — the selector has drifted").toBeGreaterThan(0);
    const rgb = (s: string) => s.match(/\d+/g)!.slice(0, 3).map(Number);
    for (const c of controls) {
      if (c.width === "0px") continue;
      const [a, b] = [luminance(rgb(c.border)) + 0.05, luminance(rgb(c.behind)) + 0.05];
      const ratio = Math.max(a, b) / Math.min(a, b);
      expect(ratio, `${c.name}: ${c.border} on ${c.behind} is ${ratio.toFixed(2)}:1, under 3:1`).toBeGreaterThanOrEqual(3);
    }
  });
}

/** A skip link that is not the first thing in the tab order is not a skip link.
 *  Tab order is in the markup, so this does not wait on the chain reads. */
for (const path of PAGES.concat("/404")) {
  test(`${path} opens with a skip link that lands on the content`, async ({ page }) => {
    await withoutChainReads(page);
    await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
    await page.keyboard.press("Tab");
    const href = await page.evaluate(() => (document.activeElement as HTMLAnchorElement).getAttribute("href"));
    expect(href, "the first tab stop is not a skip link").toMatch(/^#/);
    await expect(page.locator(href!)).toHaveCount(1);
  });
}

test("the deck says which slide it moved to", async ({ page }) => {
  await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
  const live = page.locator("#announce");
  // Nothing announced over the page load — only the move.
  await expect(live).toHaveText("");
  await page.keyboard.press("ArrowRight");
  await expect(live).toHaveText(/Slide 2 of 10: Every position dies/);
});

test("space on the deck's previous button goes back, not forward", async ({ page }) => {
  await page.goto(BASE + "/deck#3", { waitUntil: "networkidle" });
  await page.locator("#prev").focus();
  await page.keyboard.press("Space");
  // The document-level handler used to swallow this and advance while cancelling the
  // button's own activation, so the focused control did the opposite of what it says.
  await expect(page.locator(".slide.on")).toHaveAttribute("data-i", "1");
});

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
