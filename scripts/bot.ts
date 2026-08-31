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
 *       MAX_TIER=14400  longest window to quote, seconds. The ledger by tier: 15m and 4h
 *                       windows 0% adverse, 1h 19%, 24h 25% — a quote resting for a day
 *                       is a quote standing in front of every move that day
 *       EDGE=0.08       do not quote a window priced under EDGE or over 1-EDGE: the spread
 *                       there is a few ticks wide, one leg is nearly free and the other
 *                       is nearly the whole dollar, and the only thing that can happen
 *                       to the expensive leg is the tail event
 */
import { createPublicClient, createWalletClient, formatEther, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { shannon, addresses, RPC, OUTCOME_TOKEN, env, exchange, retry } from "./lib/somnia.ts";
import { candidates, hasHeadroom, priceInside, ticksAway, toWei, fmt } from "./lib/quoting.ts";

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
const MAX_TIER = Number(process.env.MAX_TIER ?? 14400);

/** Contracts per side for a window: smaller where a move eats most of the window. */
function sizeFor(intervalSec: number): bigint {
  const mult = intervalSec <= 900 ? SHORT_SIZE : intervalSec <= 3600 ? (1 + SHORT_SIZE) / 2 : 1;
  const lots = (QTY * BigInt(Math.round(mult * 100))) / 100n;
  return (lots / 1_000n) * 1_000n; // on the venue's lot grid
}

const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2);

/** How many cycles a market has refused the dead-oracle hatch. Escalates the log line. */
const stuck = new Map<string, number>();
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a: unknown[]) => console.log(ts(), ...a);

const vault = readFileSync(".vault-addr", "utf8").trim() as `0x${string}`;
const account = privateKeyToAccount(env().PRIVATE_KEY as `0x${string}`);
const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: shannon, transport: http(RPC) });
const ex = exchange();

const read = <T>(fn: string, args: unknown[] = []) =>
  pub.readContract({ address: vault, abi: VAULT_ABI, functionName: fn as never, args: args as never }) as Promise<T>;

async function send(label: string, fn: string, args: unknown[], to = vault, abi: any = VAULT_ABI) {
  try {
    const hash = await wallet.writeContract({ address: to, abi, functionName: fn as never, args: args as never });
    const r = await pub.waitForTransactionReceipt({ hash });
    log(`${label}  ${r.status}  ${hash}  gas ${r.gasUsed}`);
    return r.status === "success";
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0];
    log(`${label}  rejected: ${msg}`);
    return false;
  }
}

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
  const [bal, floor, gas] = await Promise.all([
    pub.getBalance({ address: vault }),
    read<bigint>("MIN_HANDLER_BALANCE"),
    read<bigint>("SWEEP_GAS").catch(() => 0n),
  ]);
  if (bal < floor) {
    log(`arm      SKIPPED, VAULT UNARMED: holds ${formatEther(bal)} STT, floor is ${formatEther(floor)}.`);
    log(`         Send it STT or the chain will not close these windows by itself.`);
    return false;
  }
  // The callback is paid out of the vault's own balance. If a worst-case sweep would
  // take it under the floor it can never arm again, and nothing else watches for that.
  const worst = gas * 50_000_000_000n; // SWEEP_GAS at the arm's maxFeePerGas cap
  if (gas === 0n) {
    log(`arm      note: could not read SWEEP_GAS, so the handler-balance check is off this cycle`);
  } else if (bal - floor < worst) {
    log(`arm      WARNING: headroom ${formatEther(bal - floor)} STT is under the ${formatEther(worst)} STT`);
    log(`         a worst-case callback could cost. One bad sweep ends arming for good.`);
  }
  return await send(`arm      ${at}Z`, "armSweep", [BigInt(firesAtSec)]);
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
        if (!(await send(`void     ${tag}`, "voidExpired", [], m.market, MARKET_ABI))) continue;
        await send(`sync     ${tag}`, "syncSettlement", [s.marketId], addresses.binaryModule as `0x${string}`, MODULE_ABI);
        await send(`final    ${tag}`, "finalizeMarket", [s.marketId], addresses.binaryModule as `0x${string}`, MODULE_ABI);
      }
      await send(`settle   ${tag}`, "settle", [BigInt(i)], v.address);
    }
  }
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

    if (m.resolved || m.voided) {
      if (await send(`settle   ${tag}`, "settle", [BigInt(i)])) active--;
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
        await send(`poke     ${tag}`, "pokeOracle", [m.questionId], addresses.binaryModule as `0x${string}`, MODULE_ABI);
      } else if (await send(`void     ${tag}`, "voidExpired", [], m.market, MARKET_ABI)) {
        // Kept from off-chain even though a fork measurement says redemption does not
        // need them: the gas is the operator's here, and belt-and-braces is free. The
        // on-chain sweep deliberately does not pay for these.
        await send(`sync     ${tag}`, "syncSettlement", [s.marketId], addresses.binaryModule as `0x${string}`, MODULE_ABI);
        await send(`final    ${tag}`, "finalizeMarket", [s.marketId], addresses.binaryModule as `0x${string}`, MODULE_ABI);
        if (await send(`settle   ${tag}`, "settle", [BigInt(i)])) active--;
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
      if (await send(`flatten  ${tag}`, "flatten", [BigInt(i)])) active--;
    } else if (yes === 0n && no === 0n) {
      // Nothing filled and nothing will: the book is gone. Pull the escrow back so the
      // quote step can put it where the market actually is.
      log(`slot ${i}: no fills, book ${away} ticks away — pulling the quote`);
      if (await send(`cancel   ${tag}`, "cancelQuote", [BigInt(i)])) {
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
  const cands = candidates(all, { shortest: SHORTEST }).filter(
    (c) => !quotedMarkets.has(c.marketId.toLowerCase()) && hasHeadroom(c) && c.intervalSec <= MAX_TIER,
  );

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
      const p = priceInside(c, bid, ask, minHalf, qty);
      if (!p) continue;
      if (p.escrow > idleLeft) continue;

      log(`quote    slot ${i} ${c.symbol}  theirs ${fmt(p.theirBid)}/${fmt(p.theirAsk)}  ours ${fmt(p.bid)}/${fmt(p.ask)}  size ${Number(qty) / 1e6}  escrow ${usd(p.escrow)}  (mid still, ${moved} ticks)`);
      if (await send(`quote    slot ${i} ${c.marketId.slice(-4)}`, "quote", [BigInt(i), c.marketId, p.mid, p.half, qty])) {
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

  for (let n = 1; !CYCLES || n <= CYCLES; n++) {
    try {
      const all = Object.values(await retry("loadMarkets", () => ex.loadMarkets(true))) as any[];
      const bySymbol = new Map<string, any>();
      for (const m of all) if (m?.info?.marketId) bySymbol.set(String(m.info.marketId).toLowerCase(), m);

      await sweepOld();
      await cycle(n, bySymbol);

      const [nav, idle, resting, supply] = await Promise.all([
        read<bigint>("totalAssets"), read<bigint>("idleAssets"), read<bigint>("totalEscrowed"), read<bigint>("totalSupply"),
      ]);
      const share = supply > 0n ? (Number(nav) / Number(supply)).toFixed(6) : "-";
      log(`cycle ${n}  NAV ${usd(nav)}  idle ${usd(idle)}  resting ${usd(resting)}  share ${share}`);
    } catch (e: any) {
      log("cycle failed:", (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0]);
    }
    if (CYCLES && n >= CYCLES) break;
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
