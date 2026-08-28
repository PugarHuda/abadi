/**
 * Abadi bot. The requote loop the README kept calling "what comes next".
 *
 * Every cycle it does, in order, the things a human operator did by hand on the 27th:
 *
 *   1. settle    any slot whose market has resolved — permissionless, proceeds to the vault
 *   2. finalize  any slot whose market has expired but not resolved, through the venue's
 *                own permissionless keeper entry, so the next cycle can settle it
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
 */
import { createPublicClient, createWalletClient, formatEther, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { shannon, addresses, RPC, OUTCOME_TOKEN, env, exchange, retry } from "./lib/somnia.ts";
import { candidates, hasHeadroom, priceInside, ticksAway, fmt } from "./lib/quoting.ts";

/** Every vault this project has deployed. Redeploys leave positions behind; see sweepOld. */
const OLD_VAULTS: { address: `0x${string}` }[] = JSON.parse(
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
]);
const MODULE_ABI = parseAbi([
  "function markets(bytes32) view returns (uint256,uint8,uint8,address,uint32,bytes32,address,address,address,address,uint256,uint256,uint64,uint64)",
  "function finalizeMarket(bytes32 marketId)",
]);
const MARKET_ABI = parseAbi(["function isResolved() view returns (bool)", "function isVoided() view returns (bool)"]);
const ERC6909_ABI = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);

const TRADING = 1;

const INTERVAL = Number(process.env.INTERVAL ?? 30);
const CYCLES = Number(process.env.CYCLES ?? 0);
const ACTIVE = Number(process.env.ACTIVE ?? 3);
const QTY = BigInt(Math.round(Number(process.env.SIZE ?? 100) * 1e6));
const DEAD_TICKS = BigInt(process.env.DEAD_TICKS ?? 6);
const GAS_FLOOR = Number(process.env.GAS_FLOOR ?? 0.5);
const SHORTEST = !!process.env.SHORTEST;

const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2);
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
  const tradingStart = Number(rec[12]);
  const expiry = Number(rec[13]);
  const now = Date.now() / 1000;
  const status = now < tradingStart ? 0 : now >= expiry ? 2 : TRADING;
  const [resolved, voided] = await Promise.all([
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: "isResolved" }),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: "isVoided" }),
  ]);
  return { status, market, expiry, resolved: resolved as boolean, voided: voided as boolean };
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
  if ((await read<bigint>("armed", [ms])) !== 0n) return;
  const [bal, floor] = await Promise.all([pub.getBalance({ address: vault }), read<bigint>("MIN_HANDLER_BALANCE")]);
  if (bal < floor) {
    log(`arm      skipped: vault holds ${formatEther(bal)} STT, floor is ${formatEther(floor)}`);
    return;
  }
  await send(`arm      ${new Date(firesAtSec * 1000).toISOString().slice(11, 19)}Z`, "armSweep", [BigInt(firesAtSec)]);
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
      const s: any = await pub.readContract({ address: v.address, abi: VAULT_ABI, functionName: "slots", args: [BigInt(i)] }).catch(() => null);
      if (!s?.active) continue;
      const m = await marketState(s.marketId).catch(() => null);
      if (!m || !(m.resolved || m.voided)) continue;
      await send(`settle   old ${v.address.slice(0, 8)} slot ${i}`, "settle", [BigInt(i)], v.address);
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
      // Expired and not resolved: nobody has poked the venue yet. Anyone may.
      await send(`finalize ${tag}`, "finalizeMarket", [s.marketId], addresses.binaryModule as `0x${string}`, MODULE_ABI);
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
    (c) => !quotedMarkets.has(c.marketId.toLowerCase()) && hasHeadroom(c),
  );

  for (let i = 0; i < maxSlots && active < ACTIVE; i++) {
    const s = await read<any>("slots", [BigInt(i)]);
    if (s.active) continue;

    for (const c of cands) {
      if (quotedMarkets.has(c.marketId.toLowerCase())) continue;
      const oc: any = await ex.client.getMarketOnchain(c.marketId).catch(() => null);
      if (!oc || oc.status !== TRADING) continue;
      const book: any = await ex.fetchOrderBook(c.upSymbol, 5).catch(() => null);
      const bid = book?.bids?.[0]?.[0], ask = book?.asks?.[0]?.[0];
      if (bid === undefined || ask === undefined) continue;

      const p = priceInside(c, bid, ask, minHalf, QTY);
      if (!p) continue;
      if (p.escrow > idleLeft) continue;

      log(`quote    slot ${i} ${c.symbol}  theirs ${fmt(p.theirBid)}/${fmt(p.theirAsk)}  ours ${fmt(p.bid)}/${fmt(p.ask)}  escrow ${usd(p.escrow)}`);
      if (await send(`quote    slot ${i} ${c.marketId.slice(-4)}`, "quote", [BigInt(i), c.marketId, p.mid, p.half, QTY])) {
        quotedMarkets.add(c.marketId.toLowerCase());
        idleLeft -= p.escrow;
        active++;
        await armAt(c.expiry + 45);
        break;
      }
    }
  }
}

async function main() {
  log("vault   ", vault);
  log("operator", account.address);
  log(`interval ${INTERVAL}s  active ${ACTIVE}  size ${Number(QTY) / 1e6}  dead ${DEAD_TICKS} ticks  gas floor ${GAS_FLOOR} STT  ${CYCLES ? CYCLES + " cycles" : "until killed"}`);

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
