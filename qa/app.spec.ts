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
import { toFunctionSelector } from "viem";

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
 * A wallet that adds the chain and stays where it was. Real ones do this: adding a
 * network is not switching to it, and a switch the user dismisses can still resolve.
 */
const STUCK_PROVIDER = `
  (() => {
    const sent = [];
    window.__sent = sent;
    window.ethereum = {
      isStub: true,
      on() {},
      async request({ method, params }) {
        if (method === "eth_requestAccounts") return ["${ACCOUNT}"];
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_switchEthereumChain") { const e = new Error("Unrecognized chain ID"); e.code = 4902; throw e; }
        if (method === "wallet_addEthereumChain") return null;
        if (method === "eth_sendTransaction") { sent.push(params[0]); return "0x" + "11".repeat(32); }
        throw new Error("stub: " + method);
      }
    };
  })();
`;

/** Everything the chain would say, said from a table instead.
 *
 *  The live vault has exactly one depositor and a bot that keeps three slots open, so
 *  a test that reads it is a test about whatever the bot is doing this minute: the
 *  last-share guard flipped one of these red for good the day the bot stopped going
 *  idle. Worse, the states that matter here — shares worth more than the vault holds
 *  in idle collateral, a transaction that reverts — cannot be arranged on a live
 *  vault at all. The returned object is live: mutate a field and the next read sees
 *  it, which is how a refresh landing mid-confirmation is staged.
 *
 *  The page's own encoders still build every byte that is asserted on. */
type Chain = {
  nav: bigint; idle: bigint; supply: bigint; usdc: bigint; shares: bigint; worth: bigint;
  stt: bigint; allowance: bigint;
  /** Status bit on the receipt every sent transaction gets back. */
  receipt: string;
  /** Revert bytes returned when a write is replayed with eth_call. */
  revert: string | null;
  /** Once true, every read fails, the way an unreachable node fails. */
  down: boolean;
};

async function fakeChain(page: Page, over: Partial<Chain> = {}): Promise<Chain> {
  const c: Chain = {
    nav: 1_000_000_000n, idle: 1_000_000_000n, supply: 1_000_000_000n,
    usdc: 500_000_000n, shares: 100_000_000n, worth: 100_000_000n,
    stt: 10n ** 18n, allowance: 0n, receipt: "0x1", revert: null, down: false, ...over,
  };
  const num = (v: bigint) => "0x" + word(v);
  await page.route("**/*", async (route) => {
    const raw = route.request().postData();
    if (!raw) return route.continue();
    const req = JSON.parse(raw);
    const p = req.params?.[0];
    const reply = (body: object) => route.fulfill({ json: { jsonrpc: "2.0", id: req.id, ...body } });
    if (c.down) return reply({ error: { code: -32000, message: "the node is unreachable" } });
    if (req.method === "eth_getBalance") return reply({ result: num(String(p).toLowerCase() === ACCOUNT ? c.stt : 40n * 10n ** 18n) });
    if (req.method === "eth_getTransactionReceipt") return reply({ result: { status: c.receipt, blockNumber: "0x1e240", transactionHash: p } });
    if (req.method !== "eth_call") return route.continue();
    const to = String(p.to).toLowerCase(), sel = String(p.data).slice(0, 10);
    if (sel === "0x70a08231") return reply({ result: num(to === USDC ? c.usdc : c.shares) }); // balanceOf
    const reads: Record<string, bigint> = {
      "0x01e1d114": c.nav,       // totalAssets
      "0xe16b03a3": c.idle,      // idleAssets
      "0x18160ddd": c.supply,    // totalSupply
      "0xc0f3f2e9": 0n,          // MAX_SLOTS — no quotes to draw
      "0x07a2d13a": c.worth,     // convertToAssets
      "0xdd62ed3e": c.allowance, // allowance
      "0x359f27e8": 32n * 10n ** 18n, // MIN_HANDLER_BALANCE
    };
    if (sel in reads) return reply({ result: num(reads[sel]) });
    return reply({ error: { code: 3, message: "execution reverted", data: c.revert } });
  });
  return c;
}

const sent = (page: Page) => page.evaluate(() => (window as any).__sent as { to: string; data: string }[]);

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

  test("names both contracts it will ask you to sign for, and links them", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    const vault = await page.evaluate(() => (window as any).ABADI.vault as string);
    await expect(page.locator("#vaultAddr")).toHaveText(vault);
    await expect(page.locator("#vaultAddr")).toHaveAttribute("href", new RegExp("/address/" + vault + "$", "i"));
    await expect(page.locator("#usdcAddr")).toHaveText(new RegExp("^" + USDC + "$", "i"));
    await expect(page.locator("#usdcAddr")).toHaveAttribute("href", new RegExp("/address/" + USDC + "$", "i"));
  });

  test("says how many signatures a deposit really costs", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    // The approval is for exactly the deposit, so the deposit spends it: there is no
    // second deposit that costs one signature, and the page must not promise one.
    await expect(page.locator("body")).not.toContainText(/one after/i);
    await expect(page.locator("body")).toContainText(/every deposit signs twice/i);
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
    await fakeChain(page, { usdc: 500_000_000n });
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#usdc")).toHaveText("500.00");
    await page.locator("#amount").fill("999999999");
    await page.locator("#deposit").click();
    await expect(page.locator("#status")).toContainText(/you have 500\.00 tUSDC/i);
    expect(await sent(page)).toHaveLength(0);
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
    await fakeChain(page);
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#faucet")).toBeEnabled();
    // The gas pre-check reads the wallet's STT first; wait for that read to land.
    await expect(page.locator("#stt")).toHaveText("1.000");
    await page.locator("#faucet").click();
    await expect.poll(async () => (await sent(page)).length, { timeout: 15000 }).toBe(1);
    expect((await sent(page))[0].to.toLowerCase()).toBe(USDC);
    expect((await sent(page))[0].data).toBe("0x57915897" + word(10_000_000_000n)); // faucet(10_000e6)
  });

  test("a withdrawal within what the shares are worth is sent as ERC-4626 withdraw(assets)", async ({ page }) => {
    await fakeChain(page, { worth: 100_000_000n, idle: 1_000_000_000n });
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    const vault = await page.evaluate(() => (window as any).ABADI.vault as string);
    await page.locator("#connect").click();
    await expect(page.locator("#worth")).toHaveText("100.00");
    await page.locator("#withdrawAmount").fill("12.5");
    await page.locator("#withdraw").click();
    await expect.poll(async () => (await sent(page)).length, { timeout: 15000 }).toBe(1);
    const tx = (await sent(page))[0];
    expect(tx.to.toLowerCase()).toBe(vault.toLowerCase());
    expect(tx.data).toBe("0xb460af94" + word(12_500_000n) + addr(ACCOUNT) + addr(ACCOUNT));
    await expect(page.locator("#status")).toContainText(/withdraw 12\.5 tUSDC/i);
  });

  // A withdrawal is paid out of the vault's token balance, not out of NAV. Shares worth
  // 900 against 5 idle are a transaction that reverts and still costs gas, so the page
  // has to refuse it here, with the number that is actually available.
  test("a withdrawal above what is idle is refused client-side", async ({ page }) => {
    await fakeChain(page, { shares: 900_000_000n, worth: 900_000_000n, idle: 5_000_000n });
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#worth")).toHaveText("900.00");
    await expect(page.locator("#idle")).toHaveText("5.00");
    await page.locator("#withdrawAmount").fill("50");
    await page.locator("#withdraw").click();
    await expect(page.locator("#status")).toContainText(/5\.00 tUSDC is available now/i);
    await expect(page.locator("#status")).toContainText(/working in open quotes/i);
    expect(await sent(page)).toHaveLength(0);
  });

  test("Max fills what is available, not what the shares are worth", async ({ page }) => {
    await fakeChain(page, { shares: 900_000_000n, worth: 900_000_000n, idle: 5_500_000n });
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#idle")).toHaveText("5.50");
    await page.locator("#withdrawMax").click();
    await expect(page.locator("#withdrawAmount")).toHaveValue("5.5");
    await page.locator("#withdraw").click();
    await expect.poll(async () => (await sent(page)).length, { timeout: 15000 }).toBe(1);
    expect((await sent(page))[0].data).toBe("0xb460af94" + word(5_500_000n) + addr(ACCOUNT) + addr(ACCOUNT));
  });

  test("redeem all explains itself instead of sending when the vault cannot pay it", async ({ page }) => {
    await fakeChain(page, { shares: 900_000_000n, worth: 900_000_000n, idle: 5_000_000n });
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#allPreview")).toContainText(/only 5\.00 of that is available now/i);
    await page.locator("#withdrawAll").click();
    // The sentence names the exact amount, not a rounded one: the number shown has to be
    // the number the vault would be asked for.
    await expect(page.locator("#status")).toContainText(/needs 900 tUSDC and 5 is available now/i);
    await expect(page.locator("#withdrawAll")).toHaveText(/redeem all shares/i);
    await page.locator("#withdrawAll").click();
    expect(await sent(page)).toHaveLength(0);
  });

  test("redeem all asks twice and shows what it will do", async ({ page }) => {
    await fakeChain(page, { shares: 100_000_000n, worth: 100_000_000n, idle: 1_000_000_000n });
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#worth")).toHaveText("100.00");
    await expect(page.locator("#allPreview")).toContainText(/≈ .* tUSDC for .* shares/);
    await expect(page.locator("#withdrawAll")).toBeEnabled();
    await page.locator("#withdrawAll").click();
    await expect(page.locator("#withdrawAll")).toHaveText(/confirm: redeem 100 shares for ≈ 100 tUSDC/i);
    expect(await sent(page)).toHaveLength(0);
    await page.waitForTimeout(750);
    await page.locator("#withdrawAll").click();
    await expect.poll(async () => (await sent(page)).length, { timeout: 15000 }).toBe(1);
    expect((await sent(page))[0].data).toBe("0xba087652" + word(100_000_000n) + addr(ACCOUNT) + addr(ACCOUNT));
  });

  // 150ms apart is a slipped mouse, not a decision to empty an account.
  test("a double-click does not redeem everything", async ({ page }) => {
    await fakeChain(page, { idle: 1_000_000_000n });
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#worth")).toHaveText("100.00");
    await page.locator("#withdrawAll").dblclick();
    expect(await sent(page)).toHaveLength(0);
    await expect(page.locator("#withdrawAll")).toHaveText(/confirm: redeem/i);
    // The confirmation is still armed, so a deliberate press still works.
    await page.waitForTimeout(750);
    await page.locator("#withdrawAll").click();
    await expect.poll(async () => (await sent(page)).length, { timeout: 15000 }).toBe(1);
  });

  // The label is a promise about a number. A refresh between the two presses must not
  // turn "redeem 100 shares" into a transaction for 500.
  test("the confirmation sends the share count it showed", async ({ page }) => {
    const chain = await fakeChain(page, { shares: 100_000_000n, worth: 100_000_000n, idle: 1_000_000_000n });
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#shares")).toHaveText("100.00");
    await page.locator("#withdrawAll").click();
    await expect(page.locator("#withdrawAll")).toHaveText(/redeem 100 shares/i);

    chain.shares = 500_000_000n;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("#shares")).toHaveText("500.00");

    await page.waitForTimeout(750); // past the double-click guard, inside the five seconds
    await page.locator("#withdrawAll").click();
    await expect.poll(async () => (await sent(page)).length, { timeout: 15000 }).toBe(1);
    expect((await sent(page))[0].data).toBe("0xba087652" + word(100_000_000n) + addr(ACCOUNT) + addr(ACCOUNT));
  });

  test("the status line shows every decimal of the amount it is sending", async ({ page }) => {
    await fakeChain(page, { usdc: 500_000_000n, allowance: 0n });
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    const vault = await page.evaluate(() => (window as any).ABADI.vault as string);
    await page.locator("#connect").click();
    await expect(page.locator("#usdc")).toHaveText("500.00");
    await page.locator("#amount").fill("100.123456");
    await page.locator("#deposit").click();
    await expect.poll(async () => (await sent(page)).length, { timeout: 15000 }).toBe(2);
    const [approve, deposit] = await sent(page);
    expect(approve.data).toBe("0x095ea7b3" + addr(vault) + word(100_123_456n));
    expect(deposit.data).toBe("0x6e553f65" + word(100_123_456n) + addr(ACCOUNT));
    // What it said it was sending is what it sent, to the last decimal — never 100.12.
    await expect(page.locator("#log")).toContainText(/approve 100\.123456 tUSDC for the vault/i);
    await expect(page.locator("#log")).toContainText(/deposit 100\.123456 tUSDC/i);
    await expect(page.locator("#log")).not.toContainText(/100\.12 tUSDC/);
  });

  test("a revert is reported with the reason the chain gave", async ({ page }) => {
    await fakeChain(page, { receipt: "0x0", revert: "0x71ca2b95" + word(3n) }); // LastShareWhileOpen(3)
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#worth")).toHaveText("100.00");
    await page.locator("#withdrawAmount").fill("10");
    await page.locator("#withdraw").click();
    await expect(page.locator("#status")).toContainText(/reverted/i);
    await expect(page.locator("#status")).toContainText(/last share and slot 3 is still open/i);
  });

  test("stale numbers are struck through and dated, not served as fresh", async ({ page }) => {
    const chain = await fakeChain(page);
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#nav")).toHaveText("1,000.00");
    await expect(page.locator("#app")).toHaveAttribute("data-stale", "false");

    chain.down = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("#app")).toHaveAttribute("data-stale", "true");
    await expect(page.locator("#freshness")).toHaveText(/stale — last read at \d\d:\d\d:\d\d UTC/);
    await expect(page.locator("#status")).toContainText(/could not read the chain/i);
    // The number is still there — it was true once — and it is visibly not current.
    await expect(page.locator("#nav")).toHaveText("1,000.00");
    await expect(page.locator(".grid dd:has(#nav)")).toHaveCSS("text-decoration-line", "line-through");
  });

  test("an empty amount is refused before anything is sent", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#deposit")).toBeEnabled();
    await page.locator("#deposit").click();
    await expect(page.locator("#status")).toContainText(/enter an amount/i);
    expect(await sent(page)).toHaveLength(0);
  });
});

test.describe("a wallet that adds the chain but does not switch to it", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(STUCK_PROVIDER);
  });

  test("is never treated as connected, and nothing is sent", async ({ page }) => {
    await fakeChain(page);
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    await page.locator("#connect").click();
    await expect(page.locator("#status")).toContainText(/still on chain 0x1/i);
    await expect(page.locator("#network")).toContainText(/wrong network/i);
    await expect(page.locator("#connect")).toHaveText(/switch network/i);
    await expect(page.locator("#deposit")).toBeDisabled();
    await expect(page.locator("#withdraw")).toBeDisabled();
    expect(await sent(page)).toHaveLength(0);
  });
});

/**
 * The revert table is only useful if its four bytes are the compiler's four bytes.
 * One transposed hex digit and every failure reads "an error this page cannot name",
 * which is exactly the state this table exists to end — so the selectors are recomputed
 * here from the signatures in src/LiquidityVault.sol and OpenZeppelin's ERC20.
 */
const ERRORS = [
  "LastShareWhileOpen(uint256)",
  "SlotOutOfRange(uint256)",
  "SlotIdle(uint256)",
  "NotOperator(address)",
  "OrderRejected(uint8)",
  "InsufficientIdle(uint256,uint256)",
  "MarketNotTrading(bytes32,uint8)",
  "ERC20InsufficientBalance(address,uint256,uint256)",
  "ERC20InsufficientAllowance(address,uint256,uint256)",
  // The vault caps maxWithdraw/maxRedeem, so OpenZeppelin refuses at the max check
  // before the transfer — these two are the likeliest reverts this page will meet.
  "ERC4626ExceededMaxWithdraw(address,uint256,uint256)",
  "ERC4626ExceededMaxRedeem(address,uint256,uint256)",
  "Error(string)",
  "Panic(uint256)",
];

test.describe("revert decoding", () => {
  test("every selector in the table is keccak of the signature it claims", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    const table = await page.evaluate(() => Object.keys((window as any).ABADI_APP.REVERTS));
    for (const sig of ERRORS) expect(table).toContain(toFunctionSelector("function " + sig));
    expect(table).toHaveLength(ERRORS.length);
  });

  test("turns revert bytes into a sentence with the numbers in it", async ({ page }) => {
    await page.goto(BASE + "/app", { waitUntil: "networkidle" });
    const say = (hex: string) => page.evaluate((h) => (window as any).ABADI_APP.revertReason(h) as string, hex);
    // ERC20InsufficientBalance(vault, 5.00, 50.00) — the shape a withdrawal above idle takes.
    expect(await say("0xe450d38c" + addr(USDC) + word(5_000_000n) + word(50_000_000n)))
      .toMatch(/holds 5\.00 and 50\.00 is needed/);
    expect(await say("0x08c379a0" + word(32n) + word(5n) + Buffer.from("hello").toString("hex").padEnd(64, "0")))
      .toBe("hello");
    expect(await say("0xdeadbeef")).toMatch(/cannot name \(0xdeadbeef\)/);
    expect(await say("0x")).toBe(null);
  });
});
