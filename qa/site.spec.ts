/**
 * Browser QA against the deployed site — the thing judges actually open.
 *
 * Runs against BASE (default: production). Point it at a preview with
 *   BASE=https://... npx playwright test
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";

/** Console errors and failed requests are bugs, not noise. */
/** A third party throttling us is not this page failing. Everything else still is.
 *
 *  The explorer's log API answers 429 to GitHub's runners often enough that this suite
 *  went red three times in three days on it, always on the same test, never on anything
 *  the repository had changed. A check that cries wolf gets ignored, and the next real
 *  console error would have been ignored with it.
 *
 *  The page's own behaviour under a throttled read is still asserted, and asserted
 *  harder: `[data-live=error]` and `[data-ledger=error]` must say so on screen. That is
 *  the project's rule — a failed read is stated, never hidden — and it is testable
 *  without depending on a rate limiter's mood. */
const THIRD_PARTY_THROTTLE = /status of 429|429 \(\)|Too Many Requests/i;

function watchForFailures(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (THIRD_PARTY_THROTTLE.test(m.text())) return;
    problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    // Font CDN hiccups are the network's problem, not the page's.
    if (r.url().includes("fonts.g")) return;
    // ERR_ABORTED here is the page cancelling its own request after its own timeout,
    // which is the failure handling working rather than a failure. The consequence is
    // asserted where it belongs: the section must say it could not read, and the
    // "live numbers or an honest failure" tests check exactly that.
    if (f.includes("net::ERR_ABORTED")) return;
    problems.push(`request failed: ${r.url()} ${f}`);
  });
  return problems;
}

test.describe("document shape", () => {
  for (const path of ["/", "/dashboard", "/deck", "/app"]) {
    test(`${path} is a complete HTML document`, async ({ page }) => {
      const res = await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
      expect(res?.status(), "must not redirect to an SSO wall").toBe(200);

      // A page served without a doctype falls into quirks mode, where box sizing
      // and layout differ from every design decision made against standards mode.
      const mode = await page.evaluate(() => document.compatMode);
      expect(mode, "quirks mode breaks the layout").toBe("CSS1Compat");

      // Without this, a phone renders the page at 980px and scales it down.
      const viewport = await page.locator('meta[name="viewport"]').count();
      expect(viewport, "missing meta viewport").toBeGreaterThan(0);

      // Screen readers and translation tools need it; it is one attribute.
      const lang = await page.evaluate(() => document.documentElement.lang);
      expect(lang, "missing lang on <html>").not.toBe("");

      const title = await page.title();
      expect(title.length, "missing title").toBeGreaterThan(2);
    });
  }
});

test.describe("response headers", () => {
  /** `/app` builds and sends transactions from the visitor's wallet. Without
   *  `frame-ancestors`, any site could load it in an invisible iframe over its own
   *  buttons and the wallet prompt would name this origin. It was demonstrably
   *  framable before the policy went in, so the policy is what holds it closed and
   *  the header is worth asserting rather than assuming. */
  test("/app cannot be framed and the policy is served with it", async ({ page }) => {
    const res = await page.goto(BASE + "/app", { waitUntil: "domcontentloaded" });
    const csp = res?.headers()["content-security-policy"] ?? "";
    expect(csp, "no Content-Security-Policy on /app").toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res?.headers()["x-content-type-options"]).toBe("nosniff");
  });

  /** RFC 9116 says a reporter looks here first. A rewrite pointing at a file that
   *  does not exist reads exactly like having no contact at all. */
  test("/.well-known/security.txt answers", async ({ request }) => {
    const res = await request.get(BASE + "/.well-known/security.txt");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain("Contact:");
    expect(body, "RFC 9116 requires Expires").toContain("Expires:");
  });
});

test.describe("landing", () => {
  // The pages under here read the chain on load, and the public explorer's log API is
  // rate-limited: it stalls past 30s often enough to fail roughly two runs in five on an
  // untouched checkout. `networkidle` then never settles and the test times out on the
  // venue's availability rather than on anything this repo did. More budget, not a weaker
  // wait — every assertion below is unchanged, so a real regression still fails.
  test.beforeEach(() => test.slow());

  /** The page's whole claim is that one of each side is worth exactly one, at any
   *  price. It is stated as a control the reader can work, so the control has to be
   *  true — and a hard-coded 1.000 would look identical to a working one. */
  test("the pair reads 1.000 wherever the price is put", async ({ page }) => {
    const problems = watchForFailures(page);
    await page.goto(BASE + "/", { waitUntil: "networkidle" });

    const track = page.locator("#track");
    const up = page.locator("#pUp");
    const down = page.locator("#pDown");
    const sum = page.locator("#pSum");

    await expect(sum).toHaveText("1.000");
    /* `boundingBox()` is viewport coordinates and does not scroll, so `page.mouse` aims at
       whatever is on screen right now. Both pointer tests here passed for weeks only because
       the control happened to sit above the fold; adding two paragraphs to the hero pushed it
       below one and every click landed on nothing, still reading a valid 0.620. */
    await track.scrollIntoViewIfNeeded();
    const box = (await track.boundingBox())!;

    for (const frac of [0.08, 0.31, 0.5, 0.77, 0.96]) {
      await page.mouse.move(box.x + box.width * frac, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      const u = Number(await up.textContent());
      const d = Number(await down.textContent());
      expect(u + d, `up ${u} + down ${d} must be one`).toBeCloseTo(1, 3);
      await expect(sum).toHaveText("1.000");
    }

    // Dragging must actually have moved something, or the assertion above is vacuous.
    await page.mouse.move(box.x + box.width * 0.08, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    const low = Number(await up.textContent());
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    const high = Number(await up.textContent());
    expect(high, "the control does not respond to the pointer").toBeGreaterThan(low + 0.5);

    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("the control works from the keyboard", async ({ page }) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    const track = page.locator("#track");
    await track.focus();
    const before = Number(await page.locator("#pUp").textContent());
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    const after = Number(await page.locator("#pUp").textContent());
    expect(after, "arrow keys move nothing").toBeGreaterThan(before);
    await expect(page.locator("#pSum")).toHaveText("1.000");

    await page.keyboard.press("Home");
    await expect(track).toHaveAttribute("aria-valuenow", "0.010");
  });

  test("does not scroll sideways on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 780 });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "horizontal scroll on mobile").toBeLessThanOrEqual(1);
  });

  test("works by touch as well as pointer", async ({ browser }) => {
    const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    const track = page.locator("#track");
    await track.scrollIntoViewIfNeeded();
    const box = (await track.boundingBox())!;
    const before = Number(await page.locator("#pUp").textContent());
    await page.touchscreen.tap(box.x + box.width * 0.9, box.y + box.height / 2);
    const after = Number(await page.locator("#pUp").textContent());
    expect(after, "a tap on the track must move the price").toBeGreaterThan(before);
    await expect(page.locator("#pSum")).toHaveText("1.000");
    await ctx.close();
  });

  test("every transaction it cites exists on chain", async ({ request, page }) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    const hrefs = await page.locator('a[href*="/tx/0x"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    expect(hrefs.length, "the page cites transactions").toBeGreaterThan(0);
    /* The explorer rate-limits, and this test asks it once per cited transaction while the
       rest of the suite is hitting it too. A 429 is the explorer declining to answer, not
       this page citing a transaction that does not exist, and failing the build on it makes
       a green suite a matter of how busy somebody else's server is — it went red twice on
       an unchanged checkout while this file was being edited. Every other explorer read in
       the suite already tolerates a 429; this one asserted a bare 200.

       Checked, not skipped: at least one hash still has to be confirmed on chain, so the
       claim is verified even on a throttled run. */
    let checked = 0, throttled = 0;
    for (const href of hrefs) {
      const hash = href.split("/tx/")[1];
      const res = await request.get(`https://shannon-explorer.somnia.network/api/v2/transactions/${hash}`);
      if (res.status() === 429) { throttled++; continue; }
      expect(res.status(), `${hash} is not on the explorer`).toBe(200);
      const j = await res.json();
      expect(j.status ?? j.result, `${hash} did not succeed`).toBe("ok");
      checked++;
    }
    expect(checked, `the explorer throttled all ${throttled} reads; nothing was verified`).toBeGreaterThan(0);
  });

  test("sends the reader on to the working", async ({ page }) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: /open the app/i }).first().click();
    await expect(page).toHaveURL(/\/app$/);
  });
});

test.describe("live strip", () => {
  // The pages under here read the chain on load, and the public explorer's log API is
  // rate-limited: it stalls past 30s often enough to fail roughly two runs in five on an
  // untouched checkout. `networkidle` then never settles and the test times out on the
  // venue's availability rather than on anything this repo did. More budget, not a weaker
  // wait — every assertion below is unchanged, so a real regression still fails.
  test.beforeEach(() => test.slow());

  /** The strip reads the vault off the chain in the browser. It may show live numbers
   *  or an explicit failure; it must never sit forever on the loading placeholders,
   *  and it must never show a number for a vault other than the one the page names. */
  for (const path of ["/", "/dashboard"]) {
    test(`${path} resolves to live numbers or an honest failure`, async ({ page }) => {
      await page.goto(BASE + path, { waitUntil: "networkidle" });
      const strip = page.locator("#live");
      await expect(strip).toBeVisible();
      await expect
        .poll(async () => strip.getAttribute("data-state"), { timeout: 20000 })
        .toMatch(/^(live|unreachable)$/);

      const state = await strip.getAttribute("data-state");
      if (state === "live") {
        const nav = await strip.locator("[data-live=nav]").textContent();
        expect(nav, "NAV must be a real number").toMatch(/^\d{1,3}(,\d{3})*\.\d{2}$/);
        const block = await strip.locator("[data-live=block]").textContent();
        expect(Number(block!.replace(/,/g, "")), "block number must be real").toBeGreaterThan(400_000_000);
        const vault = await page.evaluate(() => (window as any).ABADI?.vault as string);
        const href = await strip.locator("[data-live=explorer]").getAttribute("href");
        expect(href, "explorer link must point at the vault the page reads").toContain(vault);
        // The footer names a vault; the strip reads one. They have to be the same.
        const short = vault.slice(0, 10) + "…" + vault.slice(-4);
        await expect(page.locator("footer, .foot").first()).toContainText(short);
      } else {
        await expect(strip.locator("[data-live=error]")).toContainText("Chain read failed");
      }
    });
  }
});

test.describe("dashboard", () => {
  // The pages under here read the chain on load, and the public explorer's log API is
  // rate-limited: it stalls past 30s often enough to fail roughly two runs in five on an
  // untouched checkout. `networkidle` then never settles and the test times out on the
  // venue's availability rather than on anything this repo did. More budget, not a weaker
  // wait — every assertion below is unchanged, so a real regression still fails.
  test.beforeEach(() => test.slow());

  test("renders the numbers it exists to show", async ({ page }) => {
    const problems = watchForFailures(page);
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });

    await expect(page.getByText("directional exposure")).toBeVisible();
    await expect(page.getByText("0.744", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("2,422 settled markets", { exact: true })).toBeVisible();
    await expect(page.getByText("+2.60 tUSDC · 2.67%")).toBeVisible();

    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("does not scroll sideways on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 780 });
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "horizontal scroll on mobile").toBeLessThanOrEqual(1);
  });

  test("the display face actually loaded", async ({ page }) => {
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
    const family = await page.evaluate(() => {
      const el = document.querySelector(".wordmark");
      return el ? getComputedStyle(el).fontFamily : "";
    });
    expect(family, "wordmark fell back to a system face").toContain("Archivo");
  });
});

test.describe("deck", () => {
  test("shows exactly one slide at a time", async ({ page }) => {
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    await expect(page.locator(".slide.on")).toHaveCount(1);
    await expect(page.locator(".slide")).toHaveCount(11);
    await expect(page.locator(".slide.on")).toHaveAttribute("data-i", "0");
  });

  test("arrow keys move forward and back", async ({ page }) => {
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".slide.on")).toHaveAttribute("data-i", "1");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".slide.on")).toHaveAttribute("data-i", "2");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".slide.on")).toHaveAttribute("data-i", "1");
  });

  test("space advances and does not also scroll the page", async ({ page }) => {
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    await page.keyboard.press("Space");
    await expect(page.locator(".slide.on")).toHaveAttribute("data-i", "1");
    const y = await page.evaluate(() => window.scrollY);
    expect(y, "space scrolled instead of only advancing").toBe(0);
  });

  test("buttons disable at both ends", async ({ page }) => {
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    await expect(page.locator("#prev")).toBeDisabled();
    await expect(page.locator("#next")).toBeEnabled();

    await page.keyboard.press("End");
    // Derived, not written down: a hardcoded 9 here had to be edited by hand the first
    // time a slide was added, and a test that needs editing to keep passing is a test
    // that will one day be edited into agreeing with a mistake.
    const last = (await page.locator(".slide").count()) - 1;
    await expect(page.locator(".slide.on")).toHaveAttribute("data-i", String(last));
    await expect(page.locator("#next")).toBeDisabled();
    await expect(page.locator("#prev")).toBeEnabled();
  });

  test("a hash deep link opens that slide", async ({ page }) => {
    await page.goto(BASE + "/deck#7", { waitUntil: "networkidle" });
    await expect(page.locator(".slide.on")).toHaveAttribute("data-i", "6");
    await expect(page.locator(".slide.on")).toContainText("directional exposure");
  });

  test("the hash follows navigation, so a slide can be shared", async ({ page }) => {
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(page.url()).toContain("#3");
  });

  /* This asserted the `transform` string and nothing else, and so it passed for the whole
   * life of a rail that was wrong. The markup carried an inline `width: 10%`, which beats
   * the stylesheet's `width: 100%`; `scaleX()` was then applied on top, so the fill was a
   * tenth of a tenth and reached 10% of the track on the LAST slide. The transform was
   * correct at every step, which is all the old assertion ever looked at.
   *
   * So it measures what the reader sees: painted width against the track it sits in. */
  test("progress rail tracks position", async ({ page }) => {
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    const filled = () =>
      page.evaluate(() => {
        const track = document.querySelector(".bar")!.getBoundingClientRect().width;
        const fill = document.querySelector(".bar i")!.getBoundingClientRect().width;
        return fill / track;
      });
    const slides = await page.locator(".slide").count();

    // The fill transitions over .34s, so poll rather than read once.
    await expect.poll(filled, { timeout: 5000 }).toBeCloseTo(1 / slides, 2);
    await page.keyboard.press("End");
    await expect.poll(filled, { timeout: 5000 }).toBeCloseTo(1, 2);
  });

  /* Five of the deck's slides are built on fixed-width ASCII tables, and every one of
   * them shipped as a single run-on line from the Next.js migration until 2026-09-10.
   *
   * JSX drops the newline between a text line and an element, so `<pre>a\n<b>b</b></pre>`
   * loses its break. The page still rendered, the build still passed, and the migration's
   * own body-comparison gate compared normalised text, where the difference does not
   * exist. Nothing looked at what the reader saw.
   *
   * A `<pre>` with one line is a `<pre>` that lost its formatting. */
  test("every preformatted block kept its line breaks", async ({ page }) => {
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    const blocks = await page.locator(".slide pre").evaluateAll((els) =>
      els.map((el) => ({
        label: el.getAttribute("aria-label") ?? "(unlabelled)",
        lines: (el.textContent ?? "").split("\n").length,
      })),
    );
    expect(blocks.length, "the deck has no pre blocks to check").toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.lines, `"${b.label}" collapsed to one line`).toBeGreaterThan(1);
    }
  });

  test("keyboard focus is visible on the controls", async ({ page }) => {
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    await page.locator("#next").focus();
    const outline = await page.evaluate(() => {
      const el = document.getElementById("next")!;
      return getComputedStyle(el).outlineStyle;
    });
    expect(outline, "no visible focus ring").not.toBe("none");
  });

  test("no slide overflows sideways on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 780 });
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    for (let i = 0; i < 10; i++) {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `slide ${i + 1} scrolls sideways`).toBeLessThanOrEqual(1);
      await page.keyboard.press("ArrowRight");
    }
  });

  test("tall slides stay readable on a short viewport", async ({ page }) => {
    // A laptop in a video call, or a projector at 720p.
    await page.setViewportSize({ width: 1280, height: 620 });
    await page.goto(BASE + "/deck#3", { waitUntil: "networkidle" });
    const clipped = await page.evaluate(() => {
      const s = document.querySelector(".slide.on") as HTMLElement;
      // Content taller than the slide must be reachable, not cut off.
      return s.scrollHeight > s.clientHeight && getComputedStyle(s).overflowY === "visible";
    });
    expect(clipped, "content is taller than the slide and cannot be scrolled").toBe(false);
  });

  test("loads clean", async ({ page }) => {
    const problems = watchForFailures(page);
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    await page.keyboard.press("End");
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
