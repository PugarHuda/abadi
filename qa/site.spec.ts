/**
 * Browser QA against the deployed site — the thing judges actually open.
 *
 * Runs against BASE (default: production). Point it at a preview with
 *   BASE=https://... npx playwright test
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";

/** Console errors and failed requests are bugs, not noise. */
function watchForFailures(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    // Font CDN hiccups are the network's problem, not the page's.
    if (!r.url().includes("fonts.g")) problems.push(`request failed: ${r.url()} ${f}`);
  });
  return problems;
}

test.describe("document shape", () => {
  for (const path of ["/", "/dashboard", "/deck"]) {
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

test.describe("landing", () => {
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
    for (const href of hrefs) {
      const hash = href.split("/tx/")[1];
      const res = await request.get(`https://shannon-explorer.somnia.network/api/v2/transactions/${hash}`);
      expect(res.status(), `${hash} is not on the explorer`).toBe(200);
      const j = await res.json();
      expect(j.status ?? j.result, `${hash} did not succeed`).toBe("ok");
    }
  });

  test("sends the reader on to the working", async ({ page }) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: /read the evidence/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe("live strip", () => {
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
    expect(family, "wordmark fell back to a system face").toContain("Bricolage");
  });
});

test.describe("deck", () => {
  test("shows exactly one slide at a time", async ({ page }) => {
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    await expect(page.locator(".slide.on")).toHaveCount(1);
    await expect(page.locator(".slide")).toHaveCount(10);
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
    await expect(page.locator(".slide.on")).toHaveAttribute("data-i", "9");
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

  test("progress rail tracks position", async ({ page }) => {
    await page.goto(BASE + "/deck", { waitUntil: "networkidle" });
    const width = () => page.evaluate(() => (document.querySelector(".bar i") as HTMLElement).style.transform);
    expect(await width()).toBe("scaleX(0.1)");
    await page.keyboard.press("End");
    expect(await width()).toBe("scaleX(1)");
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
