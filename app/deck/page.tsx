import type { Metadata } from "next";
import Script from "next/script";
import "./page.css";

export const metadata: Metadata = {
  title: "Abadi — deck",
  description: "Ten slides on Abadi: why 2,422 settled markets pointed at market making rather than prediction, and what happened when the vault quoted inside the spread.",
  alternates: { canonical: "/deck" },
  openGraph: {
    title: "Abadi — deck",
    description: "Ten slides on Abadi: why 2,422 settled markets pointed at market making rather than prediction, and what happened when the vault quoted inside the spread.",
    url: "/deck",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
};

export default function Deck() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>

      <main className="deck" id="main" tabIndex={-1}>
      <section className="slide cover" data-i="0" tabIndex={0} aria-label="Slide 1 of 10">
        <svg className="mark" viewBox="0 0 20 38" aria-hidden="true">
          <rect x="0" y="4" width="11.7" height="30" fill="#16262B" />
          <rect x="13.1" y="4" width="6.9" height="30" fill="#2A3A6B" />
          <path d="M12.4 0V38" stroke="#B4331C" strokeWidth="1.4" />
        </svg>
        <h1>abadi</h1>
        <p className="line">The markets expire every window. <em>The liquidity doesn't.</em></p>
        <p className="meta">Somnia × DreamDEX Event Contracts Hackathon · Shannon testnet</p>
      </section>
      <section className="slide" data-i="1" tabIndex={0} aria-label="Slide 2 of 10">
        <h2>Every position dies on a timer.</h2>
        <p>DreamDEX runs six window tiers on two assets — sixty seconds through twenty-four hours. Twelve series live at once, each expiring and respawning on schedule.</p>
        <p className="dim">Liquidity has to be re-placed every window, on every series, forever. Nobody does that by hand — and the book shows it: a flat 2.9% spread on every market regardless of tenor, volatility, or moneyness. That is the signature of one naive quoter, not a competitive book.</p>
      </section>
      <section className="slide" data-i="2" tabIndex={0} aria-label="Slide 3 of 10">
        <h2>Does up win more often than the market prices it to?</h2>
        <table>
          <tr><th>Tier</th><th>n</th><th style={{ textAlign: "right" }}>Up won</th><th style={{ textAlign: "right" }}>z vs fair coin</th></tr>
          <tr><td>60s</td><td className="num">500</td><td className="num">49.6%</td><td className="num">−0.18</td></tr>
          <tr><td>300s</td><td className="num">500</td><td className="num">48.6%</td><td className="num">−0.63</td></tr>
          <tr><td>900s</td><td className="num">500</td><td className="num">48.2%</td><td className="num">−0.80</td></tr>
          <tr><td>1h</td><td className="num">500</td><td className="num">51.0%</td><td className="num">+0.45</td></tr>
          <tr><td>4h</td><td className="num">364</td><td className="num">51.9%</td><td className="num">+0.73</td></tr>
          <tr><td>24h</td><td className="num">58</td><td className="num">58.6%</td><td className="num">+1.31</td></tr>
          <tr className="hi"><td><b>pooled</b></td><td className="num">2,422</td><td className="num">49.96%</td><td className="num">−0.04</td></tr>
        </table>
        <p className="dim">No. Four hundredths of a standard error from a coin flip, across every settled market on the venue.</p>
      </section>
      <section className="slide" data-i="3" tabIndex={0} aria-label="Slide 4 of 10">
        <h2>With a coin flip and a 3% spread, only one side of the trade is positive.</h2>
        <pre tabIndex={0} role="region" aria-label="Spread economics per contract">taker  crosses the spread   <b>−1.45%</b> per contract
      maker  collects the spread  <b>+1.45%</b> per fill</pre>
        <p>Our first design was a directional vault that <em>took</em> liquidity every window. On the 900-second tier at 10% deployment:</p>
        <pre tabIndex={0} role="region" aria-label="Decay of a directional vault over a day and a week">after 1 day   ( 96 rolls)   <b>87.0%</b> of deposit
      after 7 days  (672 rolls)   <b>37.7%</b></pre>
        <p className="dim">Zero fees don't save it — the spread is the cost. We cut that product on the evidence and built the other side of the trade instead.</p>
      </section>
      <section className="slide" data-i="4" tabIndex={0} aria-label="Slide 5 of 10">
        <h2>Quote both sides holding <em>nothing</em>.</h2>
        <p>DreamDEX keeps one book with a fill path most venues don't have: two opposite-side <em>buyers</em> cross with no seller at all, and the pool mints a fresh up/down pair from their combined collateral.</p>
        <pre tabIndex={0} role="region" aria-label="What a pair costs when two buyers cross">BUY_YES  @ p        escrows  p         <i>per contract</i>
      BUY_NO   @ p + s    escrows  1−(p+s)   <i>price is always YES-side</i>
                                   <b>───────</b>
      pair cost                    <b>1 − s</b></pre>
        <p className="dim">Both legs fill and the vault holds a complete set — worth exactly 1 at settlement whichever side wins. The spread is captured with zero directional exposure, and no inventory was ever required.</p>
      </section>
      <section className="slide" data-i="5" tabIndex={0} aria-label="Slide 6 of 10">
        <h2>We quoted inside, and the market tightened.</h2>
        <pre tabIndex={0} role="region" aria-label="The book before and after Abadi quoted">theirs   0.742 / 0.772     spread 0.030
      ours     <b>0.744 / 0.770</b>     spread 0.026   <i>inside</i>

      the book, read back:
        <b>0.744 × 100  ← abadi</b>      0.769 × 200
        0.742 × 200                <b>0.770 × 100  ← abadi</b>
        0.733 × 330                0.779 × 330

      spread after   <b>0.030 → 0.025</b>   <i>the incumbent responded</i></pre>
        <p className="dim">Abadi's bid became the best bid on the market. One vault quoting inside made prices better for everyone else trading it — the ecosystem claim as a screenshot, not an assertion.</p>
      </section>
      <section className="slide" data-i="6" tabIndex={0} aria-label="Slide 7 of 10">
        <div className="two">
          <div>
            <pre tabIndex={0} role="region" aria-label="The position that filled">paid                <b>97.40</b>
      holds       100 up + 100 down
      worth at settlement <b>100.00</b>
                         <i>either way</i>
                         <b>──────</b>
      locked in           <b>+2.60</b></pre>
            <p className="dim" style={{ fontSize: "15px" }}>Both legs were buys. Neither could fill against a seller, because none was involved.</p>
          </div>
          <div>
            <div className="big">0.00</div>
            <p className="dim" style={{ margin: "0 0 10px" }}>directional exposure</p>
            <p className="dim" style={{ fontSize: "15px" }}>The number a market maker is judged on. The 2.60 isn't a bet that paid — it's the spread, collected.</p>
          </div>
        </div>
      </section>
      <section className="slide" data-i="7" tabIndex={0} aria-label="Slide 8 of 10">
        <h2>The key that steers the quotes can't move a token.</h2>
        <p>BinaryPool has no operator gate. The DreamDEX team confirmed the only shape that works today is a contract that owns its own orders — which is what Abadi is.</p>
        <table>
          <tr><th>Actor</th><th>Can</th><th>Cannot</th></tr>
          <tr><td><code>operator</code></td><td>quote, cancel</td><td className="cross"><b>move any token</b></td></tr>
          <tr><td><code>governor</code></td><td>set operator, risk params; <code>sweepNative</code> the vault's ~32.8 STT wake-up reserve</td><td className="cross">touch depositor collateral</td></tr>
          <tr><td>depositor</td><td>deposit, withdraw</td><td className="cross">steer quotes</td></tr>
        </table>
        <p className="dim"><code>settle()</code> is permissionless — proceeds go to the vault, never the caller, and a settled market leaves the live list so redemption has to be pulled. <code>flatten()</code> is operator-only while a market still trades, because cancelling a live quote destroys the spread; open to anyone once it can't.</p>
      </section>
      <section className="slide" data-i="8" tabIndex={0} aria-label="Slide 9 of 10">
        <h2>Four assumptions died on contact with the chain.</h2>
        <ul>
          <li><b>Prices scale to the collateral's decimals</b>, not 1e18 — and a wrong scale reverts as <code>PostOnlyWouldCross</code>, sending you to look at spreads instead of units.</li>
          <li><b>The spot <code>placeOrder</code> ABI exists on binary pools and always fails.</b> It compiles, type-checks, and reverts at runtime.</li>
          <li><b>Reactivity fails identically for two unrelated reasons</b> — a 32 STT floor and a missing ERC-165 — both with empty revert data.</li>
          <li><b>Docs list two window tiers. There are six.</b> A headroom rule tuned for the documented ones silently stops trading the fast tiers.</li>
          <li><b>Redemption pulls through the module, not the pool</b> — and nothing says so until the one call that turns tokens back into money. Cost us a stranded position.</li>
          <li><b>Cancelling an order that already filled reverts.</b> So cleanup breaks on exactly the position that needs cleaning up.</li>
          <li><b>The explorer’s verifier lists <code>osaka</code> and cannot verify it.</b> Same nine-line probe: cancun passes, osaka fails.</li>
          <li><b>A reactivity callback that runs out of gas vanishes</b> — no event, no error, subscription spent. And the callback’s topic is the fired millisecond, not the scheduled one.</li>
        </ul>
        <p className="dim">All reported back with reproduction steps, alongside what genuinely worked: the Gotchas page, unpruned history, and a dev channel that answered a hard question in under an hour.</p>
      </section>
      <section className="slide" data-i="9" tabIndex={0} aria-label="Slide 10 of 10">
        <h2>One vault. Full lifecycle. Honest about the rest.</h2>
        <table>
          <tr><th>Run against the venue</th><th></th></tr>
          <tr><td>Quoting inside the book, top of book</td><td className="num tick">✓</td></tr>
          <tr><td>Both legs filled into a complete set</td><td className="num tick">✓</td></tr>
          <tr><td><code>settle()</code> — redeemed 100.00 on a 97.60 basis</td><td className="num tick">✓</td></tr>
          <tr><td><code>flatten()</code> — merged early, 671s before expiry</td><td className="num tick">✓</td></tr>
          <tr><td>148 tests, five stateful invariants</td><td className="num tick">✓</td></tr>
          <tr><td>Keeper-free wake-up — the chain settled a window for us</td><td className="num tick">✓</td></tr>
        </table>
        <p><b>A handful of fills proves the mechanism, not the edge.</b> Adverse selection is the real risk a maker carries, and we met it twice in one afternoon — a leg taken while the market walked away from the other. NAV marks that leg at zero, so the loss lands on us and not on whoever deposits next. Measuring the frequency needs many quotes across many windows. The bot and the ledger exist so that number grows without anyone having to trust it.</p>
        <p className="dim">The markets expire. The liquidity doesn't.</p>
      </section>
      </main>

      <div className="bar"><i style={{ width: "10%" }}></i></div>
      <p className="hint">← → or space to move</p>
      <p className="sr-only" id="announce" role="status"></p>
      <div className="nav">
        <span className="count"><b>01</b> / 10</span>
        <button id="prev" aria-label="Previous slide">←</button>
        <button id="next" aria-label="Next slide">→</button>
      </div>
      <Script src="/deck-inline.js" strategy="afterInteractive" />
    </>
  );
}
