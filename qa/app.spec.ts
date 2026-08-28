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
import { test, expect } from "@playwright/test";

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

test.describe("app without a wallet", () => {
  test("reads the vault live and says plainly there is no wallet", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await expect(page.locator("#connect")).toHaveText(/no wallet found/i);
    await expect(page.locator("#connect")).toBeDisabled();
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

  test("a deposit sends approve then deposit, encoded exactly, to the right contracts", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    const vault = await page.evaluate(() => (window as any).ABADI.vault as string);
    await page.locator("#connect").click();
    await expect(page.locator("#deposit")).toBeEnabled();

    await page.locator("#amount").fill("100");
    await page.locator("#deposit").click();

    // The page waits for a receipt it will never get from a stub, so read what was sent.
    await expect.poll(async () => page.evaluate(() => (window as any).__sent.length), { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    const sent = await page.evaluate(() => (window as any).__sent as { to: string; data: string; from: string }[]);

    const amount = 100_000_000n;
    expect(sent[0].to.toLowerCase()).toBe(USDC);
    expect(sent[0].from.toLowerCase()).toBe(ACCOUNT);
    expect(sent[0].data).toBe("0x095ea7b3" + addr(vault) + word(amount)); // approve(vault, 100e6)
  });

  test("the faucet asks the token for exactly 10,000 tUSDC", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#faucet")).toBeEnabled();
    await page.locator("#faucet").click();
    await expect.poll(async () => page.evaluate(() => (window as any).__sent.length), { timeout: 15000 }).toBe(1);
    const sent = await page.evaluate(() => (window as any).__sent[0] as { to: string; data: string });
    expect(sent.to.toLowerCase()).toBe(USDC);
    expect(sent.data).toBe("0x57915897" + word(10_000_000_000n)); // faucet(10_000e6)
  });

  test("redeem encodes shares, receiver and owner as the connected account", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    const vault = await page.evaluate(() => (window as any).ABADI.vault as string);
    await page.locator("#connect").click();
    await expect(page.locator("#withdraw")).toBeEnabled();
    await page.locator("#withdrawShares").fill("12.5");
    await page.locator("#withdraw").click();
    await expect.poll(async () => page.evaluate(() => (window as any).__sent.length), { timeout: 15000 }).toBe(1);
    const sent = await page.evaluate(() => (window as any).__sent[0] as { to: string; data: string });
    expect(sent.to.toLowerCase()).toBe(vault.toLowerCase());
    expect(sent.data).toBe("0xba087652" + word(12_500_000n) + addr(ACCOUNT) + addr(ACCOUNT));
  });

  test("an empty amount is refused before anything is sent", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#deposit")).toBeEnabled();
    await page.locator("#deposit").click();
    await expect(page.locator("#log li").first()).toContainText(/amount above zero/i);
    expect(await page.evaluate(() => (window as any).__sent.length)).toBe(0);
  });
});
