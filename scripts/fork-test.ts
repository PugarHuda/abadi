/**
 * Runs the fork suite against the venue as it is right now.
 *
 * test/fork/Venue.fork.t.sol needs a live window and a price inside its book. Neither
 * can be hard-coded — windows expire — so this finds one, prices it with the same
 * function the bot uses, and hands both to forge as environment variables.
 *
 * Run: node scripts/fork-test.ts            (needs an RPC; no key, no transactions)
 *
 * Runs forge through a local shim because Shannon's RPC rejects the EIP-1898 block
 * objects Foundry's fork backend sends — see startShim.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { exchange, retry, RPC } from "./lib/somnia.ts";
import { candidates, hasHeadroom, priceInside } from "./lib/quoting.ts";

/**
 * Shannon's RPC rejects EIP-1898 block objects — `{"blockHash": …}` — with
 * `-32602 invalid parameters`, and that is the only form Foundry's fork backend uses
 * for state reads, so `forge test --fork-url` cannot talk to it directly. This shim
 * sits in between and rewrites the object into the hex block number the node accepts,
 * looking each hash up once. Everything else passes through untouched.
 */
async function startShim(upstream: string): Promise<string> {
  const numberOf = new Map<string, string>();
  // The endpoint drops roughly one request in twenty under load. A shim that dies on
  // the first one takes forge down with it, so every upstream call retries.
  async function post(body: string): Promise<Response> {
    let last: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        return await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw last;
  }
  async function rpc(body: unknown) {
    return (await post(JSON.stringify(body))).json();
  }
  async function fixBlock(p: any): Promise<any> {
    if (!p || typeof p !== "object" || !p.blockHash) return p;
    let n = numberOf.get(p.blockHash);
    if (!n) {
      const blk: any = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByHash", params: [p.blockHash, false] });
      n = blk?.result?.number;
      if (!n) return p;
      numberOf.set(p.blockHash, n);
    }
    return n;
  }
  async function rewrite(req: any) {
    if (Array.isArray(req.params)) req.params = await Promise.all(req.params.map(fixBlock));
    return req;
  }
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const c of req) body += c;
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed) ? await Promise.all(parsed.map(rewrite)) : await rewrite(parsed);
      const up = await post(JSON.stringify(out));
      res.writeHead(up.status, { "content-type": "application/json" });
      res.end(await up.text());
    } catch (e: any) {
      // Answer with a JSON-RPC error rather than dying: forge retries a failed read,
      // but it cannot retry against a server that is no longer there.
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `shim: ${e?.message ?? e}` } }));
    }
  });
  process.on("unhandledRejection", (e) => console.error("shim:", e));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const port = (server.address() as any).port;
  return `http://127.0.0.1:${port}`;
}

async function main() {
  const shim = await startShim(RPC);
  const ex = exchange();
  const all = Object.values(await retry("loadMarkets", () => ex.loadMarkets(true)));
  // Longest tier first: the fork is a snapshot, but the window must still be trading
  // at the snapshot's block, and a day-long window is not about to expire.
  const cands = candidates(all).filter(hasHeadroom);

  for (const c of cands) {
    const oc: any = await ex.client.getMarketOnchain(c.marketId).catch(() => null);
    if (!oc || oc.status !== 1) continue;
    const book: any = await ex.fetchOrderBook(c.upSymbol, 5).catch(() => null);
    const bid = book?.bids?.[0]?.[0], ask = book?.asks?.[0]?.[0];
    if (bid === undefined || ask === undefined) continue;
    const p = priceInside(c, bid, ask, 2_500n);
    if (!p) continue;

    console.log(`market ${c.symbol}  ${c.marketId}`);
    console.log(`book   ${bid.toFixed(3)} / ${ask.toFixed(3)}   ours ${(Number(p.bid) / 1e6).toFixed(3)} / ${(Number(p.ask) / 1e6).toFixed(3)}`);
    console.log("");

    // Spawned, not spawnSync: the shim lives on this event loop, and a blocking wait
    // would leave forge talking to a server that cannot answer.
    const code = await new Promise<number>((done) => {
      const extra = (process.env.FORGE_ARGS ?? "-vv").split(" ").filter(Boolean);
      const child = spawn("forge", ["test", "--match-path", "test/fork/*", ...extra], {
        stdio: "inherit",
        shell: true,
        env: { ...process.env, FORK_RPC: shim, FORK_MARKET: c.marketId, FORK_MID: String(p.mid), FORK_HALF: String(p.half) },
      });
      child.on("close", (status) => done(status ?? 1));
    });
    process.exit(code);
  }
  console.error("no live window with headroom right now — try again in a minute");
  process.exit(2);
}

main().catch((e: any) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
