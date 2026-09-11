import type { Metadata } from "next";
import SiteHeader from "../site-header";
import Script from "next/script";
import "./page.css";

export const metadata: Metadata = {
  title: "Abadi App",
  description: "Deposit into the Abadi vault, redeem your shares, mint test collateral — from the wallet you already have, with every call built in the open.",
  alternates: { canonical: "/app" },
  openGraph: {
    title: "Abadi App",
    description: "Deposit into the Abadi vault, redeem your shares, mint test collateral — from the wallet you already have, with every call built in the open.",
    url: "/app",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
};

export default function AppPage() {
  return (
    <>
      <a className="skip" href="#app">Skip to content</a>

      <div className="wrap">

        <SiteHeader current="/app" />

        <main id="app" data-busy="false" tabIndex={-1}>

        {/* What this is and what happens after you press Deposit.
          *
          * The page opened on a wallet panel and never said either. Somebody who had used it
          * asked "after I deposit, then what?" — which is the only question a depositor has,
          * and four screens of correct ERC-4626 detail did not answer it. */}
        <p className="lede">
          This vault is a market maker. You put tUSDC in; a bot quotes both sides of DreamDEX
          up/down windows with it, every fifteen minutes, without you. When both sides of a
          quote fill it holds one Up and one Down — a pair worth exactly <b>1</b> at
          settlement whichever way the window goes — and it paid less than 1 for them. The
          difference is the spread, earned without ever taking a view.
        </p>
        <p className="note">
          <b>So after you deposit, you do nothing.</b> Your shares are worth their slice of
          NAV at every moment, and you withdraw whenever the vault has idle collateral. The
          risk is one leg filling while the market walks away from the other: the vault then
          holds a direction, NAV marks it at zero, and the shares fall. That is happening —{" "}
          <b>25% of filled quotes have gone adverse and the share price is{" "}
          <span id="drawdown">down</span></b>. {/* filled from the chain: a dead number beside
          a live one is the drift this repository keeps finding */}
          It is testnet money, and <a href="/dashboard">the working</a> shows every episode.
        </p>

        <h2>Wallet <span>Somnia Shannon testnet, chain 50312</span></h2>
        <div className="panel wallet">
          <div>
            <div className="who" id="wallet">Not connected</div>
            <div className="net" id="network"></div>
          </div>
          <div className="row">
            <button className="lead" id="connect" type="button">Connect wallet</button>
            {/* The page reconnects a wallet it has already been granted, silently, on every
                load. That is the right default and it needs a way out, or "connected" becomes
                a state you cannot leave from here. This forgets the wallet on this device; the
                wallet's own permission is revoked in the wallet, and the button says so. */}
            <button id="disconnect" type="button" hidden={true}>Disconnect</button>
          </div>
        </div>
        {/* EIP-6963. Only rendered when more than one wallet announces itself; with one or none
             there is nothing to choose and this stays empty. */}
        <div className="wallets" id="wallets" hidden={true} role="group" aria-label="Choose a wallet"></div>
        <p className="note nowallet" id="nowallet" hidden={true}>
          No wallet in this browser. Install <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a>{" "}
          or <a href="https://rabby.io/" target="_blank" rel="noopener">Rabby</a>, then reload this page. Everything below
          still reads live from the chain without one.
        </p>
        <p className="note" id="contracts">
          Vault <a id="vaultAddr" target="_blank" rel="noopener">…</a><br />
          tUSDC <a id="usdcAddr" target="_blank" rel="noopener">…</a><br />
          The only two contracts this page ever asks you to sign for. Both links go to the Shannon explorer.
        </p>
        <p className="note">
          Deposits mint ERC-4626 shares of the vault. The operator key can quote and cancel and
          cannot move a token; <b>settle</b> is permissionless and pays the vault. Your shares are
          worth their slice of NAV at every moment, and NAV marks a naked leg at zero.
        </p>
        <p className="note" id="wake">Self-wake reserve: <b data-wake="stt">…</b> of the 32 STT the chain requires before the vault may arm its own settlement. <span data-wake="verdict"></span></p>
        {/* Funding is not arming. This line is the live subscription itself, read from the
             node with somnia_reactivityGetSubscriptions, counting down to the second it fires. */}
        <p className="note" data-wake="armed">Reading the precompile…</p>

        <h2>Balances <span id="freshness">read from the chain every 30 seconds</span></h2>
        <div className="panel">
          <dl className="grid">
            <div><dt>Your tUSDC</dt><dd><span id="usdc">—</span> <small>tUSDC</small></dd></div>
            <div><dt>Your STT (gas)</dt><dd><span id="stt">—</span> <small>STT</small></dd></div>
            <div><dt>Your shares</dt><dd><span id="shares">—</span> <small>abLIQ</small></dd></div>
            <div><dt>Worth today</dt><dd><span id="worth">—</span> <small>tUSDC</small></dd></div>
            <div><dt>Vault NAV</dt><dd><span id="nav">…</span> <small>tUSDC</small></dd></div>
            <div><dt>Idle in vault</dt><dd><span id="idle">…</span> <small>tUSDC</small></dd></div>
            <div><dt>Per share</dt><dd><span id="share">…</span> <small>tUSDC / abLIQ</small></dd></div>
          </dl>
        </div>

        <h2>Actions <span>each one is a transaction your wallet signs</span></h2>
        <p className="status" id="status" role="status">Connect a wallet to enable these.</p>
        <div className="actions">
          <div className="action">
            <h3>Get test collateral</h3>
            <p>The venue's tUSDC mints on demand on testnet. One click, 10,000 tUSDC.</p>
            <div className="row"><button id="faucet" type="button" disabled={true}>Mint 10,000 tUSDC</button></div>
          </div>
          <div className="action">
            <h3>Deposit</h3>
            <p>Approves the vault for exactly this amount, then deposits it. The deposit spends the whole approval, so every deposit signs twice.</p>
            <form className="row" id="depositForm">
              <div className="field">
                <label htmlFor="amount">Amount in tUSDC</label>
                <input id="amount" type="text" inputMode="decimal" placeholder="100" autoComplete="off" />
              </div>
              {/* Two buttons both reading "Max" are indistinguishable in a screen reader's
                   list of controls; the label says which pot each one empties. */}
              <button id="amountMax" className="max" type="button" aria-label="Max deposit" disabled={true}>Max</button>
              <button id="deposit" className="lead" type="submit" disabled={true}>Deposit</button>
            </form>
          </div>
          <div className="action">
            <h3>Withdraw</h3>
            <p>Takes tUSDC out of what is idle and burns the shares it costs. Capital resting in a quote comes back as the quote closes.</p>
            <form className="row" id="withdrawForm">
              <div className="field">
                <label htmlFor="withdrawAmount">Amount in tUSDC</label>
                <input id="withdrawAmount" type="text" inputMode="decimal" placeholder="100" autoComplete="off" />
              </div>
              <button id="withdrawMax" className="max" type="button" aria-label="Max withdrawal" disabled={true}>Max</button>
              <button id="withdraw" type="submit" disabled={true}>Withdraw</button>
            </form>
            <div className="row all">
              <button id="withdrawAll" type="button" disabled={true}>Redeem all shares</button>
              <span className="preview" id="allPreview"></span>
            </div>
            <p className="guard" id="guard" hidden={true}>
              You hold the last share and a quote is still open. Redeeming everything now would hand
              that quote's proceeds to nobody, so the vault refuses it. Redeem all but a little, or
              wait for the slot to close.
            </p>
          </div>
          <div className="action">
            <h3>Gas</h3>
            <p>Every action costs a little STT. If <b>Your STT</b> reads zero, the <a href="https://cloud.google.com/application/web3/faucet/somnia/shannon" target="_blank" rel="noopener">Somnia faucet</a> gives 0.5 STT a day, which covers dozens of transactions here.</p>
          </div>
        </div>

        <h2>Open quotes <span>what the vault is resting right now</span></h2>
        {/* Five columns do not fit a phone, so this scrolls sideways; a scrolling region has
             to be focusable or a keyboard can never reach the columns off the right edge. */}
        <div className="panel" style={{ overflowX: "auto" }} role="region" aria-label="Open quotes, scrollable" tabIndex={0}>
          <table>
            <thead><tr><th>slot</th><th>market</th><th>bid / ask</th><th>size</th><th>basis</th></tr></thead>
            <tbody id="slots"><tr><td colSpan={5}>…</td></tr></tbody>
          </table>
        </div>

        {/* A market maker with nothing resting looks like a market maker that does not work.
          *
          * It is idle about three quarters of the time and that is the strategy, not a
          * fault: it quotes two of the venue's four tiers, and those windows open in bursts
          * with gaps between them. But the table above is empty during every gap, and a
          * reader arriving in one has no way to tell a resting bot from a dead one.
          *
          * So the gap shows the record instead of nothing. Same chain, read the same way,
          * and the explorer decodes the vault's own events for us because the contract is
          * verified — which is why there are no event topics pinned in this file. */}
        <h2>What it did last <span>the vault&apos;s own events, newest first</span></h2>
        <ul className="log" id="recent"><li className="empty">Reading the chain…</li></ul>

        <h2>Activity <span>this session, newest first</span></h2>
        <ul className="log" id="log" aria-live="polite" aria-relevant="additions">
          <li className="empty" id="logEmpty">Nothing yet. Transactions you send appear here with a link to the explorer.</li>
        </ul>

        </main>

      </div>
      <Script src="/fetchin.js" strategy="afterInteractive" />
      <Script src="/app.js" strategy="afterInteractive" />
    </>
  );
}
