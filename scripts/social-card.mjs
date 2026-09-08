/**
 * The measurement, as one 1600x900 image.
 *
 * A post gets one picture and about two seconds of attention, so the picture has to carry the
 * single claim nobody else in this hackathon can make: the venue's own order book, rebuilt
 * twice from its own `Order` rows — once with this vault's quotes in it and once without —
 * and the spread that came out of each.
 *
 * Drawn in the site's own ink on the site's own paper, using the tokens from
 * `app/recorder.css`, so the card and the thing it points at look like one project. No stock
 * gradients, no glow: this is a recorder chart, and the numbers are the design.
 *
 *   node scripts/social-card.mjs        # writes public/impact-card.png
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const W = 1600;
const H = 900;

/* 0.0245 and 0.0175 on an axis that starts at zero, so the bars are honest: the second is
 * 72% of the first and looks it. The label says the percentage rather than the picture
 * implying a bigger one. */
const html = `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400;62..125,500;62..125,600;62..125,700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --stock:#F5F1E6; --stock-sunk:#EBE5D5; --rule:#DFD5BF; --rule-major:#C3B392;
    --ink:#16262B; --pen-down:#2A3A6B; --alarm:#B4331C; --pencil:#3D4745;
    --sans:Archivo,system-ui,sans-serif; --mono:"IBM Plex Mono",ui-monospace,monospace;
  }
  * { box-sizing:border-box; margin:0; }
  body {
    width:${W}px; height:${H}px; background:var(--stock); color:var(--ink);
    font-family:var(--sans); font-variant-numeric:tabular-nums;
    /* The printed grid the whole site sits on. */
    background-image:repeating-linear-gradient(to bottom, transparent 0 47px, #EAE3D2 47px 48px);
    padding:64px 72px; display:flex; flex-direction:column; justify-content:space-between;
  }
  .top { display:flex; align-items:flex-start; justify-content:space-between; }
  .lockup { display:flex; align-items:center; gap:14px; }
  .lockup svg { width:26px; height:50px; display:block; }
  .lockup h1 { font-size:52px; font-weight:700; font-stretch:112%; letter-spacing:-.03em; line-height:.92; }
  .where { font-family:var(--mono); font-size:15px; color:var(--pencil); text-align:right; line-height:1.6; }
  h2 { font-size:46px; font-weight:600; letter-spacing:-.022em; line-height:1.12; max-width:20ch; }
  h2 em { font-style:normal; color:var(--pen-down); }
  .bars { display:flex; flex-direction:column; gap:22px; margin-top:8px; }
  .row { display:flex; align-items:center; gap:20px; }
  .cap { font-family:var(--mono); font-size:16px; color:var(--pencil); width:150px; text-align:right; }
  .track { flex:1; height:54px; background:var(--stock-sunk); border-top:1px solid var(--rule-major); border-bottom:1px solid var(--rule-major); position:relative; }
  .fill { position:absolute; left:0; top:0; bottom:0; }
  .val { position:absolute; top:50%; transform:translateY(-50%); font-family:var(--mono); font-size:22px; font-weight:500; padding-left:14px; }
  .bottom { display:flex; align-items:flex-end; justify-content:space-between; gap:40px; }
  .note { font-size:21px; color:var(--pencil); max-width:52ch; line-height:1.5; }
  .note b { color:var(--ink); font-weight:600; }
  .site { font-family:var(--mono); font-size:19px; color:var(--ink); }
</style>
<div class="top">
  <div class="lockup">
    <svg viewBox="0 0 20 38"><rect x="0" y="4" width="11.7" height="30" fill="#16262B"/><rect x="13.1" y="4" width="6.9" height="30" fill="#2A3A6B"/><path d="M12.4 0V38" stroke="#B4331C" stroke-width="1.4"/></svg>
    <h1>abadi</h1>
  </div>
  <div class="where">DreamDEX Event Contracts<br>Somnia Shannon · 50312</div>
</div>

<h2>The book is <em>28% tighter</em> with this vault quoting in it.</h2>

<div class="bars">
  <div class="row">
    <div class="cap">without Abadi</div>
    <div class="track"><div class="fill" style="width:100%;background:var(--rule)"></div><div class="val" style="color:var(--ink)">0.0245</div></div>
  </div>
  <div class="row">
    <div class="cap">with Abadi</div>
    <div class="track"><div class="fill" style="width:71.7%;background:var(--ink)"></div><div class="val" style="color:var(--stock)">0.0175</div></div>
  </div>
</div>

<div class="bottom">
  <div class="note">
    Every quoted window rebuilt twice from the venue's own <b>Order</b> rows — with our orders
    and without — at the instant each quote landed. <b>All 148 windows: tighter on 138, wider on
    none.</b> The same ledger publishes the vault's losses.
  </div>
  <div class="site">abadi-wheat.vercel.app</div>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(600); // the web font, or the card ships in a fallback
const png = await page.screenshot({ type: "png" });
await browser.close();

writeFileSync("public/impact-card.png", png);
console.log(`wrote public/impact-card.png  (${W}x${H}, ${Math.round(png.length / 1024)} KB)`);
