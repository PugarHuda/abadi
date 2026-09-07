import type { Metadata, Viewport } from "next";
import { readFileSync } from "node:fs";
import "./recorder.css";

const ORIGIN = "https://abadi-wheat.vercel.app";

/* The mark: one contract split by a price, the two sides always filling the whole. Drawn in
 * the recorder's pens — channel one solid ink, channel two the second pen, the price a gap
 * the paper shows through. Inline as a data URI so it costs no request. */
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" fill="#F5F1E6"/>' +
      '<rect x="6" y="6" width="11.7" height="20" fill="#16262B"/>' +
      '<rect x="19.1" y="6" width="6.9" height="20" fill="#2A3A6B"/>' +
      '<path d="M18.4 2V30" stroke="#B4331C" stroke-width="1.4"/>' +
      "</svg>",
  );

/* Read at build time. The live strip reads the vault in the visitor's browser and the address
 * comes from `.vault-addr`, so a page can never quote one vault and read another. */
const VAULT = readFileSync(".vault-addr", "utf8").trim();
const VAULTS = JSON.parse(readFileSync("scripts/lib/vaults.json", "utf8"));
const LIVE_CONFIG =
  "window.ABADI=" +
  JSON.stringify({
    vault: VAULT,
    rpc: "https://api.infra.testnet.somnia.network",
    vaults: VAULTS,
    explorer: "https://shannon-explorer.somnia.network",
  })
    /* Every value here comes from two files in this repository, so there is no untrusted
     * input to escape — but a `<` inside a JSON string would still end the script element
     * early, and that is a footgun rather than a threat model. Escaped, so the question
     * cannot come up if somebody adds a field later. */
    .replace(/</g, "\\u003c");

export const metadata: Metadata = {
  metadataBase: new URL(ORIGIN),
  title: { default: "Abadi", template: "%s" },
  icons: { icon: FAVICON },
  openGraph: {
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#F5F1E6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Two faces, and the first has a width axis the design actually uses: Archivo runs
            from 80% on chart-margin lettering to 112% on the wordmark. Loaded once here
            rather than five times in five page heads, which is how the old three-family
            stack drifted. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400;62..125,500;62..125,600;62..125,700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: LIVE_CONFIG }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
