/**
 * The vault's own history, read back off the chain and marked honestly.
 *
 * "One fill is not a track record" has been true since the first quote. This is the
 * tool that turns it into one, or shows that it is not: every Quoted / Flattened /
 * Settled / Cancelled the vaults have ever emitted, grouped into episodes, with the
 * basis paid and the cash that came back.
 *
 * Reads the explorer's log API rather than eth_getLogs so there is no block-range cap
 * to chunk around, and decodes with the vault's own ABI so nothing is remembered from
 * when the events were sent. Read-only.
 *
 * Run: node scripts/ledger.ts            (prints, and writes docs/evidence/ledger-<date>.md)
 */
import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { PRICE_ONE, RPC, addresses, shannon } from "./lib/somnia.ts";

const MODULE_ABI = parseAbi([
  "function markets(bytes32) view returns (uint256,uint8,uint8,address,uint32,bytes32,address,address,address,address,uint256,uint256,uint64,uint64)",
]);
const VAULT_ABI = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const pub = createPublicClient({ chain: shannon, transport: http(RPC) });

/** Window length in seconds, read from the module. The events do not carry it. */
const tierCache = new Map<string, number>();
async function tierOf(marketId: string): Promise<number> {
  const k = marketId.toLowerCase();
  if (tierCache.has(k)) return tierCache.get(k)!;
  try {
    const rec: any = await pub.readContract({ address: addresses.binaryModule as `0x${string}`, abi: MODULE_ABI, functionName: "markets", args: [marketId as `0x${string}`] });
    const t = Number(rec[13]) - Number(rec[12]);
    tierCache.set(k, t);
    return t;
  } catch { return 0; }
}
const tierName = (t: number) => (t >= 86400 ? "24h" : t >= 14400 ? "4h" : t >= 3600 ? "1h" : t >= 900 ? "15m" : t > 0 ? t + "s" : "?");

const EXPLORER = "https://shannon-explorer.somnia.network/api/v2";

/** Every vault this project has run on Shannon, oldest first. Each redeploy was a fix.
 *  One file, read here and injected into the site, so the two can never disagree. */
const VAULTS: { address: `0x${string}`; note: string }[] = JSON.parse(
  readFileSync(new URL("./lib/vaults.json", import.meta.url), "utf8"),
);

const ABI = parseAbi([
  "event Quoted(uint256 indexed slot, bytes32 indexed marketId, uint256 bid, uint256 ask, uint256 size)",
  "event Flattened(uint256 indexed slot, bytes32 indexed marketId, uint256 pairs, uint256 returned)",
  "event Settled(uint256 indexed slot, bytes32 indexed marketId, uint256 redeemed, bool voided)",
  "event Cancelled(uint256 indexed slot, bytes32 indexed marketId)",
]);

type Ev = {
  name: "Quoted" | "Flattened" | "Settled" | "Cancelled";
  args: any;
  block: number;
  at: string;
  tx: string;
};

type Episode = {
  vault: string;
  slot: number;
  marketId: string;
  quotedAt: string;
  bid: bigint;
  ask: bigint;
  size: bigint;
  basis: bigint;
  pairsMerged: bigint;
  returned: bigint;
  redeemed: bigint;
  voided: boolean;
  cancelled: boolean;
  closedBy: "settle" | "flatten" | "cancel" | "open";
  txs: string[];
  /** The market's CLOB pool, learned from where the quote's escrow went. */
  pool: string;
  /** Position of the quote in the vault's collateral history, for attributing releases. */
  quoteOrd: number;
  /** Escrow the pool gave back: the legs that never filled. */
  refunded: bigint;
};

/** One tUSDC movement in or out of a vault, in chain order. */
type Flow = { ord: number; tx: string; from: string; to: string; value: bigint };

const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2);
const px = (v: bigint) => (Number(v) / Number(PRICE_ONE)).toFixed(3);
const short = (a: string) => a.slice(0, 10) + "…" + a.slice(-4);

async function logsOf(address: string): Promise<Ev[]> {
  const out: Ev[] = [];
  let params: Record<string, string> | null = {};
  while (params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${EXPLORER}/addresses/${address}/logs${qs ? "?" + qs : ""}`);
    if (!res.ok) throw new Error(`explorer ${res.status} for ${address}`);
    const j: any = await res.json();
    for (const it of j.items) {
      try {
        const d = decodeEventLog({ abi: ABI, topics: it.topics as any, data: it.data });
        out.push({
          name: d.eventName as Ev["name"],
          args: d.args,
          block: Number(it.block_number),
          at: it.block_timestamp,
          tx: it.transaction_hash,
        });
      } catch {
        /* Deposit, Transfer, Approval, OperatorSet — not part of the trading record */
      }
    }
    params = j.next_page_params ?? null;
  }
  return out.sort((a, b) => a.block - b.block);
}

/**
 * Cut one vault's event stream into episodes. A slot's life is Quoted → ... → the event
 * that frees it. Settled always frees. Flattened and Cancelled free only when nothing is
 * left behind; from events alone that is known by what comes next — another Quoted on
 * the same slot means it was free, a later Settled means it was not.
 */
function episodesOf(vault: string, evs: Ev[]): Episode[] {
  const open = new Map<number, Episode>();
  const done: Episode[] = [];

  for (const e of evs) {
    const slot = Number(e.args.slot);
    if (e.name === "Quoted") {
      const prev = open.get(slot);
      if (prev) done.push(prev); // whatever freed it, it is over
      const bid = e.args.bid as bigint, ask = e.args.ask as bigint, size = e.args.size as bigint;
      open.set(slot, {
        vault, slot, marketId: e.args.marketId, quotedAt: e.at, bid, ask, size,
        basis: (size * bid) / PRICE_ONE + (size * (PRICE_ONE - ask)) / PRICE_ONE,
        pairsMerged: 0n, returned: 0n, redeemed: 0n, voided: false, cancelled: false,
        closedBy: "open", txs: [e.tx], pool: "", quoteOrd: 0, refunded: 0n,
      });
      continue;
    }
    const ep = open.get(slot);
    if (!ep) continue;
    ep.txs.push(e.tx);
    if (e.name === "Flattened") {
      ep.pairsMerged += e.args.pairs;
      ep.returned += e.args.returned;
      ep.closedBy = "flatten";
    } else if (e.name === "Settled") {
      ep.redeemed += e.args.redeemed;
      ep.voided = e.args.voided;
      ep.closedBy = "settle";
      open.delete(slot);
      done.push(ep);
    } else if (e.name === "Cancelled") {
      ep.cancelled = true;
      if (ep.closedBy === "open") ep.closedBy = "cancel";
    }
  }
  for (const ep of open.values()) {
    // Still open on chain, or freed by a flatten/cancel with nothing after it. The
    // difference cannot be read from events, so it is labelled, not guessed.
    if (ep.closedBy !== "settle") ep.closedBy = ep.closedBy === "open" ? "open" : ep.closedBy;
    done.push(ep);
  }
  return done.sort((a, b) => a.quotedAt.localeCompare(b.quotedAt));
}

/**
 * Every tUSDC transfer a vault was party to, oldest first.
 *
 * The four events cannot close the books on their own. A leg that never filled has its
 * escrow released by the pool — on cancel, on expiry, or when the market goes terminal —
 * and that release carries no vault event with it. It is a plain collateral transfer from
 * the pool back to the vault, and it is the term that was missing: without it a one-sided
 * episode looks like a total loss of its basis, and an episode where nothing filled at all
 * looks the same as one that held the losing side.
 */
async function flowsOf(address: string): Promise<Flow[]> {
  const out: Flow[] = [];
  const coll = addresses.collateral.toLowerCase();
  let params: Record<string, string> | null = {};
  while (params) {
    const qs = new URLSearchParams({ ...params, type: "ERC-20" }).toString();
    const res = await fetch(`${EXPLORER}/addresses/${address}/token-transfers?${qs}`);
    if (!res.ok) throw new Error(`explorer ${res.status} for ${address} transfers`);
    const j: any = await res.json();
    for (const it of j.items) {
      if ((it.token?.address_hash ?? "").toLowerCase() !== coll) continue;
      out.push({
        // one sortable position per log: blocks are ~4.7e8 here, so this stays exact.
        ord: Number(it.block_number) * 1e4 + Number(it.log_index),
        tx: it.transaction_hash,
        from: it.from.hash.toLowerCase(),
        to: it.to.hash.toLowerCase(),
        value: BigInt(it.total.value),
      });
    }
    params = j.next_page_params ?? null;
  }
  return out.sort((a, b) => a.ord - b.ord);
}

/**
 * Attach the escrow releases to the episodes that paid them.
 *
 * The quote's own transaction says where the money went: two transfers, vault to pool, one
 * per leg. That names the pool, and the pool is one per market. Everything the same pool
 * later sends back belongs to the most recent episode quoted on it — the contract allows
 * only one live slot per market, so there is never a second claimant open at the same time.
 */
function attribute(vault: string, eps: Episode[], flows: Flow[]): void {
  const v = vault.toLowerCase();
  const byTx = new Map<string, Flow[]>();
  for (const f of flows) byTx.set(f.tx, [...(byTx.get(f.tx) ?? []), f]);

  const byPool = new Map<string, Episode[]>();
  for (const ep of eps) {
    const paid = (byTx.get(ep.txs[0]) ?? []).filter((f) => f.from === v);
    if (!paid.length) continue; // no escrow left the vault on this quote — nothing to trace
    ep.pool = paid[0].to;
    ep.quoteOrd = paid[0].ord;
    byPool.set(ep.pool, [...(byPool.get(ep.pool) ?? []), ep]);
  }
  for (const list of byPool.values()) list.sort((a, b) => a.quoteOrd - b.quoteOrd);

  for (const f of flows) {
    if (f.to !== v) continue;
    const list = byPool.get(f.from);
    if (!list) continue; // merges and redemptions arrive from the module, not the pool
    let owner: Episode | null = null;
    for (const ep of list) {
      if (ep.quoteOrd > f.ord) break;
      owner = ep;
    }
    if (owner) owner.refunded += f.value;
  }
}

type Mark = { state: "open" | "no fill" | "complete" | "one-sided" | "unaccounted"; pnl: bigint; cash: bigint };

/**
 * What an episode realised. Cash is everything that came back through any door: merged
 * pairs, redemption, and the escrow the pool released. Basis is what the quote cost, all
 * of it, whether or not it traded — so a losing episode carries its full weight in the
 * denominator and its real loss in the numerator.
 *
 * The two facts the old reading confused are separated here. Escrow returned in full,
 * with nothing merged and nothing redeemed, means neither leg ever filled: no fill, no
 * loss, and no adverse selection to report. Escrow short of the basis means something
 * filled, and what it was worth at the end is the difference.
 */
function value(ep: Episode): Mark {
  const cash = ep.returned + ep.redeemed + ep.refunded;
  if (ep.closedBy === "open") return { state: "open", pnl: 0n, cash };
  if (!ep.pool || ep.refunded > ep.basis) return { state: "unaccounted", pnl: 0n, cash };
  if (ep.returned === 0n && ep.redeemed === 0n && ep.refunded === ep.basis) {
    return { state: "no fill", pnl: 0n, cash };
  }
  const both = ep.refunded === 0n && (ep.pairsMerged === ep.size || ep.redeemed === ep.size);
  return { state: both ? "complete" : "one-sided", pnl: cash - ep.basis, cash };
}

const pct = (p: bigint, basis: bigint) => (basis === 0n ? "—" : ((Number(p) / Number(basis)) * 100).toFixed(2) + "%");
const signed = (p: bigint) => (p >= 0n ? "+" : "") + usd(p);

async function main() {
  const current = readFileSync(".vault-addr", "utf8").trim() as `0x${string}`;
  const vaults = [...VAULTS, { address: current, note: "current" }].filter(
    (v, i, arr) => arr.findIndex((w) => w.address.toLowerCase() === v.address.toLowerCase()) === i,
  );

  const all: Episode[] = [];
  for (const v of vaults) {
    const evs = await logsOf(v.address);
    const eps = episodesOf(v.address, evs);
    attribute(v.address, eps, await flowsOf(v.address));
    all.push(...eps);
  }

  // The one number a depositor is actually paid in. Everything below is the account of how
  // it got here; this is where it got to.
  const [assets, supply] = (await Promise.all([
    pub.readContract({ address: current, abi: VAULT_ABI, functionName: "totalAssets" }),
    pub.readContract({ address: current, abi: VAULT_ABI, functionName: "totalSupply" }),
  ])) as [bigint, bigint];
  const share = supply > 0n ? Number(assets) / Number(supply) : 1;

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);

  say(`# Ledger — ${new Date().toISOString().slice(0, 10)}`);
  say();
  say("Every quote the vaults have placed on Shannon, read back from the chain. Basis is what");
  say("the pair cost at quote time, all of it. Cash is everything that came back: merged pairs,");
  say("redemption, and the escrow the pool released on the legs that never filled. Every closed");
  say("episode is priced, winners and losers alike, and each one carries its full basis.");
  say();
  say("| vault | slot | market | quoted | bid / ask | basis | merged | redeemed | escrow back | closed by | result |");
  say("|---|---|---|---|---|---|---|---|---|---|---|");

  let complete = 0, oneSided = 0, noFill = 0, openN = 0, openCurrent = 0, pnl = 0n, basisClosed = 0n, pnlCurrent = 0n;
  const unaccounted: Episode[] = [];
  for (const ep of all) {
    const m = value(ep);
    let result: string;
    if (m.state === "open") {
      result = "open";
      openN++;
      if (ep.vault.toLowerCase() === current.toLowerCase()) openCurrent++;
    } else if (m.state === "unaccounted") {
      unaccounted.push(ep);
      basisClosed += ep.basis;
      result = "? · not determinable from the chain";
    } else if (m.state === "no fill") {
      noFill++;
      basisClosed += ep.basis;
      result = "0.00 · no fill, escrow returned";
    } else {
      pnl += m.pnl; basisClosed += ep.basis;
      if (ep.vault.toLowerCase() === current.toLowerCase()) pnlCurrent += m.pnl;
      if (m.state === "complete") complete++; else oneSided++;
      result = `${signed(m.pnl)} (${pct(m.pnl, ep.basis)})` + (m.state === "one-sided" ? " · one-sided" : "");
    }
    say(
      `| ${short(ep.vault)} | ${ep.slot} | ${ep.marketId.slice(-4)} | ${ep.quotedAt.slice(5, 16).replace("T", " ")} | ` +
      `${px(ep.bid)} / ${px(ep.ask)} | ${usd(ep.basis)} | ${usd(ep.pairsMerged)} | ` +
      `${usd(ep.redeemed)}${ep.voided ? " (void)" : ""} | ${usd(ep.refunded)} | ` +
      `${ep.closedBy}${ep.cancelled ? "+cancel" : ""} | ${result} |`,
    );
  }

  // ---- by tier: where the adverse fills live is the number the bot's knobs are tuned on
  const byTier = new Map<string, { n: number; complete: number; oneSided: number; noFill: number; pnl: bigint; basis: bigint }>();
  for (const ep of all) {
    const t = tierName(await tierOf(ep.marketId));
    const row = byTier.get(t) ?? { n: 0, complete: 0, oneSided: 0, noFill: 0, pnl: 0n, basis: 0n };
    const m = value(ep);
    row.n++;
    if (m.state !== "open") row.basis += ep.basis;
    if (m.state === "no fill") row.noFill++;
    else if (m.state === "complete") { row.complete++; row.pnl += m.pnl; }
    else if (m.state === "one-sided") { row.oneSided++; row.pnl += m.pnl; }
    byTier.set(t, row);
  }
  say();
  say("## By window length");
  say();
  say("| tier | episodes | complete | one-sided | no fill | adverse | realised | on basis |");
  say("|---|---|---|---|---|---|---|---|");
  for (const [t, r] of [...byTier.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const filled = r.complete + r.oneSided;
    say(`| ${t} | ${r.n} | ${r.complete} | ${r.oneSided} | ${r.noFill} | ${filled ? ((r.oneSided / filled) * 100).toFixed(0) + "%" : "—"} | ${signed(r.pnl)} | ${usd(r.basis)} |`);
  }

  say();
  say("## Summary");
  say();
  say(`- **per share: ${share.toFixed(6)} tUSDC** — ${usd(assets)} of assets on ${usd(supply)} of shares`);
  say(`- **depositors, against shares issued at par: ${signed(assets - supply)} tUSDC (${((share - 1) * 100).toFixed(2)}%)**`);
  say(`- realised, every closed episode: ${signed(pnl)} tUSDC on ${usd(basisClosed)} of basis (${pct(pnl, basisClosed)})`);
  say(`- episodes: ${all.length} across ${vaults.length} vaults`);
  say(`- closed into a full set: ${complete} · one-sided: ${oneSided} · no fill: ${noFill} · open: ${openN}` +
      (unaccounted.length ? ` · not determinable: ${unaccounted.length}` : ""));
  const n = complete + oneSided;
  if (n > 0) {
    say(`- fill shape: ${complete}/${n} complete, ${oneSided}/${n} one-sided — ` +
        `**${((oneSided / n) * 100).toFixed(0)}% of filled quotes were adverse**` +
        (noFill ? `; the ${noFill} where neither leg filled are not adverse and are not counted here` : ""));
  }
  say();
  say("Per share is the honest headline: it is what a depositor's claim is worth right now,");
  say("and it carries the open positions and every loss the vault has taken. The realised");
  say("figure above spans nine vaults; the depositors are in the current one, so that is the");
  say("comparison that has to hold:");
  say();
  say(`- realised on \`${short(current)}\` alone: ${signed(pnlCurrent)} tUSDC`);
  say(`- what the share price says depositors are down: ${signed(assets - supply)} tUSDC`);
  say(`- difference: ${signed(pnlCurrent - (assets - supply))} tUSDC, across ${openCurrent} episode(s) still open there`);
  say();
  say("With nothing open those two are the same number to the cent, and that is the check on");
  say("both of them. While quotes are resting they are not, and the difference is not slack in");
  say("the account: NAV carries a filled leg that has no partner at zero until settlement says");
  say("otherwise, so an open one-sided fill reaches the share price before it reaches the");
  say("realised column, never the other way round.");
  say();
  if (unaccounted.length) {
    say(`Not determinable from the chain (${unaccounted.length}) — counted in the basis, left out of the`);
    say("realised figure rather than guessed at:");
    say();
    for (const ep of unaccounted) {
      say(`- ${short(ep.vault)} slot ${ep.slot} market …${ep.marketId.slice(-4)}, basis ${usd(ep.basis)}` +
          `${ep.pool ? `, escrow back ${usd(ep.refunded)} against a basis of ${usd(ep.basis)}` : ", no collateral transfer found for the quote"}`);
    }
    say();
  }
  say("Vaults, oldest first:");
  say();
  for (const v of vaults) say(`- \`${v.address}\` — ${v.note}`);

  const text = lines.join("\n") + "\n";
  process.stdout.write(text);
  const out = `docs/evidence/ledger-${new Date().toISOString().slice(0, 10)}.md`;
  writeFileSync(out, text);
  console.error(`\nwrote ${out}`);
}

main()
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
