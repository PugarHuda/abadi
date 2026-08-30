/**
 * The app page, two ways.
 *
 * Without a wallet it must still be honest and useful: vault numbers live from the
 * chain, actions disabled, and a plain statement that no wallet was found.
 *
 * With a wallet it must send exactly the right bytes to exactly the right contracts.
 * Playwright cannot drive a real wallet extension, so the test installs a minimal
 * EIP-1193 provider that records every request — a test double for the wallet, not
 * for the product: the page's own encoders build the calldata, and the test compares
 * it byte for byte against the ABI encoding written out by hand.
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.BASE ?? "https://abadi-wheat.vercel.app";
const ACCOUNT = "0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e";
const USDC = "0x70a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e";

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addr = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** A wallet that answers like one and remembers what it was asked. */
const STUB_PROVIDER = `
  (() => {
    const sent = [];
    let chainId = "0x1";
    window.__sent = sent;
    window.ethereum = {
      isStub: true,
      on() {},
      async request({ method, params }) {
        if (method === "eth_requestAccounts") return ["${ACCOUNT}"];
        if (method === "eth_chainId") return chainId;
        if (method === "wallet_switchEthereumChain") { chainId = params[0].chainId; return null; }
        if (method === "eth_sendTransaction") {
          sent.push(params[0]);
          return "0x" + (sent.length).toString(16).padStart(64, "0");
        }
        throw new Error("stub: " + method);
      }
    };
  })();
`;

/**
 * The live vault has exactly one depositor, and it is `ACCOUNT` — so the app's
 * last-share guard disables "Redeem all" whenever a slot is open, which the bot keeps
 * true nearly all the time. That guard is the product working; it also made this test
 * depend on whether the vault happened to be idle, and it went red for good the day the
 * bot started holding three slots continuously.
 *
 * So exactly one read is answered differently: `totalSupply()`, with a number far above
 * any one balance, which makes this account not the last holder. Nothing else is
 * touched — the shares, the worth, the NAV and the calldata under test are all still
 * the live chain and the page's own encoders.
 */
async function notTheLastHolder(page: Page) {
  const TOTAL_SUPPLY = "0x18160ddd";
  await page.route("**/*", async (route) => {
    const body = route.request().postData();
    if (!body || !body.includes(TOTAL_SUPPLY)) return route.continue();
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({ response: res, json: { ...json, result: "0x" + (10n ** 24n).toString(16).padStart(64, "0") } });
  });
}

test.describe("app without a wallet", () => {
  test("reads the vault live and says plainly there is no wallet", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await expect(page.locator("#connect")).toHaveText(/no wallet found/i);
    await expect(page.locator("#connect")).toBeDisabled();
    // A dead end is not allowed: the way out is on the page, with links.
    await expect(page.locator("#nowallet")).toBeVisible();
    await expect(page.locator("#nowallet a[href*='metamask']")).toBeVisible();
    await expect(page.locator("#status")).toContainText(/no wallet/i);
    await expect(page.locator("#logEmpty")).toBeVisible();
    // The product's claim is on the money page, live: the self-wake reserve.
    await expect.poll(async () => page.locator("[data-wake=stt]").textContent(), { timeout: 20000 }).toMatch(/\d+\.\d{3} STT/);
    await expect(page.locator("#deposit")).toBeDisabled();
    await expect(page.locator("#faucet")).toBeDisabled();
    await expect.poll(async () => page.locator("#nav").textContent(), { timeout: 20000 }).toMatch(/^\d{1,3}(,\d{3})*\.\d{2}$/);
    await expect(page.locator("#slots tr")).not.toHaveCount(0);
  });
});

test.describe("app with a wallet", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(STUB_PROVIDER);
  });

  test("connects, switches to Shannon, and enables the actions", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await expect(page.locator("#connect")).toHaveText(/connect wallet/i);
    await page.locator("#connect").click();
    await expect(page.locator("#wallet")).toHaveText(/0x39d2…cd7e/i);
    await expect(page.locator("#network")).toContainText("50312");
    await expect(page.locator("#deposit")).toBeEnabled();
    await expect(page.locator("#faucet")).toBeEnabled();
    // The stub wallet started on chain 0x1; the page must have asked it to switch.
    await expect(page.locator("#connect")).toHaveText(/connected/i);
  });

  test("a deposit above the wallet's balance is refused before anything is signed", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#deposit")).toBeEnabled();
    // Wait for the balances to arrive, then ask for more tUSDC than the account holds.
    await expect.poll(async () => page.locator("#usdc").textContent(), { timeout: 20000 }).toMatch(/^\d/);
    await page.locator("#amount").fill("999999999");
    await page.locator("#deposit").click();
    await expect(page.locator("#status")).toContainText(/you have .* tUSDC/i);
    expect(await page.evaluate(() => (window as any).__sent.length)).toBe(0);
  });

  test("approve and deposit are encoded exactly as the ABI says", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    const vault = await page.evaluate(() => (window as any).ABADI.vault as string);
    const enc = await page.evaluate((acct) => {
      const e = (window as any).ABADI_APP.encode;
      const v = (window as any).ABADI.vault;
      return { approve: e.approve(v, 100000000n), deposit: e.deposit(100000000n, acct), withdraw: e.withdraw(12500000n, acct, acct) };
    }, ACCOUNT);
    const amount = 100_000_000n;
    expect(enc.approve).toBe("0x095ea7b3" + addr(vault) + word(amount));
    expect(enc.deposit).toBe("0x6e553f65" + word(amount) + addr(ACCOUNT));
    expect(enc.withdraw).toBe("0xb460af94" + word(12_500_000n) + addr(ACCOUNT) + addr(ACCOUNT));
  });

  test("the faucet asks the token for exactly 10,000 tUSDC", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#faucet")).toBeEnabled();
    // The gas pre-check reads the wallet's STT first; wait for that read to land.
    await expect.poll(async () => page.locator("#stt").textContent(), { timeout: 20000 }).toMatch(/^\d/);
    await page.locator("#faucet").click();
    await expect.poll(async () => page.evaluate(() => (window as any).__sent.length), { timeout: 15000 }).toBe(1);
    const sent = await page.evaluate(() => (window as any).__sent[0] as { to: string; data: string });
    expect(sent.to.toLowerCase()).toBe(USDC);
    expect(sent.data).toBe("0x57915897" + word(10_000_000_000n)); // faucet(10_000e6)
  });

  test("a withdrawal within what the shares are worth is sent as ERC-4626 withdraw(assets)", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    const vault = await page.evaluate(() => (window as any).ABADI.vault as string);
    await page.locator("#connect").click();
    await expect(page.locator("#withdraw")).toBeEnabled();
    await expect.poll(async () => page.locator("#worth").textContent(), { timeout: 20000 }).toMatch(/^\d/);
    await page.locator("#withdrawAmount").fill("12.5");
    await page.locator("#withdraw").click();
    await expect.poll(async () => page.evaluate(() => (window as any).__sent.length), { timeout: 15000 }).toBe(1);
    const sent = await page.evaluate(() => (window as any).__sent[0] as { to: string; data: string });
    expect(sent.to.toLowerCase()).toBe(vault.toLowerCase());
    expect(sent.data).toBe("0xb460af94" + word(12_500_000n) + addr(ACCOUNT) + addr(ACCOUNT));
    await expect(page.locator("#withdraw")).toHaveText(/waiting for wallet/i);
    await expect(page.locator("#status")).toContainText(/waiting/i);
  });

  test("redeem all asks twice and shows what it will do", async ({ page }) => {
    await notTheLastHolder(page);
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect.poll(async () => page.locator("#worth").textContent(), { timeout: 20000 }).toMatch(/^\d/);
    await expect(page.locator("#allPreview")).toContainText(/≈ .* tUSDC for .* shares/);
    await expect(page.locator("#withdrawAll")).toBeEnabled();
    await page.locator("#withdrawAll").click();
    await expect(page.locator("#withdrawAll")).toHaveText(/confirm: redeem .* shares for ≈ .* tUSDC/i);
    expect(await page.evaluate(() => (window as any).__sent.length)).toBe(0);
    await page.locator("#withdrawAll").click();
    await expect.poll(async () => page.evaluate(() => (window as any).__sent.length), { timeout: 15000 }).toBe(1);
    const sent = await page.evaluate(() => (window as any).__sent[0] as { data: string });
    expect(sent.data.startsWith("0xba087652")).toBe(true);
  });

  test("an empty amount is refused before anything is sent", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#deposit")).toBeEnabled();
    await page.locator("#deposit").click();
    await expect(page.locator("#status")).toContainText(/enter an amount/i);
    expect(await page.evaluate(() => (window as any).__sent.length)).toBe(0);
  });
});
