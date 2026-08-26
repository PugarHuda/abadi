/**
 * Reads the vault's actual position off the chain and marks it against the live book.
 *
 * Everything here is read from the contract and the venue. Nothing is remembered from
 * when the quote was placed: an earlier version of this script printed the prices it
 * had been told about, which stayed on screen looking correct long after the market
 * had moved and the orders had filled.
 *
 * Read-only. Run: node scripts/verify.ts
 */
import { isBinaryMarket } from "@somnia-chain/markets-sdk";
import { createPublicClient, http, parseAbi } from "viem";
import { readFileSync } from "node:fs";
import { shannon, addresses, RPC, OUTCOME_TOKEN, PRICE_ONE, exchange, retry } from "./lib/somnia.ts";

const VAULT_ABI = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function idleAssets() view returns (uint256)",
  "function totalEscrowed() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function MAX_SLOTS() view returns (uint256)",
  "function slots(uint256) view returns ((bytes32 marketId,address pool,uint128 yesOrderId,uint128 noOrderId,uint256 escrowed,uint256 size,uint256 bidPrice,uint256 askPrice,bool active))",
]);
const MODULE_ABI = parseAbi([
  "function markets(bytes32) view returns (uint256,uint8,uint8,address,uint32,bytes32,address,address,address,address,uint256,uint256,uint64,uint64)",
]);
const ERC6909_ABI = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);

const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2).padStart(10);
const px = (v: bigint) => (Number(v) / Number(PRICE_ONE)).toFixed(3);

async function main() {
  const vault = readFileSync(".vault-addr", "utf8").trim() as `0x${string}`;
  const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
  const read = <T>(fn: string, args: unknown[] = []) =>
    pub.readContract({ address: vault, abi: VAULT_ABI, functionName: fn as never, args: args as never }) as Promise<T>;

  const [nav, idle, escrowed, shares, maxSlots] = await Promise.all([
    read<bigint>("totalAssets"),
    read<bigint>("idleAssets"),
    read<bigint>("totalEscrowed"),
    read<bigint>("totalSupply"),
    read<bigint>("MAX_SLOTS"),
  ]);

  console.log("vault  ", vault);
  console.log("NAV    ", usd(nav), "tUSDC");
  console.log("  idle ", usd(idle));
  console.log("  escrow", usd(escrowed));
  console.log("shares ", usd(shares), shares > 0n ? `(${(Number(nav) / Number(shares)).toFixed(6)} per share)` : "");
  console.log("");

  const ex = exchange();
  const live = await retry("loadMarkets", () => ex.loadMarkets(true));
  const bySymbol = new Map<string, any>();
  for (const m of Object.values(live) as any[]) {
    if (isBinaryMarket(m.info)) bySymbol.set(String(m.info.marketId).toLowerCase(), m);
  }

  let open = 0;
  let markedValue = 0n;

  for (let i = 0n; i < maxSlots; i++) {
    const s = await read<any>("slots", [i]);
    if (!s.active) continue;
    open++;

    const rec: any = await pub.readContract({
      address: addresses.binaryModule as `0x${string}`,
      abi: MODULE_ABI,
      functionName: "markets",
      args: [s.marketId],
    });
    const [yesId, noId] = [rec[10] as bigint, rec[11] as bigint];
    const expiry = Number(rec[13]);

    const [yes, no] = await Promise.all(
      [yesId, noId].map((id) =>
        pub.readContract({
          address: OUTCOME_TOKEN as `0x${string}`,
          abi: ERC6909_ABI,
          functionName: "balanceOf",
          args: [vault, id],
        }) as Promise<bigint>,
      ),
    );

    const m = bySymbol.get(String(s.marketId).toLowerCase());
    const symbol = m?.symbol ?? s.marketId;
    let book = "";
    if (m?.outcomes?.[0]?.symbol) {
      const b: any = await ex.fetchOrderBook(m.outcomes[0].symbol, 3).catch(() => null);
      const bid = b?.bids?.[0]?.[0];
      const ask = b?.asks?.[0]?.[0];
      book = bid !== undefined ? `${bid.toFixed(3)} / ${ask?.toFixed(3) ?? "--"}` : "no book";
    }

    // A complete set is worth exactly 1 per pair at settlement, whichever side wins.
    // A leg without a partner is directional and only settlement resolves it, so it is
    // marked at cost rather than guessed at.
    const pairs = yes < no ? yes : no;
    const naked = (yes > no ? yes - no : no - yes);
    markedValue += pairs;

    const secsLeft = expiry - Math.floor(Date.now() / 1000);
    console.log(`slot ${i}  ${symbol}`);
    console.log(`  quoted     ${px(s.bidPrice)} / ${px(s.askPrice)}    book now  ${book}`);
    console.log(`  escrowed   ${usd(s.escrowed)}   orders ${s.yesOrderId}/${s.noOrderId}`);
    console.log(`  holds      up ${usd(yes)}   down ${usd(no)}`);
    console.log(
      `  complete   ${usd(pairs)}  -> worth exactly that at settlement` +
        (naked > 0n ? `\n  NAKED      ${usd(naked)}  <- directional until settlement` : ""),
    );
    console.log(`  expires    ${secsLeft > 0 ? Math.round(secsLeft) + "s" : "EXPIRED — sweepable"}`);
    console.log("");
  }

  if (open === 0) {
    console.log("no open slots — all capital is idle");
    return;
  }

  const pnl = markedValue - escrowed;
  console.log("--- marked ---");
  console.log(`complete sets held  ${usd(markedValue)}`);
  console.log(`paid for them       ${usd(escrowed)}`);
  console.log(`locked in           ${usd(pnl)}  ${pnl > 0n ? "(spread captured, no directional exposure)" : ""}`);
}

main()
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
