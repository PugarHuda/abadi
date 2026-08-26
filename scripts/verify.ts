import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { defineChain } from "viem";
const RPC="https://api.infra.testnet.somnia.network", WS="wss://api.infra.testnet.somnia.network/ws";
const shannon = defineChain({ id:50312, name:"Somnia Shannon", nativeCurrency:{name:"STT",symbol:"STT",decimals:18}, rpcUrls:{default:{http:[RPC],webSocket:[WS]}} });
const addresses = { binaryModule:"0x3ecC694Cef705358864a646142ac17A90E29e388", marketsCore:"0x2802504314685D89bF6C992CA5a8e7cC78bc0294", binarySettlement:"0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23", collateralRouter:"0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C", oracleHub:"0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b", clobFactory:"0xb2BE8EE02F96379DB75f01802384593EBa9bfF04", binaryPoolImpl:"0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD", marketCreator:"0x5Ce69567dB39C8fBAd7e048bEfdbcCdfE67B44e6", marketCreatorFactory:"0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B", collateral:"0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E", testUsdc:"0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" };
const ex = new SomniaMarkets({ indexerUrl:"https://dev.smk.somnia.host/v1/graphql", chain:shannon, wsRpcUrl:WS, addresses: addresses as never } as never);
const ID = "0x0000000000000000000000000000000000000000000000000000000000009a50";
const all = Object.values(await ex.loadMarkets(true));
const m:any = all.find((x:any)=>isBinaryMarket(x.info) && x.info.marketId===ID);
if(!m){ console.log("market not found"); process.exit(0); }
const up = m.outcomes[0].symbol;
const bk:any = await ex.fetchOrderBook(up, 8);
console.log("market:", m.symbol);
console.log("");
console.log("       BIDS                 ASKS");
for(let i=0;i<5;i++){
  const b=bk.bids[i], a=bk.asks[i];
  const bs=b?`${b[0].toFixed(3)}  x ${String(b[1]).padStart(9)}`:"".padEnd(22);
  const as=a?`${a[0].toFixed(3)}  x ${String(a[1]).padStart(9)}`:"";
  console.log(`  ${bs}   ${as}`);
}
console.log("");
console.log("Abadi quoted 0.744 / 0.770. If those are now the top of book,");
console.log("the vault is the best price on this market.");
process.exit(0);
