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
import { decodeEventLog, parseAbi } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { PRICE_ONE } from "./lib/somnia.ts";

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
};

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
        closedBy: "open", txs: [e.tx],
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

async function main() {
  const current = readFileSync(".vault-addr", "utf8").trim() as `0x${string}`;
  const vaults = [...VAULTS, { address: current, note: "current" }].filter(
    (v, i, arr) => arr.findIndex((w) => w.address.toLowerCase() === v.address.toLowerCase()) === i,
  );

  const all: Episode[] = [];
  for (const v of vaults) {
    const evs = await logsOf(v.address);
    all.push(...episodesOf(v.address, evs));
  }

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);

  say(`# Ledger — ${new Date().toISOString().slice(0, 10)}`);
  say();
  say("Every quote the vaults have placed on Shannon, read back from the chain. Basis is what");
  say("the pair cost at quote time. Cash is what came back through the vault's own exits.");
  say("A complete set is exact; a one-sided episode is marked as such rather than guessed.");
  say();
  say("| vault | slot | market | quoted | bid / ask | basis | merged | returned | redeemed | closed by | result |");
  say("|---|---|---|---|---|---|---|---|---|---|---|");

  let complete = 0, oneSided = 0, openN = 0, pnl = 0n, basisClosed = 0n;
  for (const ep of all) {
    const cash = ep.returned + ep.redeemed;
    const isComplete = ep.pairsMerged === ep.size || (ep.closedBy === "settle" && ep.redeemed === ep.size);
    let result: string;
    if (ep.closedBy === "open") {
      result = "open";
      openN++;
    } else if (ep.closedBy === "cancel" && cash === 0n) {
      result = "no fill, escrow returned";
    } else if (isComplete) {
      const p = cash - ep.basis;
      pnl += p; basisClosed += ep.basis; complete++;
      result = `${p >= 0n ? "+" : ""}${usd(p)} (${((Number(p) / Number(ep.basis)) * 100).toFixed(2)}%)`;
    } else {
      oneSided++;
      result = ep.redeemed === 0n && ep.closedBy === "settle" ? "one-sided, lost" : "one-sided";
    }
    say(
      `| ${short(ep.vault)} | ${ep.slot} | ${ep.marketId.slice(-4)} | ${ep.quotedAt.slice(5, 16).replace("T", " ")} | ` +
      `${px(ep.bid)} / ${px(ep.ask)} | ${usd(ep.basis)} | ${usd(ep.pairsMerged)} | ${usd(ep.returned)} | ` +
      `${usd(ep.redeemed)}${ep.voided ? " (void)" : ""} | ${ep.closedBy}${ep.cancelled ? "+cancel" : ""} | ${result} |`,
    );
  }

  say();
  say("## Summary");
  say();
  say(`- episodes: **${all.length}** across ${vaults.length} vaults`);
  say(`- completed into a full set and closed: **${complete}**`);
  say(`- one-sided (adverse selection): **${oneSided}**`);
  say(`- still open on chain: ${openN}`);
  if (complete > 0) {
    say(`- realised on complete sets: **${pnl >= 0n ? "+" : ""}${usd(pnl)} tUSDC** on ${usd(basisClosed)} of basis ` +
        `(${((Number(pnl) / Number(basisClosed)) * 100).toFixed(2)}%)`);
  }
  const n = complete + oneSided;
  if (n > 0) {
    say(`- fill shape: ${complete}/${n} complete, ${oneSided}/${n} one-sided — ` +
        `**${((oneSided / n) * 100).toFixed(0)}% of filled quotes were adverse**`);
  }
  say();
  say("A one-sided episode's cash is not fully knowable from events (the unfilled leg's");
  say("escrow returns silently), so it is counted but not summed. What is summed is exact.");
  say();
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
