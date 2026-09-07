/**
 * The order-book panel on /dashboard, which had no test at all.
 *
 * This panel carries the project's loudest claim — that Abadi's own quote is resting
 * *inside* the incumbent's book — and it marks its own rows by comparing the order's
 * `owner` field against the vault address. Nothing checked that the marker lands on the
 * right row, that a level nobody owns stays unmarked, that the empty state says the vault
 * is between quotes rather than showing an empty ladder, or that a failed read says so.
 *
 * Both sources are stubbed, because all three states matter and only one of them can be
 * arranged on a live chain: the vault is either quoting or it is not, and it will not fail
 * on request. The stub answers in the venue's own shapes — the slot struct as eleven words
 * with `active` last, and the indexer's `Order` rows — so what is under test is this file's
 * decoding and marking, not the fixture.
 */
import { test, expect, type Page } from "@playwright/test";

import { readFileSync } from "node:fs";

/* The vault the page is configured to read, not a literal. A hardcoded address here kept
 * answering for a vault that had been retired, so the stub and the page disagreed about
 * which contract the test was about — and every assertion still passed. */
const VAULT = readFileSync(".vault-addr", "utf8").trim().toLowerCase();

const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";
const MARKET = "0x" + "ab".repeat(32);

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");

/** One slot struct, as `slots(uint256)` returns it: market id first, `active` eleventh. */
function slotWords(opts: { active: boolean; bid: bigint; ask: bigint }) {
  const w = new Array(11).fill(word(0n));
  w[0] = MARKET.slice(2);
  w[6] = word(opts.bid);
  w[7] = word(opts.ask);
  w[10] = word(opts.active ? 1n : 0n);
  return "0x" + w.join("");
}

type Order = { isBid: boolean; price: string; quantityRemaining: string; owner: string };

/** Answer both reads the panel makes: the vault's slots, and the venue's open orders. */
async function stub(page: Page, opts: { active: boolean; orders?: Order[]; bookFails?: boolean }) {
  const vault = VAULT;

  await page.route("**/api.infra.testnet.somnia.network/**", async (route) => {
    const raw = route.request().postData();
    if (!raw) return route.continue();
    const req = JSON.parse(raw);
    const reply = (result: unknown) => route.fulfill({ json: { jsonrpc: "2.0", id: req.id, result } });
    if (req.method !== "eth_call") return route.continue();
    const data = String(req.params[0].data);
    if (data.startsWith("0xc0f3f2e9")) return reply("0x" + word(1n));       // MAX_SLOTS = 1
    if (data.startsWith("0x387dd9e9")) return reply(slotWords({ ...opts, bid: 744_000n, ask: 770_000n }));
    return reply("0x" + word(0n));
  });

  await page.route("**/dev.smk.somnia.host/**", async (route) => {
    if (opts.bookFails) return route.fulfill({ status: 500, body: "indexer is unwell" });
    route.fulfill({ json: { data: { Order: opts.orders ?? [] } } });
  });
}

/** The vault's own address is read from the page, so the fixture cannot drift from it. */
async function vaultOf(page: Page) {
  return (await page.evaluate(() => (window as any).ABADI.vault as string)).toLowerCase();
}

test.describe("the book panel", () => {
  test.beforeEach(() => test.slow());

  test("marks the vault's own levels and leaves everyone else's alone", async ({ page }) => {
    // Route before navigating so the panel's first load already sees the stub.
    await page.route("**/api.infra.testnet.somnia.network/**", (r) => r.continue());
    await page.goto(BASE + "/dashboard");
    const vault = await vaultOf(page);

    await stub(page, {
      active: true,
      orders: [
        { isBid: true, price: "744000", quantityRemaining: "100000000", owner: vault },
        { isBid: true, price: "742000", quantityRemaining: "200000000", owner: "0x" + "11".repeat(20) },
        { isBid: false, price: "770000", quantityRemaining: "100000000", owner: vault },
        { isBid: false, price: "772000", quantityRemaining: "330000000", owner: "0x" + "22".repeat(20) },
      ],
    });
    await page.reload();

    const book = page.locator("#book");
    await expect.poll(async () => book.getAttribute("data-state"), { timeout: 30_000 }).toBe("live");

    // Exactly the two levels the vault owns carry the marker, on both sides.
    await expect(book.locator(".lvl.mine")).toHaveCount(2);
    await expect(book.locator(".lvl.mine .tag")).toHaveText(["ABADI", "ABADI"]);

    // And it is the right row: the marked bid is the vault's price, not the stranger's.
    const markedBid = book.locator('[data-book="bids"] .lvl.mine .px');
    await expect(markedBid).toContainText("0.744");
    const others = book.locator('[data-book="bids"] .lvl:not(.mine) .px');
    await expect(others).toContainText("0.742");
    await expect(book.locator('[data-book="bids"] .lvl:not(.mine) .tag')).toHaveCount(0);

    // The note names the window and the quote, because the panel is evidence, not decor.
    await expect(page.locator("[data-book=note]")).toContainText("0.744 / 0.770");
  });

  test("says the vault is between windows rather than drawing an empty ladder", async ({ page }) => {
    await page.route("**/api.infra.testnet.somnia.network/**", (r) => r.continue());
    await page.goto(BASE + "/dashboard");
    await stub(page, { active: false });
    await page.reload();

    const book = page.locator("#book");
    await expect.poll(async () => book.getAttribute("data-state"), { timeout: 30_000 }).toBe("idle");
    await expect(page.locator("[data-book=note]")).toContainText(/between windows/i);
    // An empty state is a true statement, not a blank frame with a stale heading on it.
    await expect(book.locator(".lvl")).toHaveCount(0);
  });

  test("says which read failed instead of showing a book it could not get", async ({ page }) => {
    await page.route("**/api.infra.testnet.somnia.network/**", (r) => r.continue());
    await page.goto(BASE + "/dashboard");
    await stub(page, { active: true, bookFails: true });
    await page.reload();

    const book = page.locator("#book");
    await expect.poll(async () => book.getAttribute("data-state"), { timeout: 30_000 }).toBe("error");
    await expect(page.locator("[data-book=note]")).toContainText(/could not read the book/i);
    await expect(book.locator(".lvl")).toHaveCount(0);
  });
});
