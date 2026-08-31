/**
 * Abadi bot. The requote loop the README kept calling "what comes next".
 *
 * Every cycle it does, in order, the things a human operator did by hand on the 27th:
 *
 *   1. settle    any slot whose market has resolved — permissionless, proceeds to the vault
 *   2. free      any slot whose market has expired but not resolved: poke the oracle
 *                while it still has time, and once that time is up void the window
 *                through the market's own escape hatch, then finalize and settle — so
 *                capital never waits on an oracle that went quiet
 *   3. flatten   any slot holding a complete set under a quote the book has walked away
 *                from — the set is worth exactly its size at any price, so leaving it
 *                parked until expiry earns nothing
 *   4. quote     an idle slot on the best window it can price inside, and arm the
 *                vault to wake itself at that window's expiry — so the chain closes the
 *                position even if this process is dead by then
 *
 * This key can only steer quotes. Custody lives in the vault.
 *
 * Run:  node scripts/bot.ts
 * Env:  INTERVAL=30     seconds between cycles
 *       CYCLES=0        stop after N cycles (0 = run until killed)
 *       ACTIVE=3        how many slots to keep quoted at once, one market each
 *       SIZE=100        contracts per side per quote
 *       DEAD_TICKS=6    ticks the book may move before a resting quote is called dead:
 *                       an unfilled dead quote is pulled and requoted, a filled one is
 *                       flattened if it completed
 *       GAS_FLOOR=0.5   stop quoting when the operator key holds less STT than this
 *       SHORTEST=1      prefer the fastest tiers (default: slowest)
 *       MOMENTUM_TICKS=3  a window whose mid moved this many ticks during the sample is
 *                       trending; it is not quoted this cycle. Every adverse fill in
 *                       the ledger came from a trending hour: the market took one leg
 *                       and walked away from the other. A maker's spread pays for
 *                       being wrong sometimes, not for standing in front of a move.
 *       MOMENTUM_WAIT=20  seconds between the two book samples
 *       SHORT_SIZE=0.5  size multiplier on the 900s tier, where a move is most of the window
 *       TIERS=14400,900 window lengths this bot will quote, seconds, in preference order.
 *                       This replaces a ceiling with an allowlist, because the ceiling was
 *                       excluding the wrong tier. Measured over 95 episodes:
 *
 *                         4h    7% adverse over 28 fills   EV +0.44 per filled quote
 *                         15m   0% over 6                  no signal either way
 *                         1h   36% over 36 fills           EV -6.70
 *                         24h  25% over 8                  EV -3.96
 *
 *                       A complete set earns about 2.19 and an adverse fill costs about
 *                       22, so the strategy breaks even near 9% adverse. Only 4h clears
 *                       that, and only just — its own confidence interval reaches 22.6%.
 *                       1h is the tier with the most fills AND the worst rate, and it was
 *                       being quoted at three-quarter size because the ladder keyed on
 *                       duration rather than on anything measured.
 *
 *                       Worse, SHORTEST=1 sorted ascending, aiming at 15m — which the
 *                       headroom rule makes eligible only in the first 300s of its life,
 *                       so it usually missed and landed on 1h. The bot was steering into
 *                       its worst tier by accident.
 *       MAX_TIER=14400  ceiling, kept so an operator can still cap by duration alone. The
 *                       ledger by tier: 15m and 4h
 *                       windows 0% adverse, 1h 19%, 24h 25% — a quote resting for a day
 *                       is a quote standing in front of every move that day
 *       FAIR_VALUE=     set to opt in to the vault's own opinion of fair value. Off by
 *                       default, and off is exactly today's behaviour. On, every candidate
 *                       is priced from the venue's price feed as the digital option it is
 *                       (scripts/lib/fairvalue.ts) before the book is allowed to decide
 *                       anything. If the feed is unreachable, stale or short of candles the
 *                       bot says so in the log and quotes on the book alone — it never
 *                       quotes on a model built from stale inputs.
 *       FV_MAX_EDGE=0.10  refuse the window when |book mid - fair probability| exceeds this.
 *                       One of the two of us is wrong and a 2-tick spread does not pay for
 *                       finding out which.
 *       FV_SKEW_TICKS=3   how far the quote's mid may be moved off the incumbent's toward
 *                       fair value. Bounded on purpose: a bad model must not be able to
 *                       walk the quote somewhere silly. minHalfSpread and the venue's
 *                       tick/lot grid are untouched.
 *       EDGE=0.08       do not quote a window priced under EDGE or over 1-EDGE: the spread
 *                       there is a few ticks wide, one leg is nearly free and the other
 *                       is nearly the whole dollar, and the only thing that can happen
 *                       to the expensive leg is the tail event
 *       ALERT_WEBHOOK=  optional URL that gets a short JSON POST for the five conditions
 *                       in alert(). Absent means log-only; a webhook that is down or
 *                       wrong never stops a cycle
 *       STUCK_MINS=30   how long the void hatch may stand open and refused before the
 *                       stuck window is paged rather than merely logged
 *
 * Exit code is 1 if anything alerted, so the keeper that runs this is red when the vault
 * needs a human and green when it genuinely had nothing to do. The two days this vault
 * spent frozen were two days of exit-0 runs.
 */
import { createPublicClient, createWalletClient, formatEther, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { shannon, addresses, RPC, OUTCOME_TOKEN, env, exchange, retry } from "./lib/somnia.ts";
import { candidates, hasHeadroom, priceInside, ticksAway, toWei, fmt } from "./lib/quoting.ts";
import { fairProbability, fmtFair, type FairValue } from "./lib/fairvalue.ts";

/** Every vault this project has deployed. Redeploys leave positions behind; see sweepOld. */
const OLD_VAULTS: { address: `0x${string}`; dead_slots?: number[] }[] = JSON.parse(
  readFileSync(new URL("./lib/vaults.json", import.meta.url), "utf8"),
);

const VAULT_ABI = parseAbi([
  "function quote(uint256 slot, bytes32 marketId, uint256 mid, uint256 halfSpread, uint256 size)",
  "function cancelQuote(uint256 slot)",
  "function flatten(uint256 slot) returns (uint256)",
  "function settle(uint256 slot) returns (uint256)",
  "function idleAssets() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalEscrowed() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function minHalfSpread() view returns (uint256)",
  "function MAX_SLOTS() view returns (uint256)",
  "function slots(uint256) view returns ((bytes32 marketId,address pool,uint128 yesOrderId,uint128 noOrderId,uint256 basis,uint256 size,uint256 bidPrice,uint256 askPrice,uint256 yesId,uint256 noId,bool active))",
  "function armSweep(uint64 firesAtSec) returns (uint256)",
  "function armed(uint256 firesAtMillis) view returns (uint256)",
  "function MIN_HANDLER_BALANCE() view returns (uint256)",
  "function SWEEP_GAS() view returns (uint64)",
  "function sweepNative(address to, uint256 amount)",
  "function governor() view returns (address)",
]);
const MODULE_ABI = parseAbi([
  "function markets(bytes32) view returns (uint256,uint8,uint8,address,uint32,bytes32,address,address,address,address,uint256,uint256,uint64,uint64)",
  "function finalizeMarket(bytes32 marketId)",
  "function pokeOracle(uint256 oracleQuestionId)",
  // voidExpired flips the market straight to Voided, so the oracle adapter's onResolved
  // never fires and the hub's earmark is never released. syncSettlement is the
  // permissionless nudge that does it, and finalizeMarket then moves the pool's backing
  // into settlement. Without both, `settle` finds nothing to redeem.
  "function syncSettlement(bytes32 marketId)",
]);
const MARKET_ABI = parseAbi([
  "function isResolved() view returns (bool)",
  "function isVoided() view returns (bool)",
  // Seconds after expiry the oracle still has to answer. `expiry + settlementWindow` is
  // the instant voidExpired() opens.
  "function settlementWindow() view returns (uint64)",
  "function voidExpired()",
]);
const ERC6909_ABI = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);

const TRADING = 1;

const INTERVAL = Number(process.env.INTERVAL ?? 30);
const CYCLES = Number(process.env.CYCLES ?? 0);
const ACTIVE = Number(process.env.ACTIVE ?? 3);
const QTY = BigInt(Math.round(Number(process.env.SIZE ?? 100) * 1e6));
const DEAD_TICKS = BigInt(process.env.DEAD_TICKS ?? 6);
const GAS_FLOOR = Number(process.env.GAS_FLOOR ?? 0.5);
const SHORTEST = !!process.env.SHORTEST;
const MOMENTUM_TICKS = BigInt(process.env.MOMENTUM_TICKS ?? 3);
const MOMENTUM_WAIT = Number(process.env.MOMENTUM_WAIT ?? 20);
const SHORT_SIZE = Number(process.env.SHORT_SIZE ?? 0.5);
const EDGE = Number(process.env.EDGE ?? 0.08);
const FAIR_VALUE = !!process.env.FAIR_VALUE;
const FV_MAX_EDGE = Number(process.env.FV_MAX_EDGE ?? 0.1);
const FV_SKEW_TICKS = BigInt(process.env.FV_SKEW_TICKS ?? 3);
const MAX_TIER = Number(process.env.MAX_TIER ?? 14400);
/** Window lengths worth quoting, best first. Empty disables the allowlist. */
const TIERS = (process.env.TIERS ?? "14400,900").split(",").map(Number).filter((n) => n > 0);
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK;
const STUCK_MINS = Number(process.env.STUCK_MINS ?? 30);
const STUCK_CYCLES = Number(process.env.STUCK_CYCLES ?? 2);
/**
 * Only used when the on-chain SWEEP_GAS read fails; see handlerHealth. The live vault
 * answers 8,000,000 and src/LiquidityVault.sol now declares 16,000,000, so this takes
 * the larger of the two on purpose: a fallback that under-states the worst case is a
 * headroom check that says "fine" on the cycle it should have said "fund me".
 */
const SWEEP_GAS_FALLBACK = 16_000_000n;

/** Contracts per side for a window: smaller where a move eats most of the window. */
function sizeFor(intervalSec: number): bigint {
  const mult = intervalSec <= 900 ? SHORT_SIZE : intervalSec <= 3600 ? (1 + SHORT_SIZE) / 2 : 1;
  const lots = (QTY * BigInt(Math.round(mult * 100))) / 100n;
  return (lots / 1_000n) * 1_000n; // on the venue's lot grid
}

const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2);

/** How many cycles a market has refused the dead-oracle hatch. Escalates the log line. */
const stuck = new Map<string, number>();
// Dated, because the local keeper appends every run to one file and 1,700 lines of
// bare HH:MM:SS with no day boundary in them cannot be read as evidence of anything.
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a: unknown[]) => console.log(ts(), ...a);

const vault = readFileSync(".vault-addr", "utf8").trim() as `0x${string}`;
// process.env first so the GitHub keeper can pass the key through the step's env: and
// never write it to a .env file in the workspace. env() is the local .env fallback.
const account = privateKeyToAccount((process.env.PRIVATE_KEY ?? env().PRIVATE_KEY) as `0x${string}`);
const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: shannon, transport: http(RPC) });
const ex = exchange();

const read = <T>(fn: string, args: unknown[] = []) =>
  pub.readContract({ address: vault, abi: VAULT_ABI, functionName: fn as never, args: args as never }) as Promise<T>;

/**
 * Page a human. Only the conditions a human has to act on reach here: capital that
 * cannot get out, arming about to die of a low balance, an operator that cannot pay for
 * gas, and a cycle that threw. A skipped quote is not one of them — a vault declining to
 * trade a trending or near-certain window is the vault working, and an alert that fires
 * on ordinary work is an alert nobody reads by the second day.
 *
 * The webhook is optional and its failure is never fatal. The two days this vault spent
 * frozen were lost to silence; a bot that died because a Slack URL went stale would be
 * the same bug wearing a better hat. Log first, POST second, keep going either way.
 *
 * One page per subject per run. The keeper runs one cycle per process, so that is one
 * page per subject per fifteen minutes — enough to notice, not enough to tune out.
 */
const alerted = new Set<string>();
let paged = 0;
async function alert(key: string, text: string) {
  if (alerted.has(key)) return;
  alerted.add(key);
  paged++;
  log(`ALERT    ${key}  ${text}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=abadi ${key}::${text}`);
  if (!ALERT_WEBHOOK) return;
  try {
    const r = await fetch(ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `text` so Slack/Discord render it as-is; the rest so a real sink can route on it.
      body: JSON.stringify({ text: `abadi ${key}: ${text}`, key, detail: text, vault, operator: account.address, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000), // a black-holed URL must not eat the cycle
    });
    if (!r.ok) log(`alert    webhook answered ${r.status}; the ALERT line above is the only record`);
  } catch (e: any) {
    log(`alert    webhook unreachable: ${(e?.message ?? String(e)).split("\n")[0]}; the ALERT line above is the only record`);
  }
}

/** Sends that failed this run, by label. Cleared on the first one that works. */
const fails = new Map<string, number>();

/**
 * One transaction. `verify` is what makes the return value mean anything: `r.status` is
 * "the EVM did not revert" and nothing more, and 238 pokeOracle transactions have gone
 * out under a `success` that resolved exactly nothing. Where a call has an observable
 * effect, pass a read that looks for it — the log then separates `sent` from `worked`,
 * and every caller's boolean is about the effect instead of the receipt.
 */
async function send(
  label: string,
  fn: string,
  args: unknown[],
  to = vault,
  abi: any = VAULT_ABI,
  verify?: () => Promise<boolean>,
) {
  let why: string;
  try {
    const hash = await wallet.writeContract({ address: to, abi, functionName: fn as never, args: args as never });
    const r = await pub.waitForTransactionReceipt({ hash });
    const stamp = `${hash}  gas ${r.gasUsed}`;
    if (r.status !== "success") {
      why = "reverted on chain";
      log(`${label}  REVERTED  ${stamp}`);
    } else if (!verify) {
      log(`${label}  sent  ${stamp}`);
      fails.delete(label);
      return true;
    } else if (await verify().catch(() => false)) {
      log(`${label}  worked  ${stamp}`);
      fails.delete(label);
      return true;
    } else {
      why = `sent, no effect (${hash})`;
      log(`${label}  NO-OP  ${stamp}  — accepted by the EVM, and the state it exists to change did not change`);
    }
  } catch (e: any) {
    why = (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0];
    log(`${label}  rejected: ${why}`);
  }
  const n = (fails.get(label) ?? 0) + 1;
  fails.set(label, n);
  // settle and flatten are only ever attempted on a position that should already be
  // exitable, so either one failing is money that did not come back — page on the first
  // one. A threshold of two would never be reached anyway: the keeper runs one cycle per
  // process, so the count belongs in the message, not in the trigger. `void` is louder
  // at its call sites, which know how long the hatch has been open and how much is
  // behind it, and pages from there instead.
  if (/^(settle|flatten)/.test(label)) await alert(`exit:${label.trim()}`, `${label.trim()} failed ${n}x this run — ${why}`);
  return false;
}

/** Whether a vault slot still holds a position. The observable effect of every exit. */
const slotActive = (addr: `0x${string}`, i: number) =>
  pub
    .readContract({ address: addr, abi: VAULT_ABI, functionName: "slots", args: [BigInt(i)] })
    .then((s: any) => !!s.active);

/** Anything the venue has done to a market since we quoted it, in one read. */
async function marketState(marketId: `0x${string}`) {
  const rec: any = await pub.readContract({
    address: addresses.binaryModule as `0x${string}`, abi: MODULE_ABI, functionName: "markets", args: [marketId],
  });
  // Status is derived from the clock exactly as the vault derives it. The record's own
  // byte at [1] is not a status and reading it as one made the bot try to finalize a
  // market with eight hours still to run.
  const market = rec[8] as `0x${string}`;
  const questionId = rec[0] as bigint;
  const tradingStart = Number(rec[12]);
  const expiry = Number(rec[13]);
  const now = Date.now() / 1000;
  const status = now < tradingStart ? 0 : now >= expiry ? 2 : TRADING;
  const [resolved, voided] = await Promise.all([
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: "isResolved" }),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: "isVoided" }),
  ]);
  return { status, market, expiry, questionId, resolved: resolved as boolean, voided: voided as boolean };
}

/** Seconds the oracle gets after expiry before `voidExpired` opens. Fixed per market. */
const windowCache = new Map<string, bigint>();
async function settlementWindow(market: `0x${string}`) {
  let w = windowCache.get(market);
  if (w === undefined) {
    w = (await pub.readContract({ address: market, abi: MARKET_ABI, functionName: "settlementWindow" })) as bigint;
    windowCache.set(market, w);
  }
  return w;
}

async function held(yesId: bigint, noId: bigint) {
  const [yes, no] = await Promise.all(
    [yesId, noId].map((id) =>
      pub.readContract({ address: OUTCOME_TOKEN as `0x${string}`, abi: ERC6909_ABI, functionName: "balanceOf", args: [vault, id] }),
    ),
  );
  return { yes: yes as bigint, no: no as bigint };
}

/**
 * The vault pays for its own wake-up call out of its own STT, and the precompile refuses
 * to arm at all below MIN_HANDLER_BALANCE. A worst-case callback costs SWEEP_GAS at the
 * arm's 25 gwei fee cap, so a vault holding less than floor + that much is one sweep away
 * from never arming again — and the only thing that would have said so used to be a line
 * printed after the balance had already gone under.
 *
 * Read once a cycle rather than only when a quote happens to be placed: a cycle with
 * every slot busy never reaches armAt, and that is exactly the cycle where nothing warns.
 */
async function handlerHealth() {
  const [bal, floor, gas] = await Promise.all([
    pub.getBalance({ address: vault }),
    read<bigint>("MIN_HANDLER_BALANCE"),
    read<bigint>("SWEEP_GAS").catch(() => 0n),
  ]);
  // A failed SWEEP_GAS read used to switch the headroom check off for the cycle, which
  // made one bad RPC answer look exactly like a healthy vault. Fall back to the deployed
  // constant and say so; the check is never allowed to go quiet.
  if (gas === 0n) log(`arm      note: SWEEP_GAS unreadable, using the deployed ${SWEEP_GAS_FALLBACK} for the headroom check`);
  // Must track LiquidityVault.armSweep's maxFeePerGas. It was halved from 50 to 25 gwei
  // so a worst-case sweep costs 0.4 STT rather than 0.8 against ~0.81 of live headroom —
  // an alarm that fires on every single run is one nobody reads. NOTE: the DEPLOYED vault
  // still arms at 50 gwei; this is deliberately the post-redeploy figure, because
  // understating the worst case is the direction that goes quiet when it should not.
  const worst = (gas === 0n ? SWEEP_GAS_FALLBACK : gas) * 25_000_000_000n;
  if (bal < floor) {
    await alert("handler-balance", `vault holds ${formatEther(bal)} STT, under the ${formatEther(floor)} STT floor: it can no longer arm, and the chain will not close these windows by itself`);
  } else if (bal - floor < worst) {
    await alert("handler-balance", `vault headroom is ${formatEther(bal - floor)} STT and one worst-case callback costs ${formatEther(worst)} STT: the next sweep can end arming for good`);
  }
  return { bal, floor };
}

/**
 * Ask the chain to wake the vault shortly after a window expires. Skipped, and said so,
 * when the vault is under the precompile's 32 STT floor — the bot's own settle step
 * still covers the slot, it just needs the bot to be alive for it.
 */
async function armAt(firesAtSec: number) {
  const ms = BigInt(firesAtSec) * 1000n;
  const at = new Date(firesAtSec * 1000).toISOString().slice(11, 19);
  // Every window in a tier expires on the same second, so the second slot quoted into a
  // tier finds the instant already armed. That is correct — one callback loops every
  // slot — but it used to return in silence, and a slot that was never armed at all
  // looked exactly the same in the log.
  if ((await read<bigint>("armed", [ms])) !== 0n) {
    log(`arm      ${at}Z  already armed; one callback covers every slot`);
    return true;
  }
  const { bal, floor } = await handlerHealth();
  if (bal < floor) {
    log(`arm      SKIPPED, VAULT UNARMED: holds ${formatEther(bal)} STT, floor is ${formatEther(floor)}.`);
    log(`         Send it STT or the chain will not close these windows by itself.`);
    return false;
  }
  // armed() is the effect: a receipt only says the precompile took the call.
  return await send(`arm      ${at}Z`, "armSweep", [BigInt(firesAtSec)], vault, VAULT_ABI, async () =>
    (await read<bigint>("armed", [ms])) !== 0n,
  );
}

/**
 * Positions do not follow a redeploy. Every earlier vault that still has an active slot
 * on a resolved market gets settled here — settle is permissionless and pays the vault,
 * so this costs the operator nothing but gas and leaves nothing stranded that the code
 * can reach. What cannot be reached (v1, v2 slot 1) is listed in the ledger as such.
 */
async function sweepOld() {
  for (const v of OLD_VAULTS) {
    if (v.address.toLowerCase() === vault.toLowerCase()) continue;
    let maxSlots: number;
    try { maxSlots = Number(await pub.readContract({ address: v.address, abi: VAULT_ABI, functionName: "MAX_SLOTS" })); } catch { continue; }
    for (let i = 0; i < maxSlots; i++) {
      // Slots the ledger already lists as unrecoverable: every exit reverts on that
      // build, and trying again each cycle only puts a rejected line in the log.
      if ((v.dead_slots ?? []).includes(i)) continue;
      const s: any = await pub.readContract({ address: v.address, abi: VAULT_ABI, functionName: "slots", args: [BigInt(i)] }).catch(() => null);
      if (!s?.active) continue;
      const m = await marketState(s.marketId).catch(() => null);
      if (!m) continue;
      const tag = `old ${v.address.slice(0, 8)} slot ${i}`;
      if (!(m.resolved || m.voided)) {
        // An old vault holding an expired window whose oracle never answered used to be
        // skipped here in complete silence — no settle, no log line, nothing. The hatch
        // is permissionless and works on any vault's position, not just the live one.
        if (m.expiry > Date.now() / 1000) continue; // still trading; leave it be
        // Guarded: this is the only await in sweepOld that could throw, and main() wraps
        // sweepOld and cycle in ONE try — so a retired vault holding a market that will
        // not answer `settlementWindow` would skip the whole live cycle, every cycle.
        // A retired vault must never be able to stop the current one from trading.
        const w = await settlementWindow(m.market).catch(() => null);
        if (w === null) continue;
        const gate = m.expiry + Number(w);
        if (Date.now() / 1000 < gate) continue; // the oracle still has time
        const voided = () => pub.readContract({ address: m.market, abi: MARKET_ABI, functionName: "isVoided" }) as Promise<boolean>;
        if (!(await send(`void     ${tag}`, "voidExpired", [], m.market, MARKET_ABI, voided))) {
          const mins = Math.round((Date.now() / 1000 - gate) / 60);
          await alert(`stuck:${v.address}:${i}`, `${tag}: hatch open ${mins} min and voidExpired will not take, ${usd(s.basis)} still behind it on a retired vault`);
          continue;
        }
        await send(`sync     ${tag}`, "syncSettlement", [s.marketId], addresses.binaryModule as `0x${string}`, MODULE_ABI);
        await send(`final    ${tag}`, "finalizeMarket", [s.marketId], addresses.binaryModule as `0x${string}`, MODULE_ABI);
      }
      await send(`settle   ${tag}`, "settle", [BigInt(i)], v.address, VAULT_ABI, async () => !(await slotActive(v.address, i)));
    }
    await reclaimNative(v.address, maxSlots);
  }
}

/**
 * A retired vault's reactivity reserve does not follow the redeploy either, and unlike a
 * position nothing ever comes looking for it. Each deployment holds 32 STT so its handler
 * can be armed at all, and after the 2026-08-31 redeploy the operator was down to 10 STT
 * of gas with 32.80 sitting in the vault it had just left. That is nine days of runway
 * parked next to twenty-nine.
 *
 * So it comes back, but only once the vault has nothing left to wake up for: every slot
 * closed, or the reserve is exactly what the last settle needs. `sweepNative` is
 * governor-only and this key is the governor on every vault it deployed; a vault whose
 * governor is someone else is skipped rather than attempted.
 */
async function reclaimNative(address: `0x${string}`, maxSlots: number) {
  const held = await pub.getBalance({ address });
  if (held === 0n) return;
  for (let i = 0; i < maxSlots; i++) if (await slotActive(address, i)) return;
  const gov = await pub
    .readContract({ address, abi: VAULT_ABI, functionName: "governor" })
    .catch(() => null);
  if (!gov || (gov as string).toLowerCase() !== account.address.toLowerCase()) return;
  await send(
    `reclaim  old ${address.slice(0, 8)} ${formatEther(held)} STT, no slot left open`,
    "sweepNative",
    [account.address, held],
    address,
    VAULT_ABI,
    async () => (await pub.getBalance({ address })) === 0n,
  );
}

async function cycle(n: number, bySymbol: Map<string, any>) {
  const maxSlots = Number(await read<bigint>("MAX_SLOTS"));
  const quotedMarkets = new Set<string>();
  let active = 0;

  // ---- exits first: every one of these frees capital the quote step can use
  for (let i = 0; i < maxSlots; i++) {
    const s = await read<any>("slots", [BigInt(i)]);
    if (!s.active) continue;
    active++;
    quotedMarkets.add(String(s.marketId).toLowerCase());
    const m = await marketState(s.marketId);
    const tag = `slot ${i} ${String(s.marketId).slice(-4)}`;
    // Every exit below is judged by this, not by a receipt: the slot let go of the
    // position, or it did not and the capital is still parked.
    const closed = async () => !(await slotActive(vault, i));

    if (m.resolved || m.voided) {
      if (await send(`settle   ${tag}`, "settle", [BigInt(i)], vault, VAULT_ABI, closed)) active--;
      continue;
    }
    if (m.status !== TRADING || m.expiry <= Date.now() / 1000) {
      // Expired and not resolved. There is no cancel here: past expiry the pool refuses
      // every write to its book — cancelOrder, cancelOrders, cancelExpiredOrders and
      // sweepExpiredAtLevel all revert 0x8afbce93, an error the SDK's generated table
      // cannot name (SDK feedback #15). The previous version of this branch called
      // cancelQuote anyway and logged its rejection every fifteen minutes for two days
      // while 196 of escrow sat behind it. Escrow on an expired window comes back one
      // way only: the market becomes terminal, and settle redeems.
      //
      // pokeOracle is the permissionless retry and the first thing to try, but it is a
      // nudge, not a guarantee — it resolved nothing on those two windows in two days
      // (SDK feedback #14). The market itself carries the escape hatch: once
      // `expiry + settlementWindow` has passed, voidExpired() flips it Voided without
      // the oracle and every holder is made whole at what they put in. Below that gate,
      // poke and wait; above it, stop poking and take the hatch.
      const win = await settlementWindow(m.market).catch(() => null);
      if (win === null) {
        log(`poke     ${tag}  cannot read settlementWindow; leaving this slot for the next cycle`);
        continue;
      }
      const gate = m.expiry + Number(win);
      if (Date.now() / 1000 < gate) {
        // The whole point of a poke is that the market becomes terminal, so that is what
        // gets checked. Before the gate a poke that changes nothing is normal — the
        // oracle still has time — so this logs NO-OP and does not page. What it does buy
        // is a countable record: 238 of these went out reading `success` while two
        // windows sat frozen, and nothing in the log could tell the two apart.
        const terminal = async () => { const x = await marketState(s.marketId); return x.resolved || x.voided; };
        await send(`poke     ${tag}`, "pokeOracle", [m.questionId], addresses.binaryModule as `0x${string}`, MODULE_ABI, terminal);
      } else if (await send(`void     ${tag}`, "voidExpired", [], m.market, MARKET_ABI, () => pub.readContract({ address: m.market, abi: MARKET_ABI, functionName: "isVoided" }) as Promise<boolean>)) {
        // Kept from off-chain even though a fork measurement says redemption does not
        // need them: the gas is the operator's here, and belt-and-braces is free. The
        // on-chain sweep deliberately does not pay for these.
        await send(`sync     ${tag}`, "syncSettlement", [s.marketId], addresses.binaryModule as `0x${string}`, MODULE_ABI);
        await send(`final    ${tag}`, "finalizeMarket", [s.marketId], addresses.binaryModule as `0x${string}`, MODULE_ABI);
        if (await send(`settle   ${tag}`, "settle", [BigInt(i)], vault, VAULT_ABI, closed)) active--;
        stuck.delete(String(s.marketId));
      } else {
        // The hatch is open and still refusing. That is the shape that cost two days the
        // last time: a loop that logs the same rejection every cycle and gets quieter the
        // longer it runs, because nobody reads a line they have already read. Count it
        // and escalate, so the log says how long rather than just what.
        const key = String(s.marketId);
        const n = (stuck.get(key) ?? 0) + 1;
        stuck.set(key, n);
        const mins = Math.round((Date.now() / 1000 - gate) / 60);
        log(`STUCK    ${tag}  voidExpired refused ${n}x; hatch open ${mins} min; ${usd(s.basis)} behind it`);
        // The cycle count is the honest measure only when the bot is long-lived. Under
        // the keeper it is one cycle per process, so the counter resets every fifteen
        // minutes and would never reach a threshold — the clock on the hatch is what
        // actually fires here, and it is the same clock that ran for two days.
        if (n >= STUCK_CYCLES || mins >= STUCK_MINS)
          await alert(`stuck:${key}`, `${tag}: hatch open ${mins} min, voidExpired refused ${n}x this run, ${usd(s.basis)} frozen behind it`);
      }
      continue;
    }

    const { yes, no } = await held(s.yesId, s.noId);
    const pairs = yes < no ? yes : no;

    const mkt = bySymbol.get(String(s.marketId).toLowerCase());
    const book: any = mkt ? await ex.fetchOrderBook(mkt.outcomes[0].symbol, 3).catch(() => null) : null;
    const bid = book?.bids?.[0]?.[0], ask = book?.asks?.[0]?.[0];
    if (bid === undefined || ask === undefined) continue;

    const ourMid = (s.bidPrice + s.askPrice) / 2n;
    const away = ticksAway(ourMid, bid, ask);
    if (away < DEAD_TICKS) continue; // still where the market is; leave it to fill

    if (pairs > 0n) {
      log(`slot ${i}: complete set held, book ${away} ticks from our mid — flattening`);
      // Not `closed`: an uneven fill leaves a single-side leg, and the vault deliberately
      // keeps that slot open for settlement. What flatten promises is that the complete
      // set is gone — merged back to collateral — so that is what gets checked, and the
      // slot only stops counting as active if it really did close.
      const merged = async () => { const h = await held(s.yesId, s.noId); return (h.yes < h.no ? h.yes : h.no) === 0n; };
      if ((await send(`flatten  ${tag}`, "flatten", [BigInt(i)], vault, VAULT_ABI, merged)) && (await closed())) active--;
    } else if (yes === 0n && no === 0n) {
      // Nothing filled and nothing will: the book is gone. Pull the escrow back so the
      // quote step can put it where the market actually is.
      log(`slot ${i}: no fills, book ${away} ticks away — pulling the quote`);
      if (await send(`cancel   ${tag}`, "cancelQuote", [BigInt(i)], vault, VAULT_ABI, closed)) {
        active--;
        quotedMarkets.delete(String(s.marketId).toLowerCase());
      }
    }
    // One leg filled and the other stranded: leave it. Cancelling the resting leg gives
    // up the only way the pair can still complete; settlement resolves it either way.
  }

  // ---- then quote into whatever is idle
  if (active >= ACTIVE) return;
  const stt = Number(formatEther(await pub.getBalance({ address: account.address })));
  if (stt < GAS_FLOOR) {
    log(`operator holds ${stt.toFixed(3)} STT, below GAS_FLOOR — not quoting`);
    return;
  }

  let idleLeft = await read<bigint>("idleAssets");
  const minHalf = await read<bigint>("minHalfSpread");
  const all = Object.values(await retry("loadMarkets", () => ex.loadMarkets(true)));
  // The tier choice is a measured one, so say it out loud once a cycle rather than leaving
  // it implied by which markets happen to get quoted.
  if (TIERS.length) log(`tiers    quoting ${TIERS.join("s, ")}s only — 3600s and 86400s are left alone on the ledger's record`);
  const cands = candidates(all, { shortest: SHORTEST })
    .filter(
      (c) =>
        !quotedMarkets.has(c.marketId.toLowerCase()) &&
        hasHeadroom(c) &&
        c.intervalSec <= MAX_TIER &&
        (TIERS.length === 0 || TIERS.includes(c.intervalSec)),
    )
    // Preference order is the allowlist's own order, so the tier with the measured record
    // is tried first and the rest are fallbacks rather than accidents.
    .sort((a, b) => {
      const ia = TIERS.indexOf(a.intervalSec), ib = TIERS.indexOf(b.intervalSec);
      return ia === ib ? 0 : (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  // Two looks at every candidate's book, MOMENTUM_WAIT seconds apart. A mid that moved
  // between them is a window in motion, and the one thing this vault must not do is
  // rest a two-sided quote in front of a move.
  // The indexer answers a book read in a few seconds, so the sample is small and
  // parallel: the first scheduled cycle with this filter read twelve books twice in
  // series and was killed by the scheduler's time limit before it quoted anything.
  const pool = cands.slice(0, 2 * (ACTIVE - active) + 2);
  const t0 = Date.now();
  const firstReads = await Promise.all(pool.map((c) => ex.fetchOrderBook(c.upSymbol, 5).catch(() => null)));
  const first = new Map<string, { bid: number; ask: number }>();
  pool.forEach((c, k) => {
    const b: any = firstReads[k];
    if (b?.bids?.[0]?.[0] !== undefined && b?.asks?.[0]?.[0] !== undefined) first.set(c.marketId, { bid: b.bids[0][0], ask: b.asks[0][0] });
  });
  log(`sampled  ${first.size} books in ${((Date.now() - t0) / 1000).toFixed(1)}s; second look in ${MOMENTUM_WAIT}s`);
  if (first.size > 0 && active < ACTIVE) await new Promise((r) => setTimeout(r, MOMENTUM_WAIT * 1000));
  const secondReads = new Map<string, any>();
  await Promise.all(pool.map((c) => first.has(c.marketId)
    ? ex.fetchOrderBook(c.upSymbol, 5).then((b: any) => secondReads.set(c.marketId, b)).catch(() => null)
    : Promise.resolve()));

  for (let i = 0; i < maxSlots && active < ACTIVE; i++) {
    const s = await read<any>("slots", [BigInt(i)]);
    if (s.active) continue;

    for (const c of pool) {
      if (quotedMarkets.has(c.marketId.toLowerCase())) continue;
      const then = first.get(c.marketId);
      if (!then) continue;
      // No on-chain status read here: headroom already filtered by expiry, and a window
      // that stopped trading in the meantime makes quote() revert, which is caught.
      const book: any = secondReads.get(c.marketId);
      const bid = book?.bids?.[0]?.[0], ask = book?.asks?.[0]?.[0];
      if (bid === undefined || ask === undefined) continue;

      const midNow = (bid + ask) / 2;

      // The vault's own opinion, computed for every candidate and logged whatever else
      // happens to the window — a vault that declines to trade should still say what it
      // thought. Two uses and no more: refuse a window the book and the model disagree
      // about, and lean the quote a bounded few ticks toward the model. A failed read is
      // not a reason to stop trading; it is a reason to say out loud that this quote is
      // the old book-echo and nothing more.
      let fv: FairValue | undefined;
      if (FAIR_VALUE) {
        try {
          fv = await fairProbability(c);
        } catch (e: any) {
          log(`fv       ${c.symbol}  NO MODEL: ${String(e?.message ?? e).split("\n")[0]} — quoting on the book alone`);
        }
        if (fv) {
          const edge = Math.abs(midNow - fv.p);
          log(`fv       ${c.symbol}  ${fmtFair(fv)}  book mid ${midNow.toFixed(3)}  edge ${edge.toFixed(3)}`);
          if (edge > FV_MAX_EDGE) {
            // The old wording here was "one of us is wrong and the spread will not pay
            // for finding out which". 1,276 resolved windows have since said which: past
            // 0.10 of disagreement it is us, on both sides (backtest-2026-08-31.md). The
            // rule survives the finding, its reason does not.
            log(`skip     ${c.symbol}  book mid ${midNow.toFixed(3)} vs fair ${fv.p.toFixed(3)} — ${edge.toFixed(3)} apart, over FV_MAX_EDGE ${FV_MAX_EDGE}; past this much disagreement the backtest says the book is right and we are not`);
            quotedMarkets.add(c.marketId.toLowerCase());
            continue;
          }
        }
      }

      if (midNow < EDGE || midNow > 1 - EDGE) {
        log(`skip     ${c.symbol}  mid ${midNow.toFixed(3)} — priced as near-certain, no two-sided trade here`);
        quotedMarkets.add(c.marketId.toLowerCase());
        continue;
      }
      const moved = ticksAway((toWei(then.bid) + toWei(then.ask)) / 2n, bid, ask);
      if (moved >= MOMENTUM_TICKS) {
        log(`skip     ${c.symbol}  mid moved ${moved} ticks in ${MOMENTUM_WAIT}s — trending, not quoting`);
        quotedMarkets.add(c.marketId.toLowerCase()); // not again this cycle, for any slot
        continue;
      }

      const qty = sizeFor(c.intervalSec);
      const p = priceInside(c, bid, ask, minHalf, qty, fv?.p, FV_SKEW_TICKS);
      if (!p) continue;
      if (p.escrow > idleLeft) continue;

      const lean = p.skew === 0n ? "" : `  skew ${p.skew > 0n ? "+" : ""}${p.skew} ticks toward fair`;
      log(`quote    slot ${i} ${c.symbol}  theirs ${fmt(p.theirBid)}/${fmt(p.theirAsk)}  ours ${fmt(p.bid)}/${fmt(p.ask)}  size ${Number(qty) / 1e6}  escrow ${usd(p.escrow)}  (mid still, ${moved} ticks)${lean}`);
      if (await send(`quote    slot ${i} ${c.marketId.slice(-4)}`, "quote", [BigInt(i), c.marketId, p.mid, p.half, qty], vault, VAULT_ABI, () => slotActive(vault, i))) {
        quotedMarkets.add(c.marketId.toLowerCase());
        idleLeft -= p.escrow;
        active++;
        // Wake the vault AFTER the oracle's window has closed, not 45s after the market's.
        // At expiry + 45 the market is not resolved yet and not yet voidable either, and
        // the pool has already frozen its book, so the sweep arrived with nothing it could
        // do and quietly did nothing. One second past `expiry + settlementWindow` the
        // market is either resolved — settle — or provably abandoned — void, then settle.
        const market = (await marketState(c.marketId)).market;
        await armAt(c.expiry + Number(await settlementWindow(market)) + 15);
        break;
      }
    }
  }
}

async function main() {
  log("vault   ", vault);
  log("operator", account.address);
  log(`interval ${INTERVAL}s  active ${ACTIVE}  size ${Number(QTY) / 1e6} (x${SHORT_SIZE} on 900s)  dead ${DEAD_TICKS} ticks  momentum ${MOMENTUM_TICKS} ticks/${MOMENTUM_WAIT}s  gas floor ${GAS_FLOOR} STT  ${CYCLES ? CYCLES + " cycles" : "until killed"}`);
  log(
    FAIR_VALUE
      ? `fv       ON  refuse over ${FV_MAX_EDGE} of edge, skew up to ${FV_SKEW_TICKS} ticks toward fair; no model means book-only and a log line saying so`
      : `fv       OFF  quoting off the incumbent's book alone (set FAIR_VALUE=1 for the model)`,
  );

  for (let n = 1; !CYCLES || n <= CYCLES; n++) {
    try {
      const all = Object.values(await retry("loadMarkets", () => ex.loadMarkets(true))) as any[];
      const bySymbol = new Map<string, any>();
      for (const m of all) if (m?.info?.marketId) bySymbol.set(String(m.info.marketId).toLowerCase(), m);

      // Before any trading, and unconditionally: the two balances that end this vault
      // quietly. The operator check inside cycle() only runs on the way to a quote, so a
      // cycle with every slot busy never reached it — and a dry operator cannot settle,
      // void or arm either.
      await handlerHealth();
      const opStt = Number(formatEther(await pub.getBalance({ address: account.address })));
      if (opStt < GAS_FLOOR)
        await alert("gas-floor", `operator holds ${opStt.toFixed(3)} STT, under the ${GAS_FLOOR} STT floor: it cannot pay for settle, void or arm`);

      await sweepOld();
      await cycle(n, bySymbol);

      const [nav, idle, resting, supply] = await Promise.all([
        read<bigint>("totalAssets"), read<bigint>("idleAssets"), read<bigint>("totalEscrowed"), read<bigint>("totalSupply"),
      ]);
      const share = supply > 0n ? (Number(nav) / Number(supply)).toFixed(6) : "-";
      log(`cycle ${n}  NAV ${usd(nav)}  idle ${usd(idle)}  resting ${usd(resting)}  share ${share}`);
    } catch (e: any) {
      const msg = (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0];
      log("cycle failed:", msg);
      // Caught so the next cycle still runs, paged so the run is not mistaken for a
      // quiet one. A cycle that threw did none of the settling it exists to do.
      await alert("cycle-failed", `cycle ${n} threw and did no further work this pass: ${msg}`);
    }
    if (CYCLES && n >= CYCLES) break;
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
  if (paged) log(`run ended with ${paged} alert(s) — exiting 1`);
}

// Exit 1 if anything paged. A cycle with nothing to do stays green; a cycle that hit a
// real error or found frozen capital goes red, which is the difference the keeper could
// not express while it was reporting success through the whole incident.
main()
  .then(() => process.exit(paged ? 1 : 0))
  .catch((e: any) => {
    console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
