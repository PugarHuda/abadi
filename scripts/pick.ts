import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { defineChain } from "viem";
const RPC="https://api.infra.testnet.somnia.network", WS="wss://api.infra.testnet.somnia.network/ws";
const shannon = defineChain({ id:50312, name:"Somnia Shannon", nativeCurrency:{name:"STT",symbol:"STT",decimals:18}, rpcUrls:{default:{http:[RPC],webSocket:[WS]}} });
const addresses = { binaryModule:"0x3ecC694Cef705358864a646142ac17A90E29e388", marketsCore:"0x2802504314685D89bF6C992CA5a8e7cC78bc0294", binarySettlement:"0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23", collateralRouter:"0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C", oracleHub:"0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b", clobFactory:"0xb2BE8EE02F96379DB75f01802384593EBa9bfF04", binaryPoolImpl:"0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD", marketCreator:"0x5Ce69567dB39C8fBAd7e048bEfdbcCdfE67B44e6", marketCreatorFactory:"0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B", collateral:"0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E", testUsdc:"0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" };
const ex = new SomniaMarkets({ indexerUrl:"https://dev.smk.somnia.host/v1/graphql", chain:shannon, wsRpcUrl:WS, addresses: addresses as never } as never);
const all = Object.values(await ex.loadMarkets(true));
const now = Date.now()/1000;
for (const m of all.filter((x:any)=>isBinaryMarket(x.info)) as any[]) {
  const oc:any = await ex.client.getMarketOnchain(m.info.marketId);
  if (oc.status!==1) continue;
  const left = Number(m.info.expiry)-now;
  const iv = Number(m.info.intervalSec||0);
  if (left < iv*0.25 || left < 1200) continue;          // plenty of headroom
  const up = m.outcomes?.[0]?.symbol; if(!up) continue;
  const bk:any = await ex.fetchOrderBook(up,5).catch(()=>null); if(!bk) continue;
  const bid = bk.bids[0]?.[0], ask = bk.asks[0]?.[0];
  if (bid===undefined||ask===undefined) continue;
  const mid = (bid+ask)/2;
  const midWei = BigInt(Math.round(mid*1000))*(10n**15n);   // snap to the 0.001 tick grid
  console.log("SYMBOL="+m.symbol);
  console.log("MARKET="+m.info.marketId);
  console.log("LEFT="+Math.round(left)+"s  INTERVAL="+iv+"s");
  console.log("BOOK bid="+bid.toFixed(3)+" ask="+ask.toFixed(3)+" spread="+(ask-bid).toFixed(3));
  console.log("MID="+midWei.toString());
  break;
}
process.exit(0);
