/**
 * Writes `public/deployments.json` — the file another project reads to call this vault.
 *
 * It was generated inside the old site build. It is a prebuild step now because the framework
 * serves `public/` verbatim and nothing else in the build has an opinion about it. Same shape,
 * same CAIP-2 chain id, same list of retired addresses.
 *
 *   node scripts/deployments.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const VAULT = readFileSync(".vault-addr", "utf8").trim();
const VAULTS = JSON.parse(readFileSync("scripts/lib/vaults.json", "utf8"));

mkdirSync("public", { recursive: true });
writeFileSync(
  "public/deployments.json",
  JSON.stringify(
    {
      name: "Abadi",
      description:
        "An ERC-4626 vault that makes markets on DreamDEX Event Contracts holding no inventory.",
      chain: "eip155:50312",
      chainName: "Somnia Shannon Testnet",
      rpc: "https://api.infra.testnet.somnia.network",
      explorer: "https://shannon-explorer.somnia.network",
      vault: { address: VAULT, kind: "ERC-4626", abi: "/abi.json" },
      asset: {
        address: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
        symbol: "tUSDC",
        decimals: 6,
      },
      // Every address this project has ever deployed, so a reader who finds an old one in a
      // transaction can tell it is retired rather than wonder which is live.
      retired: VAULTS.map((v) => ({ address: v.address, note: v.note ?? "" })),
      links: {
        repo: "https://github.com/PugarHuda/abadi",
        app: "https://abadi-wheat.vercel.app/app",
        ledger: "https://abadi-wheat.vercel.app/dashboard",
      },
      updated: new Date().toISOString().slice(0, 10),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote public/deployments.json  (vault " + VAULT + ")");
