import { readFileSync } from "node:fs";
import type { Metadata } from "next";
import SiteHeader from "./site-header";
import Script from "next/script";
import "./page.css";

export const metadata: Metadata = {
  title: "Abadi",
  description: "A vault that quotes both sides of DreamDEX Event Contract markets holding no inventory, and captures the spread with no directional exposure. Live on Somnia Shannon testnet.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Abadi",
    description: "A vault that quotes both sides of DreamDEX Event Contract markets holding no inventory, and captures the spread with no directional exposure. Live on Somnia Shannon testnet.",
    url: "/",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
};

/* Read at build time in a server component, the same file the old build read. */
const vault = readFileSync(".vault-addr", "utf8").trim();
const shortVault = `vault ${vault.slice(0, 10)}…${vault.slice(-4)}`;

export default function Home() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>

      <div className="rail" aria-hidden="true"><span>abadi · shannon 50312</span></div>

      <div className="wrap">

        <SiteHeader current="/" />

        <main id="main" tabIndex={-1}>

        {/* The problem before the mechanism.
          *
          * The thesis line below is the better sentence and it was doing the wrong job: it
          * describes what this vault does, which only lands once you already know what a pair
          * is. A reader arriving cold needs the problem first — and on this venue the problem
          * is one measured fact, so it is stated as one. */}
        <p className="kicker">
          DreamDEX runs twelve series at once and quotes a flat <b>2.9%</b> on every one of
          them. That is the signature of nobody being on the other side.
        </p>

        <h2 className="thesis">The price moves. <em>The pair doesn’t.</em></h2>
        <p className="lede">
          Abadi quotes both sides of a DreamDEX event market, keeps one of each when they fill,
          and collects the difference. It never needs an opinion about the outcome.
        </p>

        {/* The proof and the invitation, above the fold.
          *
          * The measurement was four screens down, and it is the one claim in this hackathon
          * nobody else makes. The nav's "Open the app" is navigation, not an invitation; a
          * reader asking "what do I do here" had nothing to answer them until the footer. */}
        <div className="offer">
          <div className="proof">
            <span className="k">measured</span>
            <b>0.0245 → 0.0175</b>
            <span>the venue's own spread, without this vault and with it — rebuilt from its
            order rows across every one of the 148 windows this vault has quoted, tighter
            on 138 and wider on none</span>
          </div>
          <div className="acts">
            <a className="btn primary" href="/app">Open the app</a>
            <a className="btn" href="/dashboard">See the working</a>
          </div>
        </div>

        {/* ============ the instrument ============ */}
        <div className="carriage">
          <div className="channel-head">
            <span>Drag the pen, or use the arrow keys</span>
            <span className="keys"><span><i></i>Up</span><span className="two"><i></i>Down</span></span>
          </div>

          <div className="track" id="track" role="slider" tabIndex={0} aria-label="Probability the market resolves up" aria-valuemin={0.01} aria-valuemax={0.99} aria-valuenow={0.62} aria-valuetext="0.620">
            <div className="knob" id="knob" style={{ left: "62%" }}></div>
          </div>
          <div className="ends"><span>0.000</span><span>1.000</span></div>

          <div className="legs">
            <div className="leg up">
              <span className="name">Up</span>
              <span className="val" id="pUp">0.620</span>
              <span className="bar"><i id="bUp" style={{ width: "62%" }}></i></span>
            </div>
            <div className="leg down">
              <span className="name">Down</span>
              <span className="val" id="pDown">0.380</span>
              <span className="bar"><i id="bDown" style={{ width: "38%" }}></i></span>
            </div>
            <div className="sum">
              <span className="name">Pair</span>
              <span className="val" id="pSum">1.000</span>
              <span className="whole"><b id="wUp" style={{ width: "62%" }}></b><b id="wDown" style={{ width: "38%" }}></b></span>
            </div>
          </div>

          <p className="rig-foot">
            Put the price wherever you like. One Up and one Down redeems for <b>exactly one</b> at
            every price between zero and one, whichever way the market ends up resolving. That is
            not a hedge that mostly works &mdash; it is the settlement rule.
          </p>
        </div>


        {/* ============ live, from the chain ============ */}
        <h2 className="band">Live from the chain <span>read in your browser, no server of ours</span></h2>

        <div className="channel live" id="live" data-state="loading">
          <p className="live-err alarm" data-live="error"></p>
          <dl className="figures">
            <div><dt>NAV</dt><dd><span data-live="nav">…</span> <small>tUSDC</small></dd></div>
            <div><dt>Idle</dt><dd><span data-live="idle">…</span> <small>tUSDC</small></dd></div>
            <div><dt>Resting</dt><dd><span data-live="resting">…</span> <small>tUSDC</small></dd></div>
            <div><dt>Per share</dt><dd><span data-live="share">…</span></dd></div>
          </dl>
          <ul className="live-slots" data-live="slots"></ul>
          <p className="live-foot">
            block <span data-live="block">…</span> ·
            <a data-live="explorer" href="#">vault on the explorer</a> ·
            refreshes every minute
          </p>
        </div>

        {/* ============ the trade ============ */}
        <h2 className="band">Where the money comes from <span>zero inventory</span></h2>

        {/* It scrolls sideways on a phone, so it has to be reachable by keyboard as well as
             by thumb: focusable, and named, or it is a region nobody can get into. */}
        <div className="maths" role="region" aria-label="The arithmetic of a pair" tabIndex={0}>
          <span className="k">buy</span> <span className="u">UP</span>  <span className="k">at</span> p<br />
          <span className="k">buy</span> <span className="d">DOWN</span> <span className="k">at</span> p + s   <span className="k">&larr; the venue quotes both sides Up-side, so this leg escrows 1 &minus; (p + s)</span><br />
          <span className="r">pair costs <b>1 &minus; s</b> &nbsp;&middot;&nbsp; pair is worth <b>1</b> &nbsp;&middot;&nbsp; the difference is <b>s</b>, the spread</span>
        </div>

        <p className="note">
          No inventory is needed to start. DreamDEX runs one order book, and a Buy&nbsp;Up crossing a
          Buy&nbsp;Down needs no seller at all &mdash; the pool mints a fresh pair out of the two buyers'
          collateral. So the vault can quote both sides holding nothing, and the spread it earns is
          the venue's own <b>2.9%</b>, not a view about which way the price goes.
        </p>

        {/* ============ custody ============ */}
        <h2 className="band">Who can touch what <span>non-custodial</span></h2>

        <div className="scroll">
          <table>
            <tbody>
              <tr><th>Actor</th><th>Can</th><th>Cannot</th></tr>
              <tr>
                <td className="who">operator</td>
                <td>Quote and cancel</td>
                <td className="cannot"><b>Move a single token.</b> The bot key steers prices and has no path to the money</td>
              </tr>
              <tr>
                <td className="who">governor</td>
                <td>Set the operator, risk limits, price grid. Sweep the vault's native STT with <code>sweepNative</code> &mdash; ~32.8 STT today, the reserve that pays for the self-wake</td>
                <td className="cannot"><b>Touch depositor collateral.</b> Handover is two-step, so a mistyped address hands the seat to nobody</td>
              </tr>
              <tr>
                <td className="who">depositor</td>
                <td>Deposit and withdraw against ERC-4626 shares</td>
                <td className="cannot">Steer quotes</td>
              </tr>
              <tr>
                <td className="who">anyone</td>
                <td>Settle a resolved market, and merge a pair once the window can no longer trade</td>
                <td className="cannot">Redirect the proceeds &mdash; they go to the vault, never the caller</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* ============ what ran ============ */}
        <h2 className="band">What has actually run <span>Shannon testnet</span></h2>

        <ul className="ran">
          <li>
            <span className="what">quote</span>
            <span className="said">Bid became the <b>best bid on the market</b>, and the spread went from 0.030 to 0.025 &mdash; the incumbent tightened in response</span>
            <span className="tx"><a href="https://shannon-explorer.somnia.network/tx/0x3a8b93bba2a39a35102d44f8005143dafb9317033003befec7b4c5fbe095a6dd">0x3a8b93bb</a></span>
          </li>
          <li>
            <span className="what">fill</span>
            <span className="said">Both legs taken. <b>97.40 paid</b> for 100 Up and 100 Down &mdash; a complete set, worth 100.00 either way</span>
            <span className="tx">on chain</span>
          </li>
          <li>
            <span className="what">settle</span>
            <span className="said">Window resolved, position redeemed. <b>+100.00 against a 97.60 basis</b>, and NAV did not move a unit across settlement</span>
            <span className="tx"><a href="https://shannon-explorer.somnia.network/tx/0x60f880ac7c64ecd70da253a2d410476ad78052c066bfc8c8e620196dbed2a044">0x60f880ac</a></span>
          </li>
          <li>
            <span className="what">flatten</span>
            <span className="said">Quote went dead with 11 minutes left, so the pair was merged back to collateral early &mdash; <b>no oracle involved</b></span>
            <span className="tx"><a href="https://shannon-explorer.somnia.network/tx/0xf2f625213296406a2bfb3ed99a65290917097948259069f2662db73a39027b3c">0xf2f62521</a></span>
          </li>
        </ul>

        {/* ============ the honest part ============ */}
        <h2 className="band">What this is not <span>yet</span></h2>

        <p className="note">
          A handful of fills proves the mechanism, not an edge. The real risk a maker carries is
          <b>adverse selection</b> &mdash; being filled on one side while the market walks away from the
          other. It happened to us twice in one afternoon. When it does, the vault is holding a
          direction, and NAV marks that leg at <b>zero</b> rather than at what it cost, so the loss
          lands on the people already in and not on whoever deposits next.
        </p>
        <p className="note">
          Measuring how often it happens needs many quotes across many windows. That is the next
          thing, not a thing we are claiming. The dashboard has the working, including what went
          wrong and what it cost.
        </p>

        <div className="out">
          <a className="lead" href="/app">Open the app &rarr;</a>
          <a href="/dashboard">Read the evidence</a>
          <a href="/deck">Deck</a>
          <a href="https://github.com/PugarHuda/abadi">Source</a>
          <a href={`https://shannon-explorer.somnia.network/address/${vault}`}>Vault on the explorer</a>
        </div>

        </main>

        <footer className="foot">
          <span>{shortVault}</span>
          <span>abadi &middot; everlasting</span>
        </footer>

      </div>
      <Script src="/fetchin.js" strategy="afterInteractive" />
      <Script src="/live.js" strategy="afterInteractive" />
      <Script src="/home-inline.js" strategy="afterInteractive" />
    </>
  );
}
