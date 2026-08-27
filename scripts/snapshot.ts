/** Dumps a JSON snapshot for the dashboard. Read-only. */
import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { createPublicClient, http,  parseAbi } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { shannon, addresses, WS, RPC } from "./lib/somnia.ts";

const VAULT_ABI = parseAbi(["function totalAssets() view returns (uint256)","function idleAssets() view returns (uint256)","function totalEscrowed() view returns (uint256)","function totalSupply() view returns (uint256)"]);
const vault = readFileSync(".vault-addr","utf8").trim() as `0x${string}`;
const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
const ex = new SomniaMarkets({ indexerUrl:"https://dev.smk.somnia.host/v1/graphql", chain:shannon, wsRpcUrl:WS, addresses: addresses as never } as never);
const ID = "0x0000000000000000000000000000000000000000000000000000000000009a50";
const all = Object.values(await ex.loadMarkets(true));
const m:any = all.find((x:any)=>isBinaryMarket(x.info) && x.info.marketId===ID) ?? all.filter((x:any)=>isBinaryMarket(x.info))[0];
const bk:any = await ex.fetchOrderBook(m.outcomes[0].symbol, 8);
const [nav, idle, esc, supply] = await Promise.all([
  pub.readContract({address:vault,abi:VAULT_ABI,functionName:"totalAssets"}),
  pub.readContract({address:vault,abi:VAULT_ABI,functionName:"idleAssets"}),
  pub.readContract({address:vault,abi:VAULT_ABI,functionName:"totalEscrowed"}),
  pub.readContract({address:vault,abi:VAULT_ABI,functionName:"totalSupply"}),
]);
const out = {
  capturedAt: new Date(Number((await pub.getBlock()).timestamp)*1000).toISOString(),
  chainId: 50312, vault,
  market: { symbol: m.symbol, marketId: m.info.marketId, intervalSec: Number(m.info.intervalSec), expiry: Number(m.info.expiry) },
  book: { bids: bk.bids.slice(0,5).map((r:any)=>[r[0],r[1]]), asks: bk.asks.slice(0,5).map((r:any)=>[r[0],r[1]]) },
  vaultState: { nav: Number(nav)/1e6, idle: Number(idle)/1e6, resting: Number(esc)/1e6, shares: Number(supply)/1e6 },
};
writeFileSync("web/snapshot.json", JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,2));
process.exit(0);
