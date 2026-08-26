import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { defineChain } from "viem";
const RPC="https://api.infra.testnet.somnia.network", WS="wss://api.infra.testnet.somnia.network/ws";
const shannon = defineChain({ id:50312, name:"Somnia Shannon", nativeCurrency:{name:"STT",symbol:"STT",decimals:18}, rpcUrls:{default:{http:[RPC],webSocket:[WS]}} });
const addresses = { binaryModule:"0x3ecC694Cef705358864a646142ac17A90E29e388", marketsCore:"0x2802504314685D89bF6C992CA5a8e7cC78bc0294", binarySettlement:"0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23", collateralRouter:"0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C", oracleHub:"0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b", clobFactory:"0xb2BE8EE02F96379DB75f01802384593EBa9bfF04", binaryPoolImpl:"0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD", marketCreator:"0x5Ce69567dB39C8fBAd7e048bEfdbcCdfE67B44e6", marketCreatorFactory:"0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B", collateral:"0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E", testUsdc:"0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" };
const ex = new SomniaMarkets({ indexerUrl:"https://dev.smk.somnia.host/v1/graphql", chain:shannon, wsRpcUrl:WS, addresses: addresses as never } as never);
const all = Object.values(await ex.loadMarkets(true));
const b = all.filter((m:any)=>isBinaryMarket(m.info));
const now = Date.now()/1000;
for (const m of b as any[]) {
  const oc:any = await ex.client.getMarketOnchain(m.info.marketId);
  if (oc.status!==1) continue;
  const left = Number(m.info.expiry)-now;
  if (left < 900) continue;
  console.log("symbol      :", m.symbol);
  console.log("marketId    :", m.info.marketId);
  console.log("expiry      :", m.info.expiry, `(${Math.round(left)}s left)`);
  console.log("precision   :", JSON.stringify(m.precision));
  console.log("limits      :", JSON.stringify(m.limits));
  console.log("info keys   :", Object.keys(m.info).join(", "));
  const g:any = m.info;
  for (const k of ["tickSize","lotSize","minQuantity","priceTick","quantityLot"]) if (g[k]!==undefined) console.log(`info.${k} :`, g[k]);
  console.log("onchain keys:", Object.keys(oc).join(", "));
  for (const k of ["tickSize","lotSize","minQuantity"]) if ((oc as any)[k]!==undefined) console.log(`onchain.${k} :`, String((oc as any)[k]));
  break;
}
process.exit(0);
