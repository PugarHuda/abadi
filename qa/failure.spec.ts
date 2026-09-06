/**
 * What the site does when the chain does not answer.
 *
 * Every page here claims, in prose, that a number is read from the chain or it is not
 * shown. That claim is only worth anything if the failure path actually reaches the
 * reader, and until this file existed nothing checked that it did. Three bugs were living
 * in the gap:
 *
 *   - `/app` — the page where money moves — called `fetch` with no timeout at all. An RPC
 *     that accepted the socket and went quiet left NAV, Idle and Per share on "…" while the
 *     page went on saying the numbers were live, because `refresh()` never resolved and its
 *     own `.catch` never ran.
 *   - The honest-failure sentence on `/` and `/dashboard` was written into an element whose
 *     only `display: block` rule keyed on `data-state="error"`, while the code sets
 *     `"unreachable"`. The reader saw dashes and no reason. The existing test passed because
 *     `toContainText` reads `textContent`, which a hidden element still has.
 *   - `ledger.js` had one remaining un-timed `fetch`, joined by `Promise.all`, so a hung RPC
 *     left the panel on "loading" for good — the exact bug the rest of that file was
 *     rewritten to end.
 *
 * A hang is staged rather than an error, because a hang is the case that broke: `fetch`
 * rejects on a refused connection, and does not reject on a host that goes quiet. The route
 * handler below never settles, which is what that looks like from the browser.
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";
const ACCOUNT = "0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e";

/** web/fetchin.js gives up after this; every assertion below waits past it. */
const FETCH_TIMEOUT_MS = 12_000;
const PAST_TIMEOUT = FETCH_TIMEOUT_MS + 12_000;

/** A host that accepts the request and never answers. Not an error — silence. */
async function hangChain(page: Page) {
  await page.route("**/api.infra.testnet.somnia.network/**", () => new Promise(() => {}));
}

/** The explorer's log API, silent in the same way. */
async function hangExplorer(page: Page) {
  await page.route("**/shannon-explorer.somnia.network/**", () => new Promise(() => {}));
}

test.describe("a chain that goes quiet", () => {
  test.beforeEach(() => test.slow());

  test("/app says its numbers are stale instead of pretending they are live", async ({ page }) => {
    await hangChain(page);
    await page.goto(BASE + "/app");

    // The whole point: the promise must be given up on, so the catch that already existed
    // can run. Before web/fetchin.js reached this page, this attribute stayed "false".
    await expect(page.locator("#app")).toHaveAttribute("data-stale", "true", { timeout: PAST_TIMEOUT });

    // And it must say so in words, not only in an attribute a reader cannot see.
    await expect(page.locator("#freshness")).toContainText(/never read|not from now/i);
  });

  test("/ shows the reason the numbers are dashes, visibly", async ({ page }) => {
    await hangChain(page);
    await page.goto(BASE + "/");

    const strip = page.locator(".live").first();
    await expect
      .poll(async () => strip.getAttribute("data-state"), { timeout: PAST_TIMEOUT })
      .toBe("unreachable");

    // toBeVisible, not toContainText. The bug this catches is a correct sentence in a
    // `display: none` element, which every text assertion in the suite happily passed.
    const err = strip.locator("[data-live=error]");
    await expect(err).toBeVisible();
    await expect(err).toContainText(/nothing is shown rather than something stale/i);
  });

  test("/dashboard's ledger gives up rather than sitting on loading", async ({ page }) => {
    await hangExplorer(page);
    await hangChain(page);
    await page.goto(BASE + "/dashboard");

    const ledger = page.locator("#ledger");
    await expect
      .poll(async () => ledger.getAttribute("data-state"), { timeout: PAST_TIMEOUT })
      .toBe("unreachable");
    await expect(ledger.locator("[data-ledger=error]")).toBeVisible();

    // The chart is drawn only on the success path, so it kept the word "loading" under a
    // panel that had just said the read failed. An empty frame is not a flat month.
    const chart = page.locator("#pnlChart");
    await expect(chart).not.toHaveAttribute("data-state", "loading");
    await expect(chart.locator(".chart-err")).toBeVisible();
  });
});

test.describe("a URL that is not there", () => {
  test("renders the site's own 404 page, with a 404 status", async ({ page }) => {
    // Reaching /404 by name always worked, so nothing checked that a genuine miss lands
    // there. The QA server answered "not found" in plain text while Vercel served the page,
    // which is the sort of difference a mirror exists to not have.
    const res = await page.goto(BASE + "/no-such-page-abadi-qa");
    expect(res?.status(), "an unknown path is a 404, not a 200").toBe(404);
    await expect(page.locator("h1, h2").first()).toBeVisible();
    // A dead end is not allowed anywhere on this site: the way out is on the page.
    await expect(page.locator('a[href="/"]').first()).toBeVisible();
  });
});

/**
 * A wallet that signs the first transaction and refuses the second.
 *
 * This is the deposit shape exactly: approve, then deposit. Rejecting the second used to
 * print "You cancelled in the wallet. Nothing was sent." two lines under "Approve 100 tUSDC
 * for the vault confirmed in block 123,456." — leaving the reader believing they had no
 * standing allowance on the vault when they did.
 */
const REJECTS_SECOND = `
  (() => {
    const sent = [];
    let chainId = "0xc488";
    window.__sent = sent;
    window.ethereum = {
      isStub: true,
      on() {},
      async request({ method, params }) {
        if (method === "eth_requestAccounts") return ["${ACCOUNT}"];
        if (method === "eth_chainId") return chainId;
        if (method === "wallet_switchEthereumChain") { chainId = params[0].chainId; return null; }
        if (method === "eth_sendTransaction") {
          if (sent.length >= 1) { const e = new Error("User rejected the request."); e.code = 4001; throw e; }
          sent.push(params[0]);
          return "0x" + "ab".repeat(32);
        }
        throw new Error("stub: " + method);
      }
    };
  })();
`;

/** Enough of a chain to get through connect and one confirmed transaction. */
async function chainFor(page: Page, allowance: bigint) {
  const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  await page.route("**/api.infra.testnet.somnia.network/**", async (route) => {
    const raw = route.request().postData();
    if (!raw) return route.continue();
    const req = JSON.parse(raw);
    const p = req.params?.[0];
    const reply = (body: object) => route.fulfill({ json: { jsonrpc: "2.0", id: req.id, ...body } });
    if (req.method === "eth_getBalance") return reply({ result: word(10n ** 18n) });
    if (req.method === "eth_getTransactionReceipt") {
      return reply({ result: { status: "0x1", blockNumber: "0x1e240", transactionHash: p } });
    }
    if (req.method !== "eth_call") return route.continue();
    const sel = String(p.data).slice(0, 10);
    const reads: Record<string, bigint> = {
      "0x70a08231": 500_000_000n,      // balanceOf
      "0x01e1d114": 1_000_000_000n,    // totalAssets
      "0xe16b03a3": 1_000_000_000n,    // idleAssets
      "0x18160ddd": 1_000_000_000n,    // totalSupply
      "0xc0f3f2e9": 0n,                // MAX_SLOTS
      "0x07a2d13a": 100_000_000n,      // convertToAssets
      "0xdd62ed3e": allowance,         // allowance
      "0x359f27e8": 32n * 10n ** 18n,  // MIN_HANDLER_BALANCE
    };
    if (sel in reads) return reply({ result: word(reads[sel]) });
    return reply({ error: { code: 3, message: "execution reverted", data: null } });
  });
}

test.describe("a cancelled signature", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(REJECTS_SECOND);
  });

  test("names what already landed instead of claiming nothing was sent", async ({ page }) => {
    await chainFor(page, 0n); // no allowance, so the deposit needs two signatures
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#deposit")).toBeEnabled();

    await page.locator("#amount").fill("100");
    await page.locator("#depositForm").dispatchEvent("submit");

    const log = page.locator("#log");
    await expect(log).toContainText(/approve .*confirmed in block/i, { timeout: 20_000 });

    // The contradiction this test exists for.
    await expect(log).not.toContainText(/nothing was sent/i);
    await expect(log).toContainText(/already confirmed on chain/i);

    // Exactly one transaction reached the chain, which is what the sentence must describe.
    expect(await page.evaluate(() => (window as any).__sent.length)).toBe(1);
  });

  test("the failure survives the balance refresh that follows it", async ({ page }) => {
    await chainFor(page, 0n);
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await page.locator("#amount").fill("100");
    await page.locator("#depositForm").dispatchEvent("submit");

    const status = page.locator("#status");
    await expect(status).toContainText(/already confirmed on chain/i, { timeout: 20_000 });

    // run() calls refresh() straight after its catch, and refresh() used to overwrite this
    // with "Ready." about two hundred milliseconds later. Wait well past that.
    await page.waitForTimeout(4000);
    await expect(status).toContainText(/already confirmed on chain/i);

    // And it must look like a failure. The stylesheet knows work/ok/bad; the script used to
    // emit info/busy/error, so nothing on this page was ever painted with the alarm colour.
    await expect(status).toHaveAttribute("data-tone", "bad");
  });
});
