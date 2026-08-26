/** Dumps a JSON snapshot for the dashboard. Read-only. */
import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
const RPC="https://api.infra.testnet.somnia.network", WS="wss://api.infra.testnet.somnia.network/ws";
const shannon = defineChain({ id:50312, name:"Somnia Shannon", nativeCurrency:{name:"STT",symbol:"STT",decimals:18}, rpcUrls:{default:{http:[RPC],webSocket:[WS]}} });
const addresses = { binaryModule:"0x3ecC694Cef705358864a646142ac17A90E29e388", marketsCore:"0x2802504314685D89bF6C992CA5a8e7cC78bc0294", binarySettlement:"0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23", collateralRouter:"0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C", oracleHub:"0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b", clobFactory:"0xb2BE8EE02F96379DB75f01802384593EBa9bfF04", binaryPoolImpl:"0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD", marketCreator:"0x5Ce69567dB39C8fBAd7e048bEfdbcCdfE67B44e6", marketCreatorFactory:"0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B", collateral:"0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E", testUsdc:"0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" };
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
  vaultState: { nav: Number(nav)/1e6, idle: Number(idle)/1e6, escrowed: Number(esc)/1e6, shares: Number(supply)/1e6 },
};
writeFileSync("web/snapshot.json", JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,2));
process.exit(0);
