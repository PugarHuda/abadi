import { readFileSync } from "node:fs";
import type { Metadata } from "next";
import Script from "next/script";
import "./page.css";

export const metadata: Metadata = {
  title: "Abadi — the working",
  description: "The working behind Abadi: 2,422 settled markets measured, the live order book with the vault's quote inside it, and the position that filled — with what went wrong and what it cost.",
  alternates: { canonical: "/dashboard" },
  openGraph: {
    title: "Abadi — the working",
    description: "The working behind Abadi: 2,422 settled markets measured, the live order book with the vault's quote inside it, and the position that filled — with what went wrong and what it cost.",
    url: "/dashboard",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
};

/* Read at build time in a server component, the same file the old build read. */
const vault = readFileSync(".vault-addr", "utf8").trim();
const shortVault = `vault ${vault.slice(0, 10)}…${vault.slice(-4)}`;

export default function Dashboard() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>

      <div className="wrap">

        <header className="masthead">
          <a className="home" href="/" aria-label="Abadi home">
            <svg viewBox="0 0 20 38" aria-hidden="true">
              <rect x="0" y="4" width="11.7" height="30" fill="#16262B" />
              <rect x="13.1" y="4" width="6.9" height="30" fill="#2A3A6B" />
              <path d="M12.4 0V38" stroke="#B4331C" strokeWidth="1.4" />
            </svg>
            <h1 className="wordmark">abadi</h1>
          </a>
          <div className="gloss">
            Market making for<br />DreamDEX Event Contracts<br />
            <b>Shannon 50312</b><br /><b>26&ndash;28 Aug 2026</b>
          </div>
        </header>
        <nav className="nav" aria-label="Site">
          <a href="/">Landing</a>
          <a href="/dashboard" aria-current="page">The working</a>
          <a href="/deck">Deck</a>
          <a className="go" href="/app">Open the app</a>
        </nav>

        <main id="main" tabIndex={-1}>

        <h2 className="thesis">The markets expire every window. <em>The liquidity does not.</em></h2>
        <p className="sub">
          Abadi rests a two-sided quote inside the incumbent spread and holds no view on the
          outcome. Every number below was read off the chain, not modelled.
        </p>

        {/* ============ the rail ============ */}

        {/* ============ live, from the chain ============ */}
        <h2 className="band">Live from the chain <span>read in your browser, no server of ours</span></h2>

        <div className="live" id="live" data-state="loading">
          <p className="live-err" data-live="error"></p>
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

        <h2 className="band">Where the market sits <span>ETH-0-27AUG26 · 24h tier</span></h2>

        <div className="axis-frame">
          <div className="axis">
            <div className="span theirs" style={{ left: "74.2%", right: "22.8%" }}><b>0.742 — 0.772</b></div>
            <div className="span ours" style={{ left: "74.4%", right: "23.0%" }}><b>abadi 0.744 — 0.770</b></div>
          </div>
          <div className="axis-ends">
            <span>0.000 — certain down</span>
            <span>certain up — 1.000</span>
          </div>
        </div>

        <p className="axis-note">
          A prediction market has a bounded axis: every price is a probability between 0 and 1.
          At this width the entire tradable spread is three percent of the rail. Abadi's quote
          sits inside it — the narrow band, not the wide one.
        </p>

        {/* ============ ladder ============ */}
        <h2 className="band">The book, live <span>ours marked by owner address</span></h2>

        <div className="ladder" id="book" data-state="loading">
          <div className="bids" data-book="bids"></div>
          <div className="asks" data-book="asks"></div>
        </div>
        <p className="book-note" data-book="note">Reading the book…</p>

        <div className="verdict">
          <p>
            Before Abadi quoted, this market was <code>0.742 / 0.772</code> — a spread of
            <code>0.030</code>. After, it reads <code>0.744 / 0.769</code>, a spread of
            <code>0.025</code>. The incumbent quoter tightened in response.
          </p>
          <p>
            One vault quoting inside made prices better for everyone else trading this market.
          </p>
        </div>

        {/* ============ track record, live ============ */}
        <h2 className="band">Track record, live from the chain <span>every vault, every episode</span></h2>

        <div className="ledger-live" id="ledger" data-state="loading">
          <p className="live-err" data-ledger="error"></p>
          <dl className="figures">
            <div><dt>Per share</dt><dd data-ledger="share">…</dd></div>
            <div><dt>Depositors, vs. par</dt><dd><span data-ledger="depositors">…</span> <small>tUSDC</small></dd></div>
            <div><dt>Realised, every closed episode</dt><dd><span data-ledger="pnl">…</span> <small>tUSDC</small></dd></div>
            <div><dt>Episodes</dt><dd data-ledger="episodes">…</dd></div>
            <div><dt>Complete sets</dt><dd data-ledger="complete">…</dd></div>
            <div><dt>One-sided</dt><dd data-ledger="onesided">…</dd></div>
          </dl>
          <figure className="chart" id="pnlChart" aria-labelledby="pnlTitle" data-state="loading">
            <figcaption id="pnlTitle">Realised, cumulative, every closed episode, tUSDC <span data-ledger="last"></span></figcaption>
            <div className="chart-plot">
              <svg viewBox="0 0 720 220" preserveAspectRatio="none" role="img" aria-label="Cumulative realised profit and loss over time, losses included"></svg>
              <div className="xhair" hidden={true}></div>
              <div className="tip" role="status" hidden={true}></div>
            </div>
            {/* The figure's data-state was set and never styled, so on a failed read this frame
                 kept the word "loading" in its markup and an empty grid on screen while the panel
                 above it said the explorer could not be reached. */}
            <p className="chart-err">The equity curve is not drawn, because the read behind it failed. An empty frame is not a flat month.</p>
          </figure>
          {/* Eight columns of mono do not fit a phone, so this scrolls sideways. A region
               that scrolls has to be focusable, or the only way in is to tab every link in it. */}
          <div className="tablewrap" role="region" aria-label="Every episode, scrollable" tabIndex={0}>
            <table className="episodes">
              <thead><tr><th>vault</th><th>market</th><th>quoted</th><th>bid / ask</th><th>basis</th><th>back</th><th>closed by</th><th>result</th></tr></thead>
              <tbody data-ledger="rows"></tbody>
            </table>
          </div>
          <p className="live-foot">
            Per share is what a depositor’s claim is worth right now, and it carries every loss the
            vault has taken. Realised prices every closed episode against its full basis — the escrow
            the pool released on a leg that never filled is read from the collateral transfers, so a
            one-sided fill is worth what it actually returned rather than being left out.
            Read from the explorer’s log API in your browser and decoded with the vault’s ABI ·
            <span data-ledger="count"></span>
          </p>
        </div>

        {/* ============ the position ============ */}
        <h2 className="band">What filled <span>both legs taken</span></h2>

        <dl className="ledger">
          <div className="row"><dt>Paid at quote time</dt><dd>97.40 tUSDC</dd></div>
          <div className="row"><dt>Holds — up contracts</dt><dd>100.000000</dd></div>
          <div className="row"><dt>Holds — down contracts</dt><dd>100.000000</dd></div>
          <div className="row"><dt>Worth at settlement, either way</dt><dd>100.00 tUSDC</dd></div>
          <div className="row total"><dt>Locked in</dt><dd>+2.60 tUSDC · 2.67%</dd></div>
        </dl>

        <div className="verdict">
          <p>
            Both legs were <em>buys</em>. Neither could have filled against a seller, because no
            seller was involved: two opposite-side buyers crossed and the pool minted a fresh
            up/down pair from their combined collateral.
          </p>
          <p>
            That is why the position cost 97.40 rather than 100, and why it needed no inventory
            to begin with. Holding one of each side, it redeems to exactly 100 whichever way
            the market resolves.
          </p>
          <p>
            That last sentence stopped being a design claim on the 27th. A later window ran the
            same shape end to end — quoted, both legs filled, resolved, and
            <code>settle()</code> redeemed <b>100.00</b> against a <b>97.60</b> basis. Net asset
            value did not move by a single unit across settlement, because a complete set was
            already marked at exactly what it redeems for.
          </p>
        </div>

        <div className="readout">
          <div className="n">0.00</div>
          <div className="l">
            <b>directional exposure</b>
            <p>
              The number a market maker is judged on. Abadi never took a view, and the 2.60 is
              not a bet that paid — it is the spread, collected.
            </p>
          </div>
        </div>

        {/* ============ calibration ============ */}
        <h2 className="band">Why quote instead of predict <span>2,422 settled markets</span></h2>

        <div className="cal">
          <div className="tier"><div className="plot"><div className="bar under" style={{ top: "50%", height: "1.6%" }}></div></div>
            <div className="v">49.6</div><div className="t">60s</div></div>
          <div className="tier"><div className="plot"><div className="bar under" style={{ top: "50%", height: "5.6%" }}></div></div>
            <div className="v">48.6</div><div className="t">300s</div></div>
          <div className="tier"><div className="plot"><div className="bar under" style={{ top: "50%", height: "7.2%" }}></div></div>
            <div className="v">48.2</div><div className="t">900s</div></div>
          <div className="tier"><div className="plot"><div className="bar over" style={{ bottom: "50%", height: "4.0%" }}></div></div>
            <div className="v">51.0</div><div className="t">1h</div></div>
          <div className="tier"><div className="plot"><div className="bar over" style={{ bottom: "50%", height: "7.6%" }}></div></div>
            <div className="v">51.9</div><div className="t">4h</div></div>
          <div className="tier"><div className="plot"><div className="bar over" style={{ bottom: "50%", height: "34.4%" }}></div></div>
            <div className="v">58.6</div><div className="t">24h</div></div>
        </div>
        <div className="cal-axis">
          <span>deviation from a fair coin · dashed line is 50%</span>
          <span>pooled 49.96% · z = −0.04</span>
        </div>

        <div className="verdict">
          <p>
            Across every tier, up won as often as a coin. Pooled over 2,422 settled markets:
            <code>49.96%</code>, four hundredths of a standard error from 50. The 24-hour tier
            looks tempting at 58.6% — it has 58 samples and a z of 1.31. That is noise, and
            reading it as signal is the mistake to avoid.
          </p>
          <p>
            With a coin flip and a three percent spread, crossing it costs
            <code>−1.45%</code> a contract and collecting it earns <code>+1.45%</code>. So Abadi
            collects. The strategy was chosen by the measurement, not the other way round.
          </p>
        </div>

        </main>

        <footer className="foot">
          <span>{shortVault} · quote → fill → merge → redeem, all run · not a track record yet</span>
          <span>abadi · everlasting</span>
        </footer>

      </div>
      <Script src="/fetchin.js" strategy="afterInteractive" />
      <Script src="/live.js" strategy="afterInteractive" />
      <Script src="/ledger.js" strategy="afterInteractive" />
      <Script src="/book.js" strategy="afterInteractive" />
    </>
  );
}
